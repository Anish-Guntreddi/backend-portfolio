import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Worker, Queue } from 'bullmq';
import { createDb } from '../../src/db/client.ts';
import { buildServer, type BuiltServer } from '../../src/server.ts';
import { templates, notifications, preferences } from '../../src/db/schema.ts';
import { processNotification } from '../../src/worker/processor.ts';
import { startWorker } from '../../src/worker/index.ts';
import type { ChannelProvider, RenderedMessage } from '../../src/providers.ts';
import { resetDb, testConfig, createTestQueue, obliterateQueue } from '../helpers.ts';
import type { NotificationJobData } from '../../src/queue.ts';

const cfg = testConfig();
const { db, pool } = createDb(cfg.DATABASE_URL);
const auth = { 'x-api-key': cfg.API_KEY };

function parseRedisUrl(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port) || 6379 };
}

// Shared server (re-used across tests for speed).
let server: BuiltServer;
let sharedQueue: Queue<NotificationJobData>;

beforeAll(async () => {
  sharedQueue = createTestQueue(cfg.REDIS_URL, 'api');
  server = await buildServer(cfg, { db, queue: sharedQueue });
  await server.app.ready();
});

afterAll(async () => {
  await server.app.close();
  await pool.end();
  await obliterateQueue(sharedQueue);
});

beforeEach(async () => {
  await resetDb(db);
  try { await sharedQueue.drain(); } catch { /* best effort */ }
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedTemplate(overrides?: Partial<{
  key: string; channel: string; subject: string | null; body: string;
}>) {
  const [row] = await db.insert(templates).values({
    key: overrides?.key ?? 'welcome-email',
    channel: overrides?.channel ?? 'email',
    subject: overrides?.subject !== undefined ? overrides.subject : 'Hello {{name}}',
    body: overrides?.body ?? 'Hi {{name}}, welcome!',
  }).returning();
  return row!;
}

async function enqueue(overrides?: Record<string, unknown>) {
  return server.app.inject({
    method: 'POST',
    url: '/notifications',
    headers: auth,
    payload: {
      idempotencyKey: 'key-1',
      recipient: 'user@example.com',
      channel: 'email',
      templateKey: 'welcome-email',
      data: { name: 'Alice' },
      ...overrides,
    },
  });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('authentication', () => {
  it('rejects requests without an API key', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/notifications' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects requests with a wrong API key', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/notifications',
      headers: { 'x-api-key': 'wrong-key' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('leaves /healthz and /admin public', async () => {
    expect((await server.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const admin = await server.app.inject({ method: 'GET', url: '/admin/' });
    expect(admin.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Notification CRUD
// ---------------------------------------------------------------------------

describe('notifications CRUD', () => {
  it('returns 400 for unknown templateKey', async () => {
    const res = await enqueue({ templateKey: 'no-such-template' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('returns 400 for channel mismatch', async () => {
    await seedTemplate({ key: 'email-tmpl', channel: 'email', body: 'hi {{name}}' });
    const res = await enqueue({ templateKey: 'email-tmpl', channel: 'sms', data: { name: 'X' } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for missing placeholder data', async () => {
    await seedTemplate(); // body has {{name}}
    const res = await enqueue({ data: {} }); // missing 'name'
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.detail).toContain('name');
  });

  it('creates a notification and returns 201 created:true', async () => {
    await seedTemplate();
    const res = await enqueue();
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('queued');
    expect(body.created).toBe(true);
    expect(body.idempotencyKey).toBe('key-1');
  });

  it('idempotent enqueue: second POST returns 200 created:false, only one DB row', async () => {
    await seedTemplate();
    const res1 = await enqueue();
    expect(res1.statusCode).toBe(201);

    const res2 = await enqueue(); // same idempotencyKey 'key-1'
    expect(res2.statusCode).toBe(200);
    const body2 = res2.json();
    expect(body2.created).toBe(false);
    expect(body2.id).toBe(res1.json().id);

    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(1);
  });

  it('GET /notifications/:id returns 404 for missing', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/notifications/99999', headers: auth });
    expect(res.statusCode).toBe(404);
  });

  it('GET /notifications lists newest-first', async () => {
    await seedTemplate();
    await enqueue({ idempotencyKey: 'k1' });
    await enqueue({ idempotencyKey: 'k2' });
    const res = await server.app.inject({ method: 'GET', url: '/notifications', headers: auth });
    expect(res.statusCode).toBe(200);
    const items = res.json() as Array<{ id: number }>;
    expect(items).toHaveLength(2);
    expect(items[0]!.id).toBeGreaterThan(items[1]!.id);
  });
});

// ---------------------------------------------------------------------------
// Templates CRUD
// ---------------------------------------------------------------------------

describe('templates CRUD', () => {
  it('creates a template', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/templates',
      headers: auth,
      payload: { key: 'test-tmpl', channel: 'email', subject: 'Hi', body: 'Hello {{name}}' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().key).toBe('test-tmpl');
  });

  it('rejects duplicate template key with 409', async () => {
    await seedTemplate({ key: 'dup', body: 'Hi' });
    const res = await server.app.inject({
      method: 'POST',
      url: '/templates',
      headers: auth,
      payload: { key: 'dup', channel: 'sms', body: 'Hi' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('GET /templates/:key returns 404 for missing', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/templates/no-such',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /templates/:key updates existing', async () => {
    await seedTemplate({ key: 'updatable', body: 'old body {{name}}' });
    const res = await server.app.inject({
      method: 'PUT',
      url: '/templates/updatable',
      headers: auth,
      payload: { channel: 'email', body: 'new body' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().body).toBe('new body');
  });
});

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

describe('preferences', () => {
  it('upserts and reads a preference', async () => {
    const putRes = await server.app.inject({
      method: 'PUT',
      url: '/preferences',
      headers: auth,
      payload: {
        recipient: 'alice@example.com',
        channel: 'email',
        optedOut: true,
      },
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json().optedOut).toBe(true);

    const getRes = await server.app.inject({
      method: 'GET',
      url: '/preferences?recipient=alice%40example.com&channel=email',
      headers: auth,
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().optedOut).toBe(true);
  });

  it('GET /preferences returns 404 for missing', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/preferences?recipient=nobody&channel=sms',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DLQ
// ---------------------------------------------------------------------------

describe('dlq', () => {
  it('GET /dlq returns empty array by default', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/dlq', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(0);
  });

  it('POST /dlq/:id/replay returns 404 for missing', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/dlq/99999/replay',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /dlq/:id/replay returns 400 if not dead', async () => {
    await seedTemplate();
    const created = await enqueue();
    const id = created.json().id as number;

    const res = await server.app.inject({
      method: 'POST',
      url: `/dlq/${id}/replay`,
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Worker unit tests (processNotification directly with mock provider)
// ---------------------------------------------------------------------------

describe('processNotification unit tests', () => {
  let mockQueue: Queue<NotificationJobData>;

  beforeEach(() => {
    mockQueue = createTestQueue(cfg.REDIS_URL, 'proc');
  });

  afterEach(async () => {
    await obliterateQueue(mockQueue);
  });

  it('already-terminal notifications return already-terminal without calling provider', async () => {
    await seedTemplate();
    const [notif] = await db.insert(notifications).values({
      idempotencyKey: 'idem-1',
      recipient: 'u@x.com',
      channel: 'email',
      templateKey: 'welcome-email',
      data: { name: 'Bob' },
      status: 'sent',
    }).returning();

    const sendSpy = vi.fn();
    const provider: ChannelProvider = { send: sendSpy };

    const result = await processNotification(
      { db, provider, queue: mockQueue },
      notif!.id,
    );

    expect(result.kind).toBe('already-terminal');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('opt-out: skips provider call when recipient opted out', async () => {
    await seedTemplate();
    await db.insert(preferences).values({
      recipient: 'u@x.com',
      channel: 'email',
      optedOut: true,
    });
    const [notif] = await db.insert(notifications).values({
      idempotencyKey: 'optout-1',
      recipient: 'u@x.com',
      channel: 'email',
      templateKey: 'welcome-email',
      data: { name: 'Carol' },
      status: 'queued',
    }).returning();

    const sendSpy = vi.fn();
    const provider: ChannelProvider = { send: sendSpy };

    const result = await processNotification(
      { db, provider, queue: mockQueue },
      notif!.id,
    );

    expect(result.kind).toBe('skipped');
    expect(sendSpy).not.toHaveBeenCalled();

    const [updated] = await db.select().from(notifications).where(eq(notifications.id, notif!.id));
    expect(updated!.status).toBe('skipped');
  });

  it('quiet hours: defers when now is inside quiet window', async () => {
    await seedTemplate();
    // 00:00–23:59 = the entire day is "quiet" so any time is in the window.
    await db.insert(preferences).values({
      recipient: 'u@x.com',
      channel: 'email',
      optedOut: false,
      quietStart: '00:00',
      quietEnd: '23:59',
      timezone: 'UTC',
    });
    const [notif] = await db.insert(notifications).values({
      idempotencyKey: 'quiet-1',
      recipient: 'u@x.com',
      channel: 'email',
      templateKey: 'welcome-email',
      data: { name: 'Dave' },
      status: 'queued',
    }).returning();

    const sendSpy = vi.fn();
    const provider: ChannelProvider = { send: sendSpy };
    const fixedNow = new Date('2024-01-15T10:00:00Z');

    const result = await processNotification(
      { db, provider, queue: mockQueue, now: () => fixedNow },
      notif!.id,
    );

    expect(result.kind).toBe('deferred');
    expect(sendSpy).not.toHaveBeenCalled();

    const [updated] = await db.select().from(notifications).where(eq(notifications.id, notif!.id));
    expect(updated!.status).toBe('deferred');
    expect(updated!.scheduledFor).not.toBeNull();
    expect(updated!.scheduledFor!.getTime()).toBeGreaterThan(fixedNow.getTime());
  });

  it('happy path: calls provider with rendered body and marks sent', async () => {
    await seedTemplate({
      key: 'happy-tmpl',
      channel: 'email',
      subject: 'Hi {{name}}',
      body: 'Dear {{name}}, welcome!',
    });
    const [notif] = await db.insert(notifications).values({
      idempotencyKey: 'happy-1',
      recipient: 'u@x.com',
      channel: 'email',
      templateKey: 'happy-tmpl',
      data: { name: 'Eve' },
      status: 'queued',
    }).returning();

    const sent: RenderedMessage[] = [];
    const provider: ChannelProvider = {
      send: async (msg) => { sent.push(msg); },
    };

    const result = await processNotification(
      { db, provider, queue: mockQueue },
      notif!.id,
    );

    expect(result.kind).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe('Dear Eve, welcome!');
    expect(sent[0]!.subject).toBe('Hi Eve');
    expect(sent[0]!.deliveryId).toBe('happy-1'); // stable idempotency token for the provider

    const [updated] = await db.select().from(notifications).where(eq(notifications.id, notif!.id));
    expect(updated!.status).toBe('sent');
    expect(updated!.sentAt).not.toBeNull();
    expect(updated!.attempts).toBe(1);
  });

  it('provider error: increments attempts, sets lastError, resets to queued, re-throws', async () => {
    await seedTemplate({ key: 'fail-tmpl', channel: 'email', body: 'Hi {{name}}' });
    const [notif] = await db.insert(notifications).values({
      idempotencyKey: 'fail-1',
      recipient: 'u@x.com',
      channel: 'email',
      templateKey: 'fail-tmpl',
      data: { name: 'Frank' },
      status: 'queued',
    }).returning();

    const provider: ChannelProvider = {
      send: async () => { throw new Error('provider down'); },
    };

    await expect(
      processNotification({ db, provider, queue: mockQueue }, notif!.id)
    ).rejects.toThrow('provider down');

    const [updated] = await db.select().from(notifications).where(eq(notifications.id, notif!.id));
    expect(updated!.status).toBe('queued');
    expect(updated!.lastError).toBe('provider down');
    expect(updated!.attempts).toBe(1);
  });

  it('final-attempt provider failure dead-letters durably in-processor (no throw)', async () => {
    await seedTemplate({ key: 'dead-tmpl', channel: 'email', body: 'Hi {{name}}' });
    const [notif] = await db.insert(notifications).values({
      idempotencyKey: 'dead-now',
      recipient: 'u@x.com',
      channel: 'email',
      templateKey: 'dead-tmpl',
      data: { name: 'Ivy' },
      status: 'queued',
      maxAttempts: 1, // first failure is the last
    }).returning();

    const provider: ChannelProvider = { send: async () => { throw new Error('boom'); } };
    // On the final attempt the processor must NOT throw — it durably marks 'dead' and returns.
    const result = await processNotification({ db, provider, queue: mockQueue }, notif!.id);
    expect(result.kind).toBe('dead');

    const [updated] = await db.select().from(notifications).where(eq(notifications.id, notif!.id));
    expect(updated!.status).toBe('dead');
    expect(updated!.lastError).toBe('boom');
    expect(updated!.attempts).toBe(1);
  });

  it('atomic claim: concurrent processing of the same notification sends exactly once', async () => {
    await seedTemplate({ key: 'race-tmpl', channel: 'email', body: 'Hi {{name}}' });
    const [notif] = await db.insert(notifications).values({
      idempotencyKey: 'race-1',
      recipient: 'u@x.com',
      channel: 'email',
      templateKey: 'race-tmpl',
      data: { name: 'Jo' },
      status: 'queued',
    }).returning();

    let calls = 0;
    const provider: ChannelProvider = { send: async () => { calls++; } };

    // Fire two processors at the same time; the atomic claim must let only one through.
    const results = await Promise.all([
      processNotification({ db, provider, queue: mockQueue }, notif!.id),
      processNotification({ db, provider, queue: mockQueue }, notif!.id),
    ]);

    expect(calls).toBe(1); // provider invoked exactly once despite concurrency
    expect(results.filter((r) => r.kind === 'sent')).toHaveLength(1);
    const loser = results.find((r) => r.kind !== 'sent')!;
    expect(['not-claimed', 'already-terminal']).toContain(loser.kind);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: real BullMQ Queue + Worker
// ---------------------------------------------------------------------------

describe('end-to-end BullMQ flow', () => {
  it('enqueue → worker drains → status becomes sent, provider called once', async () => {
    const e2eQueue = createTestQueue(cfg.REDIS_URL, 'e2e');
    const queueName = (e2eQueue as unknown as { name: string }).name;

    const sentMessages: RenderedMessage[] = [];
    const provider: ChannelProvider = {
      send: async (msg) => { sentMessages.push(msg); },
    };

    // Build a separate server with this queue to enqueue into it.
    const e2eServer = await buildServer(cfg, { db, queue: e2eQueue });

    // Start a worker on the same queue name.
    const worker = new Worker<NotificationJobData>(
      queueName,
      async (job) => {
        await processNotification(
          { db, provider, queue: e2eQueue, retryBaseMs: 10 },
          job.data.notificationId,
        );
      },
      { connection: parseRedisUrl(cfg.REDIS_URL) },
    );

    try {
      await seedTemplate({ key: 'e2e-tmpl', channel: 'email', body: 'Hi {{name}}' });

      const res = await e2eServer.app.inject({
        method: 'POST',
        url: '/notifications',
        headers: auth,
        payload: {
          idempotencyKey: 'e2e-key',
          recipient: 'e2e@example.com',
          channel: 'email',
          templateKey: 'e2e-tmpl',
          data: { name: 'George' },
        },
      });
      expect(res.statusCode).toBe(201);
      const notifId = res.json().id as number;

      // Poll until status is 'sent' (up to 5s).
      const start = Date.now();
      let status = '';
      while (Date.now() - start < 5000) {
        const [row] = await db.select().from(notifications).where(eq(notifications.id, notifId));
        status = row?.status ?? '';
        if (status === 'sent') break;
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(status).toBe('sent');
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]!.body).toContain('George');
    } finally {
      await worker.close();
      await e2eServer.close();
      await obliterateQueue(e2eQueue);
    }
  });

  it('retry → DLQ: provider always fails, notifications becomes dead after exhausting maxAttempts', async () => {
    const dlqQueue = createTestQueue(cfg.REDIS_URL, 'dlq-e2e');

    let callCount = 0;
    const provider: ChannelProvider = {
      send: async () => {
        callCount++;
        throw new Error('always fails');
      },
    };

    const dlqServer = await buildServer(cfg, { db, queue: dlqQueue });

    // Use startWorker (with the failed handler for DLQ).
    const { worker, close: closeWorker } = startWorker(
      { redisUrl: cfg.REDIS_URL, retryBaseMs: 10 },
      { db, provider, queue: dlqQueue },
    );

    try {
      await seedTemplate({ key: 'dlq-tmpl', channel: 'email', body: 'Hi {{name}}' });

      const res = await dlqServer.app.inject({
        method: 'POST',
        url: '/notifications',
        headers: auth,
        payload: {
          idempotencyKey: 'dlq-key',
          recipient: 'dlq@example.com',
          channel: 'email',
          templateKey: 'dlq-tmpl',
          data: { name: 'Henry' },
          maxAttempts: 2,
        },
      });
      expect(res.statusCode).toBe(201);
      const notifId = res.json().id as number;

      // Poll until status is 'dead' (up to 15s — backoff is tiny: 10ms).
      const start = Date.now();
      let status = '';
      while (Date.now() - start < 15000) {
        const [row] = await db.select().from(notifications).where(eq(notifications.id, notifId));
        status = row?.status ?? '';
        if (status === 'dead') break;
        await new Promise((r) => setTimeout(r, 200));
      }

      expect(status).toBe('dead');
      expect(callCount).toBe(2); // exactly maxAttempts times

      const [dead] = await db.select().from(notifications).where(eq(notifications.id, notifId));
      expect(dead!.lastError).toBe('always fails');

      // Verify replay resets to queued.
      const replayRes = await dlqServer.app.inject({
        method: 'POST',
        url: `/dlq/${notifId}/replay`,
        headers: auth,
      });
      expect(replayRes.statusCode).toBe(200);
      expect(replayRes.json().status).toBe('queued');
    } finally {
      await closeWorker();
      await dlqServer.close();
      await obliterateQueue(dlqQueue);
    }
  });
});

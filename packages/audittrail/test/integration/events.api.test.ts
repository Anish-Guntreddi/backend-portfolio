import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client.ts';
import { buildServer, type BuiltServer } from '../../src/server.ts';
import { resetDb, testConfig } from '../helpers.ts';

const cfg = testConfig();
const { db, pool } = createDb(cfg.DATABASE_URL);
const auth = { 'x-api-key': cfg.API_KEY };
let server: BuiltServer;

beforeAll(async () => {
  server = await buildServer(cfg, { db });
  await server.app.ready();
});
afterAll(async () => {
  await server.app.close();
  await pool.end();
});
beforeEach(async () => {
  await resetDb(db);
});

function ingest(payload: Record<string, unknown>) {
  return server.app.inject({ method: 'POST', url: '/events', headers: auth, payload });
}

describe('events API', () => {
  it('appends an event and returns its hash linkage', async () => {
    const res = await ingest({ actor: 'alice', action: 'login.success', resource: 'auth' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBe(1);
    expect(body.prevHash).toBe('0'.repeat(64));
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/);

    const second = await ingest({ actor: 'bob', action: 'logout', resource: 'auth' });
    expect(second.json().prevHash).toBe(body.hash); // chains to the first event
  });

  it('requires a valid API key', async () => {
    expect((await server.app.inject({ method: 'GET', url: '/events' })).statusCode).toBe(401);
    expect(
      (await server.app.inject({ method: 'GET', url: '/events', headers: { 'x-api-key': 'nope' } }))
        .statusCode,
    ).toBe(401);
  });

  it('leaves /healthz and the admin dashboard public', async () => {
    expect((await server.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const admin = await server.app.inject({ method: 'GET', url: '/admin/' });
    expect(admin.statusCode).toBe(200);
  });

  it('rejects malformed and unknown-field bodies with 400', async () => {
    expect((await ingest({ actor: 'a' })).statusCode).toBe(400); // missing action/resource
    expect(
      (await ingest({ actor: 'a', action: 'x', resource: 'r', surprise: 1 })).statusCode,
    ).toBe(400); // strict() rejects unknown keys
    expect(
      (await ingest({ actor: 'a', action: 'x', resource: 'r', ip: 'not-an-ip' })).statusCode,
    ).toBe(400);
  });

  it('filters by actor and is immune to SQL injection in filter values', async () => {
    await ingest({ actor: 'alice', action: 'login.success', resource: 'auth' });
    await ingest({ actor: 'bob', action: 'logout', resource: 'auth' });

    const filtered = await server.app.inject({
      method: 'GET',
      url: '/events?actor=alice',
      headers: auth,
    });
    expect(filtered.statusCode).toBe(200);
    const items = filtered.json().items;
    expect(items).toHaveLength(1);
    expect(items[0].actor).toBe('alice');

    // A classic injection payload is treated as a literal value — zero matches, no SQL executed.
    const evil = "'; DROP TABLE events;--";
    const injected = await server.app.inject({
      method: 'GET',
      url: `/events?actor=${encodeURIComponent(evil)}`,
      headers: auth,
    });
    expect(injected.statusCode).toBe(200);
    expect(injected.json().items).toHaveLength(0);

    // The table still exists and still has its two rows.
    const all = await server.app.inject({ method: 'GET', url: '/events', headers: auth });
    expect(all.json().items).toHaveLength(2);
  });

  it('paginates with a keyset cursor', async () => {
    for (let i = 0; i < 3; i++) await ingest({ actor: `u${i}`, action: 'x', resource: 'r' });

    const page1 = await server.app.inject({ method: 'GET', url: '/events?limit=2', headers: auth });
    const b1 = page1.json();
    expect(b1.items).toHaveLength(2);
    expect(b1.nextCursor).toBeTypeOf('number');

    const page2 = await server.app.inject({
      method: 'GET',
      url: `/events?limit=2&cursor=${b1.nextCursor}`,
      headers: auth,
    });
    const b2 = page2.json();
    expect(b2.items).toHaveLength(1);
    expect(b2.nextCursor).toBeNull();
  });

  it('fetches a single event and 404s on a missing id', async () => {
    await ingest({ actor: 'alice', action: 'login', resource: 'auth' });
    const ok = await server.app.inject({ method: 'GET', url: '/events/1', headers: auth });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().id).toBe(1);

    const missing = await server.app.inject({ method: 'GET', url: '/events/999', headers: auth });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toContain('application/problem+json');
  });

  it('verifies the chain through the API', async () => {
    await ingest({ actor: 'alice', action: 'login', resource: 'auth' });
    await ingest({ actor: 'bob', action: 'logout', resource: 'auth' });
    const res = await server.app.inject({ method: 'GET', url: '/verify', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ valid: true, checkedCount: 2 });
  });

  it('exports filtered events as JSON and CSV', async () => {
    await ingest({ actor: 'alice', action: 'login', resource: 'auth', metadata: { a: 1 } });
    await ingest({ actor: 'bob', action: 'logout', resource: 'auth' });

    const json = await server.app.inject({
      method: 'GET',
      url: '/events/export?format=json&actor=alice',
      headers: auth,
    });
    expect(json.statusCode).toBe(200);
    const arr = json.json();
    expect(Array.isArray(arr)).toBe(true);
    expect(arr).toHaveLength(1);
    expect(arr[0].actor).toBe('alice');

    const csv = await server.app.inject({
      method: 'GET',
      url: '/events/export?format=csv',
      headers: auth,
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.body.split('\r\n');
    expect(lines[0]).toBe(
      'id,actor,action,resource,occurred_at,recorded_at,ip,metadata,prev_hash,hash',
    );
    expect(lines).toHaveLength(3); // header + 2 rows
  });
});

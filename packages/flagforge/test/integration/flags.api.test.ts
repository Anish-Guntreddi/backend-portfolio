import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client.ts';
import { NullCache } from '../../src/cache.ts';
import { buildServer, type BuiltServer } from '../../src/server.ts';
import { resetDb, testConfig } from '../helpers.ts';
import type { FlagDefinition } from '@portfolio/flagforge-core';

const cfg = testConfig();
const { db, pool } = createDb(cfg.DATABASE_URL);
const cache = new NullCache();
const auth = { 'x-api-key': cfg.API_KEY };

let server: BuiltServer;

beforeAll(async () => {
  server = await buildServer(cfg, { db, cache });
  await server.app.ready();
});

afterAll(async () => {
  await server.app.close();
  await pool.end();
});

beforeEach(async () => {
  await resetDb(db);
});

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

const boolFlag: FlagDefinition = {
  key: 'feature-x',
  type: 'boolean',
  enabled: true,
  variations: [
    { key: 'off', value: false },
    { key: 'on', value: true },
  ],
  offVariation: 'off',
  fallthrough: { kind: 'fixed', variation: 'on' },
  targets: [],
  rules: [],
  salt: 'feature-x-v1',
};

const rolloutFlag: FlagDefinition = {
  key: 'rollout-100',
  type: 'boolean',
  enabled: true,
  variations: [
    { key: 'control', value: false },
    { key: 'treatment', value: true },
  ],
  offVariation: 'control',
  fallthrough: {
    kind: 'rollout',
    weights: [
      { variation: 'control', weight: 0 },
      { variation: 'treatment', weight: 100 },
    ],
  },
  targets: [],
  rules: [],
  salt: 'rollout-v1',
};

const targetedFlag: FlagDefinition = {
  key: 'targeted-flag',
  type: 'string',
  enabled: true,
  variations: [
    { key: 'default', value: 'default' },
    { key: 'vip', value: 'vip-experience' },
  ],
  offVariation: 'default',
  fallthrough: { kind: 'fixed', variation: 'default' },
  targets: [{ variation: 'vip', values: ['vip-user-1', 'vip-user-2'] }],
  rules: [],
  salt: 'targeted-v1',
};

async function createFlag(flag: FlagDefinition) {
  return server.app.inject({
    method: 'POST',
    url: '/flags',
    headers: auth,
    payload: flag,
  });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('authentication', () => {
  it('rejects requests without an API key', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/flags' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects requests with a wrong API key', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/flags',
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
// CRUD lifecycle
// ---------------------------------------------------------------------------

describe('CRUD lifecycle', () => {
  it('creates a flag and returns 201', async () => {
    const res = await createFlag(boolFlag);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.key).toBe('feature-x');
    expect(body.type).toBe('boolean');
    expect(body.enabled).toBe(true);
    expect(body.version).toBe(1);
    expect(body.archived).toBe(false);
    expect(body.createdAt).toBeTypeOf('string');
    expect(body.updatedAt).toBeTypeOf('string');
  });

  it('get by key returns the flag', async () => {
    await createFlag(boolFlag);
    const res = await server.app.inject({
      method: 'GET',
      url: '/flags/feature-x',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().key).toBe('feature-x');
  });

  it('get by key returns 404 for a missing flag', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/flags/does-not-exist',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('list returns all non-archived flags', async () => {
    await createFlag(boolFlag);
    await createFlag(rolloutFlag);
    const res = await server.app.inject({ method: 'GET', url: '/flags', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
  });

  it('update replaces the definition and bumps version', async () => {
    await createFlag(boolFlag);
    const updated = { ...boolFlag, enabled: false };
    const res = await server.app.inject({
      method: 'PUT',
      url: '/flags/feature-x',
      headers: auth,
      payload: updated,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(false);
    expect(body.version).toBe(2);
  });

  it('toggle enabled via PATCH and bumps version', async () => {
    await createFlag(boolFlag);
    const res = await server.app.inject({
      method: 'PATCH',
      url: '/flags/feature-x',
      headers: auth,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(false);
    expect(body.version).toBe(2);
  });

  it('archive via DELETE returns 204 and hides from list', async () => {
    await createFlag(boolFlag);
    const del = await server.app.inject({
      method: 'DELETE',
      url: '/flags/feature-x',
      headers: auth,
    });
    expect(del.statusCode).toBe(204);

    // Should not appear in the default list
    const list = await server.app.inject({ method: 'GET', url: '/flags', headers: auth });
    expect(list.json()).toHaveLength(0);

    // Should appear when includeArchived=true
    const listAll = await server.app.inject({
      method: 'GET',
      url: '/flags?includeArchived=true',
      headers: auth,
    });
    expect(listAll.json()).toHaveLength(1);
    expect(listAll.json()[0].archived).toBe(true);
  });

  it('returns audit records with correct actions and newest-first order', async () => {
    await createFlag(boolFlag);
    await server.app.inject({
      method: 'PATCH',
      url: '/flags/feature-x',
      headers: auth,
      payload: { enabled: false },
    });
    await server.app.inject({
      method: 'DELETE',
      url: '/flags/feature-x',
      headers: auth,
    });

    const res = await server.app.inject({
      method: 'GET',
      url: '/flags/feature-x/audit',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const audit = res.json() as Array<{ action: string }>;
    expect(audit).toHaveLength(3);
    // Newest first
    expect(audit[0]!.action).toBe('archived');
    expect(audit[1]!.action).toBe('toggled');
    expect(audit[2]!.action).toBe('created');
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('validation', () => {
  it('rejects a flag referencing an unknown offVariation', async () => {
    const bad = { ...boolFlag, offVariation: 'nonexistent' };
    const res = await createFlag(bad);
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('rejects a flag referencing an unknown variation in fallthrough', async () => {
    const bad = {
      ...boolFlag,
      fallthrough: { kind: 'fixed' as const, variation: 'ghost' },
    };
    const res = await createFlag(bad);
    expect(res.statusCode).toBe(400);
  });

  it('rejects a duplicate flag key with 409', async () => {
    await createFlag(boolFlag);
    const res = await createFlag(boolFlag);
    expect(res.statusCode).toBe(409);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('rejects a boolean flag whose variation value is not a boolean', async () => {
    const bad: FlagDefinition = {
      ...boolFlag,
      variations: [
        { key: 'off', value: 'false' }, // string, not boolean
        { key: 'on', value: 'true' },
      ],
    };
    const res = await createFlag(bad);
    expect(res.statusCode).toBe(400);
  });

  it('rejects a number flag whose variation value is not a number', async () => {
    const bad: FlagDefinition = {
      key: 'num-flag',
      type: 'number',
      enabled: true,
      variations: [
        { key: 'low', value: 'not-a-number' as unknown as number },
        { key: 'high', value: 100 },
      ],
      offVariation: 'low',
      fallthrough: { kind: 'fixed', variation: 'high' },
      targets: [],
      rules: [],
      salt: 'num-v1',
    };
    const res = await createFlag(bad);
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

describe('evaluation', () => {
  it('disabled flag returns off variation with reason OFF', async () => {
    const disabledFlag = { ...boolFlag, key: 'disabled-flag', enabled: false };
    await createFlag(disabledFlag);

    const res = await server.app.inject({
      method: 'POST',
      url: '/evaluate',
      headers: auth,
      payload: {
        flagKey: 'disabled-flag',
        context: { key: 'user-1', attributes: {} },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.value).toBe(false);
    expect(body.reason.kind).toBe('OFF');
    expect(body.flagVersion).toBe(1);
  });

  it('100% rollout returns the rolled variation', async () => {
    await createFlag(rolloutFlag);

    const res = await server.app.inject({
      method: 'POST',
      url: '/evaluate',
      headers: auth,
      payload: {
        flagKey: 'rollout-100',
        context: { key: 'any-user', attributes: {} },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.value).toBe(true);
    expect(body.variation).toBe('treatment');
  });

  it('targeted user gets target variation', async () => {
    await createFlag(targetedFlag);

    const res = await server.app.inject({
      method: 'POST',
      url: '/evaluate',
      headers: auth,
      payload: {
        flagKey: 'targeted-flag',
        context: { key: 'vip-user-1', attributes: {} },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.value).toBe('vip-experience');
    expect(body.reason.kind).toBe('TARGET_MATCH');
  });

  it('missing flag returns FLAG_NOT_FOUND with defaultValue and 200', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/evaluate',
      headers: auth,
      payload: {
        flagKey: 'does-not-exist',
        context: { key: 'user-1', attributes: {} },
        defaultValue: false,
      },
    });
    // Must be 200, not 404
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.value).toBe(false);
    expect(body.variation).toBeNull();
    expect(body.reason.kind).toBe('FLAG_NOT_FOUND');
    expect(body.flagVersion).toBeNull();
  });

  it('missing flag with no defaultValue returns null', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/evaluate',
      headers: auth,
      payload: {
        flagKey: 'ghost',
        context: { key: 'u', attributes: {} },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().value).toBeNull();
  });

  it('archived flag is treated as missing (FLAG_NOT_FOUND)', async () => {
    await createFlag(boolFlag);
    await server.app.inject({
      method: 'DELETE',
      url: '/flags/feature-x',
      headers: auth,
    });

    const res = await server.app.inject({
      method: 'POST',
      url: '/evaluate',
      headers: auth,
      payload: {
        flagKey: 'feature-x',
        context: { key: 'u', attributes: {} },
        defaultValue: 'fallback',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reason.kind).toBe('FLAG_NOT_FOUND');
    expect(res.json().value).toBe('fallback');
  });

  it('evaluate/all returns all non-archived flags evaluated for a context', async () => {
    await createFlag(boolFlag);
    await createFlag(rolloutFlag);
    // Archive one flag
    await server.app.inject({ method: 'DELETE', url: '/flags/rollout-100', headers: auth });

    const res = await server.app.inject({
      method: 'POST',
      url: '/evaluate/all',
      headers: auth,
      payload: { context: { key: 'user-1', attributes: {} } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body.flags)).toHaveLength(1);
    expect(body.flags['feature-x']).toBeDefined();
    expect(body.flags['rollout-100']).toBeUndefined();
  });
});

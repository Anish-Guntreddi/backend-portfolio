import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createClient } from '../src/client.ts';
import {
  evaluate,
  type FlagDefinition,
  type EvalContext,
} from '@portfolio/flagforge-core';

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

/** A simple boolean flag with a targeted user and a 50% rollout for everyone else. */
const booleanFlag: FlagDefinition = {
  key: 'show-banner',
  type: 'boolean',
  enabled: true,
  salt: 'abc123',
  variations: [
    { key: 'on', value: true },
    { key: 'off', value: false },
  ],
  offVariation: 'off',
  fallthrough: {
    kind: 'rollout',
    weights: [
      { variation: 'on', weight: 50 },
      { variation: 'off', weight: 50 },
    ],
  },
  targets: [{ variation: 'on', values: ['vip-user'] }],
  rules: [],
};

/** A string flag with a rule matching users in the "beta" segment. */
const stringFlag: FlagDefinition = {
  key: 'theme',
  type: 'string',
  enabled: true,
  salt: 'salt-theme',
  variations: [
    { key: 'dark', value: 'dark' },
    { key: 'light', value: 'light' },
  ],
  offVariation: 'light',
  fallthrough: { kind: 'fixed', variation: 'light' },
  targets: [],
  rules: [
    {
      id: 'beta-rule',
      clauses: [{ attribute: 'segment', op: 'in', values: ['beta'], negate: false }],
      serve: { kind: 'fixed', variation: 'dark' },
    },
  ],
};

/** FlagOutput shape: FlagDefinition + server-only fields. */
function asFlagOutput(flag: FlagDefinition, extra: Record<string, unknown> = {}) {
  return {
    ...flag,
    version: 1,
    archived: false,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...extra,
  };
}

/** Build a fake fetch that returns a JSON array of FlagOutput objects for GET /flags. */
function makeFakeFetch(flags: FlagDefinition[], extra: Record<string, unknown> = {}) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (urlStr.endsWith('/flags')) {
      return new Response(JSON.stringify(flags.map((f) => asFlagOutput(f, extra))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (urlStr.endsWith('/evaluate')) {
      return new Response(JSON.stringify({ value: true, variation: 'on', reason: { kind: 'FALLTHROUGH', inRollout: false } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('Not Found', { status: 404 });
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// 1. Parity test — SDK local evaluation equals @portfolio/flagforge-core directly
// ---------------------------------------------------------------------------

describe('parity: local SDK evaluation matches evaluate() from flagforge-core', () => {
  const contexts: EvalContext[] = [
    { key: 'vip-user', attributes: {} },
    { key: 'regular-user', attributes: {} },
    { key: 'beta-tester', attributes: { segment: 'beta' } },
    { key: 'another-user', attributes: { segment: 'regular' } },
    // many more to stress the bucketing
    ...Array.from({ length: 10 }, (_, i) => ({ key: `user-${i}`, attributes: {} })),
  ];

  it('boolean flag: SDK variation() matches evaluate() for all test contexts', async () => {
    const fakeFetch = makeFakeFetch([booleanFlag]);
    const client = createClient({ baseUrl: 'http://localhost', apiKey: 'test', fetch: fakeFetch });
    await client.bootstrap();

    for (const ctx of contexts) {
      const sdkValue = client.variation('show-banner', ctx, null);
      const coreResult = evaluate(booleanFlag, ctx);
      expect(sdkValue).toEqual(coreResult.value);
    }
  });

  it('boolean flag: SDK evaluateDetail().variation matches evaluate() for all test contexts', async () => {
    const fakeFetch = makeFakeFetch([booleanFlag]);
    const client = createClient({ baseUrl: 'http://localhost', apiKey: 'test', fetch: fakeFetch });
    await client.bootstrap();

    for (const ctx of contexts) {
      const sdkDetail = client.evaluateDetail('show-banner', ctx, false);
      const coreResult = evaluate(booleanFlag, ctx);
      expect(sdkDetail.value).toEqual(coreResult.value);
      expect(sdkDetail.variation).toEqual(coreResult.variation);
      expect(sdkDetail.reason.kind).toEqual(coreResult.reason.kind);
    }
  });

  it('string flag: SDK variation() matches evaluate() for all test contexts', async () => {
    const fakeFetch = makeFakeFetch([booleanFlag, stringFlag]);
    const client = createClient({ baseUrl: 'http://localhost', apiKey: 'test', fetch: fakeFetch });
    await client.bootstrap();

    for (const ctx of contexts) {
      const sdkValue = client.variation('theme', ctx, 'light');
      const coreResult = evaluate(stringFlag, ctx);
      expect(sdkValue).toEqual(coreResult.value);
    }
  });

  it('disabled flag evaluates to offVariation both locally and via core', async () => {
    const disabledFlag: FlagDefinition = { ...booleanFlag, key: 'disabled-flag', enabled: false };
    const fakeFetch = makeFakeFetch([disabledFlag]);
    const client = createClient({ baseUrl: 'http://localhost', apiKey: 'test', fetch: fakeFetch });
    await client.bootstrap();

    for (const ctx of contexts) {
      const sdkValue = client.variation('disabled-flag', ctx, null);
      const coreResult = evaluate(disabledFlag, ctx);
      expect(sdkValue).toEqual(coreResult.value);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. variation() returns defaultValue for unknown / unloaded flag
// ---------------------------------------------------------------------------

describe('variation() returns defaultValue for missing flags', () => {
  it('returns defaultValue when no flags are loaded', async () => {
    const fakeFetch = makeFakeFetch([]);
    const client = createClient({ baseUrl: 'http://localhost', apiKey: 'test', fetch: fakeFetch });
    await client.bootstrap();

    expect(client.variation('nonexistent', { key: 'user-1', attributes: {} }, 'fallback')).toBe('fallback');
    expect(client.variation('nonexistent', { key: 'user-1', attributes: {} }, 42)).toBe(42);
    expect(client.variation('nonexistent', { key: 'user-1', attributes: {} }, false)).toBe(false);
  });

  it('returns defaultValue before bootstrap() is called', () => {
    const fakeFetch = makeFakeFetch([booleanFlag]);
    const client = createClient({ baseUrl: 'http://localhost', apiKey: 'test', fetch: fakeFetch });
    // NOTE: no bootstrap() call
    expect(client.variation('show-banner', { key: 'vip-user', attributes: {} }, 'sentinel')).toBe('sentinel');
  });

  it('evaluateDetail returns FLAG_NOT_FOUND reason for missing flag', async () => {
    const fakeFetch = makeFakeFetch([]);
    const client = createClient({ baseUrl: 'http://localhost', apiKey: 'test', fetch: fakeFetch });
    await client.bootstrap();

    const result = client.evaluateDetail('missing', { key: 'user', attributes: {} }, 'default');
    expect(result.value).toBe('default');
    expect(result.variation).toBeNull();
    expect((result.reason as { kind: string }).kind).toBe('FLAG_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// 3. allFlags() returns a value for every loaded flag
// ---------------------------------------------------------------------------

describe('allFlags()', () => {
  it('returns an entry for every loaded flag', async () => {
    const fakeFetch = makeFakeFetch([booleanFlag, stringFlag]);
    const client = createClient({ baseUrl: 'http://localhost', apiKey: 'test', fetch: fakeFetch });
    await client.bootstrap();

    const all = client.allFlags({ key: 'some-user', attributes: {} });
    expect(Object.keys(all)).toContain('show-banner');
    expect(Object.keys(all)).toContain('theme');
    expect(typeof all['show-banner']).toBe('boolean');
    expect(typeof all['theme']).toBe('string');
  });

  it('returns empty object when no flags are loaded', async () => {
    const fakeFetch = makeFakeFetch([]);
    const client = createClient({ baseUrl: 'http://localhost', apiKey: 'test', fetch: fakeFetch });
    await client.bootstrap();

    expect(client.allFlags({ key: 'user', attributes: {} })).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 4. evaluateRemote()
// ---------------------------------------------------------------------------

describe('evaluateRemote()', () => {
  it('calls POST /evaluate and returns the server body', async () => {
    const serverResponse = { value: true, variation: 'on', reason: { kind: 'TARGET_MATCH' }, flagVersion: 3 };
    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (urlStr.endsWith('/flags')) {
        return new Response(JSON.stringify([asFlagOutput(booleanFlag)]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (urlStr.endsWith('/evaluate')) {
        // Verify method and headers.
        expect((init as RequestInit).method).toBe('POST');
        const body = JSON.parse((init as RequestInit).body as string) as { flagKey: string; context: EvalContext };
        expect(body.flagKey).toBe('show-banner');
        expect(body.context.key).toBe('user-1');
        return new Response(JSON.stringify(serverResponse), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('Not Found', { status: 404 });
    }) as unknown as typeof fetch;

    const client = createClient({ baseUrl: 'http://localhost', apiKey: 'test-key', fetch: fakeFetch });
    await client.bootstrap();

    const result = await client.evaluateRemote('show-banner', { key: 'user-1', attributes: {} }, false);
    expect(result.value).toBe(true);
    expect(result.variation).toBe('on');
    expect((result.reason as { kind: string }).kind).toBe('TARGET_MATCH');
  });

  it('returns ERROR reason on network failure', async () => {
    const fakeFetch = vi.fn(async (input: string | URL | Request) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (urlStr.endsWith('/flags')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('network error');
    }) as unknown as typeof fetch;

    const client = createClient({ baseUrl: 'http://localhost', apiKey: 'test', fetch: fakeFetch });
    await client.bootstrap();

    const result = await client.evaluateRemote('any-flag', { key: 'user', attributes: {} }, 'sentinel');
    expect(result.value).toBe('sentinel');
    expect(result.variation).toBeNull();
    expect((result.reason as { kind: string }).kind).toBe('ERROR');
  });

  it('returns ERROR reason on non-2xx response', async () => {
    const fakeFetch = vi.fn(async (input: string | URL | Request) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (urlStr.endsWith('/flags')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('Internal Server Error', { status: 500 });
    }) as unknown as typeof fetch;

    const client = createClient({ baseUrl: 'http://localhost', apiKey: 'test', fetch: fakeFetch });
    await client.bootstrap();

    const result = await client.evaluateRemote('any-flag', { key: 'user', attributes: {} }, 'default');
    expect(result.value).toBe('default');
    expect((result.reason as { kind: string }).kind).toBe('ERROR');
  });
});

// ---------------------------------------------------------------------------
// 5. Polling — cache updates when the response changes
// ---------------------------------------------------------------------------

describe('polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes the flag cache when pollIntervalMs elapses', async () => {
    // Phase 1: flag enabled.
    const flagV1: FlagDefinition = { ...booleanFlag, enabled: true };
    // Phase 2: flag disabled.
    const flagV2: FlagDefinition = { ...booleanFlag, enabled: false };

    let callCount = 0;
    const fakeFetch = vi.fn(async () => {
      callCount++;
      const flags = callCount === 1 ? [flagV1] : [flagV2];
      return new Response(JSON.stringify(flags.map((f) => asFlagOutput(f))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = createClient({
      baseUrl: 'http://localhost',
      apiKey: 'test',
      fetch: fakeFetch,
      pollIntervalMs: 1000,
    });

    await client.bootstrap(); // call 1 — flag is enabled
    expect(client.variation('show-banner', { key: 'vip-user', attributes: {} }, false)).toBe(true);

    // Advance time past poll interval.
    await vi.advanceTimersByTimeAsync(1100);
    // call 2 should have run — flag is now disabled.

    expect(client.variation('show-banner', { key: 'vip-user', attributes: {} }, false)).toBe(false);

    client.close();
  });

  it('calls onError when a background poll fails', async () => {
    let callCount = 0;
    const fakeFetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify([asFlagOutput(booleanFlag)]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Subsequent calls fail.
      return new Response('Internal Server Error', { status: 500 });
    }) as unknown as typeof fetch;

    const onError = vi.fn();
    const client = createClient({
      baseUrl: 'http://localhost',
      apiKey: 'test',
      fetch: fakeFetch,
      pollIntervalMs: 500,
      onError,
    });

    await client.bootstrap();
    await vi.advanceTimersByTimeAsync(600);

    expect(onError).toHaveBeenCalledOnce();

    client.close();
  });
});

// ---------------------------------------------------------------------------
// 6. bootstrap() rejects on non-2xx
// ---------------------------------------------------------------------------

describe('bootstrap() error handling', () => {
  it('rejects when GET /flags returns non-2xx', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response('Unauthorized', { status: 401 }),
    ) as unknown as typeof fetch;

    const client = createClient({ baseUrl: 'http://localhost', apiKey: 'bad-key', fetch: fakeFetch });
    await expect(client.bootstrap()).rejects.toThrow();
  });

  it('rejects when fetch throws', async () => {
    const fakeFetch = vi.fn(async () => { throw new Error('Connection refused'); }) as unknown as typeof fetch;
    const client = createClient({ baseUrl: 'http://localhost', apiKey: 'test', fetch: fakeFetch });
    await expect(client.bootstrap()).rejects.toThrow('Connection refused');
  });
});

// ---------------------------------------------------------------------------
// 7. x-api-key header is sent on all requests
// ---------------------------------------------------------------------------

describe('authentication', () => {
  it('sends x-api-key header on bootstrap', async () => {
    const fakeFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.['x-api-key']).toBe('my-secret-key');
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const client = createClient({ baseUrl: 'http://localhost', apiKey: 'my-secret-key', fetch: fakeFetch });
    await client.bootstrap();
  });
});

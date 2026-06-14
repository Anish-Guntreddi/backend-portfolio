import { afterAll, describe, expect, it } from 'vitest';
import { flagDefinitionSchema, type FlagDefinition } from '@portfolio/flagforge-core';
import { RedisCache } from '../../src/cache.ts';

// This suite exercises the REAL Redis version-guard (the Lua scripts), so it only runs when a
// REDIS_URL is provided. The default `npm test` leaves it unset and the suite self-skips.
const REDIS_URL = process.env.REDIS_URL;

// Version floors persist (1h TTL) and can only rise, so each run uses fresh keys to stay isolated.
const RUN = Date.now();
const keyFor = (n: string) => `guard-${RUN}-${n}`;

const defFor = (key: string): FlagDefinition =>
  flagDefinitionSchema.parse({
    key,
    type: 'boolean',
    enabled: true,
    variations: [
      { key: 'on', value: true },
      { key: 'off', value: false },
    ],
    offVariation: 'off',
    fallthrough: { kind: 'fixed', variation: 'on' },
    salt: 's',
  });

describe.skipIf(!REDIS_URL)('RedisCache version guard', () => {
  const cache = new RedisCache(REDIS_URL!);

  afterAll(async () => {
    await cache.close();
  });

  it('stores and reads back a flag with its version', async () => {
    const key = keyFor('rw');
    await cache.set(key, defFor(key), 5);
    const got = await cache.get(key);
    expect(got?.version).toBe(5);
    expect(got?.def.key).toBe(key);
  });

  it('REJECTS a stale write whose version is below the floor (the race fix)', async () => {
    const key = keyFor('race');
    const def = defFor(key);
    // A write at v5 establishes the floor at 5.
    await cache.set(key, def, 5);
    expect((await cache.get(key))?.version).toBe(5);
    // An admin write bumps to v6 and invalidates (raises floor to 6, deletes the value).
    await cache.invalidate(key, 6);
    expect(await cache.get(key)).toBeNull();
    // A slow reader that loaded v5 now tries to repopulate — must be rejected by the floor.
    await cache.set(key, def, 5);
    expect(await cache.get(key)).toBeNull();
    // A fresh fill at v6 is accepted.
    await cache.set(key, def, 6);
    expect((await cache.get(key))?.version).toBe(6);
  });
});

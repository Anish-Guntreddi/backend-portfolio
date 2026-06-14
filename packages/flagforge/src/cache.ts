import Redis from 'ioredis';
import type { FlagDefinition } from '@portfolio/flagforge-core';
import { createLogger } from '@portfolio/shared';

const log = createLogger('flagforge:cache');

const VALUE_TTL = 30; // seconds — single-flag entries + bulk snapshot; short so stale fills self-heal
const FLOOR_TTL = 3600; // seconds — version floors outlive values so a stale fill stays gated
const KEY_PREFIX = 'flagforge:flag:';
const VER_PREFIX = 'flagforge:ver:';
const ALL_KEY = 'flagforge:flags:all';

/** A flag definition together with the version it was cached at. */
export interface CachedFlag {
  def: FlagDefinition;
  version: number;
}

export interface FlagCache {
  get(key: string): Promise<CachedFlag | null>;
  /** Version-guarded write: stores only if `version` >= the key's current version floor. */
  set(key: string, def: FlagDefinition, version: number): Promise<void>;
  /** Raises the key's version floor to `version` and drops the cached value + bulk snapshot. */
  invalidate(key: string, version: number): Promise<void>;
  getAll(): Promise<CachedFlag[] | null>;
  setAll(flags: CachedFlag[]): Promise<void>;
  close(): Promise<void>;
}

/** NullCache: misses everywhere. Used in tests and when REDIS_URL is unset. */
export class NullCache implements FlagCache {
  async get(): Promise<CachedFlag | null> {
    return null;
  }
  async set(): Promise<void> {}
  async invalidate(): Promise<void> {}
  async getAll(): Promise<CachedFlag[] | null> {
    return null;
  }
  async setAll(): Promise<void> {}
  async close(): Promise<void> {}
}

// Store the value and raise the version floor, but ONLY if the incoming version is >= the current
// floor. This closes the cache-aside race: a slow reader that loaded an old definition cannot write
// it back over a fresher state, because a concurrent write will have raised the floor past it.
const SET_IF_FRESH = `
local floor = redis.call('GET', KEYS[2])
if (not floor) or (tonumber(ARGV[2]) >= tonumber(floor)) then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[3]))
  redis.call('SET', KEYS[2], ARGV[2], 'EX', tonumber(ARGV[4]))
  return 1
end
return 0`;

// Raise the floor to the post-write version and delete the cached value + the bulk snapshot.
const INVALIDATE = `
local floor = redis.call('GET', KEYS[2])
if (not floor) or (tonumber(ARGV[1]) >= tonumber(floor)) then
  redis.call('SET', KEYS[2], ARGV[1], 'EX', tonumber(ARGV[2]))
end
redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[3])
return 1`;

/**
 * Redis-backed cache with two guarantees:
 *   - Graceful degradation: every operation is wrapped so a Redis outage turns reads into misses
 *     (caller falls back to Postgres) and writes into warned no-ops. The service never 500s on Redis.
 *   - Version-guarded single-flag path: writes carry the flag's version and a stale fill is rejected,
 *     so an archived/updated flag is never served as live by a racing cache fill (see SET_IF_FRESH).
 * The bulk snapshot (getAll/setAll) is intentionally eventually-consistent: a short TTL plus deletion
 * on every write bound its staleness; the correctness-critical hot path is the single-flag one.
 */
export class RedisCache implements FlagCache {
  private client: Redis;

  constructor(redisUrl: string) {
    this.client = new Redis(redisUrl, {
      // Eager connect with a bounded offline queue: commands issued during the initial connect (or a
      // brief reconnect) queue and flush once ready, so the cache is warm from the first request
      // rather than silently cold. Tight timeouts + capped retries keep a real outage degrading fast
      // (commands fail within ~1s and the caller falls back to Postgres).
      connectTimeout: 2000,
      commandTimeout: 1000,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => (times > 10 ? null : Math.min(times * 100, 2000)),
    });
    this.client.on('error', (err: Error) => log.warn({ err }, 'redis error'));
  }

  async get(key: string): Promise<CachedFlag | null> {
    try {
      const raw = await this.client.get(`${KEY_PREFIX}${key}`);
      return raw ? (JSON.parse(raw) as CachedFlag) : null;
    } catch (err) {
      log.warn({ err, key }, 'cache get failed, returning miss');
      return null;
    }
  }

  async set(key: string, def: FlagDefinition, version: number): Promise<void> {
    try {
      const payload: CachedFlag = { def, version };
      await this.client.eval(
        SET_IF_FRESH,
        2,
        `${KEY_PREFIX}${key}`,
        `${VER_PREFIX}${key}`,
        JSON.stringify(payload),
        String(version),
        String(VALUE_TTL),
        String(FLOOR_TTL),
      );
    } catch (err) {
      log.warn({ err, key }, 'cache set failed, skipping');
    }
  }

  async invalidate(key: string, version: number): Promise<void> {
    try {
      await this.client.eval(
        INVALIDATE,
        3,
        `${KEY_PREFIX}${key}`,
        `${VER_PREFIX}${key}`,
        ALL_KEY,
        String(version),
        String(FLOOR_TTL),
      );
    } catch (err) {
      log.warn({ err, key }, 'cache invalidate failed, skipping');
    }
  }

  async getAll(): Promise<CachedFlag[] | null> {
    try {
      const raw = await this.client.get(ALL_KEY);
      return raw ? (JSON.parse(raw) as CachedFlag[]) : null;
    } catch (err) {
      log.warn({ err }, 'cache getAll failed, returning miss');
      return null;
    }
  }

  async setAll(flags: CachedFlag[]): Promise<void> {
    try {
      await this.client.set(ALL_KEY, JSON.stringify(flags), 'EX', VALUE_TTL);
    } catch (err) {
      log.warn({ err }, 'cache setAll failed, skipping');
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      // best effort
    }
  }
}

/** Factory: Redis when REDIS_URL is configured, else NullCache. */
export function createCache(cfg: { REDIS_URL?: string }): FlagCache {
  return cfg.REDIS_URL ? new RedisCache(cfg.REDIS_URL) : new NullCache();
}

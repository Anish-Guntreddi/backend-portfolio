import {
  evaluate,
  flagDefinitionSchema,
  evalContextSchema,
  type FlagDefinition,
  type EvalContext,
  type EvalResult,
  type EvalReason,
  type JsonValue,
} from '@portfolio/flagforge-core';

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  /** If set, refresh the flag cache on this interval (ms). Default: off. */
  pollIntervalMs?: number;
  /** Injectable fetch for tests. Default: globalThis.fetch. */
  fetch?: typeof fetch;
  /** Called when a background poll fails. */
  onError?: (err: unknown) => void;
}

/** Minimal detail result for local evaluation. */
export interface EvalDetail {
  value: JsonValue;
  variation: string | null;
  reason: EvalReason;
}

/** Shape returned by evaluateRemote — mirrors the server's POST /evaluate body. */
export interface RemoteEvalResult {
  value: JsonValue;
  variation: string | null;
  reason: EvalReason | { kind: 'ERROR'; error: unknown };
}

/** Loose context input accepted by public methods — normalized internally. */
export interface LooseContext {
  key: string;
  attributes?: Record<string, JsonValue>;
}

/**
 * FlagForge client SDK.
 *
 * The canonical usage pattern:
 *   const client = createClient({ baseUrl, apiKey });
 *   await client.bootstrap();           // fetches flag definitions once
 *   const value = client.variation('my-flag', { key: userId }, false);
 */
export interface FlagForgeClient {
  /**
   * Fetch all non-archived flag definitions from the server and cache them.
   * Starts the background poll timer if `pollIntervalMs` was set.
   * Rejects on a non-2xx response so callers know setup failed.
   */
  bootstrap(): Promise<void>;

  /**
   * Synchronous local evaluation. Returns `defaultValue` if the flag is not
   * loaded (not yet bootstrapped, or the key doesn't exist).
   */
  variation<T = JsonValue>(flagKey: string, context: EvalContext | LooseContext, defaultValue: T): T;

  /**
   * Like `variation` but returns the full `{ value, variation, reason }`.
   * Reason is `{ kind: 'FLAG_NOT_FOUND' }` when the flag isn't loaded.
   */
  evaluateDetail(
    flagKey: string,
    context: EvalContext | LooseContext,
    defaultValue: JsonValue,
  ): EvalDetail;

  /**
   * Evaluate every loaded flag for the given context. Returns a key→value map.
   */
  allFlags(context: EvalContext | LooseContext): Record<string, JsonValue>;

  /**
   * Call the server's POST /evaluate endpoint for a server-authoritative result.
   * On network/parse error returns `{ value: defaultValue, variation: null, reason: { kind: 'ERROR', error } }`.
   */
  evaluateRemote(
    flagKey: string,
    context: EvalContext | LooseContext,
    defaultValue: JsonValue,
  ): Promise<RemoteEvalResult>;

  /** Stop the background poll timer. */
  close(): void;
}

/** The not-found reason isn't part of EvalReason in the core but we extend locally. */
type ExtendedReason = EvalReason | { kind: 'FLAG_NOT_FOUND' };

function parseContext(ctx: EvalContext | LooseContext): EvalContext {
  return evalContextSchema.parse({ key: ctx.key, attributes: ctx.attributes ?? {} });
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'content-type': 'application/json',
  };
}

/**
 * Create a FlagForge SDK client. Call `bootstrap()` before using `variation()`.
 */
export function createClient(options: ClientOptions): FlagForgeClient {
  const {
    baseUrl,
    apiKey,
    pollIntervalMs,
    fetch: fetchImpl = globalThis.fetch,
    onError,
  } = options;

  /** Canonical in-memory flag store. */
  const flags = new Map<string, FlagDefinition>();
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const url = (path: string) => `${baseUrl.replace(/\/$/, '')}${path}`;

  async function fetchFlags(): Promise<void> {
    const res = await fetchImpl(url('/flags'), {
      headers: authHeaders(apiKey),
    });
    if (!res.ok) {
      throw new Error(`GET /flags failed: ${res.status} ${res.statusText}`);
    }
    const body: unknown = await res.json();
    if (!Array.isArray(body)) {
      throw new Error('GET /flags did not return an array');
    }
    // Parse each flag via the schema, stripping any extra server-only fields.
    const updated = new Map<string, FlagDefinition>();
    for (const raw of body) {
      const parsed = flagDefinitionSchema.parse(raw);
      updated.set(parsed.key, parsed);
    }
    // Atomic swap — replace the whole map so `variation` never sees a partial state.
    flags.clear();
    for (const [k, v] of updated) flags.set(k, v);
  }

  function localEval(flag: FlagDefinition, ctx: EvalContext): EvalResult {
    return evaluate(flag, ctx);
  }

  return {
    async bootstrap(): Promise<void> {
      await fetchFlags();
      if (pollIntervalMs !== undefined && pollIntervalMs > 0) {
        pollTimer = setInterval(async () => {
          try {
            await fetchFlags();
          } catch (err) {
            onError?.(err);
          }
        }, pollIntervalMs);
        // Allow the Node process to exit even if the timer is running.
        if (typeof pollTimer === 'object' && pollTimer !== null && 'unref' in pollTimer) {
          (pollTimer as NodeJS.Timeout).unref();
        }
      }
    },

    variation<T = JsonValue>(flagKey: string, context: EvalContext | LooseContext, defaultValue: T): T {
      const flag = flags.get(flagKey);
      if (!flag) return defaultValue;
      try {
        const ctx = parseContext(context);
        const result = localEval(flag, ctx);
        return result.value as T;
      } catch {
        return defaultValue;
      }
    },

    evaluateDetail(
      flagKey: string,
      context: EvalContext | LooseContext,
      defaultValue: JsonValue,
    ): EvalDetail {
      const flag = flags.get(flagKey);
      if (!flag) {
        return {
          value: defaultValue,
          variation: null,
          reason: { kind: 'FLAG_NOT_FOUND' } as unknown as EvalReason,
        };
      }
      try {
        const ctx = parseContext(context);
        return localEval(flag, ctx);
      } catch {
        return {
          value: defaultValue,
          variation: null,
          reason: { kind: 'ERROR', error: 'evaluation error' },
        };
      }
    },

    allFlags(context: EvalContext | LooseContext): Record<string, JsonValue> {
      const ctx = parseContext(context);
      const result: Record<string, JsonValue> = {};
      for (const [key, flag] of flags) {
        try {
          result[key] = localEval(flag, ctx).value;
        } catch {
          // skip flags that error
        }
      }
      return result;
    },

    async evaluateRemote(
      flagKey: string,
      context: EvalContext | LooseContext,
      defaultValue: JsonValue,
    ): Promise<RemoteEvalResult> {
      try {
        const ctx = parseContext(context);
        const res = await fetchImpl(url('/evaluate'), {
          method: 'POST',
          headers: authHeaders(apiKey),
          body: JSON.stringify({ flagKey, context: ctx, defaultValue }),
        });
        if (!res.ok) {
          throw new Error(`POST /evaluate failed: ${res.status} ${res.statusText}`);
        }
        const body = (await res.json()) as RemoteEvalResult;
        return body;
      } catch (err) {
        return {
          value: defaultValue,
          variation: null,
          reason: { kind: 'ERROR', error: err },
        };
      }
    },

    close(): void {
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    },
  };
}

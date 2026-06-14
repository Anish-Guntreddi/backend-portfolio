# FlagForge — Feature Flag Service

Deterministic percentage rollouts, targeting rules, a typed evaluation engine, and a per-flag audit
changelog — with **byte-identical decisions on server and client** guaranteed by running the same pure
engine in both places.

> Portfolio goal: correctness-first distributed-systems design — specifically, making the evaluation
> contract provably consistent across a caching layer, a server, and a remote SDK with no per-eval
> network latency.

## What it proves

- **Deterministic, uniform bucketing.** `bucket(seed, key)` maps to a stable value in `[0, 1)` using
  the first 52 bits of a SHA-1 digest (exactly representable as a JS double — no float aliasing).
  For a given `(flag-salt, user-key)` pair, the bucket never changes.
- **Monotonic rollout.** Increasing an on-variation's rollout percentage only **adds** users, never
  evicts an already-included one. The bucket depends only on `(flag salt, key)`, never on weights, so
  re-weighting cannot move a user who was already inside the threshold. Verified by a property test.
- **Server/SDK parity.** The SDK bootstraps flag definitions from the server, then evaluates locally
  using the identical `@portfolio/flagforge-core` engine. A user can't get a different answer from a
  local SDK call than they would have gotten from a server-side call.
- **Version-guarded Redis cache.** A Lua script (`SET_IF_FRESH`) enforces a per-flag version floor:
  a slow reader that loaded an old definition cannot write it back over a fresher state, so an
  archived or updated flag is never served as live by a racing cache fill.
- **Graceful degradation.** Every Redis operation is wrapped; a Redis outage turns reads into cache
  misses (fallback to Postgres) and writes into no-ops. The service never 500s on Redis. Bounded
  fallback latency (~1 s) via tight ioredis timeouts (`commandTimeout: 1000`, `maxRetriesPerRequest: 1`).
- **Total evaluation.** `evaluate()` never throws — a malformed flag resolves to its off variation
  with an `ERROR` reason. `POST /evaluate` never 404s for a missing flag; it returns the caller's
  `defaultValue` with reason `FLAG_NOT_FOUND`.

## Architecture — three packages

```
┌─────────────────────────────────────────────────────────────────┐
│  @portfolio/flagforge-core  (pure, zero I/O)                    │
│  evaluate(flag, context) -> {value, variation, reason}          │
│  bucket(seed, key) -> [0, 1)    pickVariation()                 │
│  Zod schemas   referentialErrors()                              │
└──────────────────────────┬──────────────────────────────────────┘
                           │ shared dependency
           ┌───────────────┴──────────────────┐
           ▼                                  ▼
┌──────────────────────┐          ┌───────────────────────────────┐
│  @portfolio/flagforge │          │  @portfolio/flagforge-sdk      │
│  (service)           │          │  (client SDK)                  │
│                      │          │                                │
│  Fastify + Zod REST  │  HTTP    │  createClient()               │
│  Drizzle + Postgres  │◄─────────│  bootstrap()  (POST /eval/all) │
│  Redis eval-cache    │          │  variation()  (local eval)     │
│  /admin/ dashboard   │          │  background polling            │
└──────────────────────┘          └───────────────────────────────┘
```

**`@portfolio/flagforge-core`** — pure evaluation engine, no I/O, exhaustively tested. Exports
`evaluate`, `bucket`, Zod schemas, and `referentialErrors` (validates that all variation keys
referenced by rules/targets/serve strategies are defined). This is the correctness centerpiece.

**`@portfolio/flagforge`** — the service. Postgres store (Drizzle + `pg`), Redis eval-cache
(`ioredis`), Fastify + Zod REST API, static admin dashboard at `/admin/`.

**`@portfolio/flagforge-sdk`** — bootstraps all flag definitions in one call (`POST /evaluate/all`),
then evaluates every subsequent `variation()` call locally using `@portfolio/flagforge-core`. Zero
per-eval network latency; supports background polling to stay fresh.

## Evaluation waterfall

First match wins (standard flag-system model):

1. **Flag disabled** → off variation (`OFF`)
2. **Explicit target list** — if `context.key` is in any target's `values` → that target's variation (`TARGET_MATCH`)
3. **Targeting rules, in order** — first matching rule's serve strategy (`RULE_MATCH`)
4. **Fallthrough** — the flag's default serve strategy (`FALLTHROUGH`)

Each serve strategy is either **fixed** (a named variation) or a **weighted rollout** (a bucketed percentage split). Weighted rollouts use `bucket(flagKey + "." + salt, bucketByValue)` to place the user in the distribution.

## API surface

All routes require `x-api-key` except `/healthz`, `/docs`, `/openapi.json`, `/admin/*`, and `/`.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/flags` | Create a flag |
| `GET` | `/flags` | List flags (`?includeArchived=true`) |
| `GET` | `/flags/:key` | Get a flag by key |
| `PUT` | `/flags/:key` | Replace a flag definition |
| `PATCH` | `/flags/:key` | Toggle enabled/disabled (`{"enabled": bool}`) |
| `DELETE` | `/flags/:key` | Archive a flag (soft delete) |
| `GET` | `/flags/:key/audit` | Per-flag audit changelog |
| `POST` | `/evaluate` | Evaluate a single flag for a context |
| `POST` | `/evaluate/all` | Evaluate all live flags (SDK bootstrap) |
| `GET` | `/healthz` | Liveness (public) |

Swagger UI at `/docs`. Spec at `/openapi.json` (also committed as [`openapi.json`](openapi.json)).

## Quickstart

```bash
# from the repo root
npm install
docker compose -f packages/flagforge/docker-compose.yml up -d --build
# Postgres on host :5435, Redis on host :6380, API on http://localhost:8081
# Migrations run on container start.
curl localhost:8081/healthz
open http://localhost:8081/admin/   # admin dashboard
open http://localhost:8081/docs     # Swagger UI
```

Running the service locally without the app container:

```bash
docker compose -f packages/flagforge/docker-compose.yml up -d postgres redis
DATABASE_URL=postgres://flagforge:flagforge@localhost:5435/flagforge \
  API_KEY=dev-flagforge-key \
  npx tsx packages/flagforge/src/db/migrate.ts
# then: npm run dev (inside packages/flagforge)
```

## End-to-end curl flow

```bash
API=http://localhost:8081
KEY=dev-flagforge-key

# 1) Create a boolean flag with a 20 % rollout
curl -s -XPOST $API/flags -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{
  "key": "new-checkout",
  "type": "boolean",
  "enabled": true,
  "variations": [
    {"key": "on",  "value": true},
    {"key": "off", "value": false}
  ],
  "offVariation": "off",
  "fallthrough": {
    "kind": "rollout",
    "weights": [{"variation": "on", "weight": 20}, {"variation": "off", "weight": 80}]
  },
  "targets": [],
  "rules": []
}'

# 2) Evaluate for a user
curl -s -XPOST $API/evaluate -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{
  "flagKey": "new-checkout",
  "context": {"key": "user-42", "attributes": {"plan": "pro"}},
  "defaultValue": false
}'
# -> {"flagKey":"new-checkout","value":true,"variation":"on","reason":{"kind":"FALLTHROUGH","inRollout":true},...}

# 3) Missing flag returns defaultValue, not 404
curl -s -XPOST $API/evaluate -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{
  "flagKey": "does-not-exist",
  "context": {"key": "user-1"},
  "defaultValue": false
}'
# -> {"reason":{"kind":"FLAG_NOT_FOUND"},"value":false,"variation":null,...}

# 4) Add a targeting rule (internal beta users get "on" unconditionally)
curl -s -XPUT $API/flags/new-checkout -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d @- <<'EOF'
{
  "key": "new-checkout",
  "type": "boolean",
  "enabled": true,
  "variations": [
    {"key": "on",  "value": true},
    {"key": "off", "value": false}
  ],
  "offVariation": "off",
  "fallthrough": {
    "kind": "rollout",
    "weights": [{"variation": "on", "weight": 20}, {"variation": "off", "weight": 80}]
  },
  "targets": [],
  "rules": [
    {
      "id": "beta-users",
      "clauses": [{"attribute": "plan", "op": "in", "values": ["beta"], "negate": false}],
      "serve": {"kind": "fixed", "variation": "on"}
    }
  ]
}
EOF

# 5) Inspect the audit log
curl -s $API/flags/new-checkout/audit -H "x-api-key: $KEY"

# 6) Toggle off without touching the definition
curl -s -XPATCH $API/flags/new-checkout -H "x-api-key: $KEY" \
  -H 'content-type: application/json' -d '{"enabled": false}'
# -> reason: {"kind":"OFF"} on next evaluation

# 7) Auth is enforced
curl -s -o /dev/null -w '%{http_code}\n' $API/flags   # -> 401
```

## SDK usage

```ts
import { createClient } from '@portfolio/flagforge-sdk';

const client = createClient({
  baseUrl: 'http://localhost:8081',
  apiKey: 'dev-flagforge-key',
});

// Fetch all flag definitions once (POST /evaluate/all); start background polling.
await client.bootstrap();

// All subsequent calls are synchronous, local, and zero-latency.
const enabled = client.variation('new-checkout', { key: userId }, false);
```

The SDK evaluates using `@portfolio/flagforge-core` — the same pure function the server uses — so
`client.variation()` produces the identical result as `POST /evaluate` for the same flag version and
context.

## Verification gates

```bash
# Bring up dependencies only
docker compose -f packages/flagforge/docker-compose.yml up -d postgres redis

# Migrate
DATABASE_URL=postgres://flagforge:flagforge@localhost:5435/flagforge \
  API_KEY=dev-flagforge-key \
  npx tsx packages/flagforge/src/db/migrate.ts

# Run all three suites
npx vitest run --root packages/flagforge-core   # 32 tests (pure engine)
npx vitest run --root packages/flagforge-sdk    # 17 tests (SDK/server parity)
npx vitest run --root packages/flagforge        # 23 tests (API + integration)
                                                # +2 Redis-guard tests when REDIS_URL is set
```

The suites assert the PRD gates:

- **Core (pure)** — bucket uniformity; monotonic rollout property test; evaluation waterfall (OFF,
  TARGET_MATCH, RULE_MATCH, FALLTHROUGH); ERROR reason on malformed flags; all eight operators;
  `referentialErrors` catches dangling variation references.
- **SDK** — `variation()` results byte-match direct `evaluate()` calls for the same flag definitions
  and contexts; background poll picks up updated definitions.
- **API/integration (real Postgres + optional Redis)** — CRUD lifecycle; `DELETE` archives (soft
  delete, not hard remove); audit log records every mutation; `POST /evaluate` returns `FLAG_NOT_FOUND`
  for unknown keys; per-flag Redis version floor blocks stale fills; graceful Redis-down fallback.

## Security notes

- **Auth.** Single shared API key (`x-api-key`), compared in constant time by Fastify's auth plugin.
  Multi-tenant RBAC is out of v1 scope.
- **Targeting operator surface.** Operators are `in`, `contains`, `startsWith`, `endsWith`,
  `greaterThan`, `greaterThanOrEqual`, `lessThan`, `lessThanOrEqual`. A `matches` (regex) operator was
  deliberately omitted to eliminate a ReDoS surface.
- **Relational comparisons.** The four `>/<` operators are defined only for same-typed operands:
  numbers compare numerically, strings lexically. A mixed pair (e.g. attribute `"10"` vs threshold
  `10`) is treated as a non-match — not a type-coerced comparison — to avoid the classic `"10" < 2`
  footgun. Callers that want numeric ordering must send a numeric attribute.
- **No user-supplied patterns.** All clause matching is by the fixed operator set above; no
  user-supplied regex or format strings touch the evaluator.

## Threat model / limitations

**What the version-guarded cache does and does not guarantee.**

The single-flag `POST /evaluate` hot path is version-guarded: a Lua script (`SET_IF_FRESH`) enforces
a per-flag version floor in Redis (TTL: 1 hour), so a slow cache fill of an old definition is
rejected if a fresher write has already raised the floor. **Within this path, an archived or updated
flag cannot be served as live by a racing fill.**

The bulk snapshot used by `POST /evaluate/all` (and therefore the SDK's `bootstrap()` call) is
intentionally **eventually consistent**: it is stored with a 30-second TTL and deleted on every flag
write. Staleness is bounded by that TTL; there is no per-flag version guard on the bulk entry. For a
flag change to reach an SDK instance, the SDK must re-bootstrap (either by polling expiry or an
explicit call). The single-flag eval path is the correctness-critical one.

**What graceful degradation does and does not provide.**

When Redis is unavailable, the service falls back to Postgres on every request (reads become misses;
writes become warned no-ops). Fallback latency is bounded to roughly 1 second by tight ioredis
settings. The service stays live. **It does not stay fast**: under a Redis outage, every eval request
hits Postgres, so sustained outages will push latency toward your Postgres p99.

**What targeting does and does not cover.**

Targeting rules match on `context.key` (the canonical subject identifier) and `context.attributes`
(a flat JSON object). There is no support for nested attribute paths, computed attributes, or
server-side user lookups. A missing attribute is treated as a non-match before `negate` is applied
(`attribute not-in [...]` evaluates to `true` for a context that lacks the attribute entirely —
which is usually correct but should be kept in mind when writing exclusion rules).

**Out of v1 scope:** multi-tenant RBAC, regex targeting, signed evaluation tokens, streaming flag
updates (long-poll / SSE), percentage experiments with statistical significance tracking.

## Portfolio hooks

1. **Deterministic, monotonic bucketing** — SHA-1-derived bucket provably uniform and provably
   monotonic; verified by a property test, not just documentation.
2. **Version-guarded cache-aside** — Lua script closes the stale-fill race without a distributed
   lock; staleness window is auditable from the constants in `cache.ts`.
3. **Server/SDK parity by construction** — sharing `@portfolio/flagforge-core` makes divergence
   impossible without breaking the shared module; 17 parity tests make it observable.
4. **Total, never-throwing evaluation** — `evaluate()` handles malformed flags without propagating
   exceptions into the request path; every code path returns a structured `EvalResult`.

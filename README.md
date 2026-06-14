# Backend Portfolio — Infrastructure-Grade Services

Three internal-platform backends — the kind other engineers build on top of — sharing one TypeScript
spine. Each one proves a distinct **reliability or correctness discipline**, not CRUD: tamper-evidence,
deterministic rollout + caching, and at-least-once delivery with a dead-letter queue.

> 🌐 **Live showcase:** https://anish-guntreddi.github.io/backend-portfolio/
> 📊 **161 tests** · `tsc` clean across 7 packages · every service: Docker-boots + live e2e + adversarially reviewed

| Service | What it proves | Tests |
|---------|----------------|:-----:|
| **[AuditTrail](packages/audittrail)** | Append-only, **tamper-evident hash-chained** audit log; constant-time auth; TRUNCATE-guarded append-only enforcement | 29 |
| **[FlagForge](packages/flagforge)** | Feature flags with **deterministic, monotonic % rollout**; pure eval engine shared by server **and** SDK; **version-guarded** Redis cache | 74 |
| **[NotifyCore](packages/notifycore)** | Notification delivery: BullMQ worker, **atomic claim** (no double-send), exponential backoff, **durable DLQ + replay**, idempotency, quiet hours | 58 |

Each service is independently runnable (`docker compose up`), documents its own threat model honestly,
and ships an OpenAPI spec, a Swagger UI, and a small admin dashboard.

---

## The shared spine (`packages/shared`)

Every service is assembled from the same primitives, so the portfolio reads as one platform rather
than three unrelated apps:

- **`buildBaseServer()`** — a Fastify 5 instance wired with the Zod type provider so a single schema
  drives **validation + response serialization + OpenAPI** at once; `@fastify/swagger` (+ UI at
  `/docs`); an RFC-7807 *problem+json* error handler; a constant-time API-key auth plugin; `/healthz`.
- **`createPool()`** — a configured `pg` connection pool.
- **`loadEnv()`** — fail-fast, Zod-validated environment loading (a misconfigured container crashes
  immediately instead of mid-request).

## The "pure core" pattern

The hardest, most correctness-critical logic in each service is factored into a **pure, I/O-free
package** that is exhaustively unit-tested in isolation — and, where it matters, **shared verbatim**
between processes:

- **`@portfolio/flagforge-core`** — the flag evaluation engine + deterministic bucketing. Imported by
  **both** the FlagForge service and the `@portfolio/flagforge-sdk` client, so a flag evaluates
  *identically* server-side and in a client that bootstrapped the definitions. No "the SDK drifted
  from the backend" class of bug.
- **`@portfolio/notifycore-core`** — template rendering, timezone-aware quiet-hours scheduling
  (including windows that cross midnight), and exponential backoff. Testable without a database,
  a queue, or a clock.

## Engineering highlights

**AuditTrail — tamper-evidence.** Each row stores `sha256(prev_hash ‖ canonical(content))`, linking
the log like a blockchain; a `/verify` endpoint walks the chain and reports the first break. Writes are
serialized with a `pg_advisory_xact_lock` so concurrent appends can't fork the chain, while reads stay
fully concurrent. Append-only is enforced three ways: no update/delete code paths, revoked grants on a
least-privilege role, **and** a trigger that blocks `UPDATE`/`DELETE`/`TRUNCATE`.

**FlagForge — deterministic rollout + a cache that can't lie.** Bucketing is `hash(flagSalt ‖ key)`
mapped to `[0,1)`, depending only on the key — never on the rollout weights — which makes rollouts
**monotonic**: ramping 10%→20% only *adds* users, never evicts one (property-tested, plus a χ²
uniformity test over 100k keys). The Redis eval-cache is **version-guarded** by a Lua script: a write
raises a per-flag version *floor*, so a slow reader can never write a stale definition back over a
fresher one — an archived flag is never served as live. If Redis is down, evaluation transparently
falls back to Postgres (never 500s).

**NotifyCore — honest at-least-once delivery.** The worker **atomically claims** a notification
(`UPDATE … WHERE status claimable RETURNING *`) so two workers can never both deliver it; a lease lets a
crashed worker's claim be reclaimed. Retry/attempt accounting and the terminal `dead` transition are
**DB-authoritative and written before control returns** (not in a fire-and-forget queue event), so the
dead-letter queue survives crashes; total provider calls stay bounded by `maxAttempts`. A reconciler
sweep re-enqueues anything orphaned by a crash between a DB write and the queue add. Delivery is
documented as at-least-once, with a stable `deliveryId` handed to providers for downstream dedup.

> Each service's README has a candid **"threat model / limitations"** section — the guarantees *and*
> their boundaries (e.g. external anchoring vs. KMS signing; the eventually-consistent bulk-eval
> snapshot; the transactional-outbox hardening left as future work).

## Stack

- **Language:** TypeScript, run directly via `tsx` (no build step); `tsc --noEmit` for type checking
- **HTTP:** Fastify 5 + `fastify-type-provider-zod` · OpenAPI via `@fastify/swagger`, UI at `/docs`
- **Data:** PostgreSQL via `pg` + Drizzle ORM (hand-authored SQL migrations)
- **Cache / Queue:** Redis via `ioredis` (FlagForge cache) and BullMQ (NotifyCore worker)
- **Tests:** Vitest — pure-unit suites + integration tests against **real** Postgres/Redis in Docker
- **Monorepo:** npm workspaces

## Repo layout

```
packages/
  shared/            # platform spine reused by every service
  audittrail/        # service 1 — immutable, tamper-evident audit logging
  flagforge/         # service 2 — feature-flag service (Postgres + Redis cache + admin UI)
  flagforge-core/    #   pure flag-evaluation engine (shared by service AND sdk)
  flagforge-sdk/     #   client SDK — local evaluation via the core engine
  notifycore/        # service 3 — notification delivery (API + BullMQ worker)
  notifycore-core/   #   pure rendering / quiet-hours / backoff logic
site/                # the portfolio showcase website (deployed to GitHub Pages)
```

## Getting started

```bash
npm install

# Run any service end-to-end (Postgres/Redis + API in Docker):
docker compose -f packages/audittrail/docker-compose.yml up -d --build   # → http://localhost:8080
docker compose -f packages/flagforge/docker-compose.yml  up -d --build   # → http://localhost:8081
docker compose -f packages/notifycore/docker-compose.yml up -d --build   # → http://localhost:8082

# Each exposes Swagger UI at /docs and an admin dashboard at /admin/.
```

## Testing

```bash
# Pure-logic suites need nothing running:
npx vitest run --root packages/flagforge-core     # 32 — bucketing, monotonic rollout, eval waterfall
npx vitest run --root packages/notifycore-core    # 30 — rendering, quiet hours, backoff

# Integration suites run against real Postgres/Redis (bring the service's compose up first):
npx vitest run --root packages/audittrail         # 29
npx vitest run --root packages/flagforge          # 25  (+ Redis version-guard suite when REDIS_URL set)
npx vitest run --root packages/notifycore         # 28  (real BullMQ worker: idempotency, DLQ, replay)
```

Per-service "done" criteria and run/test details live in each service's README.

## How it was built

Planned and orchestrated with a token-optimal model-allocation workflow (see `CLAUDE.md`): the
correctness-critical cores (hash chain, bucketing/eval engine, quiet-hours math) were authored and
verified directly, well-scoped implementation was delegated, and an independent model ran an
**adversarial review** of each service before its gates closed — which surfaced and fixed real bugs
(a cache-aside race that could serve archived flags as live; a non-durable dead-letter path; a
mixed-type comparison footgun), each now covered by a regression test.

---

_License: MIT_

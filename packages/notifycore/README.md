# NotifyCore — Reliable Notification Delivery Service

Accept a notification request, persist it, deliver it exactly once — even across crashes, duplicate
submits, and concurrent workers. Template rendering, recipient opt-out, timezone-aware quiet hours,
exponential-backoff retry, a DB-authoritative dead-letter queue, and replay — all in one deployable
service.

> Portfolio goal: at-least-once delivery with idempotent intake and crash-safe state transitions —
> the set of distributed-systems properties that separate a "send email" wrapper from a production
> notification pipeline.

## What it proves

- **Idempotent intake.** `POST /notifications` is safe to retry. A duplicate `idempotencyKey` hits
  `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`, returns the existing row
  (HTTP 200, `created: false`), and enqueues no second job. Verified end-to-end: one row, one delivery.
- **Atomic claim — no double-send under concurrency.** A worker claims a notification with a single
  `UPDATE ... WHERE status IN ('queued','deferred') RETURNING *`, transitioning it to `sending`. Two
  workers racing on the same row: exactly one wins; the other gets zero rows back and no-ops.
- **Lease-based crash recovery.** A `sending` row whose `updatedAt` is older than ~60 s is
  reclaimable by any worker. A crashed worker cannot strand a notification indefinitely.
- **DB-authoritative DLQ.** Retry counting and the terminal `dead` transition are written to Postgres
  *before* the function returns — not fire-and-forget. A notification exhausting `maxAttempts` is
  durably dead even if the process crashes during the write. Total provider calls are bounded by
  `maxAttempts` regardless of how BullMQ's per-job retry budget is reset by deferral.
- **Reconciler.** A periodic sweep re-enqueues notifications whose worker died between a DB write and
  the `queue.add()` call (the one window the inline path cannot make atomic). Re-enqueuing is safe
  because the atomic claim turns duplicate jobs into no-ops.
- **Quiet hours.** Per-recipient, per-channel do-not-disturb windows (timezone-aware, midnight-crossing).
  A notification arriving inside the window is set to `deferred` and re-enqueued with a delay computed
  to fire exactly when the window ends.
- **Opt-out.** An opted-out recipient transitions to `skipped`; the provider is never called.
- **Pluggable providers.** A `ChannelProvider` interface (`send(RenderedMessage): Promise<void>`)
  is all a real email/SMS/push adapter needs to implement. The bundled `ConsoleProvider` logs.

## Architecture — two packages

```
┌────────────────────────────────────────────────────────────────────┐
│  @portfolio/notifycore-core  (pure, zero I/O, exhaustively tested) │
│                                                                    │
│  render / missingPlaceholders  — safe {{placeholder}} interpolation│
│  nextSendTime / quietDeferralMinutes / parseHHMM / localTimeMinutes│
│    — timezone-aware quiet-hours scheduling (midnight-crossing)     │
│  backoffDelayMs  — exponential backoff, capped                     │
│                                                                    │
│  30 unit tests                                                     │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ shared dependency
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│  @portfolio/notifycore  (the service)                              │
│                                                                    │
│  Fastify + Zod REST API         Postgres store (Drizzle + pg)      │
│  BullMQ queue                   Admin dashboard  /admin/           │
│                                                                    │
│  ┌──────────────────────┐   ┌──────────────────────────────────┐  │
│  │  app container       │   │  worker container (own process)  │  │
│  │  Fastify on :8082    │   │  processNotification()           │  │
│  │  migrations on start │   │  startReconciler()               │  │
│  └──────────────────────┘   └──────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

The worker runs as its **own container** (`worker-main.ts`), separate from the API process. Both
share Postgres and Redis; neither shares in-process state.

## Status lifecycle

```
POST /notifications
       │
       ▼
   [queued] ──► [sending] ──► [sent]
                    │
                    ├──► [skipped]   (opted out)
                    │
                    ├──► [deferred] ──► [queued] ──► ...
                    │      (quiet hours; re-enqueued with delay)
                    │
                    └──► [dead]  ◄── exhausted maxAttempts
                              │
                    POST /dlq/:id/replay
                              │
                              ▼
                          [queued] ──► ...
```

## API surface

All routes require `x-api-key` except `/healthz`, `/docs`, `/openapi.json`, `/admin/*`, and `/`.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/notifications` | Enqueue a notification (idempotent); 201 new / 200 duplicate |
| `GET` | `/notifications/:id` | Fetch one notification by id |
| `GET` | `/notifications` | List notifications (`?status=&recipient=&limit=`) |
| `POST` | `/templates` | Create a template |
| `GET` | `/templates` | List templates |
| `GET` | `/templates/:key` | Get a template by key |
| `PUT` | `/templates/:key` | Update a template |
| `GET` | `/preferences` | Get recipient/channel preference (`?recipient=&channel=`) |
| `PUT` | `/preferences` | Upsert recipient/channel preference (opt-out, quiet hours) |
| `GET` | `/dlq` | List dead notifications |
| `POST` | `/dlq/:id/replay` | Reset a dead notification to `queued` and re-enqueue |
| `GET` | `/healthz` | Liveness (public) |

Swagger UI at `/docs`. Spec at `/openapi.json`.

## Quickstart

```bash
# from the repo root
npm install
docker compose -f packages/notifycore/docker-compose.yml up -d --build
# Postgres host :5436, Redis host :6381, API http://localhost:8082
# Migrations run on app container start.
curl localhost:8082/healthz
open http://localhost:8082/admin/   # admin dashboard
open http://localhost:8082/docs     # Swagger UI
```

## End-to-end curl flow

```bash
API=http://localhost:8082
KEY=dev-notifycore-key

# 1) Create a template
curl -s -XPOST $API/templates \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{
    "key": "welcome-email",
    "channel": "email",
    "subject": "Welcome, {{name}}!",
    "body": "Hi {{name}}, your account is ready."
  }'

# 2) Enqueue a notification (first call → 201 created:true)
curl -s -XPOST $API/notifications \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{
    "idempotencyKey": "onboard-user-42",
    "recipient": "user@example.com",
    "channel": "email",
    "templateKey": "welcome-email",
    "data": {"name": "Alice"}
  }'

# 3) Duplicate submit returns the existing row, no second job (200 created:false)
curl -s -XPOST $API/notifications \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{
    "idempotencyKey": "onboard-user-42",
    "recipient": "user@example.com",
    "channel": "email",
    "templateKey": "welcome-email",
    "data": {"name": "Alice"}
  }'

# 4) Poll status (worker delivers asynchronously)
curl -s $API/notifications/1 -H "x-api-key: $KEY"
# -> {"id":1,"status":"sent",...}

# 5) Set quiet hours for a recipient (22:00–08:00 America/New_York)
curl -s -XPUT $API/preferences \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{
    "recipient": "user@example.com",
    "channel": "email",
    "optedOut": false,
    "quietStart": "22:00",
    "quietEnd": "08:00",
    "timezone": "America/New_York"
  }'

# 6) Opt a recipient out entirely
curl -s -XPUT $API/preferences \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"recipient":"user@example.com","channel":"email","optedOut":true}'

# 7) List the dead-letter queue
curl -s $API/dlq -H "x-api-key: $KEY"

# 8) Replay a dead notification
curl -s -XPOST $API/dlq/7/replay -H "x-api-key: $KEY"
# -> {"id":7,"status":"queued",...}  (re-enqueued for delivery)

# 9) Auth enforced
curl -s -o /dev/null -w '%{http_code}\n' $API/notifications   # -> 401
```

## Verification gates

```bash
# Bring up dependencies only
docker compose -f packages/notifycore/docker-compose.yml up -d postgres redis

# Migrate
DATABASE_URL=postgres://notifycore:notifycore@localhost:5436/notifycore \
  REDIS_URL=redis://localhost:6381 \
  API_KEY=dev-notifycore-key \
  npx tsx packages/notifycore/src/db/migrate.ts

# Pure logic (no I/O)
npx vitest run --root packages/notifycore-core   # 30 tests

# API + integration (real Postgres + BullMQ worker)
npx vitest run --root packages/notifycore        # 28 tests
```

The suites assert the PRD gates:

- **Core (pure)** — `render` interpolation; `missingPlaceholders` detects unfilled slots; quiet-hours
  scheduling across midnight and timezone boundaries; exponential backoff cap.
- **API/integration (real Postgres + BullMQ)** — idempotent enqueue (one row, one delivery); atomic
  claim (concurrent workers, zero double-sends); retry → DLQ after `maxAttempts` exhausted; replay
  resets `dead` to `queued`; quiet-hours deferred then delivered; opt-out results in `skipped`; auth
  enforced on all protected routes.

## Security notes

- **Auth.** Single shared API key (`x-api-key`), compared in constant time via Fastify's auth plugin.
  Multi-tenant RBAC is out of v1 scope.
- **Template rendering.** Interpolation replaces `{{placeholder}}` tokens from a caller-supplied data
  object. There is no recursion, no expression evaluation, and no user-supplied format strings reach
  the renderer. A missing placeholder is caught at enqueue time (`missingPlaceholders`) and rejected
  with HTTP 400 before any job is written.
- **SQL.** All filters are Drizzle bound parameters; no string interpolation touches queries.

## Threat model / limitations

**Delivery is at-least-once, not exactly-once.**

A worker crash *after* a successful provider send but *before* the `sent` DB commit causes a
redelivery. The provider receives a stable `deliveryId` (the client's `idempotencyKey`) so a real
provider *should* dedupe on it to make the end-to-end effect exactly-once. The bundled
`ConsoleProvider` just logs; it does not dedupe. The exact-once guarantee lives in the provider, not
the service.

**The enqueue/defer/replay paths are not transactional outboxes.**

Each path writes DB state then calls `queue.add()` in two separate steps — they are not one
transaction. A crash between the two leaves a row in `queued`/`deferred` with no live BullMQ job.
The reconciler heals this with a bounded delay (sweep interval: 30 s by default; stale threshold:
60 s), not preventively. A production-grade hardening is a transactional outbox pattern (write the
job row inside the same transaction as the notification row, poll the outbox to publish) — noted as
future work.

**Replay is conditionally atomic, with a two-step window.**

`replayNotification` resets a `dead` row with `UPDATE ... WHERE status='dead' RETURNING *` (atomic),
then calls `queue.add()`. The conditional update ensures only one of two concurrent replays wins.
However, the winner's `queue.add()` is outside that transaction, so a crash between the two leaves a
`queued` row with no job — healed by the reconciler on the next sweep.

**Reconciler sweep is speculative, not guaranteed-once.**

The reconciler re-enqueues any `queued`/`deferred`/`sending` row older than the stale threshold. In
the healthy case (no crashes), this is a no-op because healthy jobs complete before the threshold.
After a crash it re-enqueues, which is safe because the atomic claim makes duplicate jobs no-ops.
The reconciler does *not* prevent the redelivery described above — it prevents *abandonment*.

**What the lease does and does not provide.**

A `sending` row with a stale `updatedAt` (> 60 s) is reclaimable, so a crashed worker's in-flight
notification is not stranded permanently. However, if a worker successfully sends but stalls *before*
writing `sent`, the row will eventually be reclaimed and the provider will be called again. The lease
window (60 s) bounds the re-claim latency, not the redelivery risk — that is inherent to at-least-once.

**Out of v1 scope:** multi-tenant RBAC, webhook/push channel providers, signed delivery tokens,
transactional outbox, priority queues, per-notification TTL.

## Portfolio hooks

1. **Atomic claim closes the double-send race** — a single `UPDATE ... RETURNING` in one round-trip
   is all that is needed; no distributed locks, no advisory locks, no compare-and-swap loop.
2. **DB-authoritative DLQ** — the `dead` transition is durable before the function returns; BullMQ
   is the transport, not the source of truth for retry state.
3. **Reconciler as safety net, not crutch** — the two-step write is a known gap, documented and
   bounded; the reconciler is the precisely-scoped fix for that gap and nothing more.
4. **Pure core, zero I/O** — `@portfolio/notifycore-core` is independently testable and the only
   place quiet-hours math or template rendering logic lives; the service layer imports it but never
   reimplements it.

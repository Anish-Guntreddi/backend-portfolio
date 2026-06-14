# AuditTrail — Immutable Audit Logging Service

Record who did what, when, and from where — **append-only** and **tamper-evident**. Every event is
chained to its predecessor with a SHA-256 hash, so editing, deleting, or reordering a record —
without also recomputing every later hash — is detected by walking the chain (`GET /verify`). See
[Security notes](#security-notes) for the precise guarantee and its limits.

> Portfolio goal: security-conscious backend design, careful data modeling, and compliance thinking
> — not a CRUD wrapper.

## What it proves

- **Tamper-evident hash chain.** Each row stores `hash = sha256(prevHash ‖ "\n" ‖ canonical(content))`.
  `GET /verify` re-walks the chain and reports the first break (content tampering or re-linking).
- **Append-only, defense in depth.** Postgres triggers raise on any `UPDATE`/`DELETE`/`TRUNCATE` of
  `events` (catches even the table owner), and the application connects as a least-privilege role
  granted only `SELECT`/`INSERT`. `/verify` exists to catch tampering that bypasses *both* layers.
- **Fork-free under concurrency.** Chain extension is serialized with a transaction-scoped Postgres
  advisory lock, so concurrent appends can't read the same head and fork the chain.
- **Injection-safe by construction.** All filters are bound parameters (no string interpolation), and
  exports are RFC-4180 escaped.

## Architecture

```
POST /events ──▶ appendEvent (advisory lock ▶ read head ▶ hash ▶ INSERT)  ─┐
GET  /events ──▶ keyset-paginated, parameterized filters                   ├─▶ Postgres
GET  /verify ──▶ paged chain walk, recompute + compare                     │   (append-only:
GET  /events/export ─▶ same filters → JSON or CSV                          │    trigger + grants)
POST /alert-rules, GET /alert-rules, GET /alerts                           ┘
in-process scheduler ──▶ evaluateRules() every N seconds
```

- **HTTP/validation/OpenAPI:** Fastify 5 + Zod (one schema validates the request *and* generates the
  OpenAPI spec). Swagger UI at `/docs`, spec at `/openapi.json` and committed to [`openapi.json`](openapi.json).
- **Auth:** shared API-key plugin (`x-api-key`, constant-time compare). Public: `/healthz`, `/docs`,
  `/openapi.json`, `/admin`, and `/`.
- **DB:** Drizzle ORM over `pg`. Migrations in [`drizzle/`](drizzle): `0000_init` (tables/indexes),
  `0001_append_only_guard` (trigger + least-privilege role + grants).
- **Admin dashboard:** a thin static UI at `/admin/` (vanilla JS, no build) that calls the API.

## Data model

`events` (append-only): `id` (chain order), `actor`, `action`, `resource`, `occurred_at`,
`recorded_at`, `ip`, `metadata` (jsonb), `prev_hash`, `hash`.
The hash covers the asserted content (`actor/action/resource/occurred_at/ip/metadata`) plus
`prev_hash`. It deliberately does **not** cover `id` (assigned by the sequence) or `recorded_at`
(server-controlled, not a caller-asserted fact).

`alert_rules`: `match_action`, `threshold`, `window_seconds`, `group_by_actor`, `enabled`.
`alerts`: triggered breaches (`rule_id`, `actor`, `matched_count`, window bounds, `triggered_at`).

## API surface

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/events` | Append an event; returns it with `prevHash`/`hash` |
| `GET`  | `/events` | Search/filter (`actor,action,resource,from,to,cursor,limit`), keyset pagination |
| `GET`  | `/events/:id` | Fetch one event |
| `GET`  | `/events/export` | Export filtered events (`format=json\|csv`) |
| `GET`  | `/verify` | Walk the chain; `{valid, checkedCount, brokenAtId?, reason?}` |
| `POST` | `/alert-rules` | Create an alert rule |
| `GET`  | `/alert-rules` | List rules |
| `GET`  | `/alerts` | List triggered alerts |
| `GET`  | `/healthz` | Liveness (public) |

All routes except `/healthz`, `/docs`, `/openapi.json`, `/admin/*`, `/` require `x-api-key`.

## Quickstart

```bash
# from the repo root
npm install
docker compose -f packages/audittrail/docker-compose.yml up -d --build
# Postgres on host :5434, API on http://localhost:8080 (migrations run on container start)
open http://localhost:8080/admin/   # admin dashboard (paste the API key)
open http://localhost:8080/docs      # Swagger UI
```

Running locally without the app container:

```bash
docker compose -f packages/audittrail/docker-compose.yml up -d postgres
cd packages/audittrail
cp .env.example .env
DATABASE_URL=postgres://audittrail:audittrail@localhost:5434/audittrail API_KEY=dev-audittrail-key npm run migrate
DATABASE_URL=postgres://audittrail:audittrail@localhost:5434/audittrail API_KEY=dev-audittrail-key npm run seed   # optional demo data
npm run dev
```

## End-to-end curl flow

```bash
API=http://localhost:8080
KEY=dev-audittrail-key

# 1) Append two events — the second chains to the first
curl -s -XPOST $API/events -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"actor":"alice","action":"login.success","resource":"auth","ip":"203.0.113.5","metadata":{"mfa":true}}'
curl -s -XPOST $API/events -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"actor":"bob","action":"document.delete","resource":"doc:42"}'
#   → event 1 prevHash = 000…0 (genesis); event 2 prevHash = event 1's hash

# 2) Verify the chain is intact
curl -s $API/verify -H "x-api-key: $KEY"
#   → {"valid":true,"checkedCount":2}

# 3) Search and export
curl -s "$API/events?actor=alice" -H "x-api-key: $KEY"
curl -s "$API/events/export?format=csv" -H "x-api-key: $KEY"

# 4) Auth is enforced
curl -s -o /dev/null -w '%{http_code}\n' $API/events       # → 401

# 5) Create an alert rule (the scheduler evaluates it every N seconds)
curl -s -XPOST $API/alert-rules -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"name":"Brute-force logins","matchAction":"login.failed","threshold":5,"windowSeconds":300,"groupByActor":true}'
```

## Verification gates (how "done" is proven)

```bash
docker compose -f packages/audittrail/docker-compose.yml up -d postgres
cd packages/audittrail
DATABASE_URL=postgres://audittrail:audittrail@localhost:5434/audittrail API_KEY=dev-audittrail-key npm run migrate
npm test          # 28 tests, unit + integration
npm run typecheck # tsc --noEmit, clean
```

The suite asserts the PRD gates:

- **Unit** — hash determinism + canonical-JSON key-order independence + per-field sensitivity; the
  `selectBreaches` alert predicate.
- **Integration (real Postgres)** —
  - `UPDATE`/`DELETE` rejected by the trigger (as owner) and by missing grants (as the app role);
  - `TRUNCATE` rejected by a dedicated statement-level trigger (even as owner);
  - out-of-band tampering (trigger disabled, row edited) makes `/verify` report `content_tampered`;
  - re-linking a row makes `/verify` report `prev_hash_mismatch`;
  - 50 concurrent appends keep the chain **linear and verifiable** (no fork);
  - filters are injection-safe (a `DROP TABLE` payload matches zero rows; table intact);
  - search/pagination/export/404/auth behave as specified.

## Security notes

- **Auth/data path (`/cso`).** Single shared API key (multi-tenant RBAC is out of v1 scope), compared
  in constant time. All filters are bound parameters — no SQL injection; no user-supplied regex — no
  ReDoS. Exports respect the same filters and are RFC-4180 escaped.
- **Threat model — what `/verify` does and does not prove.** It proves the rows *currently present*
  form a self-consistent chain, so it catches tampering by anyone who edits/deletes/reorders a row
  **without** recomputing the rest of the chain (the trigger blocks that in-band; out-of-band edits
  are caught by `/verify`). It does **not**, on its own, catch a privileged attacker who bypasses the
  trigger **and** recomputes every downstream hash, or who deletes the newest suffix — the hashing is
  deterministic, so they can produce a valid-looking chain. Two honest mitigations:
  1. **External anchor (in v1):** `/verify` returns `headHash` and `checkedCount`. An external monitor
     records these over time and alerts if either regresses — detecting suffix deletion and rewrites.
  2. **Signed head (future work, out of v1):** signing the head with an external KMS key the DB writer
     cannot use makes rewrites unforgeable. The PRD scopes this to future work.
  The chain also proves integrity/ordering but **not authenticity**: an actor with `INSERT` can append
  a correctly-hashed event (again, signing is the fix).
- The `audittrail_app` password in `0001_append_only_guard.sql` is **local-demo only**; production
  provisions that role and its secret out-of-band.

## Portfolio hooks

1. **Tamper-evident hash chain** with a real `/verify` walk that pinpoints the break.
2. **Append-only enforced two ways** (trigger + least-privilege grants) — defense in depth.
3. **Fork-free concurrency** via a Postgres advisory lock, proven by a 50-way concurrent-append test.

import { and, asc, desc, eq, gt, gte, lt, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { events, type EventRow } from '../db/schema.ts';
import { computeEventHash, GENESIS_HASH, type HashableEvent } from '../domain/hashChain.ts';

/** Arbitrary constant for pg_advisory_xact_lock — namespaces the audit chain's serialization lock. */
const CHAIN_LOCK_KEY = 4242424242;

export interface AppendInput {
  actor: string;
  action: string;
  resource: string;
  occurredAt?: Date;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append one event to the chain.
 *
 * Concurrency: two inserts that both read the same chain head would compute the same `prev_hash`
 * and FORK the chain. We prevent that with a transaction-scoped advisory lock, so chain extension
 * is serialized while ordinary reads stay fully concurrent. The lock auto-releases at COMMIT.
 */
export async function appendEvent(db: Db, input: AppendInput): Promise<EventRow> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(CAST(${CHAIN_LOCK_KEY} AS bigint))`);

    const head = await tx
      .select({ hash: events.hash })
      .from(events)
      .orderBy(desc(events.id))
      .limit(1);
    const prevHash = head[0]?.hash ?? GENESIS_HASH;

    const occurredAt = input.occurredAt ?? new Date();
    const ip = input.ip ?? null;
    const metadata = input.metadata ?? {};
    const hashable: HashableEvent = {
      actor: input.actor,
      action: input.action,
      resource: input.resource,
      occurredAt,
      ip,
      metadata,
    };
    const hash = computeEventHash(hashable, prevHash);

    const inserted = await tx
      .insert(events)
      .values({
        actor: input.actor,
        action: input.action,
        resource: input.resource,
        occurredAt,
        ip,
        metadata,
        prevHash,
        hash,
      })
      .returning();

    return inserted[0]!;
  });
}

export interface EventFilters {
  actor?: string;
  action?: string;
  resource?: string;
  from?: Date;
  to?: Date;
  cursor?: number;
  limit?: number;
}

export interface EventPage {
  items: EventRow[];
  nextCursor: number | null;
}

const MAX_PAGE = 500;

/** Build WHERE conditions. Every value is a bound parameter (eq/gte/lte) — never interpolated. */
function buildConds(f: EventFilters) {
  const conds = [];
  if (f.actor) conds.push(eq(events.actor, f.actor));
  if (f.action) conds.push(eq(events.action, f.action));
  if (f.resource) conds.push(eq(events.resource, f.resource));
  if (f.from) conds.push(gte(events.occurredAt, f.from));
  if (f.to) conds.push(lte(events.occurredAt, f.to));
  return conds;
}

/** Search/filter with keyset (cursor) pagination, newest first. */
export async function listEvents(db: Db, f: EventFilters): Promise<EventPage> {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), MAX_PAGE);
  const conds = buildConds(f);
  if (f.cursor) conds.push(lt(events.id, f.cursor));

  const rows = await db
    .select()
    .from(events)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(events.id))
    .limit(limit + 1);

  const items = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? (items[items.length - 1]?.id ?? null) : null;
  return { items, nextCursor };
}

export async function getEventById(db: Db, id: number): Promise<EventRow | null> {
  const rows = await db.select().from(events).where(eq(events.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Fetch all events matching the filters (id ascending), capped, for export. */
export async function exportEvents(db: Db, f: EventFilters, cap = 50_000): Promise<EventRow[]> {
  const conds = buildConds(f);
  const out: EventRow[] = [];
  let lastId = 0;
  const pageSize = 1000;
  while (out.length < cap) {
    const page = await db
      .select()
      .from(events)
      .where(and(gt(events.id, lastId), ...conds))
      .orderBy(asc(events.id))
      .limit(Math.min(pageSize, cap - out.length));
    if (page.length === 0) break;
    out.push(...page);
    lastId = page[page.length - 1]!.id;
    if (page.length < pageSize) break;
  }
  return out;
}

export type VerifyResult =
  | { valid: true; checkedCount: number; headHash: string }
  | {
      valid: false;
      checkedCount: number;
      brokenAtId: number;
      reason: 'prev_hash_mismatch' | 'content_tampered';
      expected: string;
      actual: string;
    };

/**
 * Walk the entire chain in id order, recomputing each hash and checking it links to its predecessor.
 * Paged so memory stays bounded for large logs. Returns the first break found, if any.
 *
 * NOTE: this proves the rows *currently present* form a self-consistent chain. It cannot, on its
 * own, detect a privileged attacker who deletes the newest suffix or rewrites-and-rehashes from
 * some point onward (they can recompute valid hashes — the algorithm is deterministic). For that,
 * an external monitor should record `(checkedCount, headHash)` over time and alert if either
 * regresses; tamper-proofing it fully requires signing the head with a key the DB writer lacks
 * (KMS signing — future work).
 */
export async function verifyChain(db: Db): Promise<VerifyResult> {
  const pageSize = 1000;
  let prev = GENESIS_HASH;
  let checked = 0;
  let lastId = 0;

  for (;;) {
    const rows = await db
      .select()
      .from(events)
      .where(gt(events.id, lastId))
      .orderBy(asc(events.id))
      .limit(pageSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      if (row.prevHash !== prev) {
        return {
          valid: false,
          checkedCount: checked,
          brokenAtId: row.id,
          reason: 'prev_hash_mismatch',
          expected: prev,
          actual: row.prevHash,
        };
      }
      const expected = computeEventHash(row, row.prevHash);
      if (expected !== row.hash) {
        return {
          valid: false,
          checkedCount: checked,
          brokenAtId: row.id,
          reason: 'content_tampered',
          expected,
          actual: row.hash,
        };
      }
      prev = row.hash;
      checked += 1;
      lastId = row.id;
    }
    if (rows.length < pageSize) break;
  }

  return { valid: true, checkedCount: checked, headHash: prev };
}

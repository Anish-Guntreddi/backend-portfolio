import { eq, desc, sql } from 'drizzle-orm';
import {
  flagDefinitionSchema,
  referentialErrors,
  type FlagDefinition,
  type EvalContext,
} from '@portfolio/flagforge-core';
import { BadRequest, Conflict, NotFound } from '@portfolio/shared';
import type { Db } from '../db/client.ts';
import { flags, flagAudit, type FlagRow, type FlagAuditRow } from '../db/schema.ts';
import type { FlagCache } from '../cache.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a database row back to the core FlagDefinition shape. */
export function rowToDefinition(row: FlagRow): FlagDefinition {
  return flagDefinitionSchema.parse({
    key: row.key,
    type: row.type,
    enabled: row.enabled,
    variations: row.variations,
    offVariation: row.offVariation,
    fallthrough: row.fallthrough,
    targets: row.targets,
    rules: row.rules,
    salt: row.salt,
  });
}

/** Validate that every variation value matches the flag's declared type. */
function assertValueTypes(def: FlagDefinition): void {
  for (const v of def.variations) {
    const ok =
      def.type === 'boolean'
        ? typeof v.value === 'boolean'
        : def.type === 'number'
          ? typeof v.value === 'number'
          : def.type === 'string'
            ? typeof v.value === 'string'
            : true; // json — any value
    if (!ok) {
      throw BadRequest(
        `variation "${v.key}" has value of type ${typeof v.value} but flag type is ${def.type}`,
      );
    }
  }
}

/** Run all definition-level validations. Throws BadRequest on failure. */
function validateDefinition(def: FlagDefinition): void {
  const errors = referentialErrors(def);
  if (errors.length > 0) throw BadRequest(errors.join('; '));
  assertValueTypes(def);
}

/** Build the JSONB representation to store and audit-log. */
function defToJson(def: FlagDefinition): Record<string, unknown> {
  return def as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

export async function createFlag(
  db: Db,
  cache: FlagCache,
  input: FlagDefinition,
  actor: string,
): Promise<FlagRow> {
  validateDefinition(input);

  // Check duplicate key
  const existing = await db
    .select({ id: flags.id })
    .from(flags)
    .where(eq(flags.key, input.key))
    .limit(1);
  if (existing.length > 0) throw Conflict(`flag "${input.key}" already exists`);

  const [row] = await db
    .insert(flags)
    .values({
      key: input.key,
      type: input.type,
      enabled: input.enabled,
      variations: input.variations,
      offVariation: input.offVariation,
      fallthrough: input.fallthrough,
      targets: input.targets,
      rules: input.rules,
      salt: input.salt,
    })
    .returning();

  await db.insert(flagAudit).values({
    flagKey: input.key,
    action: 'created',
    actor,
    before: null,
    after: defToJson(input),
  });

  await cache.invalidate(input.key, row!.version);

  return row!;
}

export async function updateFlag(
  db: Db,
  cache: FlagCache,
  key: string,
  input: FlagDefinition,
  actor: string,
): Promise<FlagRow> {
  validateDefinition(input);

  const [existing] = await db.select().from(flags).where(eq(flags.key, key)).limit(1);
  if (!existing) throw NotFound(`flag "${key}" not found`);

  const before = defToJson(rowToDefinition(existing));

  const [updated] = await db
    .update(flags)
    .set({
      type: input.type,
      enabled: input.enabled,
      variations: input.variations,
      offVariation: input.offVariation,
      fallthrough: input.fallthrough,
      targets: input.targets,
      rules: input.rules,
      salt: input.salt,
      version: sql`${flags.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(flags.key, key))
    .returning();

  await db.insert(flagAudit).values({
    flagKey: key,
    action: 'updated',
    actor,
    before,
    after: defToJson(input),
  });

  await cache.invalidate(key, updated!.version);

  return updated!;
}

export async function setEnabled(
  db: Db,
  cache: FlagCache,
  key: string,
  enabled: boolean,
  actor: string,
): Promise<FlagRow> {
  const [existing] = await db.select().from(flags).where(eq(flags.key, key)).limit(1);
  if (!existing) throw NotFound(`flag "${key}" not found`);

  const [updated] = await db
    .update(flags)
    .set({
      enabled,
      version: sql`${flags.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(flags.key, key))
    .returning();

  await db.insert(flagAudit).values({
    flagKey: key,
    action: 'toggled',
    actor,
    before: { enabled: existing.enabled },
    after: { enabled },
  });

  await cache.invalidate(key, updated!.version);

  return updated!;
}

export async function archiveFlag(
  db: Db,
  cache: FlagCache,
  key: string,
  actor: string,
): Promise<FlagRow> {
  const [existing] = await db.select().from(flags).where(eq(flags.key, key)).limit(1);
  if (!existing) throw NotFound(`flag "${key}" not found`);

  const [updated] = await db
    .update(flags)
    .set({
      archived: true,
      version: sql`${flags.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(flags.key, key))
    .returning();

  await db.insert(flagAudit).values({
    flagKey: key,
    action: 'archived',
    actor,
    before: { archived: false },
    after: { archived: true },
  });

  await cache.invalidate(key, updated!.version);

  return updated!;
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

export async function getFlag(db: Db, key: string): Promise<FlagRow | null> {
  const [row] = await db.select().from(flags).where(eq(flags.key, key)).limit(1);
  return row ?? null;
}

export async function listFlags(db: Db, includeArchived: boolean): Promise<FlagRow[]> {
  if (includeArchived) {
    return db.select().from(flags).orderBy(flags.id);
  }
  return db.select().from(flags).where(eq(flags.archived, false)).orderBy(flags.id);
}

export async function getFlagAudit(db: Db, key: string): Promise<FlagAuditRow[]> {
  return db
    .select()
    .from(flagAudit)
    .where(eq(flagAudit.flagKey, key))
    .orderBy(desc(flagAudit.id));
}

// ---------------------------------------------------------------------------
// Evaluation helpers (cache-aware)
// ---------------------------------------------------------------------------

/** Load one non-archived flag (+version) for evaluation, populating the cache on a miss. */
export async function loadDefinitionForEval(
  db: Db,
  cache: FlagCache,
  key: string,
): Promise<{ def: FlagDefinition; version: number } | null> {
  const cached = await cache.get(key);
  if (cached) return { def: cached.def, version: cached.version };

  const [row] = await db.select().from(flags).where(eq(flags.key, key)).limit(1);
  if (!row || row.archived) return null;

  const def = rowToDefinition(row);
  await cache.set(key, def, row.version);
  return { def, version: row.version };
}

/** Load all non-archived flags (+versions) for evaluation, populating the cache on a miss. */
export async function loadAllForEval(
  db: Db,
  cache: FlagCache,
): Promise<{ def: FlagDefinition; version: number }[]> {
  const cachedAll = await cache.getAll();
  if (cachedAll) return cachedAll.map((c) => ({ def: c.def, version: c.version }));

  const rows = await db
    .select()
    .from(flags)
    .where(eq(flags.archived, false))
    .orderBy(flags.id);

  const results = rows.map((row) => ({ def: rowToDefinition(row), version: row.version }));
  await cache.setAll(results);
  return results;
}

import type { FlagRow, FlagAuditRow } from '../db/schema.ts';
import { rowToDefinition } from '../repo/flagsRepo.ts';

export function toFlagDTO(row: FlagRow) {
  const def = rowToDefinition(row);
  return {
    ...def,
    version: row.version,
    archived: row.archived,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toAuditDTO(row: FlagAuditRow) {
  return {
    id: row.id,
    flagKey: row.flagKey,
    action: row.action,
    actor: row.actor,
    before: row.before ?? null,
    after: row.after ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

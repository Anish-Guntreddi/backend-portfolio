import type { AlertRow, AlertRuleRow, EventRow } from '../db/schema.ts';

export function toEventDTO(row: EventRow) {
  return {
    id: row.id,
    actor: row.actor,
    action: row.action,
    resource: row.resource,
    occurredAt: row.occurredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    ip: row.ip,
    metadata: row.metadata,
    prevHash: row.prevHash,
    hash: row.hash,
  };
}

export function toRuleDTO(row: AlertRuleRow) {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    matchAction: row.matchAction,
    groupByActor: row.groupByActor,
    threshold: row.threshold,
    windowSeconds: row.windowSeconds,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toAlertDTO(row: AlertRow) {
  return {
    id: row.id,
    ruleId: row.ruleId,
    actor: row.actor,
    matchedCount: row.matchedCount,
    windowStart: row.windowStart.toISOString(),
    windowEnd: row.windowEnd.toISOString(),
    triggeredAt: row.triggeredAt.toISOString(),
  };
}

const CSV_COLUMNS = [
  'id',
  'actor',
  'action',
  'resource',
  'occurred_at',
  'recorded_at',
  'ip',
  'metadata',
  'prev_hash',
  'hash',
] as const;

/**
 * Escape a CSV field. Two concerns:
 *   - RFC-4180: quote fields containing comma/quote/newline, doubling inner quotes.
 *   - CSV formula injection: a field beginning with `= + - @` (or a tab/CR) is interpreted as a
 *     formula by Excel/Sheets. Since audit fields (actor/action/resource/metadata) are caller-supplied,
 *     we neutralize that by prefixing such a value with a single quote before escaping.
 */
function csvField(value: string): string {
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

export function toCSV(rows: EventRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        String(r.id),
        r.actor,
        r.action,
        r.resource,
        r.occurredAt.toISOString(),
        r.recordedAt.toISOString(),
        r.ip ?? '',
        JSON.stringify(r.metadata),
        r.prevHash,
        r.hash,
      ]
        .map(csvField)
        .join(','),
    );
  }
  return lines.join('\r\n');
}

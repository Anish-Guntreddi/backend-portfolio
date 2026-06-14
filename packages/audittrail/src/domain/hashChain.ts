import { createHash } from 'node:crypto';

/** Genesis link: the `prev_hash` of the very first event in the chain. */
export const GENESIS_HASH = '0'.repeat(64);

/** The asserted content of an event — exactly the fields covered by the tamper-evident hash. */
export interface HashableEvent {
  actor: string;
  action: string;
  resource: string;
  occurredAt: Date | string;
  ip: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Deterministic, canonical JSON serialization: object keys are sorted recursively so that two
 * semantically-identical events always produce byte-identical input (and therefore the same hash),
 * regardless of key insertion order in the request body.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(',');
  return `{${body}}`;
}

/**
 * Compute an event's hash: sha256(prevHash || "\n" || canonical(content)).
 *
 * The hash covers the asserted event content (actor/action/resource/occurredAt/ip/metadata) plus
 * the previous record's hash — linking each record to its predecessor like a blockchain. It does
 * NOT cover `id` (assigned by the sequence) or `recordedAt` (a server-controlled timestamp, not a
 * caller-asserted fact). Changing any covered field, or reordering the chain, breaks verification.
 */
export function computeEventHash(event: HashableEvent, prevHash: string): string {
  const occurredAtIso =
    typeof event.occurredAt === 'string'
      ? new Date(event.occurredAt).toISOString()
      : event.occurredAt.toISOString();

  const canonicalContent = canonicalize({
    actor: event.actor,
    action: event.action,
    resource: event.resource,
    occurredAt: occurredAtIso,
    ip: event.ip ?? null,
    metadata: event.metadata ?? {},
  });

  return createHash('sha256').update(prevHash).update('\n').update(canonicalContent).digest('hex');
}

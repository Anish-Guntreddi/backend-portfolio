import type { AlertRuleRow } from '../db/schema.ts';

export interface GroupCount {
  /** The actor for group-by-actor rules, or null for the single across-all-actors group. */
  actor: string | null;
  count: number;
}

export interface BreachCandidate {
  actor: string | null;
  matchedCount: number;
}

/**
 * Pure decision function: given a rule and the per-group event counts already computed for its
 * window, return the groups that breached the threshold.
 *
 * Threshold semantics: a group breaches when `count >= threshold` — i.e. the Nth matching event
 * fires the rule (not the N+1th). For across-all-actors rules the single group is reported with a
 * null actor. Dedupe (don't re-alert for the same group within the same window) is intentionally
 * NOT here — it depends on already-persisted alerts and lives in the repository.
 */
export function selectBreaches(rule: AlertRuleRow, counts: GroupCount[]): BreachCandidate[] {
  return counts
    .filter((c) => c.count >= rule.threshold)
    .map((c) => ({
      actor: rule.groupByActor ? c.actor : null,
      matchedCount: c.count,
    }));
}

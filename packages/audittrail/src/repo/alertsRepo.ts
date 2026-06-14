import { and, count, desc, eq, gte, isNull, lte } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { alertRules, alerts, events, type AlertRow, type AlertRuleRow } from '../db/schema.ts';
import { selectBreaches, type GroupCount } from '../domain/alertRules.ts';

export interface CreateRuleInput {
  name: string;
  matchAction: string;
  threshold: number;
  windowSeconds: number;
  groupByActor?: boolean;
  enabled?: boolean;
}

export async function createRule(db: Db, input: CreateRuleInput): Promise<AlertRuleRow> {
  const inserted = await db
    .insert(alertRules)
    .values({
      name: input.name,
      matchAction: input.matchAction,
      threshold: input.threshold,
      windowSeconds: input.windowSeconds,
      groupByActor: input.groupByActor ?? true,
      enabled: input.enabled ?? true,
    })
    .returning();
  return inserted[0]!;
}

export async function listRules(db: Db): Promise<AlertRuleRow[]> {
  return db.select().from(alertRules).orderBy(desc(alertRules.id));
}

export async function listAlerts(db: Db, limit = 100): Promise<AlertRow[]> {
  return db
    .select()
    .from(alerts)
    .orderBy(desc(alerts.triggeredAt))
    .limit(Math.min(Math.max(limit, 1), 500));
}

/**
 * Evaluate every enabled rule against events in its sliding window and persist newly-triggered
 * alerts. Dedupe: a (rule, actor) pair is not re-alerted if an alert for it already fired within
 * the current window. Returns the alerts created on this pass.
 */
export async function evaluateRules(db: Db, now: Date = new Date()): Promise<AlertRow[]> {
  const rules = await db.select().from(alertRules).where(eq(alertRules.enabled, true));
  const triggered: AlertRow[] = [];

  for (const rule of rules) {
    const windowStart = new Date(now.getTime() - rule.windowSeconds * 1000);
    const inWindow = and(
      eq(events.action, rule.matchAction),
      gte(events.occurredAt, windowStart),
      lte(events.occurredAt, now),
    );

    let counts: GroupCount[];
    if (rule.groupByActor) {
      const rows = await db
        .select({ actor: events.actor, c: count() })
        .from(events)
        .where(inWindow)
        .groupBy(events.actor);
      counts = rows.map((r) => ({ actor: r.actor, count: Number(r.c) }));
    } else {
      const rows = await db.select({ c: count() }).from(events).where(inWindow);
      counts = [{ actor: null, count: Number(rows[0]?.c ?? 0) }];
    }

    for (const breach of selectBreaches(rule, counts)) {
      const dedupe = and(
        eq(alerts.ruleId, rule.id),
        gte(alerts.triggeredAt, windowStart),
        breach.actor === null ? isNull(alerts.actor) : eq(alerts.actor, breach.actor),
      );
      const existing = await db.select({ id: alerts.id }).from(alerts).where(dedupe).limit(1);
      if (existing.length > 0) continue;

      const inserted = await db
        .insert(alerts)
        .values({
          ruleId: rule.id,
          actor: breach.actor,
          matchedCount: breach.matchedCount,
          windowStart,
          windowEnd: now,
        })
        .returning();
      if (inserted[0]) triggered.push(inserted[0]);
    }
  }

  return triggered;
}

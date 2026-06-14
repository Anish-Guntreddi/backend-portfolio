import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { Conflict, NotFound } from '@portfolio/shared';
import type { Db } from '../db/client.ts';
import { notifications, templates, preferences } from '../db/schema.ts';
import { enqueueNotification, replayNotification, type NotificationJobData } from '../queue.ts';
import type { Queue } from 'bullmq';
import {
  NotificationInput,
  NotificationOutput,
  NotificationListQuery,
  TemplateInput,
  TemplateUpdateInput,
  TemplateOutput,
  PreferenceQuery,
  PreferenceUpsertInput,
  PreferenceOutput,
} from './schemas.ts';
import { toNotificationDTO, toTemplateDTO, toPreferenceDTO } from './serialize.ts';

export interface RouteDeps {
  db: Db;
  queue: Queue<NotificationJobData>;
  defaultMaxAttempts: number;
  retryBaseMs: number;
}

const apiKeySecurity = [{ apiKey: [] as string[] }];

export const apiRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, opts) => {
  const { db, queue, defaultMaxAttempts, retryBaseMs } = opts;

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  app.post(
    '/notifications',
    {
      schema: {
        tags: ['notifications'],
        summary: 'Enqueue a notification (idempotent)',
        security: apiKeySecurity,
        body: NotificationInput,
        response: { 200: NotificationOutput, 201: NotificationOutput },
      },
    },
    async (req, reply) => {
      const { notification, created } = await enqueueNotification(
        db,
        queue,
        req.body,
        defaultMaxAttempts,
        retryBaseMs,
      );
      reply.code(created ? 201 : 200);
      return toNotificationDTO(notification, created);
    },
  );

  app.get(
    '/notifications/:id',
    {
      schema: {
        tags: ['notifications'],
        summary: 'Get a notification by id',
        security: apiKeySecurity,
        params: z.object({ id: z.coerce.number().int().positive() }),
        response: { 200: NotificationOutput },
      },
    },
    async (req) => {
      const [row] = await db
        .select()
        .from(notifications)
        .where(eq(notifications.id, req.params.id))
        .limit(1);
      if (!row) throw NotFound(`notification ${req.params.id} not found`);
      return toNotificationDTO(row);
    },
  );

  app.get(
    '/notifications',
    {
      schema: {
        tags: ['notifications'],
        summary: 'List notifications',
        security: apiKeySecurity,
        querystring: NotificationListQuery,
        response: { 200: z.array(NotificationOutput) },
      },
    },
    async (req) => {
      const { status, recipient, limit } = req.query;
      const conditions = [];
      if (status) conditions.push(eq(notifications.status, status));
      if (recipient) conditions.push(eq(notifications.recipient, recipient));

      const rows = await db
        .select()
        .from(notifications)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(notifications.id))
        .limit(limit);
      return rows.map((r) => toNotificationDTO(r));
    },
  );

  // -------------------------------------------------------------------------
  // Templates
  // -------------------------------------------------------------------------

  app.post(
    '/templates',
    {
      schema: {
        tags: ['templates'],
        summary: 'Create a template',
        security: apiKeySecurity,
        body: TemplateInput,
        response: { 201: TemplateOutput },
      },
    },
    async (req, reply) => {
      const existing = await db
        .select({ id: templates.id })
        .from(templates)
        .where(eq(templates.key, req.body.key))
        .limit(1);
      if (existing.length > 0) throw Conflict(`template "${req.body.key}" already exists`);

      const [row] = await db
        .insert(templates)
        .values({
          key: req.body.key,
          channel: req.body.channel,
          subject: req.body.subject ?? null,
          body: req.body.body,
        })
        .returning();
      reply.code(201);
      return toTemplateDTO(row!);
    },
  );

  app.get(
    '/templates',
    {
      schema: {
        tags: ['templates'],
        summary: 'List templates',
        security: apiKeySecurity,
        response: { 200: z.array(TemplateOutput) },
      },
    },
    async () => {
      const rows = await db.select().from(templates).orderBy(templates.id);
      return rows.map(toTemplateDTO);
    },
  );

  app.get(
    '/templates/:key',
    {
      schema: {
        tags: ['templates'],
        summary: 'Get a template by key',
        security: apiKeySecurity,
        params: z.object({ key: z.string().min(1) }),
        response: { 200: TemplateOutput },
      },
    },
    async (req) => {
      const [row] = await db
        .select()
        .from(templates)
        .where(eq(templates.key, req.params.key))
        .limit(1);
      if (!row) throw NotFound(`template "${req.params.key}" not found`);
      return toTemplateDTO(row);
    },
  );

  app.put(
    '/templates/:key',
    {
      schema: {
        tags: ['templates'],
        summary: 'Upsert a template',
        security: apiKeySecurity,
        params: z.object({ key: z.string().min(1) }),
        body: TemplateUpdateInput,
        response: { 200: TemplateOutput },
      },
    },
    async (req) => {
      const [existing] = await db
        .select()
        .from(templates)
        .where(eq(templates.key, req.params.key))
        .limit(1);
      if (!existing) throw NotFound(`template "${req.params.key}" not found`);

      const [updated] = await db
        .update(templates)
        .set({
          channel: req.body.channel,
          subject: req.body.subject ?? null,
          body: req.body.body,
          updatedAt: sql`now()`,
        })
        .where(eq(templates.key, req.params.key))
        .returning();
      return toTemplateDTO(updated!);
    },
  );

  // -------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------

  app.get(
    '/preferences',
    {
      schema: {
        tags: ['preferences'],
        summary: 'Get recipient channel preference',
        security: apiKeySecurity,
        querystring: PreferenceQuery,
        response: { 200: PreferenceOutput },
      },
    },
    async (req) => {
      const [row] = await db
        .select()
        .from(preferences)
        .where(
          and(
            eq(preferences.recipient, req.query.recipient),
            eq(preferences.channel, req.query.channel),
          ),
        )
        .limit(1);
      if (!row) throw NotFound(`preference for ${req.query.recipient}/${req.query.channel} not found`);
      return toPreferenceDTO(row);
    },
  );

  app.put(
    '/preferences',
    {
      schema: {
        tags: ['preferences'],
        summary: 'Upsert recipient channel preference',
        security: apiKeySecurity,
        body: PreferenceUpsertInput,
        response: { 200: PreferenceOutput },
      },
    },
    async (req) => {
      const { recipient, channel, optedOut, quietStart, quietEnd, timezone } = req.body;

      const [row] = await db
        .insert(preferences)
        .values({
          recipient,
          channel,
          optedOut: optedOut ?? false,
          quietStart: quietStart ?? null,
          quietEnd: quietEnd ?? null,
          timezone: timezone ?? null,
        })
        .onConflictDoUpdate({
          target: [preferences.recipient, preferences.channel],
          set: {
            optedOut: optedOut ?? false,
            quietStart: quietStart ?? null,
            quietEnd: quietEnd ?? null,
            timezone: timezone ?? null,
            updatedAt: sql`now()`,
          },
        })
        .returning();
      return toPreferenceDTO(row!);
    },
  );

  // -------------------------------------------------------------------------
  // DLQ
  // -------------------------------------------------------------------------

  app.get(
    '/dlq',
    {
      schema: {
        tags: ['dlq'],
        summary: 'List dead notifications',
        security: apiKeySecurity,
        response: { 200: z.array(NotificationOutput) },
      },
    },
    async () => {
      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.status, 'dead'))
        .orderBy(desc(notifications.id));
      return rows.map((r) => toNotificationDTO(r));
    },
  );

  app.post(
    '/dlq/:id/replay',
    {
      schema: {
        tags: ['dlq'],
        summary: 'Replay a dead notification',
        security: apiKeySecurity,
        params: z.object({ id: z.coerce.number().int().positive() }),
        response: { 200: NotificationOutput },
      },
    },
    async (req) => {
      const row = await replayNotification(db, queue, req.params.id, retryBaseMs);
      return toNotificationDTO(row);
    },
  );
};

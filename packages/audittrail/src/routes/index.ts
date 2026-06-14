import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { NotFound } from '@portfolio/shared';
import type { Db } from '../db/client.ts';
import {
  appendEvent,
  exportEvents,
  getEventById,
  listEvents,
  verifyChain,
} from '../repo/eventsRepo.ts';
import { createRule, listAlerts, listRules } from '../repo/alertsRepo.ts';
import {
  AlertOutput,
  EventExportQuery,
  EventInput,
  EventListQuery,
  EventListResponse,
  EventOutput,
  RuleInput,
  RuleOutput,
  VerifyResponse,
} from './schemas.ts';
import { toAlertDTO, toCSV, toEventDTO, toRuleDTO } from './serialize.ts';

export interface RouteDeps {
  db: Db;
}

const apiKeySecurity = [{ apiKey: [] as string[] }];

export const apiRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, opts) => {
  const { db } = opts;

  // --- Events --------------------------------------------------------------
  app.post(
    '/events',
    {
      schema: {
        tags: ['events'],
        summary: 'Append an audit event to the immutable log',
        security: apiKeySecurity,
        body: EventInput,
        response: { 201: EventOutput },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const row = await appendEvent(db, {
        actor: b.actor,
        action: b.action,
        resource: b.resource,
        occurredAt: b.occurredAt ? new Date(b.occurredAt) : undefined,
        ip: b.ip ?? null,
        metadata: b.metadata ?? {},
      });
      reply.code(201);
      return toEventDTO(row);
    },
  );

  app.get(
    '/events',
    {
      schema: {
        tags: ['events'],
        summary: 'Search and filter events (keyset pagination, newest first)',
        security: apiKeySecurity,
        querystring: EventListQuery,
        response: { 200: EventListResponse },
      },
    },
    async (req) => {
      const q = req.query;
      const page = await listEvents(db, {
        actor: q.actor,
        action: q.action,
        resource: q.resource,
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
        cursor: q.cursor,
        limit: q.limit,
      });
      return { items: page.items.map(toEventDTO), nextCursor: page.nextCursor };
    },
  );

  // Static path registered before the `:id` param route so it always wins the radix match.
  app.get(
    '/events/export',
    {
      schema: {
        tags: ['events'],
        summary: 'Export filtered events as JSON or CSV',
        security: apiKeySecurity,
        querystring: EventExportQuery,
      },
    },
    async (req, reply) => {
      const q = req.query;
      const rows = await exportEvents(db, {
        actor: q.actor,
        action: q.action,
        resource: q.resource,
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
      });
      if (q.format === 'csv') {
        reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', 'attachment; filename="audit-export.csv"');
        return toCSV(rows);
      }
      reply.header('content-type', 'application/json; charset=utf-8');
      return rows.map(toEventDTO);
    },
  );

  app.get(
    '/events/:id',
    {
      schema: {
        tags: ['events'],
        summary: 'Fetch a single event by id',
        security: apiKeySecurity,
        params: z.object({ id: z.coerce.number().int().positive() }),
        response: { 200: EventOutput },
      },
    },
    async (req) => {
      const row = await getEventById(db, req.params.id);
      if (!row) throw NotFound(`event ${req.params.id} not found`);
      return toEventDTO(row);
    },
  );

  // --- Integrity -----------------------------------------------------------
  app.get(
    '/verify',
    {
      schema: {
        tags: ['integrity'],
        summary: 'Verify the entire audit chain is intact and tamper-free',
        security: apiKeySecurity,
        response: { 200: VerifyResponse },
      },
    },
    async () => verifyChain(db),
  );

  // --- Alert rules & alerts ------------------------------------------------
  app.post(
    '/alert-rules',
    {
      schema: {
        tags: ['alerts'],
        summary: 'Create an alert rule',
        security: apiKeySecurity,
        body: RuleInput,
        response: { 201: RuleOutput },
      },
    },
    async (req, reply) => {
      const rule = await createRule(db, req.body);
      reply.code(201);
      return toRuleDTO(rule);
    },
  );

  app.get(
    '/alert-rules',
    {
      schema: {
        tags: ['alerts'],
        summary: 'List alert rules',
        security: apiKeySecurity,
        response: { 200: z.array(RuleOutput) },
      },
    },
    async () => (await listRules(db)).map(toRuleDTO),
  );

  app.get(
    '/alerts',
    {
      schema: {
        tags: ['alerts'],
        summary: 'List triggered alerts (newest first)',
        security: apiKeySecurity,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }),
        response: { 200: z.array(AlertOutput) },
      },
    },
    async (req) => (await listAlerts(db, req.query.limit)).map(toAlertDTO),
  );
};

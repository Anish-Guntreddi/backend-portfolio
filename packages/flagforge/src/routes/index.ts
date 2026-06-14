import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { evaluate, type JsonValue } from '@portfolio/flagforge-core';
import { NotFound } from '@portfolio/shared';
import type { Db } from '../db/client.ts';
import type { FlagCache } from '../cache.ts';
import {
  createFlag,
  updateFlag,
  setEnabled,
  archiveFlag,
  getFlag,
  listFlags,
  getFlagAudit,
  loadDefinitionForEval,
  loadAllForEval,
} from '../repo/flagsRepo.ts';
import {
  FlagInput,
  FlagOutput,
  FlagListQuery,
  AuditOutput,
  EvalInput,
  EvalResultOutput,
  EvalAllInput,
  EvalAllOutput,
} from './schemas.ts';
import { toFlagDTO, toAuditDTO } from './serialize.ts';

export interface RouteDeps {
  db: Db;
  cache: FlagCache;
}

const apiKeySecurity = [{ apiKey: [] as string[] }];

export const apiRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, opts) => {
  const { db, cache } = opts;

  /** Read the optional x-actor header, defaulting to 'system'. */
  function getActor(req: { headers: Record<string, string | string[] | undefined> }): string {
    const h = req.headers['x-actor'];
    return (Array.isArray(h) ? h[0] : h) ?? 'system';
  }

  // -------------------------------------------------------------------------
  // Flags CRUD
  // -------------------------------------------------------------------------

  app.post(
    '/flags',
    {
      schema: {
        tags: ['flags'],
        summary: 'Create a flag',
        security: apiKeySecurity,
        body: FlagInput,
        response: { 201: FlagOutput },
      },
    },
    async (req, reply) => {
      const row = await createFlag(db, cache, req.body, getActor(req));
      reply.code(201);
      return toFlagDTO(row);
    },
  );

  app.get(
    '/flags',
    {
      schema: {
        tags: ['flags'],
        summary: 'List flags',
        security: apiKeySecurity,
        querystring: FlagListQuery,
        response: { 200: z.array(FlagOutput) },
      },
    },
    async (req) => {
      const rows = await listFlags(db, Boolean(req.query.includeArchived));
      return rows.map(toFlagDTO);
    },
  );

  app.get(
    '/flags/:key',
    {
      schema: {
        tags: ['flags'],
        summary: 'Get a flag by key',
        security: apiKeySecurity,
        params: z.object({ key: z.string().min(1) }),
        response: { 200: FlagOutput },
      },
    },
    async (req) => {
      const row = await getFlag(db, req.params.key);
      if (!row) throw NotFound(`flag "${req.params.key}" not found`);
      return toFlagDTO(row);
    },
  );

  app.put(
    '/flags/:key',
    {
      schema: {
        tags: ['flags'],
        summary: 'Replace a flag definition',
        security: apiKeySecurity,
        params: z.object({ key: z.string().min(1) }),
        body: FlagInput,
        response: { 200: FlagOutput },
      },
    },
    async (req) => {
      // The path key takes precedence; patch the body key to match.
      const input = { ...req.body, key: req.params.key };
      const row = await updateFlag(db, cache, req.params.key, input, getActor(req));
      return toFlagDTO(row);
    },
  );

  app.patch(
    '/flags/:key',
    {
      schema: {
        tags: ['flags'],
        summary: 'Toggle a flag enabled/disabled',
        security: apiKeySecurity,
        params: z.object({ key: z.string().min(1) }),
        body: z.object({ enabled: z.boolean() }),
        response: { 200: FlagOutput },
      },
    },
    async (req) => {
      const row = await setEnabled(db, cache, req.params.key, req.body.enabled, getActor(req));
      return toFlagDTO(row);
    },
  );

  app.delete(
    '/flags/:key',
    {
      schema: {
        tags: ['flags'],
        summary: 'Archive a flag (soft delete)',
        security: apiKeySecurity,
        params: z.object({ key: z.string().min(1) }),
        response: { 204: z.void() },
      },
    },
    async (req, reply) => {
      await archiveFlag(db, cache, req.params.key, getActor(req));
      reply.code(204);
    },
  );

  app.get(
    '/flags/:key/audit',
    {
      schema: {
        tags: ['flags'],
        summary: 'Get audit log for a flag',
        security: apiKeySecurity,
        params: z.object({ key: z.string().min(1) }),
        response: { 200: z.array(AuditOutput) },
      },
    },
    async (req) => {
      const rows = await getFlagAudit(db, req.params.key);
      return rows.map(toAuditDTO);
    },
  );

  // -------------------------------------------------------------------------
  // Evaluation
  // -------------------------------------------------------------------------

  app.post(
    '/evaluate',
    {
      schema: {
        tags: ['evaluation'],
        summary: 'Evaluate a single flag for a context',
        security: apiKeySecurity,
        body: EvalInput,
        response: { 200: EvalResultOutput },
      },
    },
    async (req) => {
      const { flagKey, context, defaultValue } = req.body;
      const found = await loadDefinitionForEval(db, cache, flagKey);
      if (!found) {
        return {
          flagKey,
          value: defaultValue ?? null,
          variation: null,
          reason: { kind: 'FLAG_NOT_FOUND' },
          flagVersion: null,
        };
      }
      const result = evaluate(found.def, context);
      return {
        flagKey,
        value: result.value,
        variation: result.variation,
        reason: result.reason,
        flagVersion: found.version,
      };
    },
  );

  app.post(
    '/evaluate/all',
    {
      schema: {
        tags: ['evaluation'],
        summary: 'Evaluate all non-archived flags for a context (SDK bootstrap)',
        security: apiKeySecurity,
        body: EvalAllInput,
        response: { 200: EvalAllOutput },
      },
    },
    async (req) => {
      const { context } = req.body;
      const all = await loadAllForEval(db, cache);
      const flagsOut: Record<string, { value: JsonValue | null; variation: string | null; reason: { kind: string }; flagVersion: number | null }> = {};
      for (const { def, version } of all) {
        const result = evaluate(def, context);
        flagsOut[def.key] = {
          value: result.value,
          variation: result.variation,
          reason: result.reason,
          flagVersion: version,
        };
      }
      return { flags: flagsOut };
    },
  );
};

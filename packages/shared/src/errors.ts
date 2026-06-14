import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

/**
 * Application-level error carrying an HTTP status and a stable machine-readable code. Throw this
 * from routes/services; the shared error handler renders it as an RFC-7807 problem+json document.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly errors?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const NotFound = (detail: string) => new AppError(404, 'not_found', detail);
export const BadRequest = (detail: string, errors?: unknown) =>
  new AppError(400, 'bad_request', detail, errors);
export const Conflict = (detail: string) => new AppError(409, 'conflict', detail);

interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  errors?: unknown;
}

/**
 * Single error handler for every service. Maps:
 *   - Zod request-validation failures -> 400 with the field issues
 *   - AppError                        -> its declared status/code
 *   - anything else                   -> 500 (logged, never leaking internals to the client)
 * The response shape follows RFC 7807 (application/problem+json).
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      const problem: Problem = {
        type: 'about:blank',
        title: 'Validation Error',
        status: 400,
        detail: 'Request did not match the expected schema.',
        errors: err.validation,
      };
      return reply.code(400).type('application/problem+json').send(problem);
    }

    if (err instanceof AppError) {
      const problem: Problem = {
        type: 'about:blank',
        title: err.code,
        status: err.statusCode,
        detail: err.message,
        ...(err.errors !== undefined ? { errors: err.errors } : {}),
      };
      return reply.code(err.statusCode).type('application/problem+json').send(problem);
    }

    // Unexpected: log the real error server-side, return a generic 500 to the client.
    req.log.error({ err }, 'unhandled error');
    const status = typeof err.statusCode === 'number' && err.statusCode < 500 ? err.statusCode : 500;
    const problem: Problem = {
      type: 'about:blank',
      title: status === 500 ? 'Internal Server Error' : 'Request Error',
      status,
      detail: status === 500 ? 'An unexpected error occurred.' : err.message,
    };
    return reply.code(status).type('application/problem+json').send(problem);
  });
}

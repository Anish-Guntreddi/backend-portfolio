import { z } from 'zod';

/**
 * Parse and validate environment variables against a Zod schema, failing fast with a readable
 * error if anything is missing or malformed. Services define their own schema and call this once
 * at startup so a misconfigured container crashes immediately instead of midway through a request.
 */
export function loadEnv<T extends z.ZodTypeAny>(
  schema: T,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return parsed.data;
}

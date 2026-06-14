export { createClient } from './client.ts';
export type {
  ClientOptions,
  FlagForgeClient,
  EvalDetail,
  RemoteEvalResult,
  LooseContext,
} from './client.ts';

// Re-export key core types for convenience.
export type {
  FlagDefinition,
  EvalContext,
  EvalResult,
  EvalReason,
  JsonValue,
} from '@portfolio/flagforge-core';

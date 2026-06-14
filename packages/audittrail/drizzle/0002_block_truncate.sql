-- Extend append-only enforcement to TRUNCATE. The 0001 trigger only covers UPDATE/DELETE, leaving
-- a gap where a table owner could wipe the entire log with one TRUNCATE (and /verify would report a
-- valid, empty chain). Reuse the same block function via a statement-level BEFORE TRUNCATE trigger.
DROP TRIGGER IF EXISTS events_append_only_truncate ON "events";
--> statement-breakpoint
CREATE TRIGGER events_append_only_truncate
  BEFORE TRUNCATE ON "events"
  FOR EACH STATEMENT EXECUTE FUNCTION audittrail_block_mutation();
--> statement-breakpoint
-- Defense in depth: the app role was never granted TRUNCATE, but make that explicit.
REVOKE TRUNCATE ON "events" FROM audittrail_app;

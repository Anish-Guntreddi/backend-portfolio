-- Append-only enforcement, defense in depth:
--   (1) A trigger that raises on ANY UPDATE/DELETE against `events` — the real tamper-prevention
--       guarantee, catching even privileged mistakes by the table owner.
--   (2) A least-privilege role `audittrail_app` granted only SELECT + INSERT — the principle-of-
--       least-privilege layer the service connects as in production.
-- The /verify endpoint detects tampering that bypasses BOTH layers (e.g. disabling the trigger as
-- superuser, or storage-level edits). The integration suite exercises all three.

-- (1) Block mutations on the immutable log.
CREATE OR REPLACE FUNCTION audittrail_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS events_append_only ON "events";
--> statement-breakpoint
CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON "events"
  FOR EACH ROW EXECUTE FUNCTION audittrail_block_mutation();
--> statement-breakpoint
-- (2) Least-privilege application role.
-- DEMO CREDENTIALS ONLY: the password exists so the integration test can connect as a non-owner
-- and prove UPDATE/DELETE are rejected at the grant level. Production provisions this role and its
-- secret out-of-band (e.g. via your secrets manager), never in a committed migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audittrail_app') THEN
    CREATE ROLE audittrail_app LOGIN PASSWORD 'audittrail_app';
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO audittrail_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "events", "alert_rules", "alerts" TO audittrail_app;
--> statement-breakpoint
-- Required so INSERTs can advance the bigserial sequences. Deliberately NO UPDATE/DELETE.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO audittrail_app;

-- Applied by scripts/migrate.ts after every drizzle migration run. Must stay idempotent.
-- Tenant-owned tables: ENABLE + FORCE row-level security. A missing app.org_id means no rows.
-- NULLIF: after a transaction-local set_config commits, the setting reverts to '' (not NULL) for
-- the rest of the session, so '' must also match nothing (fail closed).
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['contact','audit_event','contact_permission_event','timeline_event','contact_duplicate_dismissal','task','notification','otto_draft','usage_event','provider_credential','call','call_event','voicemail','wallet','ledger_entry','phone_number','provider_balance_snapshot','provider_usage_record','reconciliation_report','setup_progress','number_quote','number_order'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (organization_id = NULLIF(current_setting('app.org_id', true), ''))
      WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), ''))$p$, t);
  END LOOP; END $$;

-- Runtime role. Superusers and BYPASSRLS roles ignore RLS, so the app connects as knoqra_app
-- (created by docker/postgres/init locally; created by hand in hosted Postgres, see deploy docs).
-- Only the public schema is granted: the drizzle migrations schema stays owner-only.
GRANT USAGE ON SCHEMA public TO knoqra_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO knoqra_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO knoqra_app;
-- Tables and sequences created later by the migrating role get the same privileges.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO knoqra_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO knoqra_app;

-- Append-only history: the app may only insert and read these tables. The single allowed update is
-- merge re-pointing contact_id. Must come AFTER the blanket GRANT above (which re-runs every time).
-- FK cascade deletes still work: referential actions run as the table owner.
REVOKE UPDATE, DELETE ON contact_permission_event, timeline_event, audit_event FROM knoqra_app;
GRANT UPDATE (contact_id) ON contact_permission_event, timeline_event TO knoqra_app;

-- M5: Otto drafts and usage events are append-only. Notifications are append-only except read_at.
REVOKE UPDATE, DELETE ON otto_draft, usage_event FROM knoqra_app;
REVOKE UPDATE, DELETE ON notification FROM knoqra_app;
GRANT UPDATE (read_at) ON notification TO knoqra_app;

-- M3 inbox: tenant tables, same ENABLE + FORCE + tenant_isolation policy as above.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['channel_connection','channel_route','conversation','message','message_status_event','message_template'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (organization_id = NULLIF(current_setting('app.org_id', true), ''))
      WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), ''))$p$, t);
  END LOOP; END $$;

-- The inbound consumer resolves an address to a tenant before it knows the tenant, so routes are
-- readable by everyone (no secrets in them). Writes stay tenant-checked by tenant_isolation.
DROP POLICY IF EXISTS route_lookup ON channel_route;
CREATE POLICY route_lookup ON channel_route FOR SELECT USING (true);

-- Messages are never deleted by the app; delivery events and routes are append-only.
-- Must come AFTER the blanket GRANT above (which re-runs every time).
REVOKE DELETE ON message FROM knoqra_app;
REVOKE UPDATE, DELETE ON message_status_event, channel_route FROM knoqra_app;

-- M2: call_event and ledger_entry are insert/read only. voicemail is never deleted and its only
-- allowed update is listened_at (the column grant must come after the table-level revoke).
REVOKE UPDATE, DELETE ON call_event, ledger_entry FROM knoqra_app;
REVOKE UPDATE, DELETE ON voicemail FROM knoqra_app;
GRANT UPDATE (listened_at) ON voicemail TO knoqra_app;

-- Migration status for the deep health check. The drizzle schema stays owner-only; this function is
-- the only window into it and returns counts only.
CREATE OR REPLACE FUNCTION public.knoqra_migration_status()
  RETURNS TABLE(applied int, last_created_at bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ select count(*)::int, max(created_at)::bigint from drizzle.__drizzle_migrations $$;
REVOKE ALL ON FUNCTION public.knoqra_migration_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.knoqra_migration_status() TO knoqra_app;

-- M4: balance snapshots, usage records and reconciliation reports are insert/read only.
REVOKE UPDATE, DELETE ON provider_balance_snapshot, provider_usage_record, reconciliation_report FROM knoqra_app;

-- M4b: quotes are insert/read only. Orders are never deleted and only their outcome columns change
-- (the column grant must come after the table-level revoke).
REVOKE UPDATE, DELETE ON number_quote FROM knoqra_app;
REVOKE UPDATE, DELETE ON number_order FROM knoqra_app;
GRANT UPDATE (status, provider_order_id, failure_code, updated_at) ON number_order TO knoqra_app;

-- Self-host licensing: instance_license is a one-row system table with no RLS (the blanket grant
-- above covers it); the key may be replaced but never deleted.
REVOKE DELETE ON instance_license FROM knoqra_app;

-- Messaging upgrade: attachments, reactions and US texting registrations are tenant tables with the
-- same ENABLE + FORCE + tenant_isolation policy. Attachments and registrations are never deleted by
-- the app (a draft attachment simply stays unsent); a removed reaction deletes its row.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['message_attachment','message_reaction','sms_registration'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (organization_id = NULLIF(current_setting('app.org_id', true), ''))
      WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), ''))$p$, t);
  END LOOP; END $$;
REVOKE DELETE ON message_attachment, sms_registration FROM knoqra_app;

-- Local development only. The app connects as this role so row-level security applies:
-- superusers and BYPASSRLS roles ignore RLS. Table privileges are granted by
-- packages/db/sql/rls.sql, which runs after every migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'knoqra_app') THEN
    CREATE ROLE knoqra_app LOGIN PASSWORD 'knoqra_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

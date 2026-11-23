-- M0: the private schema, the single-row instance table, and grant defaults.
-- Design doc section 3 ("Tables", "Grants"). Checked by supabase/tests/database/000_baseline.test.sql.

-- Helpers and instance state live here. PostgREST does not expose this schema.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Single-row instance state. The setup wizard (M5) claims the row.
create table private.instance (
  id boolean primary key default true check (id),
  admin_user_id uuid references auth.users (id),
  setup_completed_at timestamptz
);
revoke all on table private.instance from public, anon, authenticated;
insert into private.instance default values;

-- The API roles get nothing in public unless a later migration grants it explicitly.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

-- Supabase's default privileges grant new public tables, sequences and functions to the API
-- roles. Remove those grants for objects that migrations (run as postgres) create later.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;
-- Postgres grants execute on every new function to PUBLIC (which includes anon) as a global
-- default, and a per-schema revoke cannot remove a global default (Postgres docs, ALTER DEFAULT
-- PRIVILEGES). So this one is global: functions postgres creates in any schema start with no
-- execute grant, and each migration grants execute explicitly to the roles that need it.
alter default privileges for role postgres revoke execute on functions from public;

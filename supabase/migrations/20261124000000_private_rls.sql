-- Row level security on every private table, with no policies (defence in depth).
-- The API roles already have no usage on schema private and no grants on these tables, and
-- PostgREST does not expose the schema. RLS with no policies is a third lock: if a later
-- migration grants a table or exposes the schema by mistake, anon and authenticated still see
-- and change no rows. Checked by supabase/tests/database/000_baseline.test.sql.
--
-- The security definer functions that use these tables keep working: they run as postgres,
-- which owns the tables and has BYPASSRLS. FORCE ROW LEVEL SECURITY is not set, because it
-- would only restrict the owner, and postgres bypasses RLS through BYPASSRLS anyway.
alter table private.instance enable row level security;
alter table private.rate_limit_hits enable row level security;
alter table private.rate_limit_key enable row level security;

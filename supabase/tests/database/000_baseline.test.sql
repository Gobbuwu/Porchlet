-- Baseline checks that every later migration must keep passing.
-- Covers: private.instance, private.rate_limit_hits, private.rate_limit_key
begin;
select plan(25);

-- 1-3. Nothing in the API schemas is open by default.
-- private is included as defence in depth (migration 20261124000000_private_rls.sql).
select is_empty(
  $$ select c.oid::regclass::text
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'graphql_public', 'private') and c.relkind in ('r', 'p')
        and not c.relrowsecurity $$,
  'every table in public, graphql_public and private has row level security on');

select is_empty(
  $$ select c.oid::regclass::text || ' to ' || r.rolname
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
            cross join (values ('anon')) r (rolname)
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and has_table_privilege(r.rolname, c.oid, 'select,insert,update,delete,truncate,references,trigger') $$,
  'anon has no privileges on any table or view in public');

select results_eq(
  $$ select p.oid::regprocedure::text
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') order by 1 $$,
  $$ values ('rate_limit_release(text,bigint[])'), ('rate_limit_take(text,text,text[],integer[],integer[])') $$,
  'anon can execute only rate_limit_take() and rate_limit_release() in public (setup_status() is added in M5)');

-- 4-5. The private schema is closed to the API roles.
select ok(not has_schema_privilege('anon', 'private', 'usage'), 'anon has no usage on schema private');
select ok(not has_schema_privilege('authenticated', 'private', 'usage'),
  'authenticated has no usage on schema private (M2 grants it for the policy helpers)');

-- 6-11. private.instance: one row, no second row, no API access.
select has_table('private', 'instance', 'private.instance exists');
select is((select count(*)::int from private.instance), 1, 'private.instance has exactly one row');
select throws_ok($$ insert into private.instance default values $$, '23505', null,
  'a second private.instance row is rejected (primary key)');
select throws_ok($$ insert into private.instance (id) values (false) $$, '23514', null,
  'private.instance id must be true (check constraint)');
select ok(not has_table_privilege('anon', 'private.instance', 'select,insert,update,delete'),
  'anon has no privileges on private.instance');
select ok(not has_table_privilege('authenticated', 'private.instance', 'select,insert,update,delete'),
  'authenticated has no privileges on private.instance');

-- 12-16. Objects that later migrations create in public get no API grants by default.
-- The probes are rolled back with the transaction.
create table public.zz_default_privs_probe (id uuid primary key default gen_random_uuid());
create function public.zz_default_privs_probe_fn() returns int language sql as 'select 1';

select ok(not has_table_privilege('anon', 'public.zz_default_privs_probe',
  'select,insert,update,delete,truncate,references,trigger'), 'a new public table gets no anon grants');
select ok(not has_table_privilege('authenticated', 'public.zz_default_privs_probe',
  'select,insert,update,delete,truncate,references,trigger'), 'a new public table gets no authenticated grants');
select ok(not has_function_privilege('anon', 'public.zz_default_privs_probe_fn()', 'execute'),
  'a new public function is not executable by anon');
select ok(not has_function_privilege('authenticated', 'public.zz_default_privs_probe_fn()', 'execute'),
  'a new public function is not executable by authenticated');
select is(current_user::text, 'postgres',
  'tests run as postgres, the role whose default privileges the migration changes');

-- 17. pgTAP still works after switching to an API role (M2's policy tests rely on this).
set local role authenticated;
select ok(true, 'pgTAP functions run as authenticated');
reset role;

-- 18-25. RLS on private tables, with no policies, is a lock behind the missing grants.
-- No policy may exist: a policy here would open rows to whoever a later grant reaches.
select is_empty(
  $$ select schemaname || '.' || tablename || ' ' || policyname from pg_policies where schemaname = 'private' $$,
  'no table in private has a policy');

-- The security definer functions run as postgres. They keep working because postgres owns the
-- tables and has BYPASSRLS, and no private table forces RLS on its owner.
select ok((select rolbypassrls from pg_roles where rolname = 'postgres'), 'postgres has BYPASSRLS');
select is_empty(
  $$ select c.oid::regclass::text || ' owned by ' || pg_get_userbyid(c.relowner)
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'private' and c.relkind in ('r', 'p')
        and (pg_get_userbyid(c.relowner) <> 'postgres' or c.relforcerowsecurity) $$,
  'every private table is owned by postgres and does not force RLS');

-- Simulate the mistake RLS guards against: grant authenticated the schema and the tables (rolled
-- back with the transaction), then check it still sees and writes nothing. Each table gets a row
-- first so that "sees nothing" means RLS hid it.
insert into private.rate_limit_hits (bucket) values ('baseline|probe');
delete from private.rate_limit_key;
insert into private.rate_limit_key (key_hash) values (extensions.digest('baseline-probe', 'sha256'));
grant usage on schema private to authenticated;
grant select, insert, update, delete on private.instance, private.rate_limit_hits, private.rate_limit_key
  to authenticated;

set local role authenticated;
select is((select count(*)::int from private.instance), 0,
  'with a mistaken grant, authenticated still reads no private.instance row');
select is((select count(*)::int from private.rate_limit_hits), 0,
  'with a mistaken grant, authenticated still reads no private.rate_limit_hits row');
select is((select count(*)::int from private.rate_limit_key), 0,
  'with a mistaken grant, authenticated still reads no private.rate_limit_key row');
select throws_ok($$ insert into private.rate_limit_hits (bucket) values ('forged') $$, '42501', null,
  'with a mistaken grant, authenticated still cannot insert into private.rate_limit_hits');
select is_empty($$ update private.instance set setup_completed_at = now() returning id $$,
  'with a mistaken grant, authenticated still cannot update private.instance');
reset role;

select * from finish();
rollback;

-- Baseline checks that every later migration must keep passing.
-- Covers: private.instance
begin;
select plan(17);

-- 1-3. Nothing in the API schemas is open by default.
select is_empty(
  $$ select c.oid::regclass::text
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'graphql_public') and c.relkind in ('r', 'p')
        and not c.relrowsecurity $$,
  'every table in public and graphql_public has row level security on');

select is_empty(
  $$ select c.oid::regclass::text || ' to ' || r.rolname
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
            cross join (values ('anon')) r (rolname)
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and has_table_privilege(r.rolname, c.oid, 'select,insert,update,delete,truncate,references,trigger') $$,
  'anon has no privileges on any table or view in public');

select is_empty(
  $$ select p.oid::regprocedure::text
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') $$,
  'anon can execute no function in public (setup_status() is added in M5)');

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

select * from finish();
rollback;

-- Measures the M2 policies on seeded data (ADR 0006, M2.md). Local stack only; everything is
-- rolled back. Run: psql "$DB_URL" -X -q -f scripts/dev/policy-perf.sql
-- Seed: 10,000 users, 1,000 workspaces each with an owner and 20 projects (20,000 projects).
-- The measured user owns workspace 1 and is a client of workspaces 2 to 5 (100 projects visible).
-- Each case runs 5 times; the lines print each run's Execution Time. "Index scans off" forces a
-- sequential scan, the case where a per-row auth.uid() call would cost most.
begin;
insert into auth.users (id, email)
  select ('00000000-0000-4000-b000-' || lpad(g::text, 12, '0'))::uuid, 'u' || g || '@example.test'
    from generate_series(1, 10000) g;
insert into public.workspaces (id, name, created_by)
  select ('00000000-0000-4000-c000-' || lpad(g::text, 12, '0'))::uuid, 'w' || g,
         ('00000000-0000-4000-b000-' || lpad(g::text, 12, '0'))::uuid
    from generate_series(1, 1000) g;
insert into public.workspace_members (workspace_id, user_id, role)
  select ('00000000-0000-4000-c000-' || lpad(g::text, 12, '0'))::uuid,
         ('00000000-0000-4000-b000-' || lpad(g::text, 12, '0'))::uuid, 'owner'
    from generate_series(1, 1000) g;
insert into public.workspace_members (workspace_id, user_id, role)
  select ('00000000-0000-4000-c000-' || lpad(((g % 1000) + 1)::text, 12, '0'))::uuid,
         ('00000000-0000-4000-b000-' || lpad(g::text, 12, '0'))::uuid, 'client'
    from generate_series(1001, 10000) g;
insert into public.workspace_members (workspace_id, user_id, role)
  select ('00000000-0000-4000-c000-' || lpad(g::text, 12, '0'))::uuid,
         '00000000-0000-4000-b000-000000000001', 'client'
    from generate_series(2, 5) g;
insert into public.projects (workspace_id, name)
  select w.id, 'p' || k from public.workspaces w, generate_series(1, 20) k;
analyze public.projects, public.workspace_members, public.workspaces, public.profiles;

create temp table results (case_name text, rows_seen bigint, runs text);
grant select, insert on results to authenticated;

create function pg_temp.exec_ms(q text) returns text language plpgsql as $$
declare r text; line text; out text := ''; n int;
begin
  for n in 1..5 loop
    for line in execute 'explain (analyze, costs off, summary on) ' || q loop
      if line like 'Execution Time%' then out := out || ' ' || regexp_replace(line, '[^0-9.]', '', 'g'); end if;
    end loop;
  end loop;
  return btrim(out) || ' ms';
end $$;
grant execute on function pg_temp.exec_ms(text) to authenticated;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-b000-000000000001","role":"authenticated"}', true);
insert into results select 'projects, all (set-based policy, as migrated)',
  (select count(*) from public.projects), pg_temp.exec_ms('select * from public.projects');
insert into results select 'projects, one workspace (set-based policy, as migrated)',
  (select count(*) from public.projects where workspace_id = '00000000-0000-4000-c000-000000000003'),
  pg_temp.exec_ms($q$select * from public.projects where workspace_id = '00000000-0000-4000-c000-000000000003'$q$);
insert into results select 'profiles, all (own + co-member policies, as migrated)',
  (select count(*) from public.profiles), pg_temp.exec_ms('select * from public.profiles');
insert into results select 'workspace_members, all (as migrated)',
  (select count(*) from public.workspace_members), pg_temp.exec_ms('select * from public.workspace_members');
reset role;

-- Alternative 1: a per-row boolean helper, as the design doc first wrote the policies.
create function private.perf_is_member(ws uuid) returns boolean language sql stable security definer
  set search_path = '' as $$
  select exists (select 1 from public.workspace_members m
                  where m.workspace_id = ws and m.user_id = (select auth.uid())); $$;
grant execute on function private.perf_is_member(uuid) to authenticated;
alter policy projects_select_member on public.projects using (private.perf_is_member(workspace_id));
set local role authenticated;
insert into results select 'projects, all (per-row is_member policy)',
  (select count(*) from public.projects), pg_temp.exec_ms('select * from public.projects');
insert into results select 'projects, one workspace (per-row is_member policy)',
  (select count(*) from public.projects where workspace_id = '00000000-0000-4000-c000-000000000003'),
  pg_temp.exec_ms($q$select * from public.projects where workspace_id = '00000000-0000-4000-c000-000000000003'$q$);
reset role;

-- Alternative 2: auth.uid() called per row instead of (select auth.uid()) once per statement.
drop policy profiles_select_co_member on public.profiles;
set local role authenticated;
insert into results select 'profiles, own only, (select auth.uid()) as migrated',
  (select count(*) from public.profiles), pg_temp.exec_ms('select * from public.profiles');
set local enable_indexscan = off;
set local enable_bitmapscan = off;
insert into results select 'profiles, own only, (select auth.uid()), index scans off',
  (select count(*) from public.profiles), pg_temp.exec_ms('select * from public.profiles');
reset enable_indexscan;
reset enable_bitmapscan;
reset role;
alter policy profiles_select_own on public.profiles using (id = auth.uid());
set local role authenticated;
insert into results select 'profiles, own only, bare auth.uid()',
  (select count(*) from public.profiles), pg_temp.exec_ms('select * from public.profiles');
set local enable_indexscan = off;
set local enable_bitmapscan = off;
insert into results select 'profiles, own only, bare auth.uid(), index scans off',
  (select count(*) from public.profiles), pg_temp.exec_ms('select * from public.profiles');
reset enable_indexscan;
reset enable_bitmapscan;
reset role;

select case_name, rows_seen, runs from results;
rollback;

-- Workspaces, members and projects: tables, grants, helpers, every policy, create_workspace,
-- list_workspace_members, and the profiles select widened to co-members. Invitations are in
-- 050_invitations.test.sql.
-- Covers: public.workspaces, public.workspace_members, public.projects
begin;
select plan(90);

-- Users: A is the instance admin and owns X; C is a client of X; B owns Y; D is a client of Y;
-- E belongs to nothing.
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-a000-00000000000a', 'a@example.test', now()),
  ('00000000-0000-4000-a000-00000000000b', 'b@example.test', now()),
  ('00000000-0000-4000-a000-00000000000c', 'c@example.test', now()),
  ('00000000-0000-4000-a000-00000000000d', 'd@example.test', now()),
  ('00000000-0000-4000-a000-00000000000e', 'e@example.test', now());
update public.profiles set display_name = 'Alice' where id = '00000000-0000-4000-a000-00000000000a';
update private.instance set admin_user_id = '00000000-0000-4000-a000-00000000000a';

-- Y is made directly (as postgres), X through create_workspace below.
insert into public.workspaces (id, name, created_by) values
  ('00000000-0000-4000-c000-0000000000f2', 'Y', '00000000-0000-4000-a000-00000000000b');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('00000000-0000-4000-c000-0000000000f2', '00000000-0000-4000-a000-00000000000b', 'owner'),
  ('00000000-0000-4000-c000-0000000000f2', '00000000-0000-4000-a000-00000000000d', 'client');
insert into public.projects (id, workspace_id, name) values
  ('00000000-0000-4000-d000-0000000000f2', '00000000-0000-4000-c000-0000000000f2', 'Y project');

-- Ids made during the test, readable as authenticated.
create temp table ids (name text primary key, id uuid);
grant select, insert on ids to authenticated;

-- 1-5. Tables and RLS.
select has_table('public', 'workspaces', 'public.workspaces exists');
select has_table('public', 'workspace_members', 'public.workspace_members exists');
select has_table('public', 'projects', 'public.projects exists');
select col_is_pk('public', 'workspace_members', array['workspace_id', 'user_id'],
  'workspace_members is keyed by (workspace_id, user_id)');
select is_empty(
  $$ select c.relname from pg_class c
      where c.oid in ('public.workspaces'::regclass, 'public.workspace_members'::regclass,
                      'public.invitations'::regclass, 'public.projects'::regclass)
        and not c.relrowsecurity $$,
  'row level security is on for workspaces, workspace_members, invitations and projects');

-- 6. Every policy on the M2 tables and profiles: name, command, permissive, role. Nothing else.
select results_eq(
  $$ select c.relname::text || '.' || p.polname::text || ':' || p.polcmd::text || ':' || p.polpermissive::text || ':'
            || array_to_string(array(select r::regrole::text from unnest(p.polroles) r), ',') collate "default"
       from pg_policy p join pg_class c on c.oid = p.polrelid
      where c.oid in ('public.workspaces'::regclass, 'public.workspace_members'::regclass,
                      'public.invitations'::regclass, 'public.projects'::regclass,
                      'public.profiles'::regclass)
      order by 1 $$,
  $$ values ('invitations.invitations_delete_owner:d:true:authenticated'),
            ('invitations.invitations_select_owner:r:true:authenticated'),
            ('profiles.profiles_select_co_member:r:true:authenticated'),
            ('profiles.profiles_select_own:r:true:authenticated'),
            ('profiles.profiles_update_own:w:true:authenticated'),
            ('projects.projects_delete_owner:d:true:authenticated'),
            ('projects.projects_insert_owner:a:true:authenticated'),
            ('projects.projects_select_member:r:true:authenticated'),
            ('projects.projects_update_owner:w:true:authenticated'),
            ('workspace_members.workspace_members_delete_owner_or_self:d:true:authenticated'),
            ('workspace_members.workspace_members_select_member:r:true:authenticated'),
            ('workspaces.workspaces_select_member:r:true:authenticated'),
            ('workspaces.workspaces_update_owner:w:true:authenticated') $$,
  'the M2 tables and profiles have exactly the expected policies, all permissive, for authenticated');

-- 7-10. Grants: table level, and column level for insert, update and select.
select results_eq(
  $$ select (t.relname || ':' || string_agg(p.priv, ',' order by p.priv)) collate "default"
       from (values ('workspaces'), ('workspace_members'), ('invitations'), ('projects')) t (relname)
       cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
                          ('REFERENCES'), ('TRIGGER')) p (priv)
      where has_table_privilege('authenticated', 'public.' || t.relname, p.priv)
      group by t.relname order by 1 $$,
  $$ values ('invitations:DELETE'), ('projects:DELETE,SELECT'), ('workspace_members:DELETE,SELECT'),
            ('workspaces:SELECT') $$,
  'authenticated has table-level SELECT on workspaces, SELECT and DELETE on members and projects, DELETE only on invitations');
select results_eq(
  $$ select (c.table_name::text || '.' || c.column_name::text || ':' || p.priv) collate "default"
       from information_schema.columns c
       cross join (values ('INSERT'), ('UPDATE')) p (priv)
      where c.table_schema = 'public'
        and c.table_name in ('workspaces', 'workspace_members', 'invitations', 'projects')
        and has_column_privilege('authenticated', 'public.' || c.table_name, c.column_name, p.priv)
      order by 1 $$,
  $$ values ('projects.name:INSERT'), ('projects.name:UPDATE'), ('projects.status:UPDATE'),
            ('projects.workspace_id:INSERT'), ('workspaces.name:UPDATE') $$,
  'authenticated may insert only projects (workspace_id, name) and update only projects (name, status) and workspaces (name)');
select results_eq(
  $$ select c.column_name::text collate "default" from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = 'invitations'
        and has_column_privilege('authenticated', 'public.invitations', c.column_name, 'SELECT')
      order by 1 $$,
  $$ values ('accepted_at'), ('created_at'), ('email'), ('expires_at'), ('id'), ('invited_by'),
            ('workspace_id') $$,
  'authenticated may select every invitations column except token_hash');
select is_empty(
  $$ select t from (values ('workspaces'), ('workspace_members'), ('invitations'), ('projects')) v (t)
      where has_any_column_privilege('anon', 'public.' || t, 'select,insert,update,references') $$,
  'anon has no privileges on the M2 tables');

-- 11-13. Functions: security definer with an empty search_path; who may execute them.
select is_empty(
  $$ select p.oid::regprocedure::text from pg_proc p
      where p.oid in ('private.member_workspace_ids()'::regprocedure, 'private.owner_workspace_ids()'::regprocedure,
                      'private.co_member_ids()'::regprocedure, 'private.is_owner(uuid)'::regprocedure,
                      'public.create_workspace(text)'::regprocedure,
                      'public.create_invitation(uuid,text)'::regprocedure,
                      'public.accept_invitation(text)'::regprocedure,
                      'public.list_workspace_members(uuid)'::regprocedure)
        and (not p.prosecdef or p.proconfig is distinct from array['search_path=""']) $$,
  'every M2 function is security definer with search_path pinned to empty');
select results_eq(
  $$ select p.oid::regprocedure::text
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute') order by 1 $$,
  $$ values ('accept_invitation(text)'), ('create_invitation(uuid,text)'), ('create_workspace(text)'),
            ('list_workspace_members(uuid)'), ('rate_limit_release(text,bigint[])'),
            ('rate_limit_take(text,text,text[],integer[],integer[])') $$,
  'authenticated can execute exactly the four M2 RPCs and the two limiter functions in public');
select ok(not has_function_privilege('authenticated', 'private.is_owner(uuid)', 'execute'),
  'authenticated cannot execute private.is_owner (used only inside the RPCs)');

-- 14-19. create_workspace.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000b","role":"authenticated"}', true);
select throws_ok($$ select public.create_workspace('B''s own') $$, '42501', 'not_allowed',
  'a user who is not the instance admin cannot create a workspace');
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.create_workspace('nobody') $$, '42501', 'not_allowed',
  'a JWT with no sub cannot create a workspace');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);
select lives_ok($$ insert into ids select 'X', public.create_workspace('X') $$,
  'the instance admin creates workspace X');
select results_eq(
  $$ select m.user_id, m.role from public.workspace_members m where m.workspace_id = (select id from ids where name = 'X') $$,
  $$ values ('00000000-0000-4000-a000-00000000000a'::uuid, 'owner') $$,
  'create_workspace made the admin the owner, and the only member');
select throws_ok($$ select public.create_workspace('') $$, '23514', null, 'an empty workspace name is rejected');
select throws_ok($$ select public.create_workspace(repeat('x', 81)) $$, '23514', null,
  'a workspace name over 80 characters is rejected');
reset role;

-- C joins X as a client (invitations are tested in 050).
insert into public.workspace_members (workspace_id, user_id, role)
  select id, '00000000-0000-4000-a000-00000000000c', 'client' from ids where name = 'X';

-- 20-21. anon can't call the RPCs.
set local role anon;
select throws_ok($$ select public.create_workspace('anon') $$, '42501', null, 'anon cannot call create_workspace');
select throws_ok($$ select * from public.workspaces $$, '42501', null, 'anon cannot read workspaces');
reset role;

set local role authenticated;

-- 22-28. Workspaces: members see theirs, nobody sees others'.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);
select results_eq($$ select name from public.workspaces $$, $$ values ('X') $$, 'owner A sees only X');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000c","role":"authenticated"}', true);
select results_eq($$ select name from public.workspaces $$, $$ values ('X') $$, 'client C sees only X');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000b","role":"authenticated"}', true);
select results_eq($$ select name from public.workspaces $$, $$ values ('Y') $$, 'owner B sees only Y');
select is_empty($$ select 1 from public.workspaces where id = (select id from ids where name = 'X') $$,
  'B cannot read X by id');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000e","role":"authenticated"}', true);
select is_empty($$ select 1 from public.workspaces $$, 'outsider E sees no workspace');
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select is_empty($$ select 1 from public.workspaces $$, 'a JWT with no sub sees no workspace');
select is_empty($$ select 1 from public.workspace_members $$, 'a JWT with no sub sees no membership');

-- 29-36. Workspaces: only the owner renames; nothing else is writable.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);
select results_eq(
  $$ update public.workspaces set name = 'X renamed' where id = (select id from ids where name = 'X') returning name $$,
  $$ values ('X renamed') $$, 'owner A renames X');
select is_empty(
  $$ update public.workspaces set name = 'hacked' where id = '00000000-0000-4000-c000-0000000000f2' returning id $$,
  'A''s rename of Y matches no rows');
select throws_ok($$ update public.workspaces set created_by = '00000000-0000-4000-a000-00000000000e' $$,
  '42501', null, 'created_by cannot be changed (column privilege)');
select throws_ok($$ update public.workspaces set storage_quota_bytes = 1e12 $$,
  '42501', null, 'storage_quota_bytes cannot be changed (column privilege)');
select throws_ok($$ insert into public.workspaces (name, created_by) values ('direct', '00000000-0000-4000-a000-00000000000a') $$,
  '42501', null, 'workspaces cannot be inserted directly, even by the admin');
select throws_ok($$ delete from public.workspaces $$, '42501', null, 'workspaces cannot be deleted');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000c","role":"authenticated"}', true);
-- With no WHERE or RETURNING only the update policy decides which rows change; test 37 checks.
select lives_ok($$ update public.workspaces set name = 'client was here' $$,
  'client C can run an update on workspaces with no WHERE clause');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000b","role":"authenticated"}', true);
select lives_ok($$ update public.workspaces set name = 'B was here' $$,
  'owner B can run an update on workspaces with no WHERE clause');
reset role;

-- 37. After the blanket updates only B's own workspace changed.
select results_eq($$ select name from public.workspaces order by name $$,
  $$ values ('B was here'), ('X renamed') $$,
  'the client''s blanket update changed nothing, and the owner''s changed only their own workspace');
update public.workspaces set name = 'Y' where id = '00000000-0000-4000-c000-0000000000f2';

set local role authenticated;

-- 38-48. Members: co-members see the membership list; nobody can add or change a membership.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000c","role":"authenticated"}', true);
select results_eq($$ select user_id, role from public.workspace_members order by role desc $$,
  $$ values ('00000000-0000-4000-a000-00000000000a'::uuid, 'owner'),
            ('00000000-0000-4000-a000-00000000000c'::uuid, 'client') $$,
  'client C sees X''s two memberships and none of Y''s');
select throws_ok($$ update public.workspace_members set role = 'owner' where user_id = '00000000-0000-4000-a000-00000000000c' $$,
  '42501', null, 'client C cannot make themselves owner (no update grant)');
select throws_ok(
  $$ insert into public.workspace_members (workspace_id, user_id, role)
     values ('00000000-0000-4000-c000-0000000000f2', '00000000-0000-4000-a000-00000000000c', 'owner') $$,
  '42501', null, 'client C cannot add themselves to Y (no insert grant)');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000e","role":"authenticated"}', true);
select throws_ok(
  $$ insert into public.workspace_members (workspace_id, user_id, role)
     select id, '00000000-0000-4000-a000-00000000000e', 'client' from ids where name = 'X' $$,
  '42501', null, 'outsider E cannot add themselves to X');
select is_empty($$ select 1 from public.workspace_members $$, 'outsider E sees no memberships');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000c","role":"authenticated"}', true);
select is_empty(
  $$ delete from public.workspace_members where user_id = '00000000-0000-4000-a000-00000000000a' returning user_id $$,
  'client C cannot remove owner A');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);
select is_empty(
  $$ delete from public.workspace_members where user_id = '00000000-0000-4000-a000-00000000000a' returning user_id $$,
  'owner A cannot remove themselves (the workspace keeps its owner)');
select is_empty(
  $$ delete from public.workspace_members where user_id = '00000000-0000-4000-a000-00000000000d' returning user_id $$,
  'owner A cannot remove D, a client of Y');
-- A filter or RETURNING also applies the select policy, which would hide a delete policy that let
-- an owner delete any workspace's rows. With neither, only the delete policy decides.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000b","role":"authenticated"}', true);
select lives_ok($$ delete from public.workspace_members $$,
  'owner B can run a delete on memberships with no WHERE clause');
reset role;
select results_eq(
  $$ select user_id from public.workspace_members where workspace_id = (select id from ids where name = 'X') order by user_id $$,
  $$ values ('00000000-0000-4000-a000-00000000000a'::uuid), ('00000000-0000-4000-a000-00000000000c'::uuid) $$,
  'owner B''s blanket delete removed none of X''s memberships');
select results_eq(
  $$ select user_id from public.workspace_members where workspace_id = '00000000-0000-4000-c000-0000000000f2' $$,
  $$ values ('00000000-0000-4000-a000-00000000000b'::uuid) $$,
  'owner B''s blanket delete removed only Y''s client D, not B');
insert into public.workspace_members (workspace_id, user_id, role)
  values ('00000000-0000-4000-c000-0000000000f2', '00000000-0000-4000-a000-00000000000d', 'client');
set local role authenticated;

-- 49-52. Profiles: co-members see each other; nobody else does.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000c","role":"authenticated"}', true);
select results_eq($$ select id, display_name from public.profiles order by id $$,
  $$ values ('00000000-0000-4000-a000-00000000000a'::uuid, 'Alice'),
            ('00000000-0000-4000-a000-00000000000c'::uuid, '') $$,
  'client C sees their own profile and owner A''s, not Y''s members''');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000b","role":"authenticated"}', true);
select results_eq($$ select id from public.profiles order by id $$,
  $$ values ('00000000-0000-4000-a000-00000000000b'::uuid), ('00000000-0000-4000-a000-00000000000d'::uuid) $$,
  'owner B sees only Y''s members'' profiles');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000e","role":"authenticated"}', true);
select results_eq($$ select id from public.profiles $$, $$ values ('00000000-0000-4000-a000-00000000000e'::uuid) $$,
  'outsider E sees only their own profile');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000c","role":"authenticated"}', true);
select is_empty(
  $$ update public.profiles set display_name = 'hacked' where id = '00000000-0000-4000-a000-00000000000a' returning id $$,
  'a co-member can read but not update another member''s profile');

-- 53-69. Projects: the owner writes, members read, nobody crosses workspaces.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);
select lives_ok(
  $$ with p as (
       insert into public.projects (workspace_id, name) select id, 'X project' from ids where name = 'X'
       returning id)
     insert into ids select 'PX', p.id from p $$,
  'owner A creates a project in X');
select throws_ok(
  $$ insert into public.projects (workspace_id, name) values ('00000000-0000-4000-c000-0000000000f2', 'into Y') $$,
  '42501', null, 'owner A cannot create a project in Y');
select throws_ok(
  $$ insert into public.projects (id, workspace_id, name)
     select '00000000-0000-4000-d000-00000000000f', id, 'chosen id' from ids where name = 'X' $$,
  '42501', null, 'a project id cannot be chosen by the caller (column privilege)');
select results_eq(
  $$ update public.projects set name = 'X project 2', status = 'archived'
      where id = (select id from ids where name = 'PX') returning name, status $$,
  $$ values ('X project 2', 'archived') $$, 'owner A renames and archives X''s project');
select throws_ok(
  $$ update public.projects set status = 'deleted' where id = (select id from ids where name = 'PX') $$,
  '23514', null, 'a project status other than active or archived is rejected');
select throws_ok(
  $$ update public.projects set workspace_id = '00000000-0000-4000-c000-0000000000f2'
      where id = (select id from ids where name = 'PX') $$,
  '42501', null, 'a project cannot be moved to another workspace (column privilege)');
select is_empty(
  $$ update public.projects set name = 'hacked' where id = '00000000-0000-4000-d000-0000000000f2' returning id $$,
  'owner A cannot rename Y''s project');
select is_empty(
  $$ delete from public.projects where id = '00000000-0000-4000-d000-0000000000f2' returning id $$,
  'owner A cannot delete Y''s project');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000c","role":"authenticated"}', true);
select results_eq($$ select name from public.projects $$, $$ values ('X project 2') $$,
  'client C sees X''s project and not Y''s');
select throws_ok(
  $$ insert into public.projects (workspace_id, name) select id, 'client project' from ids where name = 'X' $$,
  '42501', null, 'client C cannot create a project');
select is_empty(
  $$ update public.projects set name = 'client rename' where id = (select id from ids where name = 'PX') returning id $$,
  'client C cannot rename a project');
select lives_ok($$ update public.projects set name = 'client blanket' $$,
  'client C can run an update on projects with no WHERE clause');
select is_empty($$ delete from public.projects returning id $$, 'client C cannot delete any project');
select lives_ok($$ delete from public.projects $$, 'client C can run a delete on projects with no WHERE clause');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000e","role":"authenticated"}', true);
select is_empty($$ select 1 from public.projects $$, 'outsider E sees no project');
-- Owner B's unfiltered writes may touch only Y's project (see the memberships note above).
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000b","role":"authenticated"}', true);
select lives_ok($$ update public.projects set name = 'B blanket' $$,
  'owner B can run an update on projects with no WHERE clause');
select lives_ok($$ delete from public.projects $$, 'owner B can run a delete on projects with no WHERE clause');
reset role;

-- 70. The blanket writes changed nothing of X's.
select results_eq($$ select name from public.projects order by name $$,
  $$ values ('X project 2') $$,
  'the client''s and owner B''s blanket writes left X''s project as it was; B''s delete removed only Y''s');
insert into public.projects (id, workspace_id, name) values
  ('00000000-0000-4000-d000-0000000000f2', '00000000-0000-4000-c000-0000000000f2', 'Y project');

set local role authenticated;

-- 71-77. list_workspace_members: owners only, with emails.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);
select results_eq(
  $$ select user_id, role, display_name, email from public.list_workspace_members((select id from ids where name = 'X')) $$,
  $$ values ('00000000-0000-4000-a000-00000000000a'::uuid, 'owner', 'Alice', 'a@example.test'),
            ('00000000-0000-4000-a000-00000000000c'::uuid, 'client', '', 'c@example.test') $$,
  'owner A lists X''s members with their emails');
select throws_ok($$ select * from public.list_workspace_members('00000000-0000-4000-c000-0000000000f2') $$,
  '42501', 'not_allowed', 'owner A cannot list Y''s members');
select throws_ok($$ select * from public.list_workspace_members(null) $$, '42501', 'not_allowed',
  'a null workspace id is refused');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000c","role":"authenticated"}', true);
select throws_ok($$ select * from public.list_workspace_members((select id from ids where name = 'X')) $$,
  '42501', 'not_allowed', 'client C cannot list members'' emails (decision D3)');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000e","role":"authenticated"}', true);
select throws_ok($$ select * from public.list_workspace_members((select id from ids where name = 'X')) $$,
  '42501', 'not_allowed', 'outsider E cannot list X''s members');
select throws_ok($$ select * from public.list_workspace_members(gen_random_uuid()) $$,
  '42501', 'not_allowed', 'a workspace that does not exist answers the same as one you are not in');
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select * from public.list_workspace_members((select id from ids where name = 'X')) $$,
  '42501', 'not_allowed', 'a JWT with no sub cannot list members');

-- 78-83. A removed client loses access at once (T11); the profile view narrows with it.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);
select results_eq(
  $$ delete from public.workspace_members where user_id = '00000000-0000-4000-a000-00000000000c' returning user_id $$,
  $$ values ('00000000-0000-4000-a000-00000000000c'::uuid) $$, 'owner A removes client C');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000c","role":"authenticated"}', true);
select is_empty($$ select 1 from public.workspaces $$, 'removed client C sees no workspace');
select is_empty($$ select 1 from public.projects $$, 'removed client C sees no project');
select is_empty($$ select 1 from public.workspace_members $$, 'removed client C sees no membership');
select results_eq($$ select id from public.profiles $$, $$ values ('00000000-0000-4000-a000-00000000000c'::uuid) $$,
  'removed client C sees only their own profile');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);
select results_eq($$ select id from public.profiles $$, $$ values ('00000000-0000-4000-a000-00000000000a'::uuid) $$,
  'owner A no longer sees removed client C''s profile');

-- 84-87. A client can leave; a blanket delete by a client removes only their own membership.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000d","role":"authenticated"}', true);
select results_eq($$ delete from public.workspace_members returning user_id $$,
  $$ values ('00000000-0000-4000-a000-00000000000d'::uuid) $$,
  'client D''s delete with no WHERE removes only D''s own membership (leaving Y)');
select is_empty($$ select 1 from public.workspaces $$, 'after leaving, D sees no workspace');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000b","role":"authenticated"}', true);
select results_eq($$ select user_id from public.workspace_members $$,
  $$ values ('00000000-0000-4000-a000-00000000000b'::uuid) $$, 'owner B is still Y''s owner');
select is_empty($$ delete from public.workspace_members returning user_id $$,
  'owner B''s delete with no WHERE removes nobody (owners cannot remove themselves)');
reset role;

-- 88-90. Deleting things cascades as designed.
select lives_ok($$ delete from auth.users where id = '00000000-0000-4000-a000-00000000000d' $$,
  'a client''s auth user can be deleted');
select throws_ok($$ delete from auth.users where id = '00000000-0000-4000-a000-00000000000b' $$, '23503', null,
  'an owner who created a workspace cannot be deleted while the workspace exists (created_by)');
delete from public.workspaces where id = '00000000-0000-4000-c000-0000000000f2';
select is_empty(
  $$ select 1 from public.workspace_members where workspace_id = '00000000-0000-4000-c000-0000000000f2'
     union all select 1 from public.projects where workspace_id = '00000000-0000-4000-c000-0000000000f2' $$,
  'deleting a workspace deletes its memberships and projects');

select * from finish();
rollback;

-- public.profiles: the sign-up trigger, grants, and every RLS policy.
-- Covers: public.profiles
begin;
select plan(36);

-- Two users, created the way sign-up creates them: an insert into auth.users, which fires the
-- trigger. (Tests run as postgres, which can't switch to supabase_auth_admin; a real sign-up
-- through Supabase Auth is checked in docs/milestones/M1.md.)
insert into auth.users (id, email) values
  ('00000000-0000-4000-a000-00000000000a', 'a@example.test'),
  ('00000000-0000-4000-a000-00000000000b', 'b@example.test');

-- 1-4. Table and RLS.
select has_table('public', 'profiles', 'public.profiles exists');
select col_is_pk('public', 'profiles', 'id', 'profiles.id is the primary key');
select fk_ok('public', 'profiles', 'id', 'auth', 'users', 'id', 'profiles.id references auth.users(id)');
select ok((select relrowsecurity from pg_class where oid = 'public.profiles'::regclass),
  'row level security is on for public.profiles');

-- 5-6. Exactly the expected policies, nothing else. Co-member reads are tested in 040_workspaces.
select policies_are('public', 'profiles',
  array['profiles_select_co_member', 'profiles_select_own', 'profiles_update_own'],
  'public.profiles has only the select-own, select-co-member (M2) and update-own policies');
select is(
  (select array_agg(p.polname || ':' || p.polcmd::text || ':' || p.polpermissive::text || ':'
                    || array_to_string(array(select r::regrole::text from unnest(p.polroles) r), ',')
                    order by p.polname)
     from pg_policy p where p.polrelid = 'public.profiles'::regclass),
  array['profiles_select_co_member:r:true:authenticated', 'profiles_select_own:r:true:authenticated',
        'profiles_update_own:w:true:authenticated'],
  'all three policies are permissive, for authenticated only, on select and update');

-- 7-14. Grants: authenticated may select and update display_name only; anon gets nothing.
select table_privs_are('public', 'profiles', 'anon', array[]::text[], 'anon has no table privileges');
select table_privs_are('public', 'profiles', 'authenticated', array['SELECT'],
  'authenticated has only SELECT at table level');
select ok(has_column_privilege('authenticated', 'public.profiles', 'display_name', 'update'),
  'authenticated can update display_name');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'id', 'update'),
  'authenticated cannot update id');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'created_at', 'update'),
  'authenticated cannot update created_at');
select ok(not has_any_column_privilege('anon', 'public.profiles', 'select,insert,update,references'),
  'anon has no column privileges');
select ok(not has_table_privilege('authenticated', 'public.profiles', 'insert,delete,truncate'),
  'authenticated cannot insert, delete or truncate');
select ok(not has_any_column_privilege('authenticated', 'public.profiles', 'insert'),
  'authenticated has no column-level insert either');

-- 15-20. The trigger function: private, security definer, empty search_path, not callable.
select has_function('private', 'handle_new_user', array[]::text[], 'private.handle_new_user() exists');
select is_definer('private', 'handle_new_user', array[]::text[], 'handle_new_user is security definer');
select is((select proconfig from pg_proc where oid = 'private.handle_new_user()'::regprocedure),
  array['search_path=""'], 'handle_new_user pins search_path to empty');
select ok(not has_function_privilege('anon', 'private.handle_new_user()', 'execute'),
  'anon cannot execute handle_new_user');
select ok(not has_function_privilege('authenticated', 'private.handle_new_user()', 'execute'),
  'authenticated cannot execute handle_new_user');
select trigger_is('auth', 'users', 'on_auth_user_created', 'private', 'handle_new_user',
  'auth.users has the on_auth_user_created trigger calling private.handle_new_user');

-- 21. The trigger made one profile per user, with an empty display name.
select results_eq(
  $$ select id, display_name from public.profiles
      where id in ('00000000-0000-4000-a000-00000000000a', '00000000-0000-4000-a000-00000000000b')
      order by id $$,
  $$ values ('00000000-0000-4000-a000-00000000000a'::uuid, ''),
            ('00000000-0000-4000-a000-00000000000b'::uuid, '') $$,
  'inserting into auth.users created a profile for each user with display_name ''''');

-- 22-32. As user A.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);

select results_eq($$ select id from public.profiles $$,
  $$ values ('00000000-0000-4000-a000-00000000000a'::uuid) $$,
  'A sees only their own profile (A and B share no workspace)');
select is_empty($$ select 1 from public.profiles where id = '00000000-0000-4000-a000-00000000000b' $$,
  'A cannot see B''s profile by id');
select results_eq(
  $$ update public.profiles set display_name = 'Alice' where id = '00000000-0000-4000-a000-00000000000a'
     returning display_name $$,
  $$ values ('Alice') $$,
  'A can update their own display_name');
select is_empty(
  $$ update public.profiles set display_name = 'hacked' where id = '00000000-0000-4000-a000-00000000000b'
     returning id $$,
  'A''s update of B''s profile matches no rows');
select throws_ok(
  $$ update public.profiles set id = '00000000-0000-4000-a000-00000000000b'
      where id = '00000000-0000-4000-a000-00000000000a' $$,
  '42501', null, 'A cannot change their profile id (column privilege)');
select throws_ok(
  $$ update public.profiles set created_at = now() - interval '1 year'
      where id = '00000000-0000-4000-a000-00000000000a' $$,
  '42501', null, 'A cannot change created_at (column privilege)');
select throws_ok(
  $$ insert into public.profiles (id) values ('00000000-0000-4000-a000-00000000000c') $$,
  '42501', null, 'A cannot insert a profile');
select throws_ok(
  $$ delete from public.profiles where id = '00000000-0000-4000-a000-00000000000a' $$,
  '42501', null, 'A cannot delete their profile directly');
select throws_ok(
  $$ update public.profiles set display_name = repeat('x', 81)
      where id = '00000000-0000-4000-a000-00000000000a' $$,
  '23514', null, 'display_name longer than 80 characters is rejected');
select lives_ok(
  $$ update public.profiles set display_name = repeat('x', 80)
      where id = '00000000-0000-4000-a000-00000000000a' $$,
  'display_name of exactly 80 characters is accepted');
-- With no WHERE or RETURNING, Postgres applies only the update policy's USING clause, not the
-- select policy, so this is the test that fails if the update policy stops checking the owner.
-- Test 35 checks B's row afterwards.
select lives_ok($$ update public.profiles set display_name = 'blanket' $$,
  'A can run an update with no WHERE clause');

-- 33. Authenticated role with no user id in the JWT sees nothing.
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select is_empty($$ select 1 from public.profiles $$, 'a JWT with no sub sees no profiles');

-- 34. anon is refused outright.
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select 1 from public.profiles $$, '42501', null, 'anon cannot read profiles');

reset role;

-- 35. B's profile is unchanged after A's attempts.
select is((select display_name from public.profiles where id = '00000000-0000-4000-a000-00000000000b'), '',
  'B''s display_name is unchanged');

-- 36. Deleting the auth user removes the profile (on delete cascade).
delete from auth.users where id = '00000000-0000-4000-a000-00000000000b';
select is_empty($$ select 1 from public.profiles where id = '00000000-0000-4000-a000-00000000000b' $$,
  'deleting a user from auth.users deletes their profile');

select * from finish();
rollback;

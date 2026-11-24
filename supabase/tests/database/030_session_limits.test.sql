-- Session lifetime limits: private.session_limits and the auth.sessions triggers (ADR 0020).
-- Covers: private.session_limits
-- That Supabase Auth refuses a refresh once not_after has passed is checked against the real
-- Auth server by scripts/ci/session-limit-check.sh (E2E job).
begin;
select plan(20);

-- 1-4. The settings row exists with the shipped defaults.
select is((select count(*)::int from private.session_limits), 1, 'private.session_limits has exactly one row');
select is((select absolute_lifetime from private.session_limits), interval '24 hours', 'absolute lifetime defaults to 24 hours');
select is((select idle_timeout from private.session_limits), interval '2 hours', 'idle timeout defaults to 2 hours');
select throws_ok($$ insert into private.session_limits (id, absolute_lifetime) values (false, '1 day') $$, '23514', null,
  'a second settings row is rejected');

-- 5-6. An idle timeout no longer than the 1-hour access token, or a zero lifetime, is refused.
select throws_ok($$ update private.session_limits set idle_timeout = '1 hour' $$, '23514', null,
  'idle timeout must be longer than jwt_expiry (1 hour)');
select throws_ok($$ update private.session_limits set absolute_lifetime = '0' $$, '23514', null,
  'absolute lifetime must be positive');

-- 7-10. Closed to the API roles; nobody can call the functions.
select table_privs_are('private', 'session_limits', 'anon', array[]::text[], 'anon has nothing on session_limits');
select table_privs_are('private', 'session_limits', 'authenticated', array[]::text[], 'authenticated has nothing on session_limits');
select ok(not has_function_privilege('authenticated', 'private.session_not_after(timestamptz)', 'execute'),
  'authenticated cannot execute session_not_after');
select ok(not has_function_privilege('supabase_auth_admin', 'private.limit_new_session()', 'execute'),
  'the trigger functions need no execute grant');

-- 11-12. The triggers are on auth.sessions.
select trigger_is('auth', 'sessions', 'limit_new_session', 'private', 'limit_new_session', 'insert trigger');
select trigger_is('auth', 'sessions', 'limit_refreshed_session', 'private', 'limit_refreshed_session', 'refresh trigger');

-- A user and session to work on, as Supabase Auth would write them. now() is fixed inside a
-- transaction, so times are compared exactly.
insert into auth.users (id, instance_id, aud, role, email)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'session-limits@example.test');

-- 13. A new session: the idle limit (now + 2 h) comes before the absolute one (now + 24 h).
insert into auth.sessions (id, user_id, created_at, updated_at)
values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', now(), now());
select is((select not_after from auth.sessions where id = '00000000-0000-0000-0000-0000000000b1'),
  now() + interval '2 hours', 'a new session may refresh until 2 hours from now');

-- 14. A refresh moves the idle limit forward. created_at is moved back first (an update that
-- doesn't set refreshed_at, so the trigger doesn't fire), as if the session were 10 hours old.
update auth.sessions set created_at = now() - interval '10 hours' where id = '00000000-0000-0000-0000-0000000000b1';
update auth.sessions set refreshed_at = now() where id = '00000000-0000-0000-0000-0000000000b1';
select is((select not_after from auth.sessions where id = '00000000-0000-0000-0000-0000000000b1'),
  now() + interval '2 hours', 'a refresh at 10 hours gives 2 more hours');

-- 15. Near the end of the absolute lifetime, a refresh can't extend past it.
update auth.sessions set created_at = now() - interval '23 hours' where id = '00000000-0000-0000-0000-0000000000b1';
update auth.sessions set refreshed_at = now() where id = '00000000-0000-0000-0000-0000000000b1';
select is((select not_after from auth.sessions where id = '00000000-0000-0000-0000-0000000000b1'),
  now() + interval '1 hour', 'a refresh at 23 hours ends at the 24-hour limit');

-- 16. Past the absolute lifetime, not_after is already in the past.
update auth.sessions set created_at = now() - interval '25 hours' where id = '00000000-0000-0000-0000-0000000000b1';
update auth.sessions set refreshed_at = now() where id = '00000000-0000-0000-0000-0000000000b1';
select ok((select not_after < now() from auth.sessions where id = '00000000-0000-0000-0000-0000000000b1'),
  'a session older than 24 hours is past its limit');

-- 17. Other updates (not a refresh) leave not_after alone.
update auth.sessions set not_after = now() + interval '5 minutes', aal = 'aal2'
where id = '00000000-0000-0000-0000-0000000000b1';
select is((select not_after from auth.sessions where id = '00000000-0000-0000-0000-0000000000b1'),
  now() + interval '5 minutes', 'an update without refreshed_at does not touch not_after');

-- 18. A stricter not_after set by Supabase Auth on insert is kept.
insert into auth.sessions (id, user_id, created_at, updated_at, not_after)
values ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a1', now(), now(),
        now() + interval '10 minutes');
select is((select not_after from auth.sessions where id = '00000000-0000-0000-0000-0000000000b2'),
  now() + interval '10 minutes', 'a stricter not_after on insert is kept');

-- 19. With no idle timeout, only the absolute lifetime applies.
update private.session_limits set idle_timeout = null;
insert into auth.sessions (id, user_id, created_at, updated_at)
values ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000a1', now(), now());
select is((select not_after from auth.sessions where id = '00000000-0000-0000-0000-0000000000b3'),
  now() + interval '24 hours', 'with no idle timeout, a session lasts 24 hours');

-- 20. Supabase Auth's role has no usage on private, so the trigger functions must be security
-- definer to read the settings. (pgTAP runs as postgres, which can't SET ROLE supabase_auth_admin;
-- real sign-ins in scripts/ci/session-limit-check.sh cover that path.)
select ok(
  not has_schema_privilege('supabase_auth_admin', 'private', 'usage')
  and (select bool_and(prosecdef) from pg_proc
       where pronamespace = 'private'::regnamespace
         and proname in ('session_not_after', 'limit_new_session', 'limit_refreshed_session')),
  'the trigger functions are security definer, since supabase_auth_admin has no usage on private');

select * from finish();
rollback;

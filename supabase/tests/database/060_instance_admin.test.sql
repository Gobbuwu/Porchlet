-- public.is_instance_admin() (ADR 0025): true only for the instance admin, false for everyone else
-- and while no admin is set, and not executable by anon.
begin;
select plan(8);

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-a000-00000000006a', 'admin60@example.test', now()),
  ('00000000-0000-4000-a000-00000000006b', 'other60@example.test', now());

-- 1-2. Definer with an empty search_path; anon can't execute it (the full lists of what anon and
-- authenticated may execute are in 000_baseline test 3 and 040 test 12).
select ok(
  (select p.prosecdef and p.proconfig = array['search_path=""'] from pg_proc p
    where p.oid = 'public.is_instance_admin()'::regprocedure),
  'is_instance_admin is security definer with search_path pinned to empty');
select ok(not has_function_privilege('anon', 'public.is_instance_admin()', 'execute'),
  'anon cannot execute is_instance_admin');

-- 3. No admin set yet: false, not null, for a signed-in user.
update private.instance set admin_user_id = null;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000006a","role":"authenticated"}', true);
select is(public.is_instance_admin(), false, 'with no admin set, nobody is the admin');
reset role;

update private.instance set admin_user_id = '00000000-0000-4000-a000-00000000006a';
set local role authenticated;

-- 4-6. The admin, another user, and a JWT with no sub.
select is(public.is_instance_admin(), true, 'the admin is told they are the admin');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000006b","role":"authenticated"}', true);
select is(public.is_instance_admin(), false, 'another user is told they are not the admin');
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select is(public.is_instance_admin(), false, 'a JWT with no sub is not the admin');

-- 7. The answer is about the caller only: nothing takes an argument naming another user.
select is(
  (select pronargs::int from pg_proc where oid = 'public.is_instance_admin()'::regprocedure), 0,
  'is_instance_admin takes no arguments');
reset role;

-- 8. anon is refused when it tries.
set local role anon;
select throws_ok($$ select public.is_instance_admin() $$, '42501', null, 'anon is refused');
reset role;

select * from finish();
rollback;

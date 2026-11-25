-- The invite flow's account check (M2 PR 3, ADR 0024 section 7): before the invite email, the
-- owner deletes the invited address's unconfirmed, never-signed-in account that has a password
-- (someone else's sign-up would keep that password); every other account stays. Confirming an
-- account that an unaccepted Porchlet invitation names drops a password it already had (since ADR
-- 0027 every confirmation does: 090_clear_password_on_confirm.test.sql). Also the cleanup's
-- volatile open-invitation check and its handling of invited accounts with a password.
-- Migrations 20261125040000_invite_account_check.sql, 20261125060000_clear_password_on_confirm.sql.
-- Covers: public.invitations
begin;
select plan(28);

-- A owns X, B owns Y. Q* are accounts with each invitation's address.
insert into auth.users (id, email, email_confirmed_at, invited_at, last_sign_in_at) values
  ('00000000-0000-4000-a000-00000000000a', 'a@example.test', now(), null, now()),
  ('00000000-0000-4000-a000-00000000000b', 'b@example.test', now(), null, now()),
  ('00000000-0000-4000-b000-000000000001', 'q1@example.test', null, null, null),     -- someone's sign-up, unconfirmed
  ('00000000-0000-4000-b000-000000000002', 'q2@example.test', null, now(), null),    -- invite email's account, no password
  ('00000000-0000-4000-b000-000000000003', 'q3@example.test', now(), null, now()),   -- confirmed, signed in
  ('00000000-0000-4000-b000-000000000004', 'q4@example.test', null, null, now()),    -- unconfirmed but signed in
  ('00000000-0000-4000-b000-000000000005', 'Q5@Example.TEST', null, now(), null),    -- sign-up then invite, mixed case
  ('00000000-0000-4000-b000-000000000006', 'q6@example.test', now(), null, null),    -- confirmed, never signed in
  ('00000000-0000-4000-b000-000000000007', 'q7@example.test', null, now(), null),    -- invited, with a password
  ('00000000-0000-4000-b000-000000000008', 'q8@example.test', null, null, null),     -- own sign-up, not invited
  ('00000000-0000-4000-b000-000000000009', 'q9@example.test', null, now(), null),    -- invited outside Porchlet, with a password
  ('00000000-0000-4000-b000-000000000010', 'q10@example.test', null, now(), null),   -- invited by Porchlet, no password yet
  ('00000000-0000-4000-b000-000000000011', 'q11@example.test', null, now(), null),   -- invited by Porchlet, with a password
  ('00000000-0000-4000-b000-000000000012', 'q12@example.test', null, now(), null),   -- only an accepted Porchlet row, then a dashboard invite
  ('00000000-0000-4000-b000-000000000013', 'q13@example.test', null, now(), null);   -- an accepted row and an expired one
update auth.users set encrypted_password = extensions.crypt('someone-elses-password', extensions.gen_salt('bf'))
 where id in ('00000000-0000-4000-b000-000000000001', '00000000-0000-4000-b000-000000000003',
              '00000000-0000-4000-b000-000000000004', '00000000-0000-4000-b000-000000000005',
              '00000000-0000-4000-b000-000000000006', '00000000-0000-4000-b000-000000000007',
              '00000000-0000-4000-b000-000000000008', '00000000-0000-4000-b000-000000000009',
              '00000000-0000-4000-b000-000000000011', '00000000-0000-4000-b000-000000000012');
-- q8's sign-up sent its confirmation email, as every real sign-up does (ADR 0027).
update auth.users set confirmation_sent_at = now() where id = '00000000-0000-4000-b000-000000000008';
insert into public.workspaces (id, name, created_by) values
  ('00000000-0000-4000-c000-0000000000f1', 'X', '00000000-0000-4000-a000-00000000000a'),
  ('00000000-0000-4000-c000-0000000000f2', 'Y', '00000000-0000-4000-a000-00000000000b');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('00000000-0000-4000-c000-0000000000f1', '00000000-0000-4000-a000-00000000000a', 'owner'),
  ('00000000-0000-4000-c000-0000000000f2', '00000000-0000-4000-a000-00000000000b', 'owner');
insert into public.invitations (id, workspace_id, email, token_hash, invited_by, expires_at, accepted_at) values
  ('00000000-0000-4000-d000-000000000001', '00000000-0000-4000-c000-0000000000f1', 'q1@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000a', now() + interval '7 days', null),
  ('00000000-0000-4000-d000-000000000002', '00000000-0000-4000-c000-0000000000f1', 'q2@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000a', now() + interval '7 days', null),
  ('00000000-0000-4000-d000-000000000003', '00000000-0000-4000-c000-0000000000f1', 'q3@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000a', now() + interval '7 days', null),
  ('00000000-0000-4000-d000-000000000004', '00000000-0000-4000-c000-0000000000f1', 'q4@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000a', now() + interval '7 days', null),
  ('00000000-0000-4000-d000-000000000005', '00000000-0000-4000-c000-0000000000f1', 'q5@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000a', now() + interval '7 days', null),
  ('00000000-0000-4000-d000-000000000006', '00000000-0000-4000-c000-0000000000f1', 'q6@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000a', now() + interval '7 days', null),
  ('00000000-0000-4000-d000-000000000007', '00000000-0000-4000-c000-0000000000f2', 'q1@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000b', now() - interval '1 minute', null),
  ('00000000-0000-4000-d000-000000000008', '00000000-0000-4000-c000-0000000000f2', 'q1@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000b', now() + interval '7 days', now()),
  ('00000000-0000-4000-d000-000000000009', '00000000-0000-4000-c000-0000000000f2', 'q7@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000b', now() + interval '7 days', null),
  ('00000000-0000-4000-d000-000000000010', '00000000-0000-4000-c000-0000000000f2', 'q10@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000b', now() + interval '7 days', null),
  ('00000000-0000-4000-d000-000000000011', '00000000-0000-4000-c000-0000000000f2', 'q11@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000b', now() + interval '7 days', null),
  ('00000000-0000-4000-d000-000000000012', '00000000-0000-4000-c000-0000000000f2', 'q12@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000b', now() - interval '1 day', now() - interval '2 days'),
  ('00000000-0000-4000-d000-000000000013', '00000000-0000-4000-c000-0000000000f1', 'q13@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000a', now() - interval '1 day', now() - interval '2 days'),
  ('00000000-0000-4000-d000-000000000014', '00000000-0000-4000-c000-0000000000f2', 'q13@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000b', now() - interval '1 minute', null);

create function pg_temp.exists_user(p_id uuid) returns boolean language sql as
  $$ select exists (select 1 from auth.users where id = p_id) $$;

-- 1-5. The functions.
select is((select prosecdef from pg_proc where oid = 'public.clear_unconfirmed_signup(uuid)'::regprocedure), true,
  'clear_unconfirmed_signup is security definer');
select is((select proconfig from pg_proc where oid = 'public.clear_unconfirmed_signup(uuid)'::regprocedure),
  array['search_path=""'], 'clear_unconfirmed_signup has an empty search_path');
select ok(has_function_privilege('authenticated', 'public.clear_unconfirmed_signup(uuid)', 'execute')
      and not has_function_privilege('anon', 'public.clear_unconfirmed_signup(uuid)', 'execute'),
  'authenticated, not anon, can execute clear_unconfirmed_signup');
select ok(not has_function_privilege('authenticated', 'private.has_open_invitation(text)', 'execute')
      and not has_function_privilege('anon', 'private.has_open_invitation(text)', 'execute'),
  'the API roles cannot execute has_open_invitation');
select is((select provolatile from pg_proc where oid = 'private.has_open_invitation(text)'::regprocedure), 'v'::"char",
  'has_open_invitation is volatile (a fresh snapshot when a waiting delete re-checks a row)');

-- 6-9. Refused: anon, another workspace's owner, an expired or accepted invitation.
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select public.clear_unconfirmed_signup('00000000-0000-4000-d000-000000000001') $$,
  '42501', null, 'anon cannot run the check');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000b","role":"authenticated"}', true);
select throws_ok($$ select public.clear_unconfirmed_signup('00000000-0000-4000-d000-000000000001') $$,
  '42501', 'not_allowed', 'another workspace''s owner is refused');
select throws_ok($$ select public.clear_unconfirmed_signup('00000000-0000-4000-d000-000000000007') $$,
  '42501', 'not_allowed', 'an expired invitation is refused');
select throws_ok($$ select public.clear_unconfirmed_signup('00000000-0000-4000-d000-000000000008') $$,
  '42501', 'not_allowed', 'an accepted invitation is refused');

-- 10-16. The owner's check deletes only the unconfirmed, never-signed-in account with a password.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);
select is(public.clear_unconfirmed_signup('00000000-0000-4000-d000-000000000001'), 1,
  'an unconfirmed sign-up with the address is deleted (returns 1)');
select is(public.clear_unconfirmed_signup('00000000-0000-4000-d000-000000000001'), 0,
  'a second check finds nothing (returns 0)');
select is(public.clear_unconfirmed_signup('00000000-0000-4000-d000-000000000005'), 1,
  'a sign-up the invite already reused is deleted too, matched without case');
select is(public.clear_unconfirmed_signup('00000000-0000-4000-d000-000000000002')
        + public.clear_unconfirmed_signup('00000000-0000-4000-d000-000000000003')
        + public.clear_unconfirmed_signup('00000000-0000-4000-d000-000000000004')
        + public.clear_unconfirmed_signup('00000000-0000-4000-d000-000000000006'), 0,
  'the other checks delete nothing');
reset role;
select ok(not pg_temp.exists_user('00000000-0000-4000-b000-000000000001')
      and not pg_temp.exists_user('00000000-0000-4000-b000-000000000005'),
  'the two sign-ups are gone');
select ok(pg_temp.exists_user('00000000-0000-4000-b000-000000000002'),
  'the invite email''s own account (no password) stays, so its link keeps working');
select ok(pg_temp.exists_user('00000000-0000-4000-b000-000000000003')
      and pg_temp.exists_user('00000000-0000-4000-b000-000000000004')
      and pg_temp.exists_user('00000000-0000-4000-b000-000000000006'),
  'confirmed or signed-in accounts stay');

-- 17. The cleanup still keeps an account whose address has an open invitation.
select is(private.delete_unused_invited_users('q2@example.test'), 0,
  'the cleanup keeps q2 while its invitation is open');

-- 18-22. Confirming an invited account drops its password. ADR 0027 replaced the invite-only
-- trigger with one for every account, so a sign-up that was never invited loses its password too.
select hasnt_trigger('auth', 'users', 'clear_invited_password_on_confirm',
  'the invite-only confirm trigger is gone (replaced by ADR 0027''s)');
select trigger_is('auth', 'users', 'clear_password_on_confirm', 'private', 'clear_password_on_confirm',
  'auth.users has the confirm trigger');
update auth.users set email_confirmed_at = now()
 where id in ('00000000-0000-4000-b000-000000000007', '00000000-0000-4000-b000-000000000008');
select ok(exists (select 1 from auth.users where id = '00000000-0000-4000-b000-000000000007' and coalesce(encrypted_password, '') = ''),
  'confirming an invited account with a password drops the password');
select ok(exists (select 1 from auth.users where id = '00000000-0000-4000-b000-000000000008' and coalesce(encrypted_password, '') = ''),
  'confirming a sign-up that was never invited drops its password too (ADR 0027)');
update auth.users set email_confirmed_at = now(), invited_at = now()
 where id = '00000000-0000-4000-b000-000000000003';
select ok(exists (select 1 from auth.users where id = '00000000-0000-4000-b000-000000000003' and coalesce(encrypted_password, '') <> ''),
  'an already confirmed account keeps its password');

-- 23-25. The trigger and accounts outside Porchlet's invitations, and the cleanup of an invited
-- account with a password.
update auth.users set email_confirmed_at = now() where id = '00000000-0000-4000-b000-000000000009';
select ok(exists (select 1 from auth.users where id = '00000000-0000-4000-b000-000000000009' and coalesce(encrypted_password, '') = ''),
  'an account no Porchlet invitation names (a dashboard invite) loses its password when confirmed too (ADR 0027)');
update auth.users set email_confirmed_at = now(),
       encrypted_password = extensions.crypt('chosen-by-admin', extensions.gen_salt('bf'))
 where id = '00000000-0000-4000-b000-000000000010';
select ok(exists (select 1 from auth.users where id = '00000000-0000-4000-b000-000000000010' and coalesce(encrypted_password, '') <> ''),
  'a password set by the confirming update itself is kept');
delete from public.invitations where id = '00000000-0000-4000-d000-000000000011';
select ok(not pg_temp.exists_user('00000000-0000-4000-b000-000000000011'),
  'withdrawing deletes an unused invited account even when it has a password');

-- 26-28. The hourly job and an accepted invitation: an address whose only Porchlet invitation was
-- accepted keeps its unconfirmed account (whose password, like every account's, goes when it is
-- confirmed: ADR 0027); one that also has an expired unaccepted invitation loses it.
select is(private.delete_unused_invited_users(), 1, 'the hourly job deletes one account here (q13)');
select ok(not pg_temp.exists_user('00000000-0000-4000-b000-000000000013')
      and pg_temp.exists_user('00000000-0000-4000-b000-000000000012'),
  'an address with an expired unaccepted invitation loses its unused account even beside an accepted one; one with only an accepted row keeps it');
update auth.users set email_confirmed_at = now() where id = '00000000-0000-4000-b000-000000000012';
select ok(exists (select 1 from auth.users where id = '00000000-0000-4000-b000-000000000012' and coalesce(encrypted_password, '') = ''),
  'an account only an accepted Porchlet invitation names loses its password when confirmed (ADR 0027)');

select * from finish();
rollback;

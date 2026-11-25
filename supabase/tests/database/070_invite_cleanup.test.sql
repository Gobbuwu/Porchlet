-- Invite cleanup (M2 PR 3, ADR 0024, threat T8): deleting an invitation, or its expiry, deletes the
-- account the invite email made, but only one nobody used and only once no invitation for that
-- address is open in any workspace. Migration 20261125030000_invite_cleanup.sql.
-- Covers: public.invitations
begin;
select plan(25);

-- A owns X, B owns Y. P* are accounts an invite email made (invited, unconfirmed, never signed in)
-- unless the comment says otherwise.
insert into auth.users (id, email, email_confirmed_at, invited_at, last_sign_in_at) values
  ('00000000-0000-4000-a000-00000000000a', 'a@example.test', now(), null, now()),
  ('00000000-0000-4000-a000-00000000000b', 'b@example.test', now(), null, now()),
  ('00000000-0000-4000-b000-000000000001', 'p1@example.test', null, now(), null),
  ('00000000-0000-4000-b000-000000000002', 'p2@example.test', null, now(), null),
  ('00000000-0000-4000-b000-000000000003', 'p3@example.test', now(), null, now()),    -- has an account
  ('00000000-0000-4000-b000-000000000004', 'p4@example.test', null, now(), now()),    -- signed in once
  ('00000000-0000-4000-b000-000000000005', 'p5@example.test', null, null, null),      -- own sign-up, unconfirmed
  ('00000000-0000-4000-b000-000000000006', 'p6@example.test', null, now(), null),
  ('00000000-0000-4000-b000-000000000007', 'p7@example.test', null, now(), null),
  ('00000000-0000-4000-b000-000000000008', 'p8@example.test', null, now(), null),     -- no invitation row
  ('00000000-0000-4000-b000-000000000009', 'P9@Example.TEST', null, now(), null),     -- mixed case
  ('00000000-0000-4000-b000-000000000010', 'p10@example.test', null, now(), null),
  ('00000000-0000-4000-b000-000000000011', 'p11@example.test', now(), now(), null),   -- confirmed
  ('00000000-0000-4000-b000-000000000012', 'p12@example.test', null, now(), null);    -- own sign-up, then invited
-- p12 signed up (unconfirmed, with the password they chose), then was invited, which sets
-- invited_at on the same account (measured on GoTrue v2.198.0).
update auth.users set encrypted_password = extensions.crypt('chosen-password', extensions.gen_salt('bf'))
 where id = '00000000-0000-4000-b000-000000000012';
insert into public.workspaces (id, name, created_by) values
  ('00000000-0000-4000-c000-0000000000f1', 'X', '00000000-0000-4000-a000-00000000000a'),
  ('00000000-0000-4000-c000-0000000000f2', 'Y', '00000000-0000-4000-a000-00000000000b'),
  ('00000000-0000-4000-c000-0000000000f3', 'Z', '00000000-0000-4000-a000-00000000000b');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('00000000-0000-4000-c000-0000000000f1', '00000000-0000-4000-a000-00000000000a', 'owner'),
  ('00000000-0000-4000-c000-0000000000f2', '00000000-0000-4000-a000-00000000000b', 'owner'),
  ('00000000-0000-4000-c000-0000000000f3', '00000000-0000-4000-a000-00000000000b', 'owner');
-- Invitations in X (by A) unless noted; expires_at in the past means expired.
insert into public.invitations (id, workspace_id, email, token_hash, invited_by, expires_at) values
  ('00000000-0000-4000-d000-000000000001', '00000000-0000-4000-c000-0000000000f1', 'p1@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000a', now() + interval '7 days'),
  ('00000000-0000-4000-d000-000000000002', '00000000-0000-4000-c000-0000000000f1', 'p2@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000a', now() + interval '7 days'),
  ('00000000-0000-4000-d000-000000000012', '00000000-0000-4000-c000-0000000000f2', 'p2@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000b', now() + interval '7 days'),
  ('00000000-0000-4000-d000-000000000003', '00000000-0000-4000-c000-0000000000f1', 'p3@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000a', now() + interval '7 days'),
  ('00000000-0000-4000-d000-000000000004', '00000000-0000-4000-c000-0000000000f1', 'p4@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000a', now() + interval '7 days'),
  ('00000000-0000-4000-d000-000000000005', '00000000-0000-4000-c000-0000000000f1', 'p5@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000a', now() + interval '7 days'),
  ('00000000-0000-4000-d000-000000000006', '00000000-0000-4000-c000-0000000000f1', 'p6@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000a', now() - interval '1 minute'),
  ('00000000-0000-4000-d000-000000000007', '00000000-0000-4000-c000-0000000000f1', 'p7@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000a', now() - interval '1 minute'),
  ('00000000-0000-4000-d000-000000000017', '00000000-0000-4000-c000-0000000000f2', 'p7@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000b', now() + interval '7 days'),
  ('00000000-0000-4000-d000-000000000009', '00000000-0000-4000-c000-0000000000f1', 'p9@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000a', now() + interval '7 days'),
  ('00000000-0000-4000-d000-000000000010', '00000000-0000-4000-c000-0000000000f3', 'p10@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000b', now() + interval '7 days'),
  ('00000000-0000-4000-d000-000000000011', '00000000-0000-4000-c000-0000000000f1', 'p11@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000a', now() - interval '1 minute'),
  ('00000000-0000-4000-d000-000000000013', '00000000-0000-4000-c000-0000000000f1', 'p12@example.test', extensions.gen_random_bytes(32), '00000000-0000-4000-a000-00000000000a', now() + interval '7 days');

create function pg_temp.exists_user(p_id uuid) returns boolean language sql as
  $$ select exists (select 1 from auth.users where id = p_id) $$;

-- 1-6. The functions, the trigger and the hourly job.
select is((select prosecdef from pg_proc where oid = 'private.delete_unused_invited_users(text)'::regprocedure), true,
  'delete_unused_invited_users is security definer');
select is((select proconfig from pg_proc where oid = 'private.delete_unused_invited_users(text)'::regprocedure),
  array['search_path=""'], 'delete_unused_invited_users has an empty search_path');
select ok(not has_function_privilege('authenticated', 'private.delete_unused_invited_users(text)', 'execute')
      and not has_function_privilege('anon', 'private.delete_unused_invited_users(text)', 'execute'),
  'the API roles cannot execute delete_unused_invited_users');
select ok(not has_function_privilege('authenticated', 'private.invitations_after_delete()', 'execute')
      and not has_function_privilege('anon', 'private.invitations_after_delete()', 'execute'),
  'the API roles cannot execute the trigger function');
select trigger_is('public', 'invitations', 'invitations_after_delete', 'private', 'invitations_after_delete',
  'invitations has the after-delete cleanup trigger');
select results_eq(
  $$ select schedule, command from cron.job where jobname = 'porchlet-delete-unused-invited-users' $$,
  $$ values ('17 * * * *'::text, 'select private.delete_unused_invited_users()'::text) $$,
  'the hourly cleanup job is scheduled');

-- 7-15. An owner withdraws invitations through the API (the owners' delete policy).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);
delete from public.invitations where id = '00000000-0000-4000-d000-000000000001';
delete from public.invitations where id = '00000000-0000-4000-d000-000000000002';
delete from public.invitations where id = '00000000-0000-4000-d000-000000000003';
delete from public.invitations where id = '00000000-0000-4000-d000-000000000004';
delete from public.invitations where id = '00000000-0000-4000-d000-000000000005';
delete from public.invitations where id = '00000000-0000-4000-d000-000000000009';
delete from public.invitations where id = '00000000-0000-4000-d000-000000000013';
-- A's delete of B's invitation is refused by RLS (no row), so it removes no account either.
delete from public.invitations where id = '00000000-0000-4000-d000-000000000010';
reset role;
select ok(not pg_temp.exists_user('00000000-0000-4000-b000-000000000001'),
  'withdrawing the only invitation deletes the unused invited account');
select ok(pg_temp.exists_user('00000000-0000-4000-b000-000000000002'),
  'an unused invited account stays while another workspace''s invitation for it is open');
select ok(pg_temp.exists_user('00000000-0000-4000-b000-000000000003'), 'a confirmed account is never deleted');
select ok(pg_temp.exists_user('00000000-0000-4000-b000-000000000004'), 'an account that signed in is never deleted');
select ok(pg_temp.exists_user('00000000-0000-4000-b000-000000000005'),
  'an unconfirmed account from the person''s own sign-up (not invited) is never deleted');
select ok(not pg_temp.exists_user('00000000-0000-4000-b000-000000000009'),
  'the address is matched without regard to case');
select ok(pg_temp.exists_user('00000000-0000-4000-b000-000000000010')
      and exists (select 1 from public.invitations where id = '00000000-0000-4000-d000-000000000010'),
  'another workspace''s owner deletes nothing, so no account goes either');
select ok(pg_temp.exists_user('00000000-0000-4000-a000-00000000000a') and pg_temp.exists_user('00000000-0000-4000-a000-00000000000b'),
  'owners'' own accounts stay');
-- Changed by 20261125040000 (ADR 0024 section 7, Gobbu's OK on 2026-11-25): an unconfirmed sign-up
-- the invite reused goes with the invitation, password and all.
select ok(not pg_temp.exists_user('00000000-0000-4000-b000-000000000012'),
  'an unconfirmed sign-up that an invite reused is deleted with its last invitation, password and all');

-- 16-21. Expiry: the hourly job.
select is(private.delete_unused_invited_users(), 1, 'the hourly job deletes one account (p6)');
select ok(not pg_temp.exists_user('00000000-0000-4000-b000-000000000006'),
  'an unused invited account whose invitations all expired is deleted');
select ok(pg_temp.exists_user('00000000-0000-4000-b000-000000000007'),
  'an account with one expired and one open invitation stays');
select ok(pg_temp.exists_user('00000000-0000-4000-b000-000000000008'),
  'an invited account with no Porchlet invitation (for example from the dashboard) stays');
select ok(pg_temp.exists_user('00000000-0000-4000-b000-000000000011'),
  'a confirmed account with only expired invitations stays');
select ok(exists (select 1 from public.invitations where id = '00000000-0000-4000-d000-000000000006'),
  'the expired invitation row itself stays for the owner to see');

-- 22-23. Deleting a workspace removes its invitations by cascade, and the trigger runs for them.
delete from public.workspaces where id = '00000000-0000-4000-c000-0000000000f3';
select ok(not pg_temp.exists_user('00000000-0000-4000-b000-000000000010'),
  'a workspace deleted with its invitations deletes their unused invited accounts');
select ok(pg_temp.exists_user('00000000-0000-4000-a000-00000000000b'), 'its owner stays');

-- 24-25. Deleting an accepted invitation removes no account.
update auth.users set email_confirmed_at = now(), last_sign_in_at = now() where id = '00000000-0000-4000-b000-000000000002';
update public.invitations set accepted_at = now() where id = '00000000-0000-4000-d000-000000000012';
update auth.users set email_confirmed_at = null, last_sign_in_at = null where id = '00000000-0000-4000-b000-000000000002';
delete from public.invitations where id = '00000000-0000-4000-d000-000000000012';
select ok(pg_temp.exists_user('00000000-0000-4000-b000-000000000002'),
  'deleting an accepted invitation removes no account (the trigger skips it)');
select is(private.delete_unused_invited_users('nobody@example.test'), 0, 'an address with no account deletes nothing');

select * from finish();
rollback;

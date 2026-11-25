-- ADR 0027: the update that confirms an address drops any password the account already had once an
-- emailed link was sent to the address, so only a password the confirming person then sets opens
-- it. Every other update keeps the password, and so does a confirm no link preceded (an admin's).
-- Migration 20261125060000_clear_password_on_confirm.sql.
begin;
select plan(15);

create function pg_temp.has_password(p_id uuid) returns boolean language sql as $$
  select coalesce(encrypted_password, '') <> '' from auth.users where id = p_id
$$;

insert into auth.users (id, email, email_confirmed_at, confirmation_token, confirmation_sent_at) values
  ('00000000-0000-4000-e000-000000000001', 'r1@example.test', null, 'tok1', now()),  -- sign-up, unconfirmed
  ('00000000-0000-4000-e000-000000000002', 'r2@example.test', null, 'tok2', now()),  -- sign-up, signed up again
  ('00000000-0000-4000-e000-000000000003', 'r3@example.test', now(), '', null),      -- confirmed
  ('00000000-0000-4000-e000-000000000004', 'r4@example.test', null, 'tok4', now()),  -- unconfirmed, no password
  ('00000000-0000-4000-e000-000000000005', 'r5@example.test', null, 'tok5', now()),  -- confirmed with a new password in one update
  ('00000000-0000-4000-e000-000000000006', 'r6@example.test', null, 'tok6', now()),  -- unconfirmed, password changed
  ('00000000-0000-4000-e000-000000000007', 'r7@example.test', null, '', null),       -- made by an admin, no link sent
  ('00000000-0000-4000-e000-000000000008', 'r8@example.test', null, '', null),       -- reset link sent (a sign-in link)
  ('00000000-0000-4000-e000-000000000009', 'r9@example.test', null, '', null);       -- invited
update auth.users set encrypted_password = extensions.crypt('first-sign-up-password', extensions.gen_salt('bf'))
 where id in ('00000000-0000-4000-e000-000000000001', '00000000-0000-4000-e000-000000000002',
              '00000000-0000-4000-e000-000000000003', '00000000-0000-4000-e000-000000000005',
              '00000000-0000-4000-e000-000000000006', '00000000-0000-4000-e000-000000000007',
              '00000000-0000-4000-e000-000000000008', '00000000-0000-4000-e000-000000000009');
update auth.users set recovery_sent_at = now() where id = '00000000-0000-4000-e000-000000000008';
update auth.users set invited_at = now() where id = '00000000-0000-4000-e000-000000000009';

-- 1-3. The trigger, and nobody but its owner can call its function.
select trigger_is('auth', 'users', 'clear_password_on_confirm', 'private', 'clear_password_on_confirm',
  'auth.users has the confirm trigger');
select ok(not has_function_privilege('anon', 'private.clear_password_on_confirm()', 'execute')
      and not has_function_privilege('authenticated', 'private.clear_password_on_confirm()', 'execute')
      and not has_function_privilege('service_role', 'private.clear_password_on_confirm()', 'execute'),
  'the API roles cannot execute the trigger function');
select ok((select p.prosecdef and p.proconfig @> array['search_path=""']
             from pg_proc p where p.oid = 'private.clear_password_on_confirm()'::regprocedure),
  'the trigger function is security definer with an empty search_path');

-- 4-5. A sign-up being signed up again (Supabase Auth sends a new link and keeps the first password)
-- keeps it while unconfirmed; the confirm then drops it.
update auth.users set confirmation_token = 'tok2b', confirmation_sent_at = now()
 where id = '00000000-0000-4000-e000-000000000002';
select ok(pg_temp.has_password('00000000-0000-4000-e000-000000000002'),
  'an update that does not confirm keeps the password');
update auth.users set email_confirmed_at = now(), confirmation_token = ''
 where id = '00000000-0000-4000-e000-000000000002';
select ok(not pg_temp.has_password('00000000-0000-4000-e000-000000000002'),
  'confirming a sign-up that was signed up again drops the first password');

-- 6. The plain case: confirming a sign-up drops its password.
update auth.users set email_confirmed_at = now(), confirmation_token = ''
 where id = '00000000-0000-4000-e000-000000000001';
select ok(not pg_temp.has_password('00000000-0000-4000-e000-000000000001'),
  'confirming a sign-up drops its password');

-- 7. A password set after the confirmation is kept.
update auth.users set encrypted_password = extensions.crypt('chosen-after-confirm', extensions.gen_salt('bf'))
 where id = '00000000-0000-4000-e000-000000000001';
select ok(pg_temp.has_password('00000000-0000-4000-e000-000000000001'),
  'the password chosen after the confirmation is kept');

-- 8-9. An already confirmed account: other updates, even one writing email_confirmed_at again, keep it.
update auth.users set email_confirmed_at = now(), last_sign_in_at = now()
 where id = '00000000-0000-4000-e000-000000000003';
select ok(pg_temp.has_password('00000000-0000-4000-e000-000000000003'),
  'an already confirmed account keeps its password when email_confirmed_at is written again');
update auth.users set email = 'r3-new@example.test' where id = '00000000-0000-4000-e000-000000000003';
select ok(pg_temp.has_password('00000000-0000-4000-e000-000000000003'),
  'an address change on a confirmed account keeps its password');

-- 10. An account with no password is confirmed and still has none (nothing to drop, no error).
update auth.users set email_confirmed_at = now() where id = '00000000-0000-4000-e000-000000000004';
select ok(not pg_temp.has_password('00000000-0000-4000-e000-000000000004')
      and (select email_confirmed_at is not null from auth.users where id = '00000000-0000-4000-e000-000000000004'),
  'an account with no password is confirmed and has none');

-- 11. A password written by the confirming update itself (SQL only; ADR 0027) is kept.
update auth.users set email_confirmed_at = now(),
       encrypted_password = extensions.crypt('set-with-the-confirm', extensions.gen_salt('bf'))
 where id = '00000000-0000-4000-e000-000000000005';
select ok((select encrypted_password = extensions.crypt('set-with-the-confirm', encrypted_password)
             from auth.users where id = '00000000-0000-4000-e000-000000000005'),
  'a password written by the confirming update itself is kept');

-- 12. A password changed while unconfirmed is still one nobody proved, so the confirm drops it.
update auth.users set encrypted_password = extensions.crypt('changed-before-confirm', extensions.gen_salt('bf'))
 where id = '00000000-0000-4000-e000-000000000006';
update auth.users set email_confirmed_at = now() where id = '00000000-0000-4000-e000-000000000006';
select ok(not pg_temp.has_password('00000000-0000-4000-e000-000000000006'),
  'a password changed before the confirmation is dropped by it');

-- 13. No emailed link was ever sent: an admin made the account and confirms it, so its password
-- (the admin's) is kept.
update auth.users set email_confirmed_at = now() where id = '00000000-0000-4000-e000-000000000007';
select ok(pg_temp.has_password('00000000-0000-4000-e000-000000000007'),
  'a confirm that no emailed link preceded (an admin''s) keeps the password');

-- 14-15. A reset or an invite link counts as a link sent.
update auth.users set email_confirmed_at = now() where id = '00000000-0000-4000-e000-000000000008';
select ok(not pg_temp.has_password('00000000-0000-4000-e000-000000000008'),
  'a confirm after a reset link was sent drops the password');
update auth.users set email_confirmed_at = now() where id = '00000000-0000-4000-e000-000000000009';
select ok(not pg_temp.has_password('00000000-0000-4000-e000-000000000009'),
  'a confirm of an invited account drops the password');

select * from finish();
rollback;

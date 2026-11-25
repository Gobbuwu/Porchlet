-- Invitations: the table, its policies, create_invitation (token, checks, both caps) and
-- accept_invitation (wrong, expired, used, wrong account, unconfirmed). Parallel calls are checked
-- by scripts/ci/db-race-check.sh, which needs two sessions.
-- Covers: public.invitations, private.invitation_sends
begin;
select plan(58);

-- A owns X; D is a client of X; B owns Y; C and F are invited later; U has not confirmed their
-- email; E belongs to nothing.
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-a000-00000000000a', 'a@example.test', now()),
  ('00000000-0000-4000-a000-00000000000b', 'b@example.test', now()),
  ('00000000-0000-4000-a000-00000000000c', 'c@example.test', now()),
  ('00000000-0000-4000-a000-00000000000d', 'd@example.test', now()),
  ('00000000-0000-4000-a000-00000000000e', 'e@example.test', now()),
  ('00000000-0000-4000-a000-00000000000f', 'f@example.test', now()),
  ('00000000-0000-4000-a000-000000000001', 'u@example.test', null);
insert into public.workspaces (id, name, created_by) values
  ('00000000-0000-4000-c000-0000000000f1', 'X', '00000000-0000-4000-a000-00000000000a'),
  ('00000000-0000-4000-c000-0000000000f2', 'Y', '00000000-0000-4000-a000-00000000000b');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('00000000-0000-4000-c000-0000000000f1', '00000000-0000-4000-a000-00000000000a', 'owner'),
  ('00000000-0000-4000-c000-0000000000f1', '00000000-0000-4000-a000-00000000000d', 'client'),
  ('00000000-0000-4000-c000-0000000000f2', '00000000-0000-4000-a000-00000000000b', 'owner');

create temp table tokens (name text primary key, invitation_id uuid, token text);
grant select, insert on tokens to authenticated;

-- 1-4. Table shape.
select has_table('public', 'invitations', 'public.invitations exists');
select col_is_unique('public', 'invitations', 'token_hash', 'token_hash is unique');
select throws_ok(
  $$ insert into public.invitations (workspace_id, email, token_hash, invited_by)
     values ('00000000-0000-4000-c000-0000000000f1', 'Mixed@example.test', extensions.digest('x', 'sha256'),
             '00000000-0000-4000-a000-00000000000a') $$,
  '23514', null, 'a stored email must be lower case');
select throws_ok(
  $$ insert into public.invitations (workspace_id, email, token_hash, invited_by)
     values ('00000000-0000-4000-c000-0000000000f1', 'x@example.test', '\x00'::bytea,
             '00000000-0000-4000-a000-00000000000a') $$,
  '23514', null, 'a stored token hash must be 32 bytes');

-- 5-7. private.invitation_sends is closed to the API roles, even with a mistaken grant.
select ok(not has_table_privilege('authenticated', 'private.invitation_sends', 'select,insert,update,delete'),
  'authenticated has no privileges on private.invitation_sends');
select ok(not has_table_privilege('anon', 'private.invitation_sends', 'select,insert,update,delete'),
  'anon has no privileges on private.invitation_sends');
insert into private.invitation_sends (user_id) values ('00000000-0000-4000-a000-00000000000e');
grant select, delete on private.invitation_sends to authenticated;
set local role authenticated;
select is((select count(*)::int from private.invitation_sends), 0,
  'with a mistaken grant, authenticated still reads no private.invitation_sends row');
reset role;
revoke select, delete on private.invitation_sends from authenticated;
delete from private.invitation_sends;

set local role authenticated;

-- 8-15. create_invitation: owner only; token returned once, only its hash stored.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);
select lives_ok(
  $$ insert into tokens select 'C', i.invitation_id, i.token
       from public.create_invitation('00000000-0000-4000-c000-0000000000f1', '  C@Example.TEST ') i $$,
  'owner A invites c@example.test to X');
select matches((select token from tokens where name = 'C'), '^[0-9a-f]{64}$',
  'the token is 32 random bytes as 64 hex characters');
select results_eq(
  $$ select email, invited_by, accepted_at is null, expires_at between now() + interval '7 days' - interval '1 minute'
                                                                  and now() + interval '7 days'
       from public.invitations where id = (select invitation_id from tokens where name = 'C') $$,
  $$ values ('c@example.test', '00000000-0000-4000-a000-00000000000a'::uuid, true, true) $$,
  'the email is stored trimmed and lower case, with the inviter, unaccepted, expiring in 7 days');
select throws_ok($$ select token_hash from public.invitations $$, '42501', null,
  'owner A cannot read token_hash (column privilege)');
reset role;
select is(
  (select token_hash from public.invitations where id = (select invitation_id from tokens where name = 'C')),
  extensions.digest(decode((select token from tokens where name = 'C'), 'hex'), 'sha256'),
  'only the sha256 of the token is stored');
select is((select count(*)::int from private.invitation_sends where user_id = '00000000-0000-4000-a000-00000000000a'), 1,
  'the invitation is counted in private.invitation_sends');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);
select lives_ok(
  $$ insert into tokens select 'C2', i.invitation_id, i.token
       from public.create_invitation('00000000-0000-4000-c000-0000000000f1', 'unused@example.test') i $$,
  'owner A invites a second address');
select isnt((select token from tokens where name = 'C2'), (select token from tokens where name = 'C'),
  'each invitation gets its own token');

-- 16-24. create_invitation refusals.
select throws_ok($$ select * from public.create_invitation('00000000-0000-4000-c000-0000000000f2', 'x@example.test') $$,
  '42501', 'not_allowed', 'owner A cannot invite into Y');
select throws_ok($$ select * from public.create_invitation(null, 'x@example.test') $$,
  '42501', 'not_allowed', 'a null workspace id is refused');
select throws_ok($$ select * from public.create_invitation('00000000-0000-4000-c000-0000000000f1', 'not-an-email') $$,
  'P0001', 'invalid_email', 'an address without @ and a domain is refused');
select throws_ok($$ select * from public.create_invitation('00000000-0000-4000-c000-0000000000f1', null) $$,
  'P0001', 'invalid_email', 'a null address is refused');
select throws_ok($$ select * from public.create_invitation('00000000-0000-4000-c000-0000000000f1', 'D@example.test') $$,
  'P0001', 'already_member', 'an address that is already a member is refused');
select throws_ok($$ select * from public.create_invitation('00000000-0000-4000-c000-0000000000f1', 'c@example.test') $$,
  'P0001', 'invitation_pending', 'a second pending invitation to the same address is refused');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000d","role":"authenticated"}', true);
select throws_ok($$ select * from public.create_invitation('00000000-0000-4000-c000-0000000000f1', 'x@example.test') $$,
  '42501', 'not_allowed', 'client D cannot invite');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000e","role":"authenticated"}', true);
select throws_ok($$ select * from public.create_invitation('00000000-0000-4000-c000-0000000000f1', 'x@example.test') $$,
  '42501', 'not_allowed', 'outsider E cannot invite');
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select * from public.create_invitation('00000000-0000-4000-c000-0000000000f1', 'x@example.test') $$,
  '42501', 'not_allowed', 'a JWT with no sub cannot invite');

-- 25-33. Who sees and changes invitations.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);
select results_eq($$ select email from public.invitations order by email $$,
  $$ values ('c@example.test'), ('unused@example.test') $$, 'owner A sees X''s invitations');
select throws_ok(
  $$ insert into public.invitations (workspace_id, email, token_hash, invited_by)
     values ('00000000-0000-4000-c000-0000000000f1', 'z@example.test', extensions.digest('z', 'sha256'),
             '00000000-0000-4000-a000-00000000000a') $$,
  '42501', null, 'invitations cannot be inserted directly, even by the owner');
select throws_ok($$ update public.invitations set accepted_at = now() $$, '42501', null,
  'invitations cannot be updated directly');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000d","role":"authenticated"}', true);
select is_empty($$ select 1 from public.invitations $$, 'client D sees no invitations, not even X''s');
select is_empty($$ delete from public.invitations returning id $$, 'client D cannot delete invitations');
-- With no WHERE or RETURNING only the delete policy decides which rows go; the next test checks.
select lives_ok($$ delete from public.invitations $$, 'client D can run a delete with no WHERE clause');
reset role;
select is((select count(*)::int from public.invitations where workspace_id = '00000000-0000-4000-c000-0000000000f1'), 2,
  'client D''s blanket delete removed none of X''s invitations');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000b","role":"authenticated"}', true);
select is_empty($$ select 1 from public.invitations $$, 'owner B sees none of X''s invitations');
select is_empty($$ delete from public.invitations returning id $$, 'owner B cannot delete X''s invitations');

-- 34-43. accept_invitation refusals.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000e","role":"authenticated"}', true);
select throws_ok(format('select public.accept_invitation(%L)', (select token from tokens where name = 'C')),
  'P0001', 'invitation_wrong_account', 'E cannot accept an invitation sent to c@example.test');
select throws_ok($$ select public.accept_invitation('not-a-token') $$, 'P0001', 'invitation_invalid',
  'a malformed token is refused');
select throws_ok($$ select public.accept_invitation(upper(repeat('ab', 32))) $$, 'P0001', 'invitation_invalid',
  'an upper-case hex token is refused (tokens are lower case)');
select throws_ok(format('select public.accept_invitation(%L)', encode(extensions.gen_random_bytes(32), 'hex')),
  'P0001', 'invitation_invalid', 'a well-formed token that matches no invitation is refused');
select throws_ok($$ select public.accept_invitation(null) $$, 'P0001', 'invitation_invalid', 'a null token is refused');
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok(format('select public.accept_invitation(%L)', (select token from tokens where name = 'C')),
  '42501', 'not_allowed', 'a JWT with no sub cannot accept');

-- U has not confirmed their email.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);
insert into tokens select 'U', i.invitation_id, i.token
  from public.create_invitation('00000000-0000-4000-c000-0000000000f1', 'u@example.test') i;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000001","role":"authenticated"}', true);
select throws_ok(format('select public.accept_invitation(%L)', (select token from tokens where name = 'U')),
  'P0001', 'email_not_confirmed', 'an account whose email is not confirmed cannot accept');

-- F's invitation has expired.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);
insert into tokens select 'F', i.invitation_id, i.token
  from public.create_invitation('00000000-0000-4000-c000-0000000000f1', 'f@example.test') i;
reset role;
update public.invitations set expires_at = now() - interval '1 second'
 where id = (select invitation_id from tokens where name = 'F');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000f","role":"authenticated"}', true);
select throws_ok(format('select public.accept_invitation(%L)', (select token from tokens where name = 'F')),
  'P0001', 'invitation_expired', 'an expired invitation cannot be accepted');
select is_empty($$ select 1 from public.workspaces $$, 'after the refusals F is still in no workspace');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000e","role":"authenticated"}', true);
select is_empty($$ select 1 from public.workspaces $$, 'after the refusals E is still in no workspace');

-- 44-49. accept_invitation: the right account joins as a client, once.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000c","role":"authenticated"}', true);
select is_empty($$ select 1 from public.workspaces $$, 'before accepting, C sees no workspace');
select is(public.accept_invitation((select token from tokens where name = 'C')),
  '00000000-0000-4000-c000-0000000000f1'::uuid, 'C accepts and gets X''s id back');
select results_eq($$ select user_id, role from public.workspace_members where user_id = '00000000-0000-4000-a000-00000000000c' $$,
  $$ values ('00000000-0000-4000-a000-00000000000c'::uuid, 'client') $$, 'C is now a client of X');
select results_eq($$ select name from public.workspaces $$, $$ values ('X') $$, 'C now sees X');
select throws_ok(format('select public.accept_invitation(%L)', (select token from tokens where name = 'C')),
  'P0001', 'invitation_used', 'the same invitation cannot be accepted twice');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);
select isnt((select accepted_at from public.invitations where id = (select invitation_id from tokens where name = 'C')),
  null, 'the invitation is marked accepted');

-- 50-51. Revoking: the owner deletes a pending invitation and its link stops working.
select results_eq(
  $$ delete from public.invitations where id = (select invitation_id from tokens where name = 'C2') returning email $$,
  $$ values ('unused@example.test') $$, 'owner A revokes a pending invitation');
reset role;
insert into auth.users (id, email, email_confirmed_at)
  values ('00000000-0000-4000-a000-000000000002', 'unused@example.test', now());
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000002","role":"authenticated"}', true);
select throws_ok(format('select public.accept_invitation(%L)', (select token from tokens where name = 'C2')),
  'P0001', 'invitation_invalid', 'a revoked invitation''s link no longer works');
reset role;

-- 52-54. Cap: 20 pending (unaccepted, unexpired) invitations per workspace.
insert into public.invitations (workspace_id, email, token_hash, invited_by)
  select '00000000-0000-4000-c000-0000000000f2', 'p' || g || '@example.test',
         extensions.digest('pending' || g, 'sha256'), '00000000-0000-4000-a000-00000000000b'
    from generate_series(1, 20) g;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000b","role":"authenticated"}', true);
select throws_ok($$ select * from public.create_invitation('00000000-0000-4000-c000-0000000000f2', 'x@example.test') $$,
  'P0001', 'workspace_invitation_limit', 'a 21st pending invitation in one workspace is refused');
reset role;
update public.invitations set expires_at = now() - interval '1 second' where email = 'p1@example.test';
set local role authenticated;
select lives_ok($$ select * from public.create_invitation('00000000-0000-4000-c000-0000000000f2', 'x@example.test') $$,
  'an expired invitation no longer counts as pending');
select throws_ok($$ select * from public.create_invitation('00000000-0000-4000-c000-0000000000f2', 'y@example.test') $$,
  'P0001', 'workspace_invitation_limit', 'the workspace is at 20 pending again');
reset role;

-- 55-58. Cap: 20 invitations per owner per hour, and revoking frees no room.
-- A has made 4 so far (C, C2, U, F); add 15 from the last hour and 30 from before it.
insert into private.invitation_sends (user_id, created_at)
  select '00000000-0000-4000-a000-00000000000a', now() - interval '10 minutes' from generate_series(1, 15);
insert into private.invitation_sends (user_id, created_at)
  select '00000000-0000-4000-a000-00000000000a', now() - interval '61 minutes' from generate_series(1, 30);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);
select lives_ok(
  $$ insert into tokens select 'H20', i.invitation_id, i.token
       from public.create_invitation('00000000-0000-4000-c000-0000000000f1', 'h20@example.test') i $$,
  'the 20th invitation within the hour is allowed (older ones do not count)');
select lives_ok($$ delete from public.invitations where id = (select invitation_id from tokens where name = 'H20') $$,
  'owner A revokes it');
select throws_ok($$ select * from public.create_invitation('00000000-0000-4000-c000-0000000000f1', 'h21@example.test') $$,
  'P0001', 'hourly_invitation_limit', 'a 21st invitation within the hour is refused, even after revoking one');
reset role;
select is((select count(*)::int from private.invitation_sends where user_id = '00000000-0000-4000-a000-00000000000a'), 20,
  'sends older than an hour were cleaned up; the 20 from the last hour remain');

select * from finish();
rollback;

-- M2 PR 3, after /review-critical (ADR 0024 sections 5 and 7). Checked by
-- supabase/tests/database/080_invite_account_check.test.sql and scripts/ci/db-race-check.sh.
--
-- 1. An unconfirmed account that someone made by signing up with the address, before any invite,
--    keeps that person's password when Supabase's invite email reuses it, and the invited person's
--    click confirms it (measured on GoTrue v2.198.0: the sign-up's password then logs in). Whoever
--    signed up can be anyone who knows the address, so the invite flow deletes such an account
--    before the email goes out, and checks again after it (a sign-up in between). After the invite,
--    a sign-up stores no password (measured), so the account then has only the password the invited
--    person chooses.
--
-- 2. The cleanup's "no open invitation" check moves into a volatile function. A delete that waits on
--    the account's row lock (Supabase Auth updating it for a new invite) re-checks the row under the
--    statement's old snapshot, which can't see an invitation committed meanwhile; a volatile
--    function's query takes a fresh snapshot (PostgreSQL docs, "Function Volatility Categories").

-- Whether an invitation for the address is still open. Volatile on purpose (see 2 above).
create function private.has_open_invitation(p_email text) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return exists (
    select 1 from public.invitations i
     where i.email = lower(p_email) and i.accepted_at is null and i.expires_at > now());
end;
$$;

create or replace function private.delete_unused_invited_users(p_email text default null) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from auth.users u
   where u.invited_at is not null
     and u.email_confirmed_at is null
     and u.last_sign_in_at is null
     and coalesce(u.encrypted_password, '') = ''
     and (case when p_email is null
               then exists (select 1 from public.invitations i where i.email = lower(u.email))
               else lower(u.email) = lower(p_email) end)
     and not private.has_open_invitation(u.email);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Called by the invite action as the owner, before and after the invite email (see 1 above).
-- Deletes the open invitation's address's account if it is unconfirmed, never signed in, and has
-- a password: nobody has shown they own that address, and the password is not the invited
-- person's. An invited account with no password, and every confirmed or signed-in account, stay.
-- Returns how many accounts were deleted (0 or 1).
create function public.clear_unconfirmed_signup(p_invitation_id uuid) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_count integer;
begin
  select i.email into v_email
    from public.invitations i
   where i.id = p_invitation_id
     and i.accepted_at is null
     and i.expires_at > now()
     and private.is_owner(i.workspace_id);
  if (select auth.uid()) is null or v_email is null then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  delete from auth.users u
   where lower(u.email) = v_email
     and u.email_confirmed_at is null
     and u.last_sign_in_at is null
     and coalesce(u.encrypted_password, '') <> '';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function private.has_open_invitation(text), public.clear_unconfirmed_signup(uuid)
  from public, anon, authenticated;
grant execute on function public.clear_unconfirmed_signup(uuid) to authenticated;

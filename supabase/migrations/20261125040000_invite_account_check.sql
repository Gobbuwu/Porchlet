-- M2 PR 3, after /review-critical (ADR 0024 sections 5 and 7). Checked by
-- supabase/tests/database/080_invite_account_check.test.sql and scripts/ci/db-race-check.sh.
--
-- 1. An unconfirmed account that a sign-up made keeps that sign-up's password when Supabase's
--    invite email reuses it, and pressing the email's button confirms it (measured on GoTrue
--    v2.198.0). Two parts:
--    a. The invite action deletes such an account before the email (clear_unconfirmed_signup), so
--       the invite makes a fresh account with no password.
--    b. Whatever happens between that and the email (a sign-up in the moment between), an invited
--       account's password is cleared when its address is confirmed: only a password the confirming
--       person then sets opens it. An invited account is confirmed only by a link sent to the
--       address, so the person who confirms it is the address's owner.
--
-- 2. The cleanup no longer keeps an invited account that has a password: since 1a, such an
--    account is an unconfirmed sign-up that the invite reused (a sign-up in the moment before the
--    email), and Gobbu approved deleting unconfirmed sign-ups through the invite path (2026-11-25,
--    M2.md section 10). The hourly job acts only on addresses an unaccepted Porchlet invitation
--    names, so an address whose only rows were accepted is left alone.
--
-- 3. The cleanup's "no open invitation" check moves into a volatile function. A delete that waits on
--    the account's row lock (Supabase Auth updating it for a new invite) re-checks the row under the
--    statement's old snapshot, which can't see an invitation committed meanwhile; a volatile
--    function's query takes a fresh snapshot (PostgreSQL docs, "Function Volatility Categories").

-- Whether an invitation for the address is still open. Volatile on purpose (see 3 above).
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
     and (case when p_email is null
               then exists (select 1 from public.invitations i
                             where i.email = lower(u.email) and i.accepted_at is null)
               else lower(u.email) = lower(p_email) end)
     and not private.has_open_invitation(u.email);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Called by the invite action as the owner, before the invite email (see 1a above).
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

-- 1b: on the update that confirms the address of an account that an unaccepted Porchlet invitation
-- names, drop a password the account already had. A password set by that same update (an admin
-- setting one while confirming; no other Supabase Auth path doing so is known, unverified) is kept,
-- and so is the password of an account no unaccepted Porchlet invitation names.
create function private.clear_invited_password_on_confirm() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.email_confirmed_at is null and new.email_confirmed_at is not null
     and new.invited_at is not null and coalesce(new.encrypted_password, '') <> ''
     and new.encrypted_password is not distinct from old.encrypted_password
     and exists (select 1 from public.invitations i
                  where i.email = lower(new.email) and i.accepted_at is null) then
    new.encrypted_password := '';
  end if;
  return new;
end;
$$;

create trigger clear_invited_password_on_confirm
  before update on auth.users
  for each row execute function private.clear_invited_password_on_confirm();

revoke all on function private.has_open_invitation(text), public.clear_unconfirmed_signup(uuid),
  private.clear_invited_password_on_confirm()
  from public, anon, authenticated;
grant execute on function public.clear_unconfirmed_signup(uuid) to authenticated;

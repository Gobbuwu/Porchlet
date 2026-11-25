-- ADR 0027. Checked by supabase/tests/database/090_clear_password_on_confirm.test.sql and the E2E
-- tests in e2e/signup-confirm.spec.ts.
--
-- A sign-up stores its password before anyone has shown they own the address, and Supabase Auth
-- keeps that password through the confirmation, including after a later sign-up with the same
-- address (measured on GoTrue v2.198.0, ADR 0027). Porchlet treats a password as the account
-- owner's only when it was chosen after the address was confirmed.
--
-- From now on, the update that confirms an address drops any password the account already had,
-- once an emailed link has ever been sent to that address (this replaces 20261125040000's narrower
-- trigger, which did so only for addresses an unaccepted Porchlet invitation names). Only a password
-- the confirming person then sets opens the account; the app sends every confirm-link session to
-- choose one (ADR 0027).
--
-- "An emailed link was sent" is confirmation_sent_at, recovery_sent_at or invited_at being set
-- before the update. Every Supabase Auth path that can confirm an address through a link sets one of
-- them first (measured on GoTrue v2.198.0: sign-up and a sign-in link to an unconfirmed account set
-- confirmation_sent_at, a reset recovery_sent_at, an invite invited_at; a sign-up whose email fails
-- is rolled back). A confirm that no link preceded keeps the password: an admin creating a confirmed
-- account (an insert, then a confirm in the same request) or confirming an account it made; without
-- this exception both lost the password they were given (measured). A password written by the
-- confirming update itself is kept too (SQL only).
--
-- Requires email confirmations (enable_confirmations = true, ADR 0027): without them every sign-up
-- is confirmed at once, no link is sent, and nobody proves they own the address.

drop trigger clear_invited_password_on_confirm on auth.users;
drop function private.clear_invited_password_on_confirm();

create function private.clear_password_on_confirm() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.email_confirmed_at is null and new.email_confirmed_at is not null
     and (old.confirmation_sent_at is not null or old.recovery_sent_at is not null or old.invited_at is not null)
     and coalesce(new.encrypted_password, '') <> ''
     and new.encrypted_password is not distinct from old.encrypted_password then
    new.encrypted_password := '';
  end if;
  return new;
end;
$$;

create trigger clear_password_on_confirm
  before update on auth.users
  for each row execute function private.clear_password_on_confirm();

revoke all on function private.clear_password_on_confirm() from public, anon, authenticated;

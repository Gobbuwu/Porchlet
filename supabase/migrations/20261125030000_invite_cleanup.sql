-- M2 PR 3: delete the Supabase account an invite email made once no invitation for its address is
-- still pending, so a revoked or expired invite doesn't keep breaking that address's own sign-up
-- (docs/milestones/M2.md D2 and T8, ADR 0024). Checked by
-- supabase/tests/database/070_invite_cleanup.test.sql.
--
-- auth.admin.inviteUserByEmail creates an unconfirmed account with no usable password. While it
-- exists, the person's own sign-up stores no password they can use (measured on GoTrue v2.198.0:
-- after confirming, the chosen password answers invalid_credentials). Deleting the row (measured:
-- auth.identities and auth.one_time_tokens go with it) makes a later sign-up work normally.

-- Looked up by address below.
create index invitations_email_idx on public.invitations (email);

-- Deletes the accounts that only an invite email made and nobody has used: invited, never
-- confirmed, never signed in. Kept only while an invitation for the address is still pending
-- (in any workspace). With p_email, only that address (after its invitation was deleted); with
-- null, every such account Porchlet invited whose invitations have all expired (the hourly job).
-- A confirmed or signed-in account is never touched: those columns are checked in the delete
-- itself, so an account confirmed at the same moment is re-checked and kept (read committed).
-- Returns how many accounts were deleted.
create function private.delete_unused_invited_users(p_email text default null) returns integer
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
               then exists (select 1 from public.invitations i where i.email = lower(u.email))
               else lower(u.email) = lower(p_email) end)
     and not exists (
           select 1 from public.invitations i
            where i.email = lower(u.email) and i.accepted_at is null and i.expires_at > now());
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Revoking is a delete on invitations (the owner's delete policy, or a workspace's cascade), so
-- every way an invitation goes away cleans up after it.
create function private.invitations_after_delete() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.accepted_at is null then
    perform private.delete_unused_invited_users(old.email);
  end if;
  return null;
end;
$$;

create trigger invitations_after_delete
  after delete on public.invitations
  for each row execute function private.invitations_after_delete();

revoke all on function private.delete_unused_invited_users(text), private.invitations_after_delete()
  from public, anon, authenticated;

-- Expiry has no event, so an hourly job catches invitations that expired (Supabase Cron, the
-- pg_cron extension: supabase.com/docs/guides/cron/install). At most an hour after expiry.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule(
  'porchlet-delete-unused-invited-users',
  '17 * * * *',
  'select private.delete_unused_invited_users()'
);

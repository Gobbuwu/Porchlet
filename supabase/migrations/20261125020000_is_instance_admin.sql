-- M2 PR 2: lets the workspaces page show "Create workspace" only to the instance admin (ADR 0025).
-- private.instance is closed to the API roles (M0, ADR 0017), so the app can't read admin_user_id
-- itself. This answers one question about the caller only: whether they are the admin. It names
-- no one, and create_workspace still makes its own check, so the answer gates no data.
-- Checked by supabase/tests/database/060_instance_admin.test.sql.

create function public.is_instance_admin() returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.instance i
     where i.admin_user_id is not null and i.admin_user_id = (select auth.uid()));
$$;

revoke all on function public.is_instance_admin() from public, anon, authenticated;
grant execute on function public.is_instance_admin() to authenticated;

-- M1: public.profiles, the trigger that creates a profile on sign-up, grants and RLS.
-- Design doc section 3 ("Tables", "Grants", "Policies"). Checked by
-- supabase/tests/database/010_profiles.test.sql.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  created_at timestamptz not null default now()
);

-- The M0 default privileges leave anon and authenticated with nothing on new tables, so only
-- these grants apply. Rows are created by the trigger below and removed by the cascade from
-- auth.users, so the API roles get no insert or delete, and only display_name is writable.
alter table public.profiles enable row level security;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

-- M1 lets a user see only their own profile. M2 widens select to co-members of a workspace
-- (private.shares_workspace), and M4 adds the restrictive mfa_opt_in policy.
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Runs as postgres (security definer) when Supabase Auth inserts a user, because the auth role
-- has no grant on public.profiles. It lives in private so PostgREST can't expose it, it reads
-- nothing from the client (display_name starts empty, so user metadata can't fail a sign-up or
-- reach the table unchecked), and search_path is empty so every name is schema-qualified.
-- The M0 global default revoke means nobody gets execute on it; a trigger does not need it.
create function private.handle_new_user() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- M2: workspaces, members, invitations and projects; their helpers, grants, RLS and RPCs; and the
-- profiles select widened to co-members. Design doc section 3, docs/milestones/M2.md (PR 1),
-- ADR 0006. Checked by supabase/tests/database/040_workspaces.test.sql,
-- 050_invitations.test.sql and scripts/ci/db-race-check.sh.
--
-- The co-member profile read that the M1 profiles migration announced as private.shares_workspace
-- is built here as profiles_select_co_member with private.co_member_ids().
--
-- Decision D1 (M2.md): no aal2() here. M4 adds aal2() to the owner actions and the restrictive
-- mfa_opt_in policy to every table in one migration.

-- Tables -----------------------------------------------------------------------------------------

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  created_by uuid not null references auth.users (id),
  storage_quota_bytes bigint not null default 209715200, -- 200 MB, used from M3
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'client')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
-- The primary key serves lookups by workspace; the helpers also look up by user.
create index workspace_members_user_id_idx on public.workspace_members (user_id, workspace_id);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email text not null check (email = lower(email) and char_length(email) between 3 and 254),
  token_hash bytea not null unique check (octet_length(token_hash) = 32), -- sha256 of the token
  invited_by uuid not null references auth.users (id),
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
create index invitations_workspace_id_idx on public.invitations (workspace_id);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  unique (id, workspace_id) -- target of M3's files (project_id, workspace_id) foreign key
);
create index projects_workspace_id_idx on public.projects (workspace_id);

-- Every invitation create_invitation made, kept when the invitation is deleted, so that revoking
-- and inviting again can't get around the per-owner hourly cap (ADR 0006). create_invitation
-- deletes the caller's rows older than an hour. Private: no grants, RLS with no policies (ADR 0017).
create table private.invitation_sends (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  created_at timestamptz not null default now()
);
create index invitation_sends_user_id_created_at_idx on private.invitation_sends (user_id, created_at);
alter table private.invitation_sends enable row level security;
revoke all on table private.invitation_sends from public, anon, authenticated;

-- Grants -----------------------------------------------------------------------------------------
-- The M0 default privileges leave anon and authenticated with nothing on new tables, so only these
-- grants apply, and anon gets none. Inserts into workspaces, workspace_members and invitations go
-- only through the security definer functions below (ADR 0006), so the API can't choose a role,
-- an inviter or a token. Column grants keep ids, timestamps and workspace_id unwritable.

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.invitations enable row level security;
alter table public.projects enable row level security;

grant select on public.workspaces to authenticated;
grant update (name) on public.workspaces to authenticated;

grant select, delete on public.workspace_members to authenticated;

-- token_hash is left out: nothing in the app needs it, so an owner's session can't read it.
grant select (id, workspace_id, email, invited_by, expires_at, accepted_at, created_at)
  on public.invitations to authenticated;
grant delete on public.invitations to authenticated;

grant select, delete on public.projects to authenticated;
grant insert (workspace_id, name) on public.projects to authenticated;
grant update (name, status) on public.projects to authenticated;

-- Helpers ----------------------------------------------------------------------------------------
-- Policies run as the querying role, so authenticated needs usage on private and execute on the
-- three set-returning helpers (and nothing else in private: the M0 global default revoke means no
-- other function there has an execute grant, and every private table has no grants and RLS on).
-- security definer lets them read workspace_members without the policies calling themselves.
--
-- Policies use `column in (select private.x_ids())`, not a per-row `private.is_member(column)`:
-- the set is computed once per statement and hashed. Measured with scripts/dev/policy-perf.sql
-- (20,000 projects, ADR 0006): a full select took 123.9 to 132.2 ms per-row, 1.3 to 1.6 ms set-based.

grant usage on schema private to authenticated;

-- Workspaces the caller is a member of (any role).
create function private.member_workspace_ids() returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid());
$$;

-- Workspaces the caller owns.
create function private.owner_workspace_ids() returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.workspace_id from public.workspace_members m
   where m.user_id = (select auth.uid()) and m.role = 'owner';
$$;

-- Users who share a workspace with the caller, the caller included (for reading co-members'
-- profiles).
create function private.co_member_ids() returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct theirs.user_id
    from public.workspace_members mine
    join public.workspace_members theirs on theirs.workspace_id = mine.workspace_id
   where mine.user_id = (select auth.uid());
$$;

-- For the functions below only (they run as postgres); not granted to the API roles.
create function private.is_owner(p_workspace_id uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
     where m.workspace_id = p_workspace_id and m.user_id = (select auth.uid()) and m.role = 'owner');
$$;

revoke all on function private.member_workspace_ids(), private.owner_workspace_ids(),
  private.co_member_ids(), private.is_owner(uuid) from public, anon, authenticated;
grant execute on function private.member_workspace_ids(), private.owner_workspace_ids(),
  private.co_member_ids() to authenticated;

-- Policies (all permissive, to authenticated) ----------------------------------------------------

create policy workspaces_select_member on public.workspaces
  for select to authenticated
  using (id in (select private.member_workspace_ids()));
create policy workspaces_update_owner on public.workspaces
  for update to authenticated
  using (id in (select private.owner_workspace_ids()))
  with check (id in (select private.owner_workspace_ids()));

create policy workspace_members_select_member on public.workspace_members
  for select to authenticated
  using (workspace_id in (select private.member_workspace_ids()));
-- An owner removes anyone but themselves (so a workspace keeps its owner); a client can leave.
create policy workspace_members_delete_owner_or_self on public.workspace_members
  for delete to authenticated
  using (
    (workspace_id in (select private.owner_workspace_ids()) and user_id <> (select auth.uid()))
    or (user_id = (select auth.uid()) and role = 'client'));

create policy invitations_select_owner on public.invitations
  for select to authenticated
  using (workspace_id in (select private.owner_workspace_ids()));
create policy invitations_delete_owner on public.invitations
  for delete to authenticated
  using (workspace_id in (select private.owner_workspace_ids()));

create policy projects_select_member on public.projects
  for select to authenticated
  using (workspace_id in (select private.member_workspace_ids()));
create policy projects_insert_owner on public.projects
  for insert to authenticated
  with check (workspace_id in (select private.owner_workspace_ids()));
create policy projects_update_owner on public.projects
  for update to authenticated
  using (workspace_id in (select private.owner_workspace_ids()))
  with check (workspace_id in (select private.owner_workspace_ids()));
create policy projects_delete_owner on public.projects
  for delete to authenticated
  using (workspace_id in (select private.owner_workspace_ids()));

-- M1 promised this: co-members see each other's profile (display_name is its only data column).
create policy profiles_select_co_member on public.profiles
  for select to authenticated
  using (id in (select private.co_member_ids()));

-- Functions the app calls (RPC) ------------------------------------------------------------------
-- security definer, empty search_path, execute for authenticated only. Errors the app shows use
-- SQLSTATE P0001 with a stable message key; "not allowed" is 42501 for every caller who isn't
-- entitled, so the answer doesn't say whether a workspace exists.

-- The instance admin (private.instance.admin_user_id, set by scripts/dev/make-admin.sql until the
-- M5 wizard) creates a workspace and becomes its owner, in one transaction.
create function public.create_workspace(p_name text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_id uuid;
begin
  if v_uid is null or not exists (
       select 1 from private.instance i where i.admin_user_id = v_uid) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  insert into public.workspaces (name, created_by) values (p_name, v_uid) returning id into v_id;
  insert into public.workspace_members (workspace_id, user_id, role) values (v_id, v_uid, 'owner');
  return v_id;
end;
$$;

-- An owner invites an email address. Returns the invitation id and the raw token, once: only the
-- token's sha256 is stored. Limits: 20 pending invitations per workspace, and 20 invitations per
-- owner per hour counted from private.invitation_sends (so deleting invitations frees no room).
-- The workspace row lock (for no key update) and a per-owner advisory lock, taken in that order and held to the end of
-- the caller's transaction, make two parallel calls count one after the other; under repeatable
-- read or serializable the counts would come from a snapshot taken before the wait, so those
-- levels are refused (as in rate_limit_take, ADR 0022).
create function public.create_invitation(p_workspace_id uuid, p_email text)
returns table (invitation_id uuid, token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text := lower(btrim(p_email));
  v_token bytea;
  v_id uuid;
begin
  if v_uid is null or p_workspace_id is null or not private.is_owner(p_workspace_id) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'create_invitation needs read committed, not %', current_setting('transaction_isolation');
  end if;
  if v_email is null or char_length(v_email) > 254
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid_email' using errcode = 'P0001';
  end if;

  -- for no key update conflicts with itself, so parallel calls queue, but not with the key-share
  -- locks that foreign-key checks take, so project and membership inserts don't wait for it.
  perform 1 from public.workspaces w where w.id = p_workspace_id for no key update;
  perform pg_advisory_xact_lock(hashtextextended('porchlet.invitation_sends:' || v_uid::text, 0));

  if exists (
       select 1 from public.workspace_members m join auth.users u on u.id = m.user_id
        where m.workspace_id = p_workspace_id and lower(u.email) = v_email) then
    raise exception 'already_member' using errcode = 'P0001';
  end if;
  if exists (
       select 1 from public.invitations i
        where i.workspace_id = p_workspace_id and i.email = v_email
          and i.accepted_at is null and i.expires_at > now()) then
    raise exception 'invitation_pending' using errcode = 'P0001';
  end if;
  if (select count(*) from public.invitations i
       where i.workspace_id = p_workspace_id and i.accepted_at is null and i.expires_at > now()) >= 20 then
    raise exception 'workspace_invitation_limit' using errcode = 'P0001';
  end if;

  delete from private.invitation_sends s
   where s.user_id = v_uid and s.created_at <= now() - interval '1 hour';
  if (select count(*) from private.invitation_sends s where s.user_id = v_uid) >= 20 then
    raise exception 'hourly_invitation_limit' using errcode = 'P0001';
  end if;

  v_token := extensions.gen_random_bytes(32);
  insert into public.invitations (workspace_id, email, token_hash, invited_by)
  values (p_workspace_id, v_email, extensions.digest(v_token, 'sha256'), v_uid)
  returning id into v_id;
  insert into private.invitation_sends (user_id) values (v_uid);

  invitation_id := v_id;
  token := encode(v_token, 'hex');
  return next;
end;
$$;

-- The invited person accepts with the raw token. The caller's own auth.users row, not the JWT,
-- gives the email and whether it is confirmed. The invitation row is locked first, so of two
-- parallel accepts the second waits, then sees accepted_at set. Returns the workspace id.
create function public.accept_invitation(p_token text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_hash bytea;
  v_inv record;
  v_email text;
  v_confirmed timestamptz;
begin
  if v_uid is null then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'invitation_invalid' using errcode = 'P0001';
  end if;
  v_hash := extensions.digest(decode(p_token, 'hex'), 'sha256');

  select i.id, i.workspace_id, i.email, i.expires_at, i.accepted_at into v_inv
    from public.invitations i where i.token_hash = v_hash
     for update;
  if not found then
    raise exception 'invitation_invalid' using errcode = 'P0001';
  end if;
  if v_inv.accepted_at is not null then
    raise exception 'invitation_used' using errcode = 'P0001';
  end if;
  if v_inv.expires_at <= now() then
    raise exception 'invitation_expired' using errcode = 'P0001';
  end if;

  select lower(u.email), u.email_confirmed_at into v_email, v_confirmed
    from auth.users u where u.id = v_uid;
  if v_email is distinct from v_inv.email then
    raise exception 'invitation_wrong_account' using errcode = 'P0001';
  end if;
  if v_confirmed is null then
    raise exception 'email_not_confirmed' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.workspace_members m
              where m.workspace_id = v_inv.workspace_id and m.user_id = v_uid) then
    raise exception 'already_member' using errcode = 'P0001';
  end if;

  update public.invitations set accepted_at = now() where id = v_inv.id;
  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_inv.workspace_id, v_uid, 'client');
  return v_inv.workspace_id;
end;
$$;

-- Owners of a workspace see its members with their emails (decision D3). Anyone else, clients
-- included, gets not_allowed: clients see co-members' display names through profiles only.
create function public.list_workspace_members(p_workspace_id uuid)
returns table (user_id uuid, role text, display_name text, email text, joined_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_workspace_id is null or not private.is_owner(p_workspace_id) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return query
    select m.user_id, m.role, coalesce(p.display_name, ''), u.email::text, m.created_at
      from public.workspace_members m
      join auth.users u on u.id = m.user_id
      left join public.profiles p on p.id = m.user_id
     where m.workspace_id = p_workspace_id
     order by m.created_at, m.user_id;
end;
$$;

revoke all on function public.create_workspace(text), public.create_invitation(uuid, text),
  public.accept_invitation(text), public.list_workspace_members(uuid) from public, anon, authenticated;
grant execute on function public.create_workspace(text), public.create_invitation(uuid, text),
  public.accept_invitation(text), public.list_workspace_members(uuid) to authenticated;

-- M1: session lifetime limits (ADR 0020, ASVS 5.0.0 7.1.1, 7.3.1, 7.3.2).
-- Supabase's own time-box and inactivity timeout are paid-plan settings
-- (supabase.com/docs/guides/auth/sessions). Supabase Auth itself refuses to refresh a session
-- whose auth.sessions.not_after has passed, on every plan (Session.CheckValidity in
-- internal/models/sessions.go, and measured: 400 session_expired). These triggers set not_after
-- from the limits below, so every client of this project, not only the app, is held to them.
-- Checked by supabase/tests/database/030_session_limits.test.sql and e2e/session-limits.spec.ts.
--
-- Supabase checks not_after only when a session refreshes, so an access token issued before the
-- limit stays valid until it expires (jwt_expiry, 1 hour). Activity is seen only at refreshes,
-- which happen about once per jwt_expiry while someone is active, so idle_timeout must be longer
-- than jwt_expiry, and the effective idle limit is between idle_timeout - jwt_expiry and
-- idle_timeout.

-- One row. To change the limits on an instance: update private.session_limits set ...;
-- New values apply to each session at its next sign-in or refresh. With no row, sessions have no
-- limits again, so the row is checked by the database tests.
create table private.session_limits (
  id boolean primary key default true check (id),
  absolute_lifetime interval not null check (absolute_lifetime > interval '0'),
  -- null means no inactivity timeout.
  idle_timeout interval check (idle_timeout > interval '1 hour')
);
revoke all on table private.session_limits from public, anon, authenticated;
alter table private.session_limits enable row level security;

insert into private.session_limits (absolute_lifetime, idle_timeout)
values (interval '24 hours', interval '2 hours');

-- The latest a session may still refresh: its start plus the absolute lifetime, or the last
-- activity (now) plus the idle timeout, whichever comes first. Null when there are no limits.
-- security definer because Supabase Auth's database role (supabase_auth_admin) has no usage on
-- schema private; search_path is empty so every name is schema-qualified. Nobody has execute on
-- it (M0 global default revoke); triggers don't need it.
create function private.session_not_after(p_created_at timestamptz) returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select least(
    coalesce(p_created_at, now()) + l.absolute_lifetime,
    now() + l.idle_timeout
  )
  from private.session_limits l
$$;

-- On sign-in. A stricter not_after already set by Supabase Auth is kept. (Supabase sets one only
-- for SSO sessions, which Porchlet doesn't use; limit_refreshed_session would replace it.)
create function private.limit_new_session() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.not_after := least(new.not_after, private.session_not_after(new.created_at));
  return new;
end;
$$;

-- On refresh: Supabase Auth writes refreshed_at (with user_agent and ip) each time it refreshes a
-- session (Session.UpdateOnlyRefreshInfo), after it has checked not_after. The refresh counts as
-- activity, so the idle limit moves forward; the absolute limit never does.
create function private.limit_refreshed_session() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.not_after := private.session_not_after(new.created_at);
  return new;
end;
$$;

create trigger limit_new_session
  before insert on auth.sessions
  for each row execute function private.limit_new_session();

create trigger limit_refreshed_session
  before update of refreshed_at on auth.sessions
  for each row execute function private.limit_refreshed_session();

-- Sessions that exist when this runs get the absolute limit now; their idle limit starts at
-- their next refresh.
update auth.sessions
set not_after = least(not_after, coalesce(created_at, now()) + (select absolute_lifetime from private.session_limits));

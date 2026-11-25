-- Makes an existing, confirmed account the instance admin, who may create workspaces
-- (decision D4 in docs/milestones/M2.md). For the local stack and the porchlet-test project only,
-- until the M5 setup wizard replaces it. Never run it on a real deployment.
--
-- Local:  psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -X \
--           -v admin_email=you@example.com -f scripts/dev/make-admin.sql
-- Hosted (SQL Editor, porchlet-test): replace :'admin_email' below with the address in quotes,
--   for example 'you@example.com', then run the whole file.
begin;
select set_config('porchlet.admin_email', :'admin_email', true);

do $$
declare
  v_email text := lower(btrim(current_setting('porchlet.admin_email')));
  v_user uuid;
  v_confirmed timestamptz;
  v_old uuid;
begin
  -- Supabase's email uniqueness covers non-SSO users only, so refuse an address that matches more
  -- than one account rather than pick one.
  if (select count(*) from auth.users u where lower(u.email) = v_email) > 1 then
    raise exception 'More than one account has the email %; set admin_user_id by id instead', v_email;
  end if;
  select u.id, u.email_confirmed_at into v_user, v_confirmed
    from auth.users u where lower(u.email) = v_email;
  if v_user is null then
    raise exception 'No account with the email %', v_email;
  end if;
  if v_confirmed is null then
    raise exception 'The account % has not confirmed its email yet', v_email;
  end if;
  select i.admin_user_id into v_old from private.instance i;
  update private.instance set admin_user_id = v_user;
  if v_old is not null and v_old <> v_user then
    raise notice 'Replaced the previous admin (user id %)', v_old;
  end if;
  raise notice 'Admin is now % (user id %)', v_email, v_user;
end;
$$;

commit;

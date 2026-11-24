-- M1: the auth limiter checks and counts in one step (ADR 0022, amends ADR 0015).
-- public.rate_limit_hit counted and checked in separate steps: logins checked before the attempt
-- and counted after Supabase answered, and the other actions inserted, then counted rows that
-- parallel transactions hadn't committed yet. Parallel posts from one IP got past every limit
-- (measured on the local stack: 20 of 20 parallel wrong passwords for one account were tried
-- against a limit of 5). rate_limit_take replaces it: under a lock per bucket it checks every rule
-- and, only when all have room, records one hit per rule, so at most `limit` attempts per window
-- are ever let through. Checked by supabase/tests/database/020_rate_limit.test.sql and the
-- parallel tests in e2e/rate-limit.spec.ts.

drop function public.rate_limit_hit(text, text, text, integer, boolean);

-- An id per hit, so a login can give back the hit it took once the password proved right.
alter table private.rate_limit_hits add column id bigint generated always as identity primary key;

-- True when p_key is the server's RATE_LIMIT_KEY (its SHA-256 is in private.rate_limit_key).
create function private.rate_limit_key_ok(p_key text) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_key is not null and exists (
    select 1 from private.rate_limit_key where key_hash = extensions.digest(p_key, 'sha256'));
$$;
revoke all on function private.rate_limit_key_ok(text) from public, anon, authenticated;

-- Takes one attempt from each rule's bucket for the visitor's IP: rule i is p_scopes[i], at most
-- p_limits[i] hits within p_windows[i] seconds. Returns the new hits' ids when every bucket had
-- room, an empty array when any bucket is full (nothing is recorded then), or null when the key is
-- wrong or an argument is out of range. The bucket is the scope plus the visitor's IP: the full
-- address for IPv4 and the /64 network for IPv6, since one IPv6 user usually holds a whole /64.
-- An address that doesn't parse counts as 'unknown'.
--
-- Why it can't overshoot: each bucket is guarded by a transaction-level advisory lock, taken in a
-- fixed order (so two calls sharing buckets can't deadlock), and held until the caller's
-- transaction commits. A parallel call waits for it, and its count, a new statement under read
-- committed, then sees the committed hits. Under repeatable read or serializable the count would
-- use a snapshot taken before the wait, so those levels are refused. Old hits are cleaned up
-- before any lock is taken and skip rows another call is deleting, so cleanup never waits while
-- holding a bucket lock.
create function public.rate_limit_take(
  p_key text,
  p_ip text,
  p_scopes text[],
  p_limits integer[],
  p_windows integer[]
) returns bigint[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer := cardinality(p_scopes);
  v_ip inet;
  v_who text;
  v_buckets text[];
  v_lock integer;
  v_ids bigint[];
begin
  if not private.rate_limit_key_ok(p_key) then
    return null;
  end if;
  if v_n is null or v_n not between 1 and 10
     or cardinality(p_limits) is distinct from v_n or cardinality(p_windows) is distinct from v_n
     or array_position(p_scopes, null) is not null
     or array_position(p_limits, null) is not null or array_position(p_windows, null) is not null
     or exists (select 1 from unnest(p_scopes) s where char_length(s) > 120)
     or exists (select 1 from unnest(p_limits) l where l not between 1 and 1000)
     or exists (select 1 from unnest(p_windows) w where w not between 1 and 3600)
     or (select count(distinct s) from unnest(p_scopes) s) <> v_n then
    return null;
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'rate_limit_take needs read committed, not %', current_setting('transaction_isolation');
  end if;

  begin
    v_ip := p_ip::inet;
  exception when others then
    v_ip := null;
  end;
  v_who := coalesce(
    case when family(v_ip) = 6 then network(set_masklen(v_ip, 64))::text else host(v_ip) end,
    'unknown');
  select array_agg(s || '|' || v_who order by i) into v_buckets
  from unnest(p_scopes) with ordinality as t (s, i);

  delete from private.rate_limit_hits
  where id in (
    select id from private.rate_limit_hits where at < now() - interval '1 hour'
    for update skip locked);

  -- A hash collision only makes two buckets share a lock, which is still correct.
  for v_lock in select distinct hashtext(b) from unnest(v_buckets) b order by 1 loop
    perform pg_advisory_xact_lock(hashtext('porchlet.rate_limit'), v_lock);
  end loop;

  if exists (
    select 1 from unnest(v_buckets, p_limits, p_windows) as r (bucket, lim, win)
    where (select count(*) from private.rate_limit_hits h
           where h.bucket = r.bucket and h.at > now() - make_interval(secs => r.win)) >= r.lim
  ) then
    return '{}';
  end if;

  with ins as (
    insert into private.rate_limit_hits (bucket) select unnest(v_buckets) returning id
  )
  select array_agg(id) into v_ids from ins;
  return v_ids;
end;
$$;

-- Gives back hits taken by rate_limit_take: a login whose password proved right, or one that
-- Supabase refused before checking the password, doesn't count as a failure. Returns how many
-- hits it removed, or null when the key is wrong or the list is empty or too long.
create function public.rate_limit_release(p_key text, p_ids bigint[]) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not private.rate_limit_key_ok(p_key) or cardinality(p_ids) is null
     or cardinality(p_ids) not between 1 and 10 then
    return null;
  end if;
  delete from private.rate_limit_hits where id = any(p_ids);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- The server calls them with the publishable key (role anon), or as the signed-in user when
-- changing a password. The key check is what guards them.
revoke all on function public.rate_limit_take(text, text, text[], integer[], integer[]) from public;
revoke all on function public.rate_limit_release(text, bigint[]) from public;
grant execute on function public.rate_limit_take(text, text, text[], integer[], integer[]) to anon, authenticated;
grant execute on function public.rate_limit_release(text, bigint[]) to anon, authenticated;

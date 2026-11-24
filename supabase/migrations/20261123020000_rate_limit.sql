-- M1: Porchlet's own per-IP rate limiter for the auth Server Actions (ADR 0015).
-- Supabase Auth limits by the caller's IP, and every call from the app comes from the server's
-- IP, so all visitors share one limit (measured on the hosted test project, M1.md). The server
-- counts attempts here per visitor IP before it calls Supabase Auth. Checked by
-- supabase/tests/database/020_rate_limit.test.sql.

-- One row per counted attempt. Rows older than an hour are deleted as new ones arrive.
create table private.rate_limit_hits (
  bucket text not null check (char_length(bucket) <= 200),
  at timestamptz not null default now()
);
create index rate_limit_hits_bucket_at on private.rate_limit_hits (bucket, at);
create index rate_limit_hits_at on private.rate_limit_hits (at);
revoke all on table private.rate_limit_hits from public, anon, authenticated;

-- SHA-256 of the server's RATE_LIMIT_KEY. Only a caller holding that key can touch the counters,
-- so a direct API caller can't fill another visitor's bucket. The key grants nothing else: no
-- table, no auth, no other function. Set by scripts/e2e/write-env.sh locally and by the setup
-- wizard (M5) on a real instance; with no row, every call is refused and the app fails closed.
create table private.rate_limit_key (
  id boolean primary key default true check (id),
  key_hash bytea not null check (octet_length(key_hash) = 32)
);
revoke all on table private.rate_limit_key from public, anon, authenticated;

-- Records an attempt (when p_record) and returns how many attempts the bucket holds within the
-- window, or null when the key is wrong. The bucket is p_scope plus the visitor's IP: the full
-- address for IPv4 and the /64 network for IPv6, since one IPv6 user usually holds a whole /64.
-- An address that doesn't parse counts as 'unknown'. security definer so the API roles never get
-- a grant on the tables; search_path is empty so every name is schema-qualified.
create function public.rate_limit_hit(
  p_key text,
  p_scope text,
  p_ip text,
  p_window_seconds integer,
  p_record boolean
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ip inet;
  v_bucket text;
  v_count integer;
begin
  if p_key is null or not exists (
    select 1 from private.rate_limit_key
    where key_hash = extensions.digest(p_key, 'sha256')
  ) then
    return null;
  end if;
  if p_scope is null or char_length(p_scope) > 120
     or p_window_seconds is null or p_window_seconds not between 1 and 3600 then
    return null;
  end if;

  begin
    v_ip := p_ip::inet;
  exception when others then
    v_ip := null;
  end;
  v_bucket := p_scope || '|' || coalesce(
    case when family(v_ip) = 6 then network(set_masklen(v_ip, 64))::text else host(v_ip) end,
    'unknown');

  delete from private.rate_limit_hits where at < now() - interval '1 hour';
  if p_record then
    insert into private.rate_limit_hits (bucket) values (v_bucket);
  end if;
  select count(*) into v_count
  from private.rate_limit_hits
  where bucket = v_bucket and at > now() - make_interval(secs => p_window_seconds);
  return v_count;
end;
$$;

-- The server calls it with the publishable key (role anon), or as the signed-in user when
-- changing a password. The key check above is what guards it.
grant execute on function public.rate_limit_hit(text, text, text, integer, boolean) to anon, authenticated;

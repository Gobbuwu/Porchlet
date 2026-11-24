#!/usr/bin/env bash
# Writes .env.local for the app from the running local Supabase stack (`npx supabase start`).
# The two public values the app needs, plus a fresh RATE_LIMIT_KEY whose SHA-256 is stored in the
# local database (ADR 0015). The stack's secret key is never written.
set -euo pipefail
status=$(npx supabase status -o json)
url=$(jq -er '.API_URL' <<<"$status")
key=$(jq -er '.PUBLISHABLE_KEY' <<<"$status")
case "$key" in sb_publishable_*) ;; *) echo "unexpected publishable key format" >&2; exit 1 ;; esac
db_url=$(jq -er '.DB_URL' <<<"$status")
limit_key=$(openssl rand -hex 32)
psql "$db_url" -v ON_ERROR_STOP=1 -q -v limit_key="$limit_key" <<'SQL'
insert into private.rate_limit_key (key_hash) values (extensions.digest(:'limit_key', 'sha256'))
on conflict (id) do update set key_hash = excluded.key_hash;
SQL
printf 'NEXT_PUBLIC_SUPABASE_URL=%s\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=%s\nRATE_LIMIT_KEY=%s\n' \
  "$url" "$key" "$limit_key" > .env.local
echo "wrote .env.local for $url"

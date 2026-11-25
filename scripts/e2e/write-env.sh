#!/usr/bin/env bash
# Writes .env.local for the app from the running local Supabase stack (`npx supabase start`).
# The two public values the app needs, a fresh RATE_LIMIT_KEY whose SHA-256 is stored in the local
# database (ADR 0015), the site's URL, and the local stack's secret key, which the invite email
# needs (ADR 0005, ADR 0024). Local stack only: .env.local is ignored by git.
set -euo pipefail
status=$(npx supabase status -o json)
url=$(jq -er '.API_URL' <<<"$status")
key=$(jq -er '.PUBLISHABLE_KEY' <<<"$status")
case "$key" in sb_publishable_*) ;; *) echo "unexpected publishable key format" >&2; exit 1 ;; esac
db_url=$(jq -er '.DB_URL' <<<"$status")
secret=$(jq -er '.SECRET_KEY' <<<"$status")
# The whole URL must be a local host and port (as in make-admin.sh), so a stack's secret key is
# never written for anything else.
[[ $url =~ ^http://(127\.0\.0\.1|localhost):[0-9]+/?$ ]] || { echo "refusing: $url is not a local stack" >&2; exit 1; }
case "$secret" in sb_secret_*) ;; *) echo "unexpected secret key format" >&2; exit 1 ;; esac
limit_key=$(openssl rand -hex 32)
psql "$db_url" -v ON_ERROR_STOP=1 -q -v limit_key="$limit_key" <<'SQL'
insert into private.rate_limit_key (key_hash) values (extensions.digest(:'limit_key', 'sha256'))
on conflict (id) do update set key_hash = excluded.key_hash;
SQL
# SITE_URL matches the stack's site_url (supabase/config.toml) and Playwright's baseURL.
(umask 077 && printf 'NEXT_PUBLIC_SUPABASE_URL=%s\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=%s\nRATE_LIMIT_KEY=%s\nSITE_URL=%s\nSUPABASE_SECRET_KEY=%s\n' \
  "$url" "$key" "$limit_key" "http://127.0.0.1:3000" "$secret" > .env.local)
echo "wrote .env.local for $url"

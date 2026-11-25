#!/usr/bin/env bash
# Makes a fresh instance admin for E2E on the running local Supabase stack (decision D4: the
# admin is set by scripts/dev/make-admin.sql until the M5 wizard). Creates a confirmed account
# with a random password through Supabase Auth's admin API, makes it the admin with
# make-admin.sql, and writes its email and password to .env.e2e-admin (ignored by git, like
# .env.local) for e2e/support/workspaces.ts. Local stack only: the stack's secret key is used for
# this one call and never written.
# There is one admin per instance, so this replaces the stack's current admin (make-admin.sql
# prints a notice when it does); run make-admin.sql again to make your own account the admin.
set -euo pipefail
status=$(npx supabase status -o json)
api=$(jq -er '.API_URL' <<<"$status")
db_url=$(jq -er '.DB_URL' <<<"$status")
secret=$(jq -er '.SECRET_KEY' <<<"$status")
# The whole URL must be a local host and port: a glob such as http://127.0.0.1:* would also match
# http://127.0.0.1:1@other.host/ and send the key elsewhere.
[[ $api =~ ^http://(127\.0\.0\.1|localhost):[0-9]+/?$ ]] || { echo "refusing: $api is not a local stack" >&2; exit 1; }

email="e2e-admin-$(openssl rand -hex 6)@example.test"
password="pw-$(openssl rand -hex 16)"
body=$(jq -nc --arg email "$email" --arg password "$password" '{email: $email, password: $password, email_confirm: true}')
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$api/auth/v1/admin/users" \
  -H "apikey: $secret" -H "authorization: Bearer $secret" -H 'content-type: application/json' --data "$body")
[ "$code" = 200 ] || { echo "creating the admin account answered HTTP $code" >&2; exit 1; }

psql "$db_url" -X -q -v ON_ERROR_STOP=1 -v admin_email="$email" -f scripts/dev/make-admin.sql >/dev/null
printf 'E2E_ADMIN_EMAIL=%s\nE2E_ADMIN_PASSWORD=%s\n' "$email" "$password" > .env.e2e-admin
echo "made $email the instance admin; wrote .env.e2e-admin"

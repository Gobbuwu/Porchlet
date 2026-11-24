#!/usr/bin/env bash
# Checks the session limits (ADR 0020) against the real Supabase Auth server of the local stack,
# which the pgTAP tests can't reach: that Auth's own writes fire the auth.sessions triggers, and
# that Auth refuses to refresh a session once not_after has passed (it does so on every plan,
# Session.CheckValidity in supabase/auth). Run after `npx supabase start`. Uses the local stack's
# secret key only to create and delete a throwaway user; nothing is written to disk.
set -euo pipefail

status=$(npx supabase status -o json 2>/dev/null)
api=$(jq -er '.API_URL' <<<"$status")
key=$(jq -er '.PUBLISHABLE_KEY' <<<"$status")
secret=$(jq -er '.SECRET_KEY' <<<"$status")
db=$(jq -er '.DB_URL' <<<"$status")
email="session-limit-$(openssl rand -hex 6)@example.test"
password="pw-$(openssl rand -hex 16)"
fail=0
check() { if [ "$2" = "true" ]; then echo "ok   $1"; else echo "FAIL $1 ($3)"; fail=1; fi; }
near120() { [ -n "$1" ] && [ "$1" -ge 119 ] && [ "$1" -le 120 ] && echo true; }
sql() { psql "$db" -X -tA -v ON_ERROR_STOP=1 -c "$1"; }
token() { curl -sS -X POST "$api/auth/v1/token?grant_type=$1" -H "apikey: $key" -H 'content-type: application/json' -d "$2"; }

user_id=$(curl -sS -X POST "$api/auth/v1/admin/users" -H "apikey: $secret" -H "Authorization: Bearer $secret" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg e "$email" --arg p "$password" '{email: $e, password: $p, email_confirm: true}')" | jq -er '.id')
cleanup() { curl -sS -o /dev/null -X DELETE "$api/auth/v1/admin/users/$user_id" -H "apikey: $secret" -H "Authorization: Bearer $secret"; }
trap cleanup EXIT

# 1. Sign-in: Auth's insert sets not_after to the idle limit, about 2 hours ahead.
signin=$(token password "$(jq -n --arg e "$email" --arg p "$password" '{email: $e, password: $p}')")
refresh=$(jq -er '.refresh_token' <<<"$signin")
minutes=$(sql "select round(extract(epoch from not_after - now()) / 60) from auth.sessions where user_id = '$user_id'")
check "sign-in sets not_after about 120 minutes ahead" "$(near120 "$minutes")" "got ${minutes:-none}"

# 2. Refresh: Auth's update of refreshed_at fires the refresh trigger, which recomputes not_after.
sql "update auth.sessions set not_after = now() + interval '90 minutes' where user_id = '$user_id'" >/dev/null
second=$(token refresh_token "$(jq -n --arg t "$refresh" '{refresh_token: $t}')")
refresh=$(jq -er '.refresh_token' <<<"$second")
minutes=$(sql "select round(extract(epoch from not_after - now()) / 60) from auth.sessions where user_id = '$user_id'")
check "a refresh moves not_after back to about 120 minutes ahead" "$(near120 "$minutes")" "got ${minutes:-none}"

# 3. Past not_after, Auth refuses the refresh.
sql "update auth.sessions set not_after = now() - interval '1 second' where user_id = '$user_id'" >/dev/null
third=$(token refresh_token "$(jq -n --arg t "$refresh" '{refresh_token: $t}')")
code=$(jq -r '.error_code // "none"' <<<"$third")
check "Auth refuses to refresh a session past not_after" "$([ "$code" = session_expired ] && echo true)" "error_code $code"

exit "$fail"

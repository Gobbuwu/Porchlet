#!/usr/bin/env bash
# Writes .env.local for the app from the running local Supabase stack (`npx supabase start`).
# Only the two public values the app needs; the stack's secret key is never written.
set -euo pipefail
status=$(npx supabase status -o json)
url=$(jq -er '.API_URL' <<<"$status")
key=$(jq -er '.PUBLISHABLE_KEY' <<<"$status")
case "$key" in sb_publishable_*) ;; *) echo "unexpected publishable key format" >&2; exit 1 ;; esac
printf 'NEXT_PUBLIC_SUPABASE_URL=%s\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=%s\n' "$url" "$key" > .env.local
echo "wrote .env.local for $url"

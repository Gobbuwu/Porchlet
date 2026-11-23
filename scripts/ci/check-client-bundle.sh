#!/usr/bin/env bash
# Fails if the browser bundle contains a Supabase secret key prefix (ADR 0005), or if there is
# no browser bundle to check (a build-layout change must not turn this into a silent pass).
# Usage: scripts/ci/check-client-bundle.sh [dir]   (default .next/static)
set -euo pipefail

dir=${1:-.next/static}
count=$(find "$dir" -type f -name '*.js' 2>/dev/null | wc -l)
if [ "$count" -eq 0 ]; then
  echo "FAIL: no .js files under $dir; run the build first"
  exit 1
fi
if grep -rIl --include='*.js' -e 'sb_secret_' "$dir"; then
  echo "FAIL: the files above contain 'sb_secret_'; a secret key must never reach the browser"
  exit 1
fi
echo "ok: $count browser .js files under $dir, none contain 'sb_secret_'"

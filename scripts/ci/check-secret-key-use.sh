#!/usr/bin/env bash
# ADR 0005: the app's code uses the Supabase secret key in one module only, which sends invite
# emails (ADR 0024), and that module is used only by the invite action. Fails when:
#   1. the key (by its variable name, its sb_secret_ prefix or the legacy service_role name) or
#      Supabase's admin API appears in src/ outside src/lib/supabase/admin.ts,
#   2. that module is imported anywhere but src/app/w/actions.ts,
#   3. that module doesn't start with `import "server-only"` (a build error if a browser bundle
#      ever imports it).
# Scripts and tests outside src/ use the local stack's key on purpose (scripts/e2e, scripts/ci);
# the built bundle is checked separately (check-client-bundle.sh).
# Usage: scripts/ci/check-secret-key-use.sh [dir]   (default src)
set -euo pipefail

dir=${1:-src}
module="$dir/lib/supabase/admin.ts"
allowed_importer="$dir/app/w/actions.ts"
fail=0

[ -f "$module" ] || { echo "FAIL: $module is missing"; exit 1; }
files=$(find "$dir" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.mjs' \) | sort)
[ -n "$files" ] || { echo "FAIL: no source files under $dir"; exit 1; }

while IFS= read -r f; do
  [ "$f" = "$module" ] && continue
  if grep -nE 'SUPABASE_SECRET_KEY|sb_secret_|service_role|SERVICE_ROLE|\.auth\.admin\b' "$f"; then
    echo "FAIL: $f uses the secret key or the admin API (only $module may)"
    fail=1
  fi
  if grep -qE "from ['\"](@/lib/supabase/admin|[./]+(lib/)?supabase/admin|\./admin)['\"]|import\(['\"][^'\"]*supabase/admin['\"]\)" "$f" \
     && [ "$f" != "$allowed_importer" ]; then
    echo "FAIL: $f imports $module (only $allowed_importer may)"; grep -nE "supabase/admin" "$f"
    fail=1
  fi
done <<<"$files"

if [ "$(grep -m1 -vE '^\s*(//.*)?$' "$module")" != 'import "server-only";' ]; then
  echo "FAIL: $module must start with: import \"server-only\";"
  fail=1
fi

[ "$fail" -eq 0 ] && echo "ok: $(wc -l <<<"$files") files under $dir; the secret key is used only in $module, imported only by $allowed_importer"
exit "$fail"

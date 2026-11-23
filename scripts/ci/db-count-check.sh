#!/usr/bin/env bash
# Cross-checks a pgTAP run, because a runner can skip a file or stop early and a query can match
# nothing, and the run can still look fine. Fails unless:
#   1. the run reports PASS,
#   2. files run = *.test.sql files on disk, and tests run = the sum of their plan(N),
#   3. every table in public and private is named on a "-- Covers: schema.table" line in a test.
# Usage: scripts/ci/db-count-check.sh <pg_prove output file>
set -euo pipefail

log=${1:?usage: db-count-check.sh <pg_prove output file>}
db_url=${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}
tests_dir=supabase/tests/database
fail=0
err() { echo "FAIL: $*"; fail=1; }

mapfile -t files < <(find "$tests_dir" -name '*.test.sql' | sort)
files_found=${#files[@]}
[ "$files_found" -gt 0 ] || err "no *.test.sql files in $tests_dir"

plans_found=0
tests_found=0
for f in "${files[@]}"; do
  mapfile -t plans < <(grep -oE 'select plan\([0-9]+\)' "$f" | grep -oE '[0-9]+')
  [ "${#plans[@]}" -eq 1 ] || err "$f has ${#plans[@]} plan(N) calls, expected exactly 1"
  for n in "${plans[@]}"; do tests_found=$((tests_found + n)); plans_found=$((plans_found + 1)); done
done

grep -qx 'Result: PASS' "$log" || err "pg_prove did not report 'Result: PASS'"
summary=$(grep -E '^Files=[0-9]+, Tests=[0-9]+' "$log" | tail -1 || true)
files_run=$(sed -E 's/^Files=([0-9]+),.*/\1/' <<<"$summary")
tests_run=$(sed -E 's/^Files=[0-9]+, Tests=([0-9]+).*/\1/' <<<"$summary")
[ -n "$summary" ] || err "no 'Files=N, Tests=N' summary line in $log"
[ "${files_run:-x}" = "$files_found" ] || err "pg_prove ran ${files_run:-?} files, $files_found on disk"
[ "${tests_run:-x}" = "$tests_found" ] || err "pg_prove ran ${tests_run:-?} tests, plan(N) total is $tests_found"

mapfile -t tables < <(psql "$db_url" -X -tA -v ON_ERROR_STOP=1 -c \
  "select schemaname || '.' || tablename from pg_tables
    where schemaname in ('public', 'private') order by 1")
[ "${#tables[@]}" -gt 0 ] || err "no tables in public or private (expected at least private.instance)"
uncovered=()
for t in "${tables[@]}"; do
  grep -qxE -- "-- Covers: .*\\b${t//./\\.}\\b.*" "${files[@]}" || uncovered+=("$t")
done
[ "${#uncovered[@]}" -eq 0 ] || err "tables with no '-- Covers:' line in any test: ${uncovered[*]}"

report="| Count | Found | Run or covered |
|---|---|---|
| pgTAP files | $files_found | ${files_run:-?} |
| pgTAP tests (sum of plan) | $tests_found | ${tests_run:-?} |
| Tables in public + private | ${#tables[@]} | $(( ${#tables[@]} - ${#uncovered[@]} )) |"
echo "$report"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### Database count cross-check"; echo; echo "$report"; } >>"$GITHUB_STEP_SUMMARY"
fi
exit "$fail"

#!/usr/bin/env bash
# SiegeKit R2 (M2): the two checks that need a person to type in a terminal.
# Run it YOURSELF in a terminal (Linux or WSL), from a Porchlet checkout: scripts/siegekit/r2-run.sh
# It prepares a LOCAL stack (never porchlet-test), records account A's HAR with a browser, then runs
# SiegeKit's access-control and access-control-write. SiegeKit then asks you to type
# "test accounts" and, after listing the writes, "change test data". Nobody else types them.
# Output: $OUT (default ~/r2-out, on the Linux file system so the chmod below holds): reports, the run
# log, a findings summary. $OUT/private holds live session cookies, A's HAR and a backup of your
# .env.local: never share it; share only $OUT/report and $OUT/summary.txt.
# It replaces .env.local (restored at the end) and makes a throwaway account the local stack's
# instance admin (run scripts/dev/make-admin.sql again for your own account).
set -euo pipefail
SK_REV=${SK_REV:-703389e5e2ed1830aa4be6620440f7a12b163a7b}   # SiegeKit main on 2026-11-26
SK_DIR=${SK_DIR:-$HOME/r2/siegekit}
OUT=${OUT:-$HOME/r2-out}
[ -f "$HOME/env.sh" ] && . "$HOME/env.sh"
cd "$(git rev-parse --show-toplevel)"
[ -f supabase/config.toml ] && grep -q '"porchlet"' package.json || { echo "run this from a Porchlet checkout" >&2; exit 1; }
mkdir -p "$OUT/private"; chmod 700 "$OUT/private"
exec > >(tee -a "$OUT/run.log") 2>&1
echo "== SiegeKit R2 run $(date -u +%FT%TZ) on $(uname -srm); Porchlet $(git rev-parse --short HEAD)"

echo "== 1/7 tools"
need=""; for t in docker jq psql git go node npx curl openssl; do command -v $t >/dev/null || need="$need $t"; done
[ -z "$need" ] || { echo "missing:$need  (psql: sudo apt-get install -y postgresql-client; jq: sudo apt-get install -y jq)" >&2; exit 1; }
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' || { echo "Node 22+ needed" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running (Docker Desktop or: sudo service docker start)" >&2; exit 1; }
echo "node $(node -v), $(go version), $(docker --version), cgroup $(stat -fc %T /sys/fs/cgroup)"

echo "== 2/7 SiegeKit $SK_REV"
[ -d "$SK_DIR/.git" ] || git clone -q https://github.com/Gobbuwu/SiegeKit.git "$SK_DIR"
git -C "$SK_DIR" fetch -q origin main && git -C "$SK_DIR" -c advice.detachedHead=false checkout -q "$SK_REV"
# SiegeKit's CI toolchain (GO_VERSION in its ci.yml); Go downloads it if needed.
(cd "$SK_DIR" && GOTOOLCHAIN=${SK_GO:-go1.27.4} CGO_ENABLED=0 go build -o "$OUT/siegekit" ./cmd/siegekit && GOTOOLCHAIN=${SK_GO:-go1.27.4} go version)

echo "== 3/7 Porchlet deps, local Supabase stack, .env.local, admin"
npm ci --no-audit --no-fund >/dev/null
npx supabase start -x realtime,storage-api,imgproxy,postgres-meta,studio,edge-runtime,logflare,vector,supavisor >/dev/null
npx supabase status -o json | jq -er '.API_URL' | grep -Eq '^http://(127\.0\.0\.1|localhost):' || { echo "not a local stack" >&2; exit 1; }
BACKUP="$OUT/private/env.local.before-r2"
rm -f "$BACKUP"; [ -f .env.local ] && cp -p .env.local "$BACKUP"   # write-env.sh replaces it
restore_env() { if [ -f "$BACKUP" ]; then cp -p "$BACKUP" .env.local && rm -f "$BACKUP" && echo "restored your .env.local"; fi; }
trap restore_env EXIT
scripts/e2e/write-env.sh
scripts/e2e/make-admin.sh

echo "== 4/7 build and start the app on 127.0.0.1:3000"
if curl -s -o /dev/null http://127.0.0.1:3000/; then echo "something already listens on port 3000: stop it first" >&2; exit 1; fi
npm run build >/dev/null
setsid npx next start -H 127.0.0.1 -p 3000 > "$OUT/next.log" 2>&1 &
APP=$!; trap 'kill -- -$APP 2>/dev/null || true; restore_env' EXIT
for i in $(seq 60); do curl -sf -o /dev/null http://127.0.0.1:3000/api/health && break; sleep 1; done
curl -sf -o /dev/null http://127.0.0.1:3000/api/health || { echo "the app did not become healthy in 60 s; see $OUT/next.log" >&2; exit 1; }

echo "== 5/7 record account A's HAR and the sessions of B and C"
[ -n "${PW_CHROMIUM_PATH:-}" ] || npx playwright install --with-deps chromium
R2_OUT="$OUT/private" npx playwright test -c scripts/siegekit/playwright.config.ts
cp "$OUT/private/accounts.json" "$OUT/accounts.json"

echo "== 6/7 SiegeKit access-control and access-control-write (you type the answers)"
export SIEGEKIT_SESSION_B SIEGEKIT_SESSION_C
SIEGEKIT_SESSION_B=$(cat "$OUT/private/session-b.txt"); SIEGEKIT_SESSION_C=$(cat "$OUT/private/session-c.txt")
set +e
"$OUT/siegekit" scan --no-save --fail-on info --only access-control,access-control-write \
  --har "$OUT/private/a.har" --har-user "$(jq -r .a "$OUT/accounts.json")" --replay-writes \
  --report-dir "$OUT/report" http://127.0.0.1:3000/
echo "siegekit exit $?"; set -e

echo "== 7/7 summary (paste this back; share only $OUT/report and $OUT/summary.txt, never $OUT/private)"
[ -f "$OUT/report/report.json" ] || { echo "no report was written; see $OUT/run.log" >&2; exit 1; }
jq -r '.plugins[] | "\(.id): \(.status), \(.findings) finding(s) \(.reason // "")"' "$OUT/report/report.json" | tee "$OUT/summary.txt"
jq -r '.findings[] | "\(.severity)\t\(.ruleId)\t\(.title)"' "$OUT/report/report.json" | sort | uniq -c | tee -a "$OUT/summary.txt"
echo "Done. Reports: $OUT/report. Stop the stack later with: npx supabase stop"
echo "The local stack's instance admin is now a throwaway account: run scripts/dev/make-admin.sql for your own."

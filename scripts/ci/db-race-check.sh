#!/usr/bin/env bash
# Checks what pgTAP can't, because it needs two database sessions at once (M2 threat model T4, T7):
#   1. two parallel accept_invitation calls with one token: exactly one joins, the other gets
#      invitation_used;
#   2. two parallel create_invitation calls by the two owners of one workspace when it has 19
#      pending: exactly one succeeds, the other gets workspace_invitation_limit (different owners,
#      so only the workspace row lock keeps them in order);
#   3. two parallel create_invitation calls by one owner in two workspaces, with 19 invitations
#      made in the last hour: exactly one succeeds, the other gets hourly_invitation_limit;
#   4. create_invitation refuses repeatable read (its counts would come from an old snapshot).
# Session 1 holds its transaction open for 2 seconds after its call. Session 2 starts only once
# session 1 is in that sleep (seen in pg_stat_activity), so session 1 already holds its locks, and
# each check also requires that session 2 was seen waiting on a lock: a slow runner can't turn the
# race into two calls in a row that pass without the locks. Run after `npx supabase db start`. It writes throwaway
# rows with fixed ids and deletes them on exit.
set -euo pipefail

db=${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}
work=$(mktemp -d)
fail=0
check() { if [ "$2" = "true" ]; then echo "ok   $1"; else echo "FAIL $1 ($3)"; fail=1; fi; }
sql() { psql "$db" -X -tA -v ON_ERROR_STOP=1 -c "$1"; }
count() { cat "${@:2}" | grep -cE -- "$1" || true; } # matching lines across files; 0 is not an error

owner=00000000-0000-4000-a000-0000000000aa
owner2=00000000-0000-4000-a000-0000000000ab
invitee=00000000-0000-4000-a000-0000000000cc
ws=00000000-0000-4000-c000-0000000000aa
ws2=00000000-0000-4000-c000-0000000000ab
as_user() { # $1 user id, $2 SQL, $3 seconds to hold the transaction, $4 application_name
  PGAPPNAME=${4:-porchlet-race} psql "$db" -X -q -tA -v ON_ERROR_STOP=1 2>&1 <<SQL || true
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"$1","role":"authenticated"}', true);
$2
select pg_sleep(${3:-0});
commit;
SQL
}

# Polls pg_stat_activity (up to 10 s) until a session with application_name $1 matches $2.
wait_for() {
  local i
  for i in $(seq 1 100); do
    [ "$(sql "select count(*) from pg_stat_activity where application_name = '$1' and $2")" -gt 0 ] && return 0
    sleep 0.1
  done
  return 1
}
# Starts session 1 (holds 2 s) and session 2, in the background, writing to $5 and $6. Prints
# "waited" when session 2 was seen waiting on a lock while session 1 held its transaction.
race() { # $1 user, $2 SQL for session 1, $3 user, $4 SQL for session 2, $5 $6 output files
  as_user "$1" "$2" 2 porchlet-race-s1 >"$5" &
  # race runs inside $(...), so a failure goes to stderr (stdout is captured) and stops session 1;
  # the non-zero status then ends the script through set -e.
  wait_for porchlet-race-s1 "state = 'active' and query like '%pg_sleep(2)%'" \
    || { echo "FAIL session 1 never reached its sleep" >&2; kill %1 2>/dev/null; wait; exit 1; }
  as_user "$3" "$4" 0 porchlet-race-s2 >"$6" &
  if wait_for porchlet-race-s2 "wait_event_type = 'Lock'"; then echo waited; else echo "did-not-wait"; fi
  wait
}

delete_rows() {
  sql "delete from public.workspaces where id in ('$ws', '$ws2');
       delete from private.invitation_sends where user_id in ('$owner', '$owner2');
       delete from auth.users where id in ('$owner', '$owner2', '$invitee');" >/dev/null
}
trap 'delete_rows || true; rm -rf "$work"' EXIT
delete_rows

sql "insert into auth.users (id, email, email_confirmed_at) values
       ('$owner', 'race-owner@example.test', now()), ('$owner2', 'race-owner2@example.test', now()),
       ('$invitee', 'race-invitee@example.test', now());
     insert into public.workspaces (id, name, created_by) values ('$ws', 'race', '$owner'), ('$ws2', 'race 2', '$owner');
     insert into public.workspace_members (workspace_id, user_id, role)
       values ('$ws', '$owner', 'owner'), ('$ws', '$owner2', 'owner'), ('$ws2', '$owner', 'owner');" >/dev/null

# 1. Two accepts of one token at once.
token=$(as_user "$owner" "select token from public.create_invitation('$ws', 'race-invitee@example.test');" | sed -n 2p)
[[ $token =~ ^[0-9a-f]{64}$ ]] || { echo "FAIL could not create the invitation: $token"; exit 1; }
waited=$(race "$invitee" "select public.accept_invitation('$token');" \
  "$invitee" "select public.accept_invitation('$token');" "$work/a1" "$work/a2")
joined=$(count "^$ws\$" "$work/a1" "$work/a2")
used=$(count 'invitation_used' "$work/a1" "$work/a2")
members=$(sql "select count(*) from public.workspace_members where workspace_id = '$ws' and user_id = '$invitee'")
check "parallel accepts: the second waits, one joins, the other gets invitation_used" \
  "$([ "$waited" = waited ] && [ "$joined" = 1 ] && [ "$used" = 1 ] && [ "$members" = 1 ] && echo true)" \
  "$waited joined=$joined used=$used memberships=$members; session 1: $(tr '\n' ' ' <"$work/a1"); session 2: $(tr '\n' ' ' <"$work/a2")"

# 2. Two creates at once, by the workspace's two owners, when it has 19 pending invitations. Rows
# are inserted directly, so the hourly counts stay low and only the workspace cap can refuse. (The
# app makes one owner per workspace; two are set up here so the per-owner lock can't help.)
sql "insert into public.invitations (workspace_id, email, token_hash, invited_by)
       select '$ws', 'pending' || g || '@example.test', extensions.digest('race' || g, 'sha256'), '$owner'
         from generate_series(1, 18) g;" >/dev/null
pending=$(sql "select count(*) from public.invitations where workspace_id = '$ws' and accepted_at is null")
[ "$pending" = 18 ] || { echo "FAIL expected 18 pending before the race, found $pending"; exit 1; }
as_user "$owner" "select 1 from public.create_invitation('$ws', 'nineteen@example.test');" >/dev/null
waited=$(race "$owner" "select 'created' from public.create_invitation('$ws', 'first@example.test');" \
  "$owner2" "select 'created' from public.create_invitation('$ws', 'second@example.test');" "$work/c1" "$work/c2")
created=$(count '^created$' "$work/c1" "$work/c2")
capped=$(count 'workspace_invitation_limit' "$work/c1" "$work/c2")
pending=$(sql "select count(*) from public.invitations where workspace_id = '$ws' and accepted_at is null")
check "parallel creates at 19 pending: the second waits, one succeeds, the other gets workspace_invitation_limit" \
  "$([ "$waited" = waited ] && [ "$created" = 1 ] && [ "$capped" = 1 ] && [ "$pending" = 20 ] && echo true)" \
  "$waited created=$created capped=$capped pending=$pending; session 1: $(tr '\n' ' ' <"$work/c1"); session 2: $(tr '\n' ' ' <"$work/c2")"

# 3. Two creates at once in two workspaces when the owner has made 19 invitations this hour. The
# workspace row locks differ, so only the per-owner lock keeps the hourly count in order.
sql "delete from public.invitations where workspace_id in ('$ws', '$ws2');
     delete from private.invitation_sends where user_id = '$owner';
     insert into private.invitation_sends (user_id) select '$owner' from generate_series(1, 19);" >/dev/null
waited=$(race "$owner" "select 'created' from public.create_invitation('$ws', 'hourly1@example.test');" \
  "$owner" "select 'created' from public.create_invitation('$ws2', 'hourly2@example.test');" "$work/h1" "$work/h2")
created=$(count '^created$' "$work/h1" "$work/h2")
capped=$(count 'hourly_invitation_limit' "$work/h1" "$work/h2")
sends=$(sql "select count(*) from private.invitation_sends where user_id = '$owner'")
check "parallel creates in two workspaces at 19 this hour: the second waits, one succeeds, the other gets hourly_invitation_limit" \
  "$([ "$waited" = waited ] && [ "$created" = 1 ] && [ "$capped" = 1 ] && [ "$sends" = 20 ] && echo true)" \
  "$waited created=$created capped=$capped sends=$sends; session 1: $(tr '\n' ' ' <"$work/h1"); session 2: $(tr '\n' ' ' <"$work/h2")"

# 4. Repeatable read is refused.
rr=$(psql "$db" -X -tA 2>&1 <<SQL || true
begin isolation level repeatable read;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"$owner","role":"authenticated"}', true);
select * from public.create_invitation('$ws', 'rr@example.test');
rollback;
SQL
)
check "create_invitation refuses repeatable read" \
  "$(grep -q 'create_invitation needs read committed, not repeatable read' <<<"$rr" && echo true)" "$rr"

exit "$fail"

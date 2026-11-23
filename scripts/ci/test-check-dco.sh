#!/usr/bin/env bash
# Self-test for check-dco.sh: it must pass a signed-off commit and fail an unsigned one, a
# sign-off that doesn't match the author, and a wrong expected count. Runs in a temporary repo.
set -euo pipefail

script=$(cd "$(dirname "$0")" && pwd)/check-dco.sh
repo=$(mktemp -d)
trap 'rm -rf "$repo"' EXIT
cd "$repo"
git init -q
git config user.name "Test Author"
git config user.email "test@example.invalid"
git commit -q --allow-empty -m base
base=$(git rev-parse HEAD)
fail=0

expect() { # expect <pass|fail> <description> <args...>
  local want=$1 what=$2; shift 2
  if "$script" "$@" >/dev/null 2>&1; then got=pass; else got=fail; fi
  if [ "$got" = "$want" ]; then echo "ok   $what"; else echo "FAIL $what: expected $want, got $got"; fail=1; fi
}

git commit -q --allow-empty -m "signed" --trailer "Signed-off-by: Test Author <test@example.invalid>"
signed=$(git rev-parse HEAD)
expect pass "signed-off commit passes" "$base" "$signed" 1
expect fail "wrong expected count fails" "$base" "$signed" 2
expect fail "empty range fails" "$signed" "$signed"

git commit -q --allow-empty -m "unsigned"
expect fail "unsigned commit fails" "$base" HEAD

git reset -q --hard "$signed"
git commit -q --allow-empty -m "other" --trailer "Signed-off-by: Someone Else <else@example.invalid>"
expect fail "sign-off by someone other than the author fails" "$base" HEAD

git reset -q --hard "$signed"
git -c user.name=bot -c user.email=bot@example.invalid commit -q --allow-empty -m "bot"
expect fail "bot commit fails without the exemption" "$base" HEAD
DCO_EXEMPT_EMAIL=bot@example.invalid expect pass "bot commit passes with the exemption" "$base" HEAD
DCO_EXEMPT_EMAIL=other@example.invalid expect fail "exemption for another email does not apply" "$base" HEAD

exit "$fail"

#!/usr/bin/env bash
# DCO check: every non-merge commit in BASE..HEAD must carry a "Signed-off-by:" trailer that
# matches its author exactly ("Name <email>"). Merge commits are skipped (they add no authored
# change unless they resolve a conflict; see CONTRIBUTING once it exists).
# Usage: scripts/ci/check-dco.sh <base sha> <head sha> [expected commit count]
# DCO_EXEMPT_EMAIL (optional): commits whose author email is exactly this are skipped. CI sets it
# only on PRs that GitHub says Dependabot opened, because Dependabot can't sign off as its author.
# The optional count is the PR's commit count from GitHub, cross-checked against git so a
# shallow or wrong checkout cannot pass by checking nothing.
set -euo pipefail

base=${1:?usage: check-dco.sh <base> <head> [expected count]}
head=${2:?usage: check-dco.sh <base> <head> [expected count]}
expected=${3:-}
fail=0

total=$(git rev-list --count "$base..$head")
if [ -n "$expected" ] && [ "$total" != "$expected" ]; then
  echo "FAIL: git sees $total commits in $base..$head, GitHub reports $expected"
  fail=1
fi

checked=0
while read -r sha; do
  [ -n "$sha" ] || continue
  checked=$((checked + 1))
  author=$(git show -s --format='%an <%ae>' "$sha")
  if [ -n "${DCO_EXEMPT_EMAIL:-}" ] && [ "$(git show -s --format='%ae' "$sha")" = "$DCO_EXEMPT_EMAIL" ]; then
    echo "skip ${sha:0:12} $author (exempt bot author)"
    continue
  fi
  if git show -s --format='%(trailers:key=Signed-off-by,valueonly)' "$sha" | grep -Fxq -- "$author"; then
    echo "ok   ${sha:0:12} $author"
  else
    echo "FAIL ${sha:0:12} has no 'Signed-off-by: $author' trailer"
    fail=1
  fi
done < <(git rev-list --no-merges "$base..$head")

if [ "$total" -eq 0 ]; then
  echo "FAIL: no commits in $base..$head"
  fail=1
fi
echo "$checked non-merge commits checked, $((total - checked)) merge commits skipped"
exit "$fail"

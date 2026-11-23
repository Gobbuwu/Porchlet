#!/usr/bin/env bash
# Runs a command in Playwright's official image (PLAYWRIGHT_IMAGE, pinned by digest in ci.yml),
# which already holds the browsers and their system libraries. This replaces
# `playwright install --with-deps`, whose apt step made E2E take up to 15 minutes (ADR 0012).
# --network host: the app and, from M1, local Supabase listen on the runner's 127.0.0.1.
# --ipc host: Playwright's Docker docs recommend it so Chromium doesn't run out of shared memory.
# --user: files written to the checkout (.next, test-results) stay owned by the runner user.
# Usage: PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:vX.Y.Z-noble@sha256:... \
#          scripts/ci/in-playwright-image.sh <command...>
set -euo pipefail

image=${PLAYWRIGHT_IMAGE:?set PLAYWRIGHT_IMAGE to the digest-pinned Playwright image}

# The image's browsers only work with the same Playwright version. A bump of @playwright/test
# without a new image (or the reverse) fails here, with a clear message.
installed=$(node -p 'require("./node_modules/playwright/package.json").version')
tag=${image##*/playwright:}
tag=${tag%%@*}
tag=${tag#v}
tag=${tag%%-*}
if [ "$installed" != "$tag" ]; then
  echo "::error::Playwright $installed is installed but PLAYWRIGHT_IMAGE is for $tag. Update both together (ADR 0012)."
  exit 1
fi

exec docker run --rm --network host --ipc host \
  --user "$(id -u):$(id -g)" -e HOME=/tmp -e CI -e NEXT_TELEMETRY_DISABLED \
  -v "$PWD:/work" -w /work "$image" "$@"

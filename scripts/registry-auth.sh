#!/usr/bin/env bash
set -euo pipefail
: "${NODE_AUTH_TOKEN:?Registry access needs a token}"
auth_file="${RUNNER_TEMP:?Run this in GitHub Actions}/openbot-npmrc"
cat > "$auth_file" <<'NPMRC'
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
NPMRC
printf 'NPM_CONFIG_USERCONFIG=%s\n' "$auth_file" >> "${GITHUB_ENV:?Run this in GitHub Actions}"

#!/usr/bin/env bash
# Starts the production Compose setup with the test settings in check.env, checks it, and removes it again.
# OPENBOT_RELEASE picks the image tag. The default is "local".
set -euo pipefail
cd "$(dirname "$0")"

release="${OPENBOT_RELEASE:-local}"
# Compose prefers shell variables over check.env, and devenv sets development values for some of them.
# shellcheck disable=SC2046
unset $(compgen -e | grep -E '^(OPENBOT|PROTOCOL_TEST|POSTGRES|BETTER_AUTH)_' || true)
export OPENBOT_RELEASE="$release"

compose() {
  docker compose --env-file check.env -f compose.production.yaml -f compose.check.yaml "$@"
}
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    compose logs || true
  fi
  compose down --volumes || true
}
trap cleanup EXIT

compose config --quiet
compose run --rm --quiet-pull check

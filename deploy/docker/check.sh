#!/usr/bin/env bash
# Starts the production Compose setup with the test settings in check.env, checks it, and removes it again.
# OPENBOT_RELEASE picks the image tag. The default is "local".
set -euo pipefail
cd "$(dirname "$0")"

release="${OPENBOT_RELEASE:-local}"
project="openbot-check-$$"
report="$(mktemp)"
# Compose prefers shell variables over check.env, and devenv sets development values for some of them.
# shellcheck disable=SC2046
unset $(compgen -e | grep -E '^(OPENBOT|PROTOCOL_TEST|POSTGRES|BETTER_AUTH)_' || true)
export OPENBOT_RELEASE="$release"

compose() {
  docker compose --project-name "$project" --env-file check.env -f compose.production.yaml -f compose.check.yaml "$@"
}
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    compose logs || true
  fi
  compose down --volumes || true
  rm -f "$report"
}
trap cleanup EXIT

compose config --quiet
# Both an empty database and a repeated maintenance run must work.
compose up --detach --wait postgres
compose run --rm --no-deps --quiet-pull migrate
compose run --rm --no-deps --quiet-pull migrate
compose run --rm --quiet-pull check

# The operator can inspect policy without exposing stored secret values.
compose exec -T openbot /usr/local/bin/node /app/dist/app/Inspect.mjs > "$report"
node --input-type=module -e '
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const snapshot = JSON.parse(readFileSync(process.argv[1], "utf8"));
assert.equal(snapshot.settings.registration.selfService, "closed");
assert.equal(snapshot.settings.organizationCreation, "platform_admins");
assert.equal(snapshot.admins[0].providerId, "oidc");
assert.equal("authSecret" in snapshot.settings, false);
' "$report"

# Check each direction from the real server containers, with the mounted secret.
compose exec -T openbot /usr/local/bin/node /check/check.mjs http://openbot-peer:3000
compose exec -T openbot-peer /usr/local/bin/node /check/check.mjs http://openbot:3000

runners="$(compose exec -T postgres psql -U openbot -d openbot -Atqc \
  "select count(*) from openbot_cluster_runners where address in ('openbot:3000', 'openbot-peer:3000') and healthy")"
if [ "$runners" != "2" ]; then
  echo "Both private runner addresses must be registered." >&2
  exit 1
fi

# A live node holds the shared maintenance lock. The migrator must not change its data.
if compose run --rm --no-deps --quiet-pull migrate > "$report" 2>&1; then
  echo "The data move ran while OpenBot was still active." >&2
  exit 1
fi
if ! grep -q "Stop all OpenBot servers before the data move" "$report"; then
  cat "$report" >&2
  echo "The data move failed for a reason other than the maintenance lock." >&2
  exit 1
fi

echo "Both nodes, private RPC, and the maintenance lock passed."

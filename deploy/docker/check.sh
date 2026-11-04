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

# check.plugins.yml turns triggers off on both nodes. Their routes answer that the feature is off.
for service in openbot openbot-peer; do
  compose exec -T "$service" /usr/local/bin/node --input-type=module -e '
import assert from "node:assert/strict";
const off = await fetch("http://127.0.0.1:3000/v1/triggers", { signal: AbortSignal.timeout(5000) });
assert.equal(off.status, 503, "The triggers routes are not off");
assert.equal(off.headers.get("openbot-unavailable-feature"), "triggers");
assert.equal((await off.json())._tag, "FeatureUnavailable");
const schema = await fetch("http://127.0.0.1:3000/openapi.json", { signal: AbortSignal.timeout(5000) });
assert.ok((await schema.json()).paths["/v1/triggers"], "The OpenAPI document lost the triggers routes");
'
  # The mount is read only, so even a process with the right file mode can not write it.
  compose exec -T "$service" /usr/local/bin/node -e '
const assert = require("node:assert/strict");
assert.throws(() => require("node:fs").writeFileSync("/etc/openbot/plugins.yml", "x"), { code: "EROFS" });
'
done

# The operator sees the merged plugins and their hash without a server.
compose exec -T openbot /usr/local/bin/node /app/dist/app/Inspect.mjs plugins > "$report"
hash="$(node --input-type=module -e '
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const plugins = JSON.parse(readFileSync(process.argv[1], "utf8"));
assert.equal(plugins.file, "/etc/openbot/plugins.yml");
const triggers = plugins.entries.find((entry) => entry.id === "triggers");
assert.equal(triggers.disabled, true);
assert.deepEqual(triggers.changed, ["disabled"]);
assert.match(plugins.manifestHash, /^sha256:[0-9a-f]{64}$/);
process.stdout.write(plugins.manifestHash);
' "$report")"

# Each node writes its plugins in the runner manifest. Both nodes have the same file, so they have the same hash.
manifests="$(compose exec -T postgres psql -U openbot -d openbot -Atqc \
  "select count(*), count(distinct manifest_hash), min(manifest_hash) from openbot_execution_runners where runner_address in ('openbot:3000', 'openbot-peer:3000')")"
if [ "$manifests" != "2|1|$hash" ]; then
  echo "Both nodes must write the manifest hash of the plugins file. Found: $manifests, expected: 2|1|$hash" >&2
  exit 1
fi
if compose logs openbot openbot-peer | grep -q "are not the same as on other runners"; then
  echo "The nodes have the same plugins, but a node gave the warning for different plugins." >&2
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

echo "Both nodes, private RPC, the plugins file, and the maintenance lock passed."

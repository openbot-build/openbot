#!/usr/bin/env bash
set -euo pipefail

docker run --privileged --rm tonistiigi/binfmt --install amd64
docker build --platform linux/amd64 --file docker/Dockerfile \
  --target production --tag "openbot-platform:$CI_COMMIT_SHA" .
docker build --platform linux/amd64 --file docker/protocol-test.Dockerfile \
  --tag "openbot-protocol-test:$CI_COMMIT_SHA" .
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    docker logs platform-protocol-test || true
    docker logs platform-server || true
    docker logs platform-postgres || true
  fi
  docker rm -f platform-protocol-test platform-server platform-postgres >/dev/null 2>&1 || true
  docker network rm platform-check >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create platform-check
docker run --detach --name platform-postgres --network platform-check \
  -e POSTGRES_USER=platform -e POSTGRES_PASSWORD=platform \
  -e POSTGRES_DB=platform postgres:18-alpine
attempts=0
until docker exec platform-postgres pg_isready -U platform -d platform; do
  attempts=$((attempts + 1))
  test "$attempts" -lt 60
  sleep 1
done
docker run --rm --platform linux/amd64 --network platform-check \
  -e OPENBOT_DATABASE_URL=postgres://platform:platform@platform-postgres:5432/platform \
  "openbot-platform:$CI_COMMIT_SHA" /app/dist/app/Migrate.mjs
docker run --detach --platform linux/amd64 --name platform-server \
  --network platform-check --network-alias platform \
  -e OPENBOT_DATABASE_URL=postgres://platform:platform@platform-postgres:5432/platform \
  -e OPENBOT_PUBLIC_ORIGIN=https://platform.example.com \
  -e OPENBOT_OIDC_ISSUER=https://id.example.com \
  -e OPENBOT_OIDC_CLIENT_ID=ci-test -e OPENBOT_OIDC_CLIENT_SECRET=ci-test-secret \
  -e OPENBOT_APP_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
  -e BETTER_AUTH_SECRET=ci-test-independent-secret-at-least-32-characters \
  "openbot-platform:$CI_COMMIT_SHA"
attempts=0
until docker exec platform-server node --input-type=module -e '
  const response = await fetch("http://127.0.0.1:3000/health", { signal: AbortSignal.timeout(5000) })
  if (response.status !== 200 || (await response.json()).status !== "ok") process.exit(1)
'; do
  attempts=$((attempts + 1))
  test "$attempts" -lt 30
  sleep 1
done
docker exec platform-server node --input-type=module -e '
  const origin = "http://127.0.0.1:3000"
  const api = await fetch(origin + "/v1/sessions")
  if (api.status !== 401) throw new Error("The API does not require authentication")
  const keyed = await fetch(origin + "/v1/sessions", { headers: { authorization: "Bearer ob_invalid" } })
  if (keyed.status !== 401) throw new Error("The API does not reject invalid API keys")
  const schema = await fetch(origin + "/openapi.json")
  if (schema.status !== 200 || !(await schema.json()).openapi) throw new Error("The OpenAPI document is not available")
'
docker run --detach --platform linux/amd64 --name platform-protocol-test \
  --network platform-check -e PROTOCOL_TEST_PUBLIC_ORIGIN=https://protocol-test.example.com \
  "openbot-protocol-test:$CI_COMMIT_SHA"
attempts=0
until docker exec platform-protocol-test node --input-type=module -e '
  const response = await fetch("http://127.0.0.1:3001/healthz", { signal: AbortSignal.timeout(5000) })
  if (response.status !== 200 || (await response.json()).status !== "ok") process.exit(1)
'; do
  attempts=$((attempts + 1))
  test "$attempts" -lt 30
  sleep 1
done
docker exec platform-protocol-test node --input-type=module -e '
  const origin = "http://127.0.0.1:3001"
  const catalog = await fetch(origin + "/.well-known/ai-catalog.json", { signal: AbortSignal.timeout(5000) })
  const document = await catalog.json()
  if (catalog.status !== 200 || document.host.identifier !== "https://protocol-test.example.com" || !document.entries.some(entry => entry.url === "https://protocol-test.example.com/apps/anonymous/server-card.json")) throw new Error("The Protocol Test Catalog is not available")
  const response = await fetch(origin + "/mcp/anonymous", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "ci-host", version: "1.0.0" } } } }),
    signal: AbortSignal.timeout(5000)
  })
  const message = await response.json()
  if (response.status !== 200 || message.error || message.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name !== "openbot.protocol-test/anonymous") throw new Error("Protocol Test MCP discovery failed")
'
mkdir -p .devenv
docker save "openbot-platform:$CI_COMMIT_SHA" "openbot-protocol-test:$CI_COMMIT_SHA" | gzip > .devenv/images.tar.gz
if [ "$CI_PIPELINE_SOURCE" = push ] && [ "${CI_COMMIT_BRANCH:-}" = "$CI_DEFAULT_BRANCH" ]; then
  release_tag=latest
elif [ -n "${CI_COMMIT_TAG:-}" ]; then
  release_tag="$CI_COMMIT_TAG"
else
  exit 0
fi
printf '%s' "$CI_REGISTRY_PASSWORD" | docker login "$CI_REGISTRY" \
  --username "$CI_REGISTRY_USER" --password-stdin
for component in platform protocol-test; do
  image_name="$CI_REGISTRY_IMAGE/$component"
  docker tag "openbot-$component:$CI_COMMIT_SHA" "$image_name:$CI_COMMIT_SHA"
  docker push --platform linux/amd64 "$image_name:$CI_COMMIT_SHA"
  docker tag "openbot-$component:$CI_COMMIT_SHA" "$image_name:$release_tag"
  docker push --platform linux/amd64 "$image_name:$release_tag"
done

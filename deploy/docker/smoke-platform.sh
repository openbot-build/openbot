#!/usr/bin/env bash
set -euo pipefail
image=${1:?Supply the tested platform image}
prefix="openbot-smoke-${CI_JOB_ID:-local}-$$"
network="$prefix-network"
postgres="$prefix-postgres"
platform="$prefix-platform"
cleanup() {
  result=$?
  if [[ "$result" -ne 0 ]]; then
    docker logs "$platform" || true
    docker logs "$postgres" || true
  fi
  docker rm --force "$platform" "$postgres" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create "$network" >/dev/null
docker run --detach --name "$postgres" --network "$network"   -e POSTGRES_USER=openbot -e POSTGRES_PASSWORD=fixture-only -e POSTGRES_DB=openbot   postgres:18-alpine >/dev/null
for attempt in $(seq 1 60); do
  # The entrypoint's temporary setup server listens only on a Unix socket.
  if docker exec "$postgres" pg_isready -h 127.0.0.1 -U openbot -d openbot >/dev/null; then break; fi
  [[ "$attempt" -lt 60 ]] || exit 1
  sleep 1
done
database="postgres://openbot:fixture-only@$postgres:5432/openbot"
docker run --rm --platform linux/amd64 --network "$network"   -e OPENBOT_DATABASE_URL="$database" "$image" /app/dist/app/Migrate.mjs
keys=fixture:0000000000000000000000000000000000000000000000000000000000000000
common=(--detach --platform linux/amd64 --name "$platform" --network "$network"
  -e "OPENBOT_SECRET_KEYS=$keys")
docker run --rm --platform linux/amd64 --network "$network" \
  -e "OPENBOT_DATABASE_URL=$database" -e "OPENBOT_SECRET_KEYS=$keys" \
  "$image" /app/dist/app/Setup.mjs --public-origin https://localhost:8443 \
  --oidc-issuer https://identity.example.invalid --oidc-client-id ci-fixture \
  --admin-email fixture-admin@example.invalid

healthy() {
  for attempt in $(seq 1 60); do
    if docker exec "$platform" /usr/local/bin/node --input-type=module -e '
      if (process.getuid() === 0) throw new Error("Platform must run as nonroot")
      const response=await fetch("http://127.0.0.1:3000/health",{signal:AbortSignal.timeout(3000)})
      if(response.status!==200||(await response.json()).status!=="ok")process.exit(1)
    ' >/dev/null 2>&1; then return; fi
    [[ "$attempt" -lt 60 ]] || return 1
    sleep 1
  done
}
# Start the production OIDC configuration without contacting an external provider.
docker run "${common[@]}" -e "OPENBOT_DATABASE_URL=$database" "$image" >/dev/null
healthy
docker exec "$platform" /usr/local/bin/node --input-type=module -e '
  for(const headers of [{},{"x-user-id":"forged","x-organization-id":"forged"},{cookie:"__Host-openbot-session=forged"}]){
    const response=await fetch("http://127.0.0.1:3000/auth/session",{headers})
    if(response.status!==401)throw new Error("Unsigned requests must not authenticate")
  }
'
docker rm --force "$platform" >/dev/null
# Development owns its sign-in secret. Give it a separate database so this
# fixture never asks setup to replace the production sign-in configuration.
docker exec "$postgres" createdb -U openbot openbot_development
development_database="postgres://openbot:fixture-only@$postgres:5432/openbot_development"
docker run --rm --platform linux/amd64 --network "$network" \
  -e "OPENBOT_DATABASE_URL=$development_database" "$image" /app/dist/app/Migrate.mjs
docker run "${common[@]}" -e "OPENBOT_DATABASE_URL=$development_database" \
  -e OPENBOT_DEV_PUBLIC_ORIGIN=https://localhost:8443 "$image" /app/dist/app/DevelopmentMain.mjs >/dev/null
healthy
docker exec "$platform" /usr/local/bin/node --input-type=module -e '
  const base="http://127.0.0.1:3000",origin="https://localhost:8443"
  const login=await fetch(base+"/auth/development/sign-in",{
    method:"POST",headers:{origin,"content-type":"application/json"},body:"{}",redirect:"manual"
  })
  if(login.status!==200)throw new Error("Development fixture login failed")
  const cookie=login.headers.getSetCookie().find(value=>value.startsWith("__Host-openbot-session="))?.split(";")[0]
  if(!cookie)throw new Error("SDK session cookie missing")
  const session=await fetch(base+"/auth/session?refresh=false",{headers:{cookie}})
  if(session.status!==200||!(await session.json()).userId)throw new Error("Signed cookie lookup failed")
  const logout=await fetch(base+"/auth/logout",{method:"POST",headers:{cookie,origin}})
  if(logout.status!==204)throw new Error("SDK logout failed")
  if((await fetch(base+"/auth/session",{headers:{cookie}})).status!==401)throw new Error("Revoked cookie was accepted")
'
printf '%s\n' 'Platform container migration, production health, cookie authentication and logout checks passed.'

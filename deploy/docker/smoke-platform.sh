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
  if docker exec "$postgres" pg_isready -U openbot -d openbot >/dev/null; then break; fi
  [[ "$attempt" -lt 60 ]] || exit 1
  sleep 1
done
database="postgres://openbot:fixture-only@$postgres:5432/openbot"
docker run --rm --platform linux/amd64 --network "$network"   -e OPENBOT_DATABASE_URL="$database" "$image" /app/dist/app/Migrate.mjs
common=(--detach --platform linux/amd64 --name "$platform" --network "$network"
  -e "OPENBOT_DATABASE_URL=$database"
  -e OPENBOT_PUBLIC_ORIGIN=https://localhost:8443
  -e OPENBOT_AUTH_SESSION_COOKIE=__Host-e-session
  -e OPENBOT_AUTH_LOGIN_COOKIE=__Host-e-login
  -e BETTER_AUTH_SECRET=fixture-smoke-secret-at-least-thirty-two-bytes
  -e OPENBOT_APP_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000)
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
docker run "${common[@]}" -e OPENBOT_OIDC_ISSUER=https://identity.example.invalid   -e OPENBOT_OIDC_CLIENT_ID=ci-fixture -e OPENBOT_ALLOW_FIRST_LOGIN_ADMIN=false   -e OPENBOT_OWNER_USER_IDS=fixture-admin "$image" >/dev/null
healthy
docker exec "$platform" /usr/local/bin/node --input-type=module -e '
  for(const headers of [{},{"x-user-id":"forged","x-organization-id":"forged"},{cookie:"__Host-e-session=forged"}]){
    const response=await fetch("http://127.0.0.1:3000/auth/session",{headers})
    if(response.status!==401)throw new Error("Unsigned requests must not authenticate")
  }
'
docker rm --force "$platform" >/dev/null
# A separate explicit development fixture checks real SDK cookie issue/read/revoke
# in the packaged image. The production OIDC flow is covered by the SDK tests.
docker run "${common[@]}" -e OPENBOT_DEV_MODE=true -e OPENBOT_ALLOW_FIRST_LOGIN_ADMIN=true "$image" >/dev/null
healthy
docker exec "$platform" /usr/local/bin/node --input-type=module -e '
  const base="http://127.0.0.1:3000",origin="https://localhost:8443"
  const login=await fetch(base+"/auth/login",{redirect:"manual"})
  if(login.status!==303)throw new Error("Development fixture login failed")
  const cookie=login.headers.getSetCookie().find(value=>value.startsWith("__Host-e-session="))?.split(";")[0]
  if(!cookie)throw new Error("SDK session cookie missing")
  const session=await fetch(base+"/auth/session?refresh=false",{headers:{cookie}})
  if(session.status!==200||!(await session.json()).identity.userId)throw new Error("Signed cookie lookup failed")
  const logout=await fetch(base+"/auth/logout",{method:"POST",headers:{cookie,origin}})
  if(logout.status!==204)throw new Error("SDK logout failed")
  if((await fetch(base+"/auth/session",{headers:{cookie}})).status!==401)throw new Error("Revoked cookie was accepted")
'
printf '%s\n' 'Platform container migration, production health, cookie authentication and logout checks passed.'

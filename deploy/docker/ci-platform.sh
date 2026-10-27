#!/usr/bin/env bash
set -euo pipefail
: "${CI_COMMIT_SHA:?CI commit is required}"
[[ "$CI_COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]]
case "${OPENBOT_PUBLISH_REGISTRY:-false}" in
  false) ;;
  true) [[ "${CI_COMMIT_REF_PROTECTED:-false}" == true ]] || { echo "Registry publication requires a protected ref." >&2; exit 1; } ;;
  *) echo "OPENBOT_PUBLISH_REGISTRY must be true or false." >&2; exit 1 ;;
esac
[[ "$(git rev-parse HEAD)" == "$CI_COMMIT_SHA" ]]
# The image and corresponding source must describe exactly the same checkout.
[[ -z "$(git status --porcelain --untracked-files=normal)" ]]
hadolint deploy/docker/Dockerfile
docker run --privileged --rm tonistiigi/binfmt --install amd64
mkdir -p .devenv/release
# Failed publication must not leave a complete-looking dotenv release record.
trap 'rm -f .devenv/release/image.env' ERR
image="openbot-platform:$CI_COMMIT_SHA"
TAG="$CI_COMMIT_SHA" REVISION="$CI_COMMIT_SHA" RELEASE_TAG="" REGISTRY="" \
  docker buildx bake -f deploy/docker/docker-bake.hcl openbot protocol-test --load
docker tag "openbot:$CI_COMMIT_SHA" "$image"
[[ "$(docker image inspect "$image" --format '{{.Architecture}}')" == amd64 ]]
[[ "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" == "$CI_COMMIT_SHA" ]]
docker run --rm --platform linux/amd64 --entrypoint node "$image" \
  --eval 'if (process.versions.node !== "26.12.1") throw new Error("Unexpected Node.js runtime")'
# Use the native production bundle and Compose checks; DevelopmentMain is not shipped.
OPENBOT_RELEASE="$CI_COMMIT_SHA" COMPOSE_PROJECT_NAME="openbot-ci-${CI_JOB_ID:-local}" \
  bash deploy/docker/check.sh
image_id="$(docker image inspect "$image" --format '{{.Id}}')"
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]]
docker save "$image" | gzip -n > .devenv/release/platform.tar.gz
git archive --format=tar --prefix="openbot-$CI_COMMIT_SHA/" "$CI_COMMIT_SHA" | gzip -n > .devenv/release/source.tar.gz
cp LICENSE upstream.json .devenv/release/
printf 'OPENBOT_RELEASE=%s\nOPENBOT_IMAGE=%s\nOPENBOT_IMAGE_ID=%s\n' "$CI_COMMIT_SHA" "$image" "$image_id" > .devenv/release/image.env
# Keep long-lived package publication limited to protected refs. MR jobs keep CI artifacts.
if [[ "${CI_COMMIT_REF_PROTECTED:-false}" == true ]]; then
  node deploy/docker/publish-source.mjs
  node deploy/docker/publish-image.mjs
fi
# Registry publication is optional. An image ID is not a registry manifest digest.
if [[ "${OPENBOT_PUBLISH_REGISTRY:-false}" == true ]]; then
  : "${CI_REGISTRY:?Registry host is required}"
  : "${CI_REGISTRY_IMAGE:?Registry image is required}"
  : "${CI_REGISTRY_USER:?Registry user is required}"
  : "${CI_REGISTRY_PASSWORD:?Registry password is required}"
  registry_image="$CI_REGISTRY_IMAGE/platform:$CI_COMMIT_SHA"
  printf '%s' "$CI_REGISTRY_PASSWORD" | docker login "$CI_REGISTRY" --username "$CI_REGISTRY_USER" --password-stdin
  digest="$(bash deploy/docker/publish-platform.sh "$image" "$registry_image" "$CI_COMMIT_SHA")"
  [[ "$digest" == "$CI_REGISTRY_IMAGE/platform@sha256:"* ]]
  printf 'OPENBOT_REGISTRY_IMAGE=%s\n' "$digest" >> .devenv/release/image.env
fi
sha256sum .devenv/release/platform.tar.gz .devenv/release/source.tar.gz > .devenv/release/SHA256SUMS

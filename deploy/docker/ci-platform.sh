#!/usr/bin/env bash
set -euo pipefail
: "${CI_COMMIT_SHA:?CI commit is required}"
[[ "$CI_COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$(git rev-parse HEAD)" == "$CI_COMMIT_SHA" ]]
docker run --privileged --rm tonistiigi/binfmt --install amd64
mkdir -p .devenv/release
image="openbot-platform:$CI_COMMIT_SHA"
TAG="$CI_COMMIT_SHA" REVISION="$CI_COMMIT_SHA" RELEASE_TAG="" REGISTRY="" \
  docker buildx bake -f deploy/docker/docker-bake.hcl platform --load
[[ "$(docker image inspect "$image" --format '{{.Architecture}}')" == amd64 ]]
[[ "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" == "$CI_COMMIT_SHA" ]]
bash deploy/docker/smoke-platform.sh "$image"
docker save "$image" | gzip > .devenv/release/platform.tar.gz
git archive --format=tar --prefix="openbot-$CI_COMMIT_SHA/" "$CI_COMMIT_SHA" | gzip -n > .devenv/release/source.tar.gz
cp LICENSE upstream.json .devenv/release/
printf 'OPENBOT_RELEASE=%s\nOPENBOT_IMAGE=%s\n' "$CI_COMMIT_SHA" "$image" > .devenv/release/image.env
# Only protected commits may publish a registry image. No moving release tag is made.
if [[ "${CI_COMMIT_REF_PROTECTED:-false}" == true ]] && [[ -n "${CI_REGISTRY_IMAGE:-}" ]]; then
  : "${CI_REGISTRY_USER:?Registry user is required}"
  : "${CI_REGISTRY_PASSWORD:?Registry password is required}"
  # Commit-keyed generic packages outlive disposable CI job artifacts.
  node deploy/docker/publish-source.mjs
  registry_image="$CI_REGISTRY_IMAGE/platform:$CI_COMMIT_SHA"
  printf '%s' "$CI_REGISTRY_PASSWORD" | docker login "$CI_REGISTRY" --username "$CI_REGISTRY_USER" --password-stdin
  digest="$(bash deploy/docker/publish-platform.sh "$image" "$registry_image" "$CI_COMMIT_SHA")"
  [[ "$digest" == "$CI_REGISTRY_IMAGE/platform@sha256:"* ]]
  printf 'OPENBOT_REGISTRY_IMAGE=%s\n' "$digest" >> .devenv/release/image.env
fi
sha256sum .devenv/release/platform.tar.gz .devenv/release/source.tar.gz > .devenv/release/SHA256SUMS

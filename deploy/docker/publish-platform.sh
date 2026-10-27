#!/usr/bin/env bash
set -euo pipefail
# Bash 3.2 does not stop on a failed [[ ]] under set -e. Make checks explicit.
fail() { echo "$1" >&2; exit 1; }
image=${1:?Supply the tested local image}
registry_image=${2:?Supply the commit-tagged registry image}
revision=${3:?Supply the tested commit}
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || fail "A full commit is required."
[[ "$registry_image" == *":$revision" ]] || fail "The registry tag does not match the commit."
docker tag "$image" "$registry_image"
# Buildx loads an image index with an attestation. This registry rejects that
# index with "blob unknown". Publish the tested AMD64 manifest on its own.
# The source archive and revision label remain the release provenance.
docker push --platform linux/amd64 "$registry_image" >&2
# Read the registry digest: the local tag can still refer to the loaded index.
digest=$(docker buildx imagetools inspect "$registry_image" --format '{{.Manifest.Digest}}')
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "The registry digest is not valid."
published="${registry_image%:*}@$digest"
docker pull --platform linux/amd64 "$published" >&2
[[ "$(docker image inspect "$published" --format '{{.Architecture}}')" == amd64 ]] || fail "The image is not AMD64."
[[ "$(docker image inspect "$published" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" == "$revision" ]] || fail "The image commit does not match."
printf '%s\n' "$published"

#!/usr/bin/env bash
set -euo pipefail
image=${1:?Supply the tested local image}
registry_image=${2:?Supply the commit-tagged registry image}
revision=${3:?Supply the tested commit}
[[ "$revision" =~ ^[0-9a-f]{40}$ ]]
[[ "$registry_image" == *":$revision" ]]
docker tag "$image" "$registry_image"
# Buildx loads an image index with an attestation. This registry rejects that
# index with "blob unknown". Publish the tested AMD64 manifest on its own.
# The source archive and revision label remain the release provenance.
docker push --platform linux/amd64 "$registry_image" >&2
# Read the registry digest: the local tag can still refer to the loaded index.
digest=$(docker buildx imagetools inspect "$registry_image" --format '{{.Manifest.Digest}}')
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
published="${registry_image%:*}@$digest"
docker pull --platform linux/amd64 "$published" >&2
[[ "$(docker image inspect "$published" --format '{{.Architecture}}')" == amd64 ]]
[[ "$(docker image inspect "$published" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" == "$revision" ]]
printf '%s\n' "$published"

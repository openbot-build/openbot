# Builds the OpenBot images. Run from the repository root:
#   docker buildx bake -f deploy/docker/docker-bake.hcl

# Tag for the built images.
variable "TAG" {
  default = "local"
}

# Registry path, such as ghcr.io/owner/repository. When it is empty, the images get local names,
# such as openbot-platform:local. When it is set, they get only registry names.
variable "REGISTRY" {
  default = ""
}

# Extra registry tag, such as "latest" or "v1.2.3".
variable "RELEASE_TAG" {
  default = ""
}

# Commit that the images come from. It goes into the image labels.
variable "REVISION" {
  default = ""
}

function "tags" {
  params = [component]
  result = REGISTRY == "" ? ["openbot-${component}:${TAG}"] : concat(
    ["${lower(REGISTRY)}/${component}:${TAG}"],
    RELEASE_TAG == "" ? [] : ["${lower(REGISTRY)}/${component}:${RELEASE_TAG}"],
  )
}

group "default" {
  targets = ["platform", "protocol-test"]
}

target "_base" {
  context    = "."
  dockerfile = "deploy/docker/Dockerfile"
  platforms  = ["linux/amd64"]
  labels = {
    "org.opencontainers.image.licenses" = "AGPL-3.0-only"
    "org.opencontainers.image.revision" = REVISION
  }
}

target "platform" {
  inherits = ["_base"]
  target   = "platform"
  tags     = tags("platform")
  labels = {
    "org.opencontainers.image.title" = "OpenBot Platform"
  }
}

target "protocol-test" {
  inherits = ["_base"]
  target   = "protocol-test"
  tags     = tags("protocol-test")
  labels = {
    "org.opencontainers.image.title" = "OpenBot Protocol Test"
  }
}

# Runs the Dockerfile build checks without building.
target "lint" {
  inherits = ["_base"]
  target   = "platform"
  call     = "check"
}

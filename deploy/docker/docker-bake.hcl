# Builds the OpenBot images. Run from the repository root:
#   docker buildx bake -f deploy/docker/docker-bake.hcl

# Tag for the built images.
variable "TAG" {
  default = "local"
}

# Registry path, such as ghcr.io/owner/repository. When it is empty, the images get local names,
# such as openbot:local. When it is set, they get only registry names.
# The server image is the registry path itself. Other images get a sub path, such as /protocol-test.
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

# The component "openbot" is the server. Its local name is openbot, and the others start with openbot-.
function "image" {
  params = [component]
  result = REGISTRY == "" ? (component == "openbot" ? "openbot" : "openbot-${component}") : (
    component == "openbot" ? lower(REGISTRY) : "${lower(REGISTRY)}/${component}"
  )
}

function "tags" {
  params = [component]
  result = concat(
    ["${image(component)}:${TAG}"],
    REGISTRY == "" || RELEASE_TAG == "" ? [] : ["${image(component)}:${RELEASE_TAG}"],
  )
}

group "default" {
  targets = ["openbot", "protocol-test"]
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

target "openbot" {
  inherits = ["_base"]
  target   = "openbot"
  tags     = tags("openbot")
  labels = {
    "org.opencontainers.image.title" = "OpenBot"
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
  target   = "openbot"
  call     = "check"
}

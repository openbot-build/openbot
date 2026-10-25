# syntax=docker/dockerfile:1
# check=error=true

# Build stages make only JavaScript, so they run on the build machine's own platform.
FROM --platform=$BUILDPLATFORM node:26.12.1-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS workspace
RUN npm install --global pnpm@9.15.9
WORKDIR /workspace
# This layer changes only when the lockfile changes, so the registry cache keeps the downloaded packages.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --offline --frozen-lockfile

FROM workspace AS build-openbot
# OpenBot runs as one bundled file, so the image needs no node_modules.
RUN pnpm --filter-prod @openbot-build/openbot^... build \
    && pnpm --filter @openbot-build/openbot exec tsdown --config ../../deploy/docker/tsdown.config.ts

FROM workspace AS build-protocol-test
RUN pnpm --filter @openbot-build/protocol-test... build \
    && pnpm --filter @openbot-build/protocol-test deploy --prod /deployment

# The Node.js binary for the target platform, at the same version as development.
FROM node:26.12.1-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS node

# Distroless has no shell and no package manager. Its user is "nonroot" (65532).
# The cc image has the C and C++ libraries that Node.js needs, except libatomic.
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:3ee00291cf386ec52a552e6a858d555debd74776eb4bfa53fa3df2cd6677515e AS runtime
COPY --link --from=node /usr/lib/*-linux-gnu/libatomic.so.1* /usr/lib/
COPY --link --from=node /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production
WORKDIR /app
ENTRYPOINT ["/usr/local/bin/node"]

FROM runtime AS openbot
ENV OPENBOT_HOST=0.0.0.0 \
    OPENBOT_PORT=3000
COPY --link --from=build-openbot /workspace/.devenv/openbot/dist/app ./dist/app
COPY --link --from=build-openbot /workspace/packages/openbot/migrations ./migrations
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=5s --start-period=10s --retries=12 \
    CMD ["/usr/local/bin/node", "--input-type=module", "-e", "const response = await fetch('http://127.0.0.1:3000/health'); if (response.status !== 200 || (await response.json()).status !== 'ok') process.exit(1)"]
CMD ["/app/dist/app/Main.mjs"]

FROM runtime AS protocol-test
ENV PROTOCOL_TEST_HOST=0.0.0.0 \
    PROTOCOL_TEST_PORT=3001
COPY --link --from=build-protocol-test /deployment ./
EXPOSE 3001
HEALTHCHECK --interval=5s --timeout=5s --start-period=10s --retries=12 \
    CMD ["/usr/local/bin/node", "--input-type=module", "-e", "const response = await fetch('http://127.0.0.1:3001/healthz'); if (response.status !== 200 || (await response.json()).status !== 'ok') process.exit(1)"]
CMD ["/app/dist/Main.js"]

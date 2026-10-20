FROM --platform=$BUILDPLATFORM node:26.6.0-bookworm-slim AS workspace

RUN npm install --global pnpm@9.15.9
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --offline --frozen-lockfile

FROM workspace AS build-platform
RUN pnpm --filter-prod @openbot-build/platform^... build \
    && pnpm --filter @openbot-build/platform exec tsdown --config ../../docker/tsdown.config.ts

FROM node:26.6.0-bookworm-slim AS production
WORKDIR /app
ENV NODE_ENV=production \
    OPENBOT_HOST=0.0.0.0 \
    OPENBOT_PORT=3000
COPY --from=build-platform /workspace/.devenv/platform/dist/app ./dist/app
COPY --from=build-platform /workspace/packages/platform/migrations ./migrations
EXPOSE 3000
ENTRYPOINT ["node"]
CMD ["/app/dist/app/Main.mjs"]

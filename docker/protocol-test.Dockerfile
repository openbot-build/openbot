FROM --platform=$BUILDPLATFORM node:26.6.0-bookworm-slim AS build
RUN npm install --global pnpm@9.15.9
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --offline --frozen-lockfile \
    && pnpm --filter @openbot-build/protocol build \
    && pnpm --filter @openbot-build/protocol-test build \
    && pnpm --filter @openbot-build/protocol-test deploy --prod /deployment

FROM node:26.6.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PROTOCOL_TEST_HOST=0.0.0.0 PROTOCOL_TEST_PORT=3001
COPY --from=build --chown=node:node /deployment ./
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD node -e 'fetch("http://127.0.0.1:3001/healthz").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'
CMD ["node", "dist/Main.js"]

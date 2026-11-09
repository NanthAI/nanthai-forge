# Build from the repository root: docker build -f scripts/self-hosted-runner/Dockerfile -t forge-runner .
FROM node:24.22.1-bookworm-slim AS build
WORKDIR /opt/forge
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
# build:core generates the typed Convex API inventory from these modules (scripts/prepare-convex-api.mjs).
COPY convex ./convex
COPY scripts ./scripts
RUN npm ci --ignore-scripts && npm run build:core

FROM node:24.22.1-bookworm-slim
# Git fetches pinned submodule commits for checks (docs/operations/github-actions-checks.md#submodules-in-checks).
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/forge
COPY --from=build /opt/forge/package.json /opt/forge/package-lock.json ./
COPY --from=build /opt/forge/dist ./dist
COPY --from=build /opt/forge/scripts ./scripts
COPY --from=build /opt/forge/node_modules ./node_modules
RUN mkdir -p /var/lib/forge-runner && chown -R node:node /var/lib/forge-runner
USER node
ENV FORGE_RUNNER_STATE_DIR=/var/lib/forge-runner
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "scripts/self-hosted-runner/start.mjs"]

# syntax=docker/dockerfile:1.7
# Multi-stage build (spec §38). Runtime image = compiled app only, non-root, no .git / .env /
# signing keys / dev deps / tests.
#
# Same image serves all three process roles (override the command):
#   web     (default): node --import ./server/dist/telemetry/otel-preload.js server/dist/index.js
#   worker           : node --import ./server/dist/telemetry/otel-preload.js server/dist/worker.js
#   migrate          : node server/dist/migrate.js
#
# web + worker run the OTel ESM preload (--import) so Azure Monitor auto-instrumentation hooks
# module loading before fastify / pg / node:http are imported. migrate is a flag-less one-shot: no
# long-lived traffic, nothing worth tracing.

# ---- deps: install the full workspace graph from the lockfile ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
# packages/* has no members yet (only a .gitkeep); the workspace glob is harmless if empty.
COPY packages ./packages
RUN npm ci

# ---- build: compile TypeScript, then produce a production-only node_modules ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY packages ./packages
COPY server ./server
RUN npm -w @attendance/server run build
# prune to production deps for the runtime layer (removes root + workspace devDependencies)
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

# npm workspaces fully hoist this dependency set to the root node_modules, so there is no
# server/node_modules to copy; require('fastify') resolves from /app/node_modules at runtime.
COPY --chown=node:node package.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/server/dist ./server/dist
COPY --chown=node:node --from=build /app/server/package.json ./server/package.json
# migrations must sit where resolveMigrationsFolder() looks. The built module lives at
# server/dist/database/client.js and resolves `new URL('../../migrations', import.meta.url)`
# to /app/server/migrations (verified empirically), so that is the load-bearing copy.
# server/dist/migrations is also populated to match the documented layout / layout check.
COPY --chown=node:node --from=build /app/server/migrations ./server/migrations
COPY --chown=node:node --from=build /app/server/migrations ./server/dist/migrations
COPY --chown=node:node web ./web

USER node
EXPOSE 3000
CMD ["node", "--import", "./server/dist/telemetry/otel-preload.js", "server/dist/index.js"]

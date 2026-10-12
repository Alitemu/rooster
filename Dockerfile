# Two stages: the first builds, the second only runs. The compiler and
# Python that better-sqlite3 and bcrypt need to build (and the test tools)
# stay behind in the first; the image that runs has none of them.
#
# Node 22: Node 20 stopped getting security updates in April 2026. The same
# major version the tests run on.

# ---- build ----
FROM node:22-alpine AS build

WORKDIR /app

# Native modules (better-sqlite3, bcrypt) compile against musl here.
RUN apk add --no-cache python3 make g++

# Next.js otherwise sends anonymous usage data to Vercel while building.
ENV NEXT_TELEMETRY_DISABLED=1

# Copy package files (.npmrc: the lockfile was resolved with
# legacy-peer-deps, and `npm ci` has to use the same setting)
COPY package*.json .npmrc ./
RUN npm ci

COPY . .

# The sub-folder the app runs under, e.g. /achterwacht (lib/basePath.ts).
# Empty: the root of its address. Fixed at build time - Next.js writes it
# into the pages.
ARG BASE_PATH=""
ENV NEXT_PUBLIC_BASE_PATH=$BASE_PATH

RUN npm run build

# Only what runs is kept: the test tools (vitest, playwright, eslint, ...)
# have no business in a running installation. tsx stays - it is a
# dependency, and docker-entrypoint.sh runs scripts/seed.ts with it. The
# build's own cache goes too.
RUN npm prune --omit=dev \
  && rm -rf .next/cache \
  && chmod +x docker-entrypoint.sh

# ---- run ----
FROM node:22-alpine

WORKDIR /app

# su-exec: docker-entrypoint.sh drops from root to the unprivileged `node`
# user with it after fixing DATA_DIR's ownership (see the USER note below).
RUN apk add --no-cache su-exec

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

ARG BASE_PATH=""
# Kept for the healthcheck below (the pages have it built in already).
ENV NEXT_PUBLIC_BASE_PATH=$BASE_PATH

# Owned by root, so the app - running as `node` - cannot change its own
# code. Only two places are writable: /data (the bind mount, fixed at
# runtime by the entrypoint) and Next.js's own cache.
COPY --from=build /app /app
RUN mkdir -p /data /app/.next/cache && chown node:node /app/.next/cache

EXPOSE 3000

# Health check endpoint. Uses 127.0.0.1, not localhost: Node 18+ resolves
# "localhost" to ::1 first on Alpine/musl, and next start only binds the
# IPv4 wildcard - the healthcheck would hang against the unreachable IPv6
# loopback until it times out, reporting the container unhealthy even
# though the server is up and answering on IPv4.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=20s \
  CMD node -e "require('http').get('http://127.0.0.1:3000' + (process.env.NEXT_PUBLIC_BASE_PATH || '') + '/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# No USER here (deliberately) - the container starts as root so
# docker-entrypoint.sh can chown DATA_DIR's bind mount before dropping to
# the unprivileged `node` user via su-exec for everything the app itself
# does. A Docker-managed named volume gets its ownership from the image
# automatically on first use; a bind-mounted host directory (what this
# compose file uses, so the data is a plain folder a NAS's file manager
# can browse) does not - Docker just creates it as root:root if it doesn't
# already exist, which `node` (uid 1000) can't write into.

# Runs the optional seed (SEED_ON_START) before starting Next.js.
ENTRYPOINT ["./docker-entrypoint.sh"]

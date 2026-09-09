FROM node:20-alpine

WORKDIR /app

# Install system dependencies for better-sqlite3, plus su-exec (used by
# docker-entrypoint.sh to drop from root to the unprivileged `node` user
# after fixing DATA_DIR's ownership - see the USER note below).
RUN apk add --no-cache python3 make g++ su-exec

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy app code
COPY . .

# Build Next.js
RUN npm run build

# The app itself still runs as this non-root user (dropped into by
# docker-entrypoint.sh via su-exec, not set here with USER) - only /app
# needs pre-chowning at build time. /data does NOT: it's a bind-mount
# point (see docker-compose.yml's DATA_DIR), so whatever gets chowned into
# it here is invisible once the real host directory is mounted over it at
# container start - that's fixed at runtime instead, see the entrypoint.
RUN mkdir -p /data && chown -R node:node /app

RUN chmod +x docker-entrypoint.sh

# Expose port
EXPOSE 3000

# Health check endpoint. Uses 127.0.0.1, not localhost: Node 18+ resolves
# "localhost" to ::1 first on Alpine/musl, and next start only binds the
# IPv4 wildcard - the healthcheck would hang against the unreachable IPv6
# loopback until it times out, reporting the container unhealthy even
# though the server is up and answering on IPv4.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=20s \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# No USER here (deliberately) - the container starts as root so
# docker-entrypoint.sh can chown DATA_DIR's bind mount before dropping to
# the unprivileged `node` user via su-exec for everything the app itself
# does. A Docker-managed named volume gets its ownership from the image
# automatically on first use; a bind-mounted host directory (what this
# compose file now uses instead, so the data is a plain folder a NAS's
# file manager can browse) does not - Docker just creates it as root:root
# if it doesn't already exist, which `node` (uid 1000) can't write into.

# Runs the optional demo-data seed (SEED_ON_START) before starting Next.js.
ENTRYPOINT ["./docker-entrypoint.sh"]

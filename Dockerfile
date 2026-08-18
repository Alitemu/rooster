FROM node:20-alpine

WORKDIR /app

# Install system dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy app code
COPY . .

# Build Next.js
RUN npm run build

# Create the SQLite data directory now, owned by the non-root user, so the
# named volume mounted here inherits correct ownership on first use.
RUN mkdir -p /data && chown -R node:node /app /data

# Expose port
EXPOSE 3000

# Health check endpoint. Uses 127.0.0.1, not localhost: Node 18+ resolves
# "localhost" to ::1 first on Alpine/musl, and next start only binds the
# IPv4 wildcard - the healthcheck would hang against the unreachable IPv6
# loopback until it times out, reporting the container unhealthy even
# though the server is up and answering on IPv4.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=20s \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

USER node

# Start Next.js
CMD ["npm", "start"]

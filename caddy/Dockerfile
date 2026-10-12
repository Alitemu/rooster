# Caddy with Dienstrooster's Caddyfile in it, so a change to that file
# arrives with an update (docker compose pull, or "Bijwerken" in the app)
# like everything else, instead of needing a git pull on the server. Each
# build takes the newest Caddy 2.x, for its security fixes.
#
# A server that needs its own Caddyfile (README, a Let's Encrypt
# certificate) mounts it over this one in docker-compose.override.yml.
FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile

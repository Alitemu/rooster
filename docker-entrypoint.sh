#!/bin/sh
# Optional demo-data seed, run once per fresh database - see SEED_ON_START
# in .env.example. `npm run seed` is idempotent (scripts/seed.ts refuses to
# touch a database that already has a planner account unless told --reset),
# so leaving this on across restarts and reinstalls is safe: it only ever
# does something the first time a fresh DATA_DIR boots.
set -e

# The image starts this container as root (no USER in the Dockerfile)
# specifically so this can happen first: DATA_DIR is a bind mount (see
# docker-compose.yml), and unlike a Docker-managed named volume, Docker
# does not chown a freshly-created bind-mount host directory to match the
# image's user - a brand new DATA_DIR shows up here owned by root, which
# the app (running as the unprivileged `node` user below) couldn't write
# rooster.db or the preferences CSV backups into. Fixed once per boot,
# then everything else - including the rest of this script - runs as
# `node` via su-exec, never as root.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown -R node:node /data
  exec su-exec node "$0" "$@"
fi

if [ "$SEED_ON_START" = "true" ]; then
  echo "SEED_ON_START=true - running database seed..."
  npm run seed || echo "Seed step exited non-zero (likely: already seeded) - continuing startup."
fi

# Optional: claim the planner password from .env instead of the
# interactive /planner/login first-run form - see SEED_PLANNER_PASSWORD in
# .env.example. Idempotent (only ever touches an account with no password
# yet), so safe to leave set across restarts.
if [ -n "$SEED_PLANNER_PASSWORD" ]; then
  # Password comes from the SEED_PLANNER_PASSWORD env var already in this
  # process's environment, not a CLI argument - an argument would be
  # visible to any other process on the host via `ps aux` for as long as
  # this command runs.
  npx tsx scripts/claim-password.ts planner || echo "planner password claim failed - continuing startup."
fi

exec npm start

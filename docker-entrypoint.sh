#!/bin/sh
# Optional demo-data seed, run once per fresh database - see SEED_ON_START
# in .env.example. `npm run seed` is idempotent (scripts/seed.ts refuses to
# touch a database that already has ADMIN/PLANNER accounts unless told
# --reset), so leaving this on across restarts and reinstalls is safe: it
# only ever does something the first time a fresh db_data volume boots.
set -e

if [ "$SEED_ON_START" = "true" ]; then
  echo "SEED_ON_START=true - running database seed..."
  npm run seed || echo "Seed step exited non-zero (likely: already seeded) - continuing startup."
fi

# Optional: claim the ADMIN/PLANNER password from .env instead of the
# interactive /planner/login first-run form - see SEED_ADMIN_PASSWORD /
# SEED_PLANNER_PASSWORD in .env.example. Idempotent (only ever touches an
# account with no password yet), so safe to leave set across restarts.
if [ -n "$SEED_ADMIN_PASSWORD" ]; then
  npx tsx scripts/claim-password.ts ADMIN "$SEED_ADMIN_PASSWORD" || echo "ADMIN password claim failed - continuing startup."
fi
if [ -n "$SEED_PLANNER_PASSWORD" ]; then
  npx tsx scripts/claim-password.ts PLANNER "$SEED_PLANNER_PASSWORD" || echo "PLANNER password claim failed - continuing startup."
fi

exec npm start

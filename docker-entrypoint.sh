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

exec npm start

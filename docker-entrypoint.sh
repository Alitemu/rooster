#!/bin/sh
# Optional demo-data seed, run once per fresh database - see SEED_ON_START
# in .env.example. `npm run seed` is idempotent (scripts/seed.ts refuses to
# touch a database that already has a planner account unless told --reset),
# so leaving this on across restarts and reinstalls is safe: it only ever
# does something the first time a fresh db_data volume boots.
set -e

if [ "$SEED_ON_START" = "true" ]; then
  echo "SEED_ON_START=true - running database seed..."
  npm run seed || echo "Seed step exited non-zero (likely: already seeded) - continuing startup."
fi

# Optional: claim the planner password from .env instead of the
# interactive /planner/login first-run form - see SEED_PLANNER_PASSWORD in
# .env.example. Idempotent (only ever touches an account with no password
# yet), so safe to leave set across restarts.
if [ -n "$SEED_PLANNER_PASSWORD" ]; then
  npx tsx scripts/claim-password.ts planner "$SEED_PLANNER_PASSWORD" || echo "planner password claim failed - continuing startup."
fi

exec npm start

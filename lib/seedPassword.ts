/**
 * The password scripts/seed.ts gives the seeded planner account.
 *
 * Deliberately a known value checked into this repository: it makes a
 * freshly seeded database usable immediately - easy to type on a phone,
 * no .env file, no first-run form - while this application is being built
 * and tested.
 *
 * It lives here rather than only in scripts/seed.ts because the startup
 * check in instrumentation-node.ts has to compare against exactly the same
 * value. Two copies would drift, and the one that drifts is the warning,
 * which then silently stops warning.
 *
 * CHANGE OR REMOVE THIS before pointing a deployment at real staff and
 * real schedules: anyone with read access to this repository (now, or at
 * any point in its git history) knows it, and it controls the entire
 * roster for every participant.
 */
export const DEFAULT_TEST_PASSWORD = 'Password123!';

/**
 * Whether a staff login with DEFAULT_TEST_PASSWORD must change it before
 * anything else (app/api/auth/staff-login). The password is public with
 * the code, so on any real installation it must. ALLOW_SEED_PASSWORD=true
 * lifts that for local test runs only (the browser checks in scripts/ and
 * tests/e2e log in with it); docker-compose.yml deliberately does not pass
 * it through.
 */
export function seedPasswordMustBeChanged(password: string): boolean {
  return password === DEFAULT_TEST_PASSWORD && process.env.ALLOW_SEED_PASSWORD !== 'true';
}

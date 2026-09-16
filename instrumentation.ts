/**
 * Runs once when the Next.js server process boots - see
 * https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 *
 * docker-entrypoint.sh already runs the optional SEED_ON_START /
 * SEED_PLANNER_PASSWORD bootstrap (scripts/seed.ts, scripts/claim-password.ts)
 * before `npm start` on the NAS/Docker path - but a host that builds this
 * app with a generic buildpack instead of the project's own Dockerfile
 * (e.g. a Back4Apps-style platform) just runs `npm start` directly, with
 * no entrypoint script in front of it. On a fresh database there, no
 * planner account ever gets created, so /planner/login never shows the
 * "create a password" first-run form - login always fails, with nothing
 * to explain why. This mirrors that same bootstrap here, gated by the
 * same env vars documented in .env.example, so it also works on hosts
 * that only run `npm start`.
 *
 * Cheap no-op on the NAS: the read below finds the account
 * docker-entrypoint.sh's own seed step already created and returns
 * immediately, so this adds no meaningful startup delay there and changes
 * nothing about the existing boot sequence. Both scripts are also
 * idempotent on their own (seed.ts refuses to touch an already-seeded
 * database without --reset; claim-password.ts only ever touches an
 * account with a NULL wachtwoord_hash), so even if this ever did run
 * again after that check, it would be a harmless no-op, not a behavior
 * change.
 *
 * Runs the scripts as genuinely separate child processes, deliberately -
 * both are CLI scripts that call process.exit() on their normal
 * "nothing to do" paths, which would kill this very server process if
 * their code ran in-process instead.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.SEED_ON_START !== 'true' && !process.env.SEED_PLANNER_PASSWORD) return;

  const { db } = await import('@/db/client');
  const hasStaffAccount = db
    .prepare(`SELECT 1 FROM dienstrooster_person WHERE rol IN ('ADMIN', 'PLANNER') LIMIT 1`)
    .get();
  if (hasStaffAccount) return;

  const { spawn } = await import('child_process');
  const path = await import('path');

  function runScript(scriptPath: string, args: string[] = []): Promise<void> {
    return new Promise((resolve) => {
      const tsxBin = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
      const child = spawn(tsxBin, [scriptPath, ...args], { stdio: 'inherit' });
      // A non-zero exit (e.g. seed.ts's "already contains seed data" guard)
      // is an expected, harmless outcome here - see the hasStaffAccount
      // check above for the case this normally short-circuits on instead.
      child.on('exit', () => resolve());
      child.on('error', (err) => {
        console.error(`[instrumentation] kon ${scriptPath} niet starten:`, err);
        resolve();
      });
    });
  }

  if (process.env.SEED_ON_START === 'true') {
    await runScript('scripts/seed.ts');
  }
  if (process.env.SEED_PLANNER_PASSWORD) {
    await runScript('scripts/claim-password.ts', ['planner']);
  }
}

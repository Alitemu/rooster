/**
 * Node-only half of instrumentation.ts's startup bootstrap - kept in its
 * own module so Next.js never has to bundle better-sqlite3/child_process
 * for the Edge runtime (see instrumentation.ts for why that matters).
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
export async function runStartupBootstrap(): Promise<void> {
  await warnAboutSeededPassword();

  if (process.env.SEED_ON_START !== 'true' && !process.env.SEED_PLANNER_PASSWORD) return;

  const { db } = await import('./db/client');
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

/**
 * Say so, loudly, on every start while a staff account still has the
 * password that scripts/seed.ts sets.
 *
 * That password is in this repository on purpose - it makes the app
 * usable the moment it is seeded, while it is being built and tested. The
 * risk is not that it exists; it is that a deployment quietly keeps it
 * after becoming the real thing. docker-compose.yml's own comment claimed
 * for a while that seeding left the account without a password at all,
 * which is exactly the kind of belief this check exists to interrupt.
 *
 * Only ever a log line: it must never refuse to start or change an
 * account, because it cannot tell a real deployment apart from the
 * testing it is meant to support.
 */
async function warnAboutSeededPassword(): Promise<void> {
  try {
    const { db } = await import('./db/client');
    const staff = db
      .prepare(
        `SELECT codenaam, wachtwoord_hash FROM dienstrooster_person
         WHERE rol IN ('ADMIN', 'PLANNER') AND wachtwoord_hash IS NOT NULL`
      )
      .all() as Array<{ codenaam: string; wachtwoord_hash: string }>;
    if (staff.length === 0) return;

    const { verifyPassword } = await import('./lib/auth');
    const { DEFAULT_TEST_PASSWORD } = await import('./lib/seedPassword');

    // In parallel, not one account at a time: bcrypt.compare at cost 12 is
    // ~200-300ms by design, and this whole check runs on every server
    // boot/restart - Next.js awaits instrumentation's register() before
    // accepting a request, so a sequential loop here added that cost once
    // per staff account to every single restart. This check exists to
    // print a warning, never to gate startup, so there is no reason its
    // own accounts should be compared one after another.
    const results = await Promise.all(
      staff.map(async (account) => ({
        codenaam: account.codenaam,
        stillDefault: await verifyPassword(DEFAULT_TEST_PASSWORD, account.wachtwoord_hash),
      }))
    );
    const stillDefault = results.filter((r) => r.stillDefault).map((r) => r.codenaam);
    if (stillDefault.length === 0) return;

    console.warn(
      `\n[dienstrooster] LET OP: ${stillDefault.join(', ')} ` +
        `${stillDefault.length === 1 ? 'gebruikt' : 'gebruiken'} nog het standaard seed-wachtwoord.\n` +
        '            Dat wachtwoord staat in de broncode, dus iedereen die de repository\n' +
        '            heeft gezien kan hiermee inloggen en het hele rooster beheren.\n' +
        '            Wijzig het via "Wachtwoord wijzigen" op de periodepagina voordat\n' +
        '            deze installatie voor echte roosters gebruikt wordt.\n'
    );
  } catch {
    // A warning is never worth failing a boot over - e.g. a database that
    // has not been migrated yet at this point.
  }
}

const AUTO_REMINDER_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Checks every hour whether an automatic reminder is due (see
 * lib/autoReminders.ts, which decides what and whether). The server is the
 * only thing running on the NAS, so the schedule lives in it rather than in
 * a separate cron job someone would have to set up.
 *
 * Hourly by the planner's choice: nothing about a reminder is urgent to the
 * minute. The price is that one due at 09:00 goes out somewhere before
 * 10:00, so the last one can leave a little under 24 hours before a
 * deadline that falls just after the hour.
 *
 * Never during `next build`, and one check at a time: a slow mail server
 * must not let the next tick start the same send again (the claim in
 * dienstrooster_reminder_run would stop it anyway, this just keeps it quiet).
 */
export function startAutoReminderScheduler(): void {
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { runAutoReminders } = await import('./lib/autoReminders');
      // What was sent is on record (dienstrooster_reminder_run, the
      // dashboard); only what didn't go out is worth a line in the log.
      for (const result of await runAutoReminders()) {
        if (result.uitkomst !== 'VERSTUURD') {
          console.warn(`[auto-herinneringen] periode ${result.periodId}, ${result.dagen} dagen: ${result.uitkomst}`);
        }
      }
    } catch (error) {
      console.error('[auto-herinneringen] controle mislukt', error);
    }
    // Swap mails that could not go out earlier (lib/meldingMail.ts).
    try {
      const { flushMailQueue } = await import('./lib/meldingMail');
      const { verstuurd, over } = await flushMailQueue();
      if (verstuurd > 0 || over > 0) console.warn(`[ruilmails] alsnog verstuurd: ${verstuurd}, wachten nog: ${over}`);
    } catch (error) {
      console.error('[ruilmails] wachtrij versturen mislukt', error);
    } finally {
      running = false;
    }
  };
  // First check shortly after start: a moment missed while the server was
  // down is still sent if it's inside its catch-up window.
  setTimeout(tick, 30_000).unref();
  setInterval(tick, AUTO_REMINDER_INTERVAL_MS).unref();
}

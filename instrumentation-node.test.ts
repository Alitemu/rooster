import { describe, it, expect, afterEach, vi } from 'vitest';
import { db } from '@/db/client';
import { hashPassword } from '@/lib/auth';
import { DEFAULT_TEST_PASSWORD } from '@/lib/seedPassword';
import { runStartupBootstrap, warnAboutMissingAiosSolver } from './instrumentation-node';

/**
 * The hard rule: this warning names every staff account still on the
 * seeded default password, and nothing else - never silent when one is
 * exposed, never noisy about one that has already been changed.
 *
 * Runs on every server start/restart (Next.js awaits instrumentation's
 * register() before serving a request), so the other thing that must hold
 * is that checking N accounts costs roughly what checking one does - a
 * sequential bcrypt.compare per account turns "how many staff accounts
 * exist" into "how many times longer every restart takes".
 */

const createdPersonIds: string[] = [];

async function createStaff(password: string): Promise<string> {
  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, wachtwoord_hash, aangemaakt_op)
     VALUES (?, ?, 'PLANNER', 1, ?, datetime('now'))`
  ).run(personId, `Test-${personId.slice(0, 8)}`, await hashPassword(password));
  createdPersonIds.push(personId);
  return personId;
}

afterEach(() => {
  while (createdPersonIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(createdPersonIds.pop()!);
  }
});

describe('runStartupBootstrap / warnAboutSeededPassword', () => {
  it('warns, naming the account, when a staff account still has the seeded password', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const personId = await createStaff(DEFAULT_TEST_PASSWORD);
      const codenaam = (
        db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?').get(personId) as { codenaam: string }
      ).codenaam;

      await runStartupBootstrap();

      const warned = warn.mock.calls.some((call) => String(call[0]).includes(codenaam));
      expect(warned).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('says nothing about an account whose password has already been changed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const personId = await createStaff('EenHeelAnderWachtwoord1!');
      const codenaam = (
        db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?').get(personId) as { codenaam: string }
      ).codenaam;

      await runStartupBootstrap();

      const mentioned = warn.mock.calls.some((call) => String(call[0]).includes(codenaam));
      expect(mentioned).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('names every account still on the default password, not just the first', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const idA = await createStaff(DEFAULT_TEST_PASSWORD);
      const idB = await createStaff(DEFAULT_TEST_PASSWORD);
      const codenaamA = (db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?').get(idA) as { codenaam: string }).codenaam;
      const codenaamB = (db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?').get(idB) as { codenaam: string }).codenaam;

      await runStartupBootstrap();

      const combined = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(combined).toContain(codenaamA);
      expect(combined).toContain(codenaamB);
    } finally {
      warn.mockRestore();
    }
  });

  it('never throws, even though it is not wrapped by the route error handling every request goes through', async () => {
    // No staff accounts, no seeded database assumptions - just proving the
    // call itself is safe to await unconditionally at boot.
    await expect(runStartupBootstrap()).resolves.toBeUndefined();
  });
});

describe('warnAboutMissingAiosSolver', () => {
  const bewaardeUrl = process.env.AIOS_SOLVER_URL;
  afterEach(() => {
    if (bewaardeUrl === undefined) delete process.env.AIOS_SOLVER_URL;
    else process.env.AIOS_SOLVER_URL = bewaardeUrl;
  });

  async function waarschuwingen(lookup: (host: string) => Promise<unknown>): Promise<string> {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await warnAboutMissingAiosSolver(lookup);
      return warn.mock.calls.map((call) => String(call[0])).join('\n');
    } finally {
      warn.mockRestore();
    }
  }

  it('names the host and the compose file when the name does not exist', async () => {
    process.env.AIOS_SOLVER_URL = 'http://aios-solver:8000';
    const tekst = await waarschuwingen(() => Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' })));
    expect(tekst).toContain('"aios-solver"');
    expect(tekst).toContain('docker-compose.yml');
  });

  it('says nothing when the name exists', async () => {
    expect(await waarschuwingen(() => Promise.resolve({ address: '172.18.0.4' }))).toBe('');
  });

  it('says nothing about a lookup that failed for another reason', async () => {
    expect(await waarschuwingen(() => Promise.reject(Object.assign(new Error('x'), { code: 'EAI_AGAIN' })))).toBe('');
  });

  it('never throws on an AIOS_SOLVER_URL that is not a URL', async () => {
    process.env.AIOS_SOLVER_URL = 'geen url';
    expect(await waarschuwingen(() => Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' })))).toBe('');
  });
});

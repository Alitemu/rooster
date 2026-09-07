import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { db } from '@/db/client';
import {
  renderTemplate,
  renderNotificationTemplate,
  insertNotification,
  notificationsFeatureEnabled,
  queueBlockOverriddenNotification,
} from '@/lib/notifications';

describe('renderTemplate', () => {
  it('substitutes every placeholder present in the map', () => {
    const result = renderTemplate('Hoi {{codenaam}}, welkom bij {{periode}}.', {
      codenaam: 'Persoon-01',
      periode: '2027-1',
    });
    expect(result).toBe('Hoi Persoon-01, welkom bij 2027-1.');
  });

  it('leaves a placeholder untouched when no value was given for it', () => {
    const result = renderTemplate('Hoi {{codenaam}}, zie {{link}}.', { codenaam: 'Persoon-01' });
    expect(result).toBe('Hoi Persoon-01, zie {{link}}.');
  });
});

describe('renderNotificationTemplate', () => {
  // sleutel is CHECK-constrained to the fixed enum in db/schema.ts, so the
  // fixture has to reuse one of those keys rather than inventing its own -
  // CORRECTION_BOOKED is used nowhere else in this test file. Overwrites
  // (then restores) whatever content is already there, so this works the
  // same whether or not scripts/seed.ts has run against this database.
  const sleutel = 'CORRECTION_BOOKED';
  let previous: { id: string; onderwerp: string; body_md: string } | undefined;

  beforeEach(() => {
    previous = db
      .prepare('SELECT id, onderwerp, body_md FROM dienstrooster_notification_template WHERE sleutel = ?')
      .get(sleutel) as typeof previous;

    if (previous) {
      db.prepare(
        `UPDATE dienstrooster_notification_template SET onderwerp = ?, body_md = ? WHERE sleutel = ?`
      ).run('{{periode}}: test', 'Hoi {{codenaam}}, dit is een test voor {{periode}}.', sleutel);
    } else {
      db.prepare(
        `INSERT INTO dienstrooster_notification_template (id, sleutel, onderwerp, body_md)
         VALUES (?, ?, '{{periode}}: test', 'Hoi {{codenaam}}, dit is een test voor {{periode}}.')`
      ).run(crypto.randomUUID(), sleutel);
    }
  });

  afterEach(() => {
    if (previous) {
      db.prepare(
        `UPDATE dienstrooster_notification_template SET onderwerp = ?, body_md = ? WHERE sleutel = ?`
      ).run(previous.onderwerp, previous.body_md, sleutel);
    } else {
      db.prepare('DELETE FROM dienstrooster_notification_template WHERE sleutel = ?').run(sleutel);
    }
  });

  it('renders both subject and body from a real template row', () => {
    const rendered = renderNotificationTemplate(sleutel, { codenaam: 'Persoon-02', periode: '2027-2' });
    expect(rendered).toEqual({
      onderwerp: '2027-2: test',
      inhoud: 'Hoi Persoon-02, dit is een test voor 2027-2.',
    });
  });

  it('returns null for a sleutel with no template row', () => {
    expect(renderNotificationTemplate('DOES_NOT_EXIST', {})).toBeNull();
  });
});

describe('notificationsFeatureEnabled', () => {
  const original = process.env.NOTIFICATIONS_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.NOTIFICATIONS_ENABLED;
    else process.env.NOTIFICATIONS_ENABLED = original;
  });

  it('defaults to false when unset', () => {
    delete process.env.NOTIFICATIONS_ENABLED;
    expect(notificationsFeatureEnabled()).toBe(false);
  });

  it('is false for anything other than the literal string "true"', () => {
    process.env.NOTIFICATIONS_ENABLED = 'yes';
    expect(notificationsFeatureEnabled()).toBe(false);
    process.env.NOTIFICATIONS_ENABLED = '1';
    expect(notificationsFeatureEnabled()).toBe(false);
  });

  it('is true only when explicitly set to "true"', () => {
    process.env.NOTIFICATIONS_ENABLED = 'true';
    expect(notificationsFeatureEnabled()).toBe(true);
  });
});

describe('insertNotification', () => {
  it('writes a row that appears in the participant inbox query shape', () => {
    const personId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_person (id, codenaam, rol, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', datetime('now'))`
    ).run(personId, `Test-${personId.slice(0, 8)}`);

    insertNotification({
      personId,
      type: 'ROSTER_GEREED',
      onderwerp: 'Onderwerp',
      inhoud: 'Inhoud',
    });

    const row = db
      .prepare('SELECT person_id, type, onderwerp, inhoud, gelezen FROM dienstrooster_notification WHERE person_id = ?')
      .get(personId) as any;

    expect(row).toMatchObject({
      person_id: personId,
      type: 'ROSTER_GEREED',
      onderwerp: 'Onderwerp',
      inhoud: 'Inhoud',
      gelezen: 0,
    });

    db.prepare('DELETE FROM dienstrooster_notification WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
  });
});

describe('queueBlockOverriddenNotification', () => {
  const original = process.env.NOTIFICATIONS_ENABLED;
  let personId: string;
  let periodId: string;
  let previousTemplate: { onderwerp: string; body_md: string } | undefined;

  beforeEach(() => {
    // Ensure the BLOCK_OVERRIDDEN template this function depends on exists,
    // regardless of whether scripts/seed.ts has run against this database -
    // restored (or removed) afterward either way.
    previousTemplate = db
      .prepare(`SELECT onderwerp, body_md FROM dienstrooster_notification_template WHERE sleutel = 'BLOCK_OVERRIDDEN'`)
      .get() as typeof previousTemplate;
    if (!previousTemplate) {
      db.prepare(
        `INSERT INTO dienstrooster_notification_template (id, sleutel, onderwerp, body_md)
         VALUES (?, 'BLOCK_OVERRIDDEN', '{{periode}}: een van je voorkeuren kon niet worden gehonoreerd',
                 'Hoi {{codenaam}},\n\n{{details}}\n\nReden: {{reden}}')`
      ).run(crypto.randomUUID());
    }

    personId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_person (id, codenaam, rol, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', datetime('now'))`
    ).run(personId, `Test-${personId.slice(0, 8)}`);

    const rulesetId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, ?, '{}', datetime('now'))`
    ).run(rulesetId, 'Test ruleset');
    const poolId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
    ).run(poolId, 'Test pool', rulesetId);
    periodId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_schedule_period
         (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
       VALUES (?, ?, 'Test periode', '2027-01-04', '2027-01-10', '2099-01-01T00:00:00Z', 'GEGENEREERD', datetime('now'))`
    ).run(periodId, poolId);
  });

  afterEach(() => {
    if (original === undefined) delete process.env.NOTIFICATIONS_ENABLED;
    else process.env.NOTIFICATIONS_ENABLED = original;

    if (!previousTemplate) {
      db.prepare(`DELETE FROM dienstrooster_notification_template WHERE sleutel = 'BLOCK_OVERRIDDEN'`).run();
    }

    db.prepare('DELETE FROM dienstrooster_notification WHERE person_id = ?').run(personId);
    const pool = db
      .prepare(
        `SELECT pool_id FROM dienstrooster_schedule_period WHERE id = ?`
      )
      .get(periodId) as { pool_id: string } | undefined;
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
    if (pool) {
      const rulesetRow = db
        .prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?')
        .get(pool.pool_id) as { ruleset_id: string } | undefined;
      db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(pool.pool_id);
      if (rulesetRow) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(rulesetRow.ruleset_id);
    }
  });

  const args = () => ({
    personId,
    codenaam: 'Persoon-01',
    periodId,
    periodeNaam: 'Test periode',
    details: 'Dienst op 2027-01-05',
    reden: 'overleg met collega',
  });

  it('queues nothing while the feature flag is off (the default)', () => {
    delete process.env.NOTIFICATIONS_ENABLED;

    const queued = queueBlockOverriddenNotification(args());

    expect(queued).toBe(false);
    const count = (
      db.prepare('SELECT COUNT(*) as c FROM dienstrooster_notification WHERE person_id = ?').get(personId) as {
        c: number;
      }
    ).c;
    expect(count).toBe(0);
  });

  it('queues a rendered BLOCK_OVERRIDDEN notification once the flag is on', () => {
    process.env.NOTIFICATIONS_ENABLED = 'true';

    const queued = queueBlockOverriddenNotification(args());

    expect(queued).toBe(true);
    const row = db
      .prepare('SELECT type, onderwerp, inhoud FROM dienstrooster_notification WHERE person_id = ?')
      .get(personId) as any;
    expect(row.type).toBe('BLOCK_OVERRIDDEN');
    expect(row.onderwerp).toContain('Test periode');
    expect(row.inhoud).toContain('Persoon-01');
    expect(row.inhoud).toContain('Dienst op 2027-01-05');
    expect(row.inhoud).toContain('overleg met collega');
  });
});

/**
 * The mails about the AIOS's swaps, sent or kept in a queue of their own
 * (dienstrooster_aios_mail_queue). The AIOS's own copy of what
 * lib/meldingMail.ts does for the achterwacht, not a change to it
 * (docs/development/diensten.md, "Copied, not changed").
 *
 * A mail goes out through the AIOS's flow (lib/aiosMail.ts). When it can't
 * (sending not set up, or the mail server refusing) it waits in the queue
 * and flushAiosMailQueue sends it later: every hour, right after the
 * settings are saved and after any other mail went out. Dropped after 7
 * days, or as soon as the request it is about is no longer open. The
 * request itself never waits for its mail: it is on both pages anyway.
 *
 * The mail is stored without the personal link: that is made when the mail
 * is sent, as the plaintext of an earlier link is not kept.
 */

import { db } from '@/db/client';
import { aiosMailIngesteld, verstuurAiosVerzendlijst } from '@/lib/aiosMail';
import { aiosMailBasisUrl, aiosPersoonlijkeLink } from '@/lib/aiosUitnodigen';
import { buildVerzendlijst, verzendlijstPersonen, type VerzendlijstSoort } from '@/lib/aiosVerzendlijst';

export interface AiosRuilMail {
  periodId: string;
  ruilId: string;
  soort: VerzendlijstSoort;
  /** A participant (their page link goes under the text) or a fixed codenaam such as Roosterbureau (no link). */
  aan: { personId: string } | { codenaam: string };
  onderwerp: string;
  /** Without the link. */
  tekst: string;
  /** Other codenamen the text names, for the flow's `personen`. */
  anderen?: string[];
  /** Codenamen the flow puts in the CC (the app never holds an address). */
  cc?: string[];
}

/** How long a queued mail is still worth sending. */
export const AIOS_MAIL_WACHTRIJ_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** Mails about a request that is still open: pointless once it was answered or withdrawn. */
const ALLEEN_BIJ_OPEN_RUIL = new Set<VerzendlijstSoort>(['RUILVERZOEK', 'RUIL_BEVESTIGING', 'RUIL_HERINNERING', 'RUIL_HERINNERING_BEVESTIGING']);

type Aflevering = 'VERSTUURD' | 'MISLUKT' | 'WEG';

const codenaamVan = (personId: string) =>
  (db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?').get(personId) as { codenaam: string } | undefined)?.codenaam;

async function lever(mail: AiosRuilMail): Promise<Aflevering> {
  const periode = db.prepare('SELECT naam FROM dienstrooster_schedule_period WHERE id = ?').get(mail.periodId) as { naam: string } | undefined;
  if (!periode) return 'WEG';
  let codenaam: string;
  let tekst = mail.tekst;
  if ('personId' in mail.aan) {
    const naam = codenaamVan(mail.aan.personId);
    if (!naam) return 'WEG';
    codenaam = naam;
    const basis = aiosMailBasisUrl(mail.periodId);
    if (basis) {
      tekst += `\n\nJe pagina:\n${aiosPersoonlijkeLink(mail.aan.personId, mail.periodId, basis)}\n\nDeze link is alleen voor jou. Stuur hem niet door.`;
    }
  } else {
    codenaam = mail.aan.codenaam;
  }
  const resultaat = await verstuurAiosVerzendlijst(
    buildVerzendlijst({ soort: mail.soort, automatisch: true, periode: periode.naam }, [
      {
        soort: mail.soort,
        codenaam,
        personen: verzendlijstPersonen(codenaam, [...(mail.anderen ?? []), ...(mail.cc ?? [])]),
        onderwerp: mail.onderwerp,
        tekst,
        ...(mail.cc && mail.cc.length > 0 ? { cc: mail.cc } : {}),
      },
    ])
  );
  if (!resultaat.ok) {
    console.error(`[aios-ruilmail] ${mail.soort} niet verstuurd: ${resultaat.message}`);
    return 'MISLUKT';
  }
  return 'VERSTUURD';
}

function zetInWachtrij(mail: AiosRuilMail): void {
  db.prepare(
    `INSERT INTO dienstrooster_aios_mail_queue (id, period_id, ruil_id, soort, melding_json, aangemaakt_op) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), mail.periodId, mail.ruilId, mail.soort, JSON.stringify(mail), new Date().toISOString());
}

/**
 * A request is off before its mails ever went out: drop them. Returns whether the colleague's request mail was among
 * them: then they never heard of it, and a mail saying it is off would only confuse.
 */
function laatVerzoekMailsVallen(ruilId: string): boolean {
  const weg = db
    .prepare(
      `DELETE FROM dienstrooster_aios_mail_queue
       WHERE ruil_id = ? AND soort IN ('RUILVERZOEK', 'RUIL_BEVESTIGING', 'RUIL_HERINNERING', 'RUIL_HERINNERING_BEVESTIGING')
       RETURNING soort`
    )
    .all(ruilId) as Array<{ soort: string }>;
  return weg.some((r) => r.soort === 'RUILVERZOEK');
}

/** A withdrawal waits for its request mail to be sent or queued first, so the colleague never hears of a withdrawal for a request they never got. */
const verzoekenOnderweg = new Map<string, Promise<void>>();

/** Resolves once the mail is sent, queued or skipped. Never rejects. */
export function mailAiosRuil(mail: AiosRuilMail): Promise<void> {
  const run = verstuurOfWacht(mail);
  if (mail.soort === 'RUILVERZOEK') {
    verzoekenOnderweg.set(mail.ruilId, run);
    void run.then(() => {
      if (verzoekenOnderweg.get(mail.ruilId) === run) verzoekenOnderweg.delete(mail.ruilId);
    });
  }
  return run;
}

async function verstuurOfWacht(mail: AiosRuilMail): Promise<void> {
  try {
    if (mail.soort === 'RUIL_INGETROKKEN') {
      await verzoekenOnderweg.get(mail.ruilId);
      if (laatVerzoekMailsVallen(mail.ruilId)) return;
    }
    if (!aiosMailIngesteld()) {
      zetInWachtrij(mail);
      return;
    }
    if ((await lever(mail)) === 'MISLUKT') zetInWachtrij(mail);
  } catch (error) {
    console.error(`[aios-ruilmail] ${mail.soort} mislukt`, error);
  }
}

function inPrullenbak(periodId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM dienstrooster_schedule_period WHERE id = ? AND verwijderd_op IS NOT NULL').get(periodId));
}

function nogRelevant(soort: string, ruilId: string | null): boolean {
  if (!ALLEEN_BIJ_OPEN_RUIL.has(soort as VerzendlijstSoort) || !ruilId) return true;
  const ruil = db.prepare('SELECT status FROM dienstrooster_aios_ruil WHERE id = ?').get(ruilId) as { status: string } | undefined;
  return ruil?.status === 'IN_BEHANDELING';
}

export function aiosMailWachtrijAantal(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_aios_mail_queue').get() as { n: number }).n;
}

/** What waits, for the beheerder: which kind, for whom, since when. No addresses and no texts. */
export function aiosMailWachtrij(): Array<{ soort: string; codenaam: string; sinds: string; pogingen: number; laatste_poging_op: string | null }> {
  const rijen = db
    .prepare('SELECT soort, melding_json, aangemaakt_op, pogingen, laatste_poging_op FROM dienstrooster_aios_mail_queue ORDER BY aangemaakt_op, rowid')
    .all() as Array<{ soort: string; melding_json: string; aangemaakt_op: string; pogingen: number; laatste_poging_op: string | null }>;
  return rijen.map((r) => {
    const mail = JSON.parse(r.melding_json) as AiosRuilMail;
    const codenaam = 'personId' in mail.aan ? (codenaamVan(mail.aan.personId) ?? '') : mail.aan.codenaam;
    return { soort: r.soort, codenaam, sinds: r.aangemaakt_op, pogingen: r.pogingen, laatste_poging_op: r.laatste_poging_op };
  });
}

let bezig = false;
let huidigeRun: Promise<unknown> = Promise.resolve();

/** Resolves once no flush is running. For tests, which clean up after themselves. */
export function aiosMailWachtrijKlaar(): Promise<unknown> {
  return huidigeRun;
}

/** Drops what is too old or no longer applies. Runs also while sending isn't set up, so the count stays honest. */
function ruimOp(now: Date): number {
  const rijen = db.prepare('SELECT id, ruil_id, soort, aangemaakt_op FROM dienstrooster_aios_mail_queue').all() as Array<{
    id: string;
    ruil_id: string | null;
    soort: string;
    aangemaakt_op: string;
  }>;
  const weg = db.prepare('DELETE FROM dienstrooster_aios_mail_queue WHERE id = ?');
  let aantal = 0;
  for (const r of rijen) {
    if (now.getTime() - Date.parse(r.aangemaakt_op) > AIOS_MAIL_WACHTRIJ_MAX_MS || !nogRelevant(r.soort, r.ruil_id)) {
      weg.run(r.id);
      aantal++;
    }
  }
  return aantal;
}

/**
 * Drops what is too old or no longer applies, then sends what is left, oldest first. Stops at the first failure
 * (the mail server is still refusing; the next run tries again). One run at a time.
 */
export function flushAiosMailWachtrij(now: Date = new Date()): Promise<{ verstuurd: number; vervallen: number; over: number }> {
  if (bezig) return Promise.resolve({ verstuurd: 0, vervallen: 0, over: aiosMailWachtrijAantal() });
  bezig = true;
  const run = voerFlushUit(now).finally(() => {
    bezig = false;
  });
  huidigeRun = run.catch(() => {});
  return run;
}

async function voerFlushUit(now: Date): Promise<{ verstuurd: number; vervallen: number; over: number }> {
  const uitkomst = { verstuurd: 0, vervallen: 0, over: 0 };
  try {
    uitkomst.vervallen = ruimOp(now);
    if (!aiosMailIngesteld()) return uitkomst;
    const rijen = db
      .prepare('SELECT id, melding_json FROM dienstrooster_aios_mail_queue ORDER BY aangemaakt_op, rowid')
      .all() as Array<{ id: string; melding_json: string }>;
    const weg = db.prepare('DELETE FROM dienstrooster_aios_mail_queue WHERE id = ?');
    for (const r of rijen) {
      // Checked again per mail: an answer given while this run was sending the ones before makes a request mail pointless.
      const nu = db.prepare('SELECT ruil_id, soort, period_id FROM dienstrooster_aios_mail_queue WHERE id = ?').get(r.id) as
        | { ruil_id: string | null; soort: string; period_id: string }
        | undefined;
      if (!nu) continue;
      if (!nogRelevant(nu.soort, nu.ruil_id)) {
        weg.run(r.id);
        uitkomst.vervallen++;
        continue;
      }
      // A period in the prullenbak is closed to its AIOS, the link in the mail too: the mail waits until the period
      // is back, and goes with it when it is purged (0.905.1, as the achterwacht's lib/meldingMail.ts).
      if (inPrullenbak(nu.period_id)) continue;
      db.prepare('UPDATE dienstrooster_aios_mail_queue SET pogingen = pogingen + 1, laatste_poging_op = ? WHERE id = ?').run(now.toISOString(), r.id);
      const aflevering = await lever(JSON.parse(r.melding_json) as AiosRuilMail);
      if (aflevering === 'MISLUKT') break;
      weg.run(r.id);
      if (aflevering === 'VERSTUURD') uitkomst.verstuurd++;
    }
  } catch (error) {
    console.error('[aios-ruilmail] wachtrij versturen mislukt', error);
  } finally {
    uitkomst.over = aiosMailWachtrijAantal();
  }
  return uitkomst;
}

/** Called by lib/aiosMail.ts after every successful send: sending works, so what waited goes too. */
export function flushAiosNaVerzending(): void {
  if (!bezig && aiosMailWachtrijAantal() > 0) void flushAiosMailWachtrij();
}

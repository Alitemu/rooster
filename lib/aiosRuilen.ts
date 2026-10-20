/**
 * Swapping between AIOS (docs/aios-rooster.md, "Ruilen"): without the
 * planner (L1, L2), the colleague says yes or no. What can be swapped, as
 * the planner put it in October 2026:
 *
 * - A block stays whole: an avond- or nachtblok zo t/m di or wo t/m vr for
 *   one of the same soort and vorm. The block of four is its wo t/m vr
 *   block and the Saturday, swapped apart; the two dagdiensten of a weekend
 *   are two single diensten.
 * - A single dienst for an equal one: a dagdienst and an evening at the
 *   weekend (the Saturday's, or one of a block cut up around feestdagen)
 *   are equal to each other; a night for a night, an evening in the week
 *   for one, an uitloopdienst for one. A block another AIOS has a day of is
 *   no longer a block: its diensten are single.
 * - Not if it breaks a hard rule for either of them (L3; lib/aiosRegels.ts,
 *   inwerken included, L5); above 25% may (L4). Their own blocks by hand
 *   are theirs to give up. Not for a dienst that has been.
 *
 * Only on a definitief roster: a voorlopig one is for checking, and the
 * planner puts right what is wrong before anyone swaps. A request that can
 * never go through any more (a dienst of it went to someone else, the
 * planner changed the roster, the roster stopped being definitief) is
 * INGETROKKEN: there is no status vervallen.
 *
 * The AIOS's own copy of the achterwacht's swaps (app/api/person/.../
 * swap-requests, lib/swapLifecycle.ts), not a change to it
 * (docs/development/diensten.md, "Copied, not changed"): its own table,
 * statuses and words. Mail goes through the AIOS's flow after the commit,
 * not awaited, in a queue of its own when it can't go out
 * (lib/aiosRuilMail.ts): a request anonymous by mail until it goes through,
 * as there; then the Roosterbureau is told with the two who swapped and the
 * Planner in the CC (RUIL_DOORGEVEN). A reminder after 6 to 7 days, or by
 * hand, with a bericht to the requester that it was sent (lib/aiosRuilen.ts
 * herinnerAiosRuil).
 */

import { randomUUID } from 'crypto';
import { aiosIsDefinitief } from '@/lib/aiosDefinitief';
import { db } from '@/db/client';
import type { VerzendlijstSoort } from '@/lib/aiosVerzendlijst';
import { formatSwapDate } from '@/lib/aiosTeksten';
import { aiosContactAdres, aiosMailIngesteld } from '@/lib/aiosMail';
import { mailAiosRuil } from '@/lib/aiosRuilMail';
import { type AiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import { aiosSolverInvoer, type AiosSolverInvoer } from '@/lib/aiosSolverInvoer';
import { nieuweOvertredingen, regelZin, type Regel } from '@/lib/aiosRegels';
import { BLOK_VORM_LABELS, type BlokSoort, type BlokVorm } from '@/lib/aiosDiensten';
import { writeAuditLog } from '@/lib/auditLog';

export const RUIL_MAX_TOELICHTING = 200;

// A swap's own choices: the AIOS takes on what they blocked by hand themselves.
const EIGEN_KEUZE: ReadonlySet<Regel> = new Set(['1_GEBLOKKEERD', '1_MEER_DAN_HET_DEEL_BOVEN_DE_HELFT']);

export interface Eenheid {
  id: string; // blok:<block id> or dienst:<slot id>
  sleutel: string; // equal ones share it
  naam: string; // "Nachtblok zo t/m di" or "Dagdienst"
  van: string;
  tot: string;
  diensten: string[];
  houder: string;
}

type Rooster = Map<string, string>;

interface Slot {
  id: string;
  datum: string;
  code: string;
  blok_id: string | null;
  soort: BlokSoort | null;
  vorm: BlokVorm | null;
  opgeknipt: number | null;
}

function slotsVan(periodId: string): Slot[] {
  return db
    .prepare(
      `SELECT sl.id, sl.datum, st.code, b.id AS blok_id, b.soort, b.vorm, bk.opknippen AS opgeknipt
       FROM dienstrooster_shift_slot sl
       JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       LEFT JOIN dienstrooster_shift_block b ON b.id = sl.shift_block_id
       LEFT JOIN dienstrooster_aios_blokkeuze bk ON bk.blok_id = b.id AND bk.period_id = sl.period_id
       WHERE sl.period_id = ? AND st.code IS NOT NULL
       ORDER BY sl.datum, st.start_tijd`
    )
    .all(periodId) as Slot[];
}

function huidigRooster(periodId: string): Rooster {
  return new Map(
    (
      db.prepare('SELECT slot_id, person_id FROM dienstrooster_assignment WHERE schedule_version_id = ?').all(periodId) as Array<{
        slot_id: string;
        person_id: string;
      }>
    ).map((r) => [r.slot_id, r.person_id])
  );
}

const CODE_NAAM: Record<string, string> = {
  UD: 'Uitloopdienst',
  DD: 'Dagdienst',
  AD: 'Avonddienst',
  ADW: 'Avonddienst weekend',
  ND: 'Nachtdienst',
};

/** Which single diensten are equal: a dagdienst and an evening at the weekend count the same (1 point). */
export function losseSleutel(code: string): string {
  if (code === 'DD' || code === 'ADW') return 'DAG_OF_WEEKENDAVOND';
  if (code === 'ND') return 'NACHT';
  if (code === 'AD') return 'AVOND';
  return 'UITLOOP';
}

/** Every eenheid with an AIOS: a whole block one AIOS has, or a single dienst. */
export function aiosEenheden(slots: readonly Slot[], rooster: ReadonlyMap<string, string>): Eenheid[] {
  const uit: Eenheid[] = [];
  const perBlok = new Map<string, Slot[]>();
  const los: Slot[] = [];
  for (const s of slots) {
    // A Saturday, and a block cut up around feestdagen, are single diensten.
    if (s.blok_id && (s.vorm === 'ZO_DI' || s.vorm === 'WO_VR') && !s.opgeknipt) {
      if (!perBlok.has(s.blok_id)) perBlok.set(s.blok_id, []);
      perBlok.get(s.blok_id)!.push(s);
    } else los.push(s);
  }
  for (const [blokId, bs] of perBlok) {
    const houders = new Set(bs.map((s) => rooster.get(s.id) ?? null));
    const houder = [...houders][0];
    if (houders.size === 1 && houder) {
      uit.push({
        id: `blok:${blokId}`,
        sleutel: `BLOK_${bs[0].soort}_${bs[0].vorm}`,
        naam: `${bs[0].soort === 'AVOND' ? 'Avondblok' : 'Nachtblok'} ${BLOK_VORM_LABELS[bs[0].vorm!]}`,
        van: bs[0].datum,
        tot: bs[bs.length - 1].datum,
        diensten: bs.map((s) => s.id),
        houder,
      });
    } else los.push(...bs);
  }
  for (const s of los) {
    const houder = rooster.get(s.id);
    if (!houder) continue;
    uit.push({ id: `dienst:${s.id}`, sleutel: losseSleutel(s.code), naam: CODE_NAAM[s.code], van: s.datum, tot: s.datum, diensten: [s.id], houder });
  }
  return uit.sort((a, b) => a.van.localeCompare(b.van) || a.naam.localeCompare(b.naam));
}

/** Local calendar date, as the slots' dates are stored. */
function vandaag(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

interface Stand {
  slots: Slot[];
  rooster: Rooster;
  eenheden: Eenheid[];
  invoer: AiosSolverInvoer;
}

function stand(period: AiosUitnodigPeriode): Stand {
  const slots = slotsVan(period.id);
  const rooster = huidigRooster(period.id);
  return { slots, rooster, eenheden: aiosEenheden(slots, rooster), invoer: aiosSolverInvoer(period, 60) };
}

function na(rooster: Rooster, a: Eenheid, b: Eenheid): Rooster {
  const uit = new Map(rooster);
  for (const id of a.diensten) uit.set(id, b.houder);
  for (const id of b.diensten) uit.set(id, a.houder);
  return uit;
}

/** What the swap breaks of the hard rules, for either of them, in words; empty when it may. */
function breekt(s: Stand, a: Eenheid, b: Eenheid): string[] {
  const daarna = na(s.rooster, a, b);
  const regels = [a.houder, b.houder].flatMap((wie) => nieuweOvertredingen(s.invoer, s.rooster, daarna, wie, EIGEN_KEUZE).map((o) => o[0]));
  return [...new Set(regels)].map(regelZin);
}

export interface EenheidUit {
  id: string;
  naam: string;
  van: string;
  tot: string;
}

const uitgeschreven = (e: Eenheid): EenheidUit => ({ id: e.id, naam: e.naam, van: e.van, tot: e.tot });

function codenamen(ids: string[]): Map<string, string> {
  if (ids.length === 0) return new Map();
  return new Map(
    (
      db.prepare(`SELECT id, codenaam FROM dienstrooster_person WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{
        id: string;
        codenaam: string;
      }>
    ).map((p) => [p.id, p.codenaam])
  );
}

export interface Kandidaat {
  eenheid: EenheidUit;
  collega: { id: string; codenaam: string };
}

/** For one of the AIOS's own eenheden, every equal one of a colleague they could swap it for. */
export function aiosRuilKandidaten(period: AiosUitnodigPeriode, personId: string, eenheidId: string, now = new Date()): Kandidaat[] | null {
  const s = stand(period);
  const mijn = s.eenheden.find((e) => e.id === eenheidId && e.houder === personId);
  const dag = vandaag(now);
  if (!mijn || mijn.van < dag) return null;
  const opties = s.eenheden.filter((e) => e.houder !== personId && e.sleutel === mijn.sleutel && e.van >= dag && breekt(s, mijn, e).length === 0);
  const naam = codenamen([...new Set(opties.map((e) => e.houder))]);
  return opties.map((e) => ({ eenheid: uitgeschreven(e), collega: { id: e.houder, codenaam: naam.get(e.houder) ?? e.houder } }));
}

export type RuilStatus = 'IN_BEHANDELING' | 'GOEDGEKEURD' | 'AFGEWEZEN' | 'INGETROKKEN';

interface RuilRij {
  id: string;
  period_id: string;
  aanvrager_id: string;
  respondent_id: string;
  aangeboden_json: string;
  gevraagd_json: string;
  status: RuilStatus;
  toelichting: string | null;
  reden_afwijzing: string | null;
  aangemaakt_op: string;
  beantwoord_op: string | null;
  gezien_op: string | null;
  laatste_herinnering_op: string | null;
  laatste_herinnering_door: HerinneringDoor | null;
}

export type HerinneringDoor = 'AUTOMATISCH' | 'AANVRAGER' | 'PLANNER';

const lijstVan = (json: string) => JSON.parse(json) as string[];

export const ROOSTER_AANGEPAST_REDEN = 'Het rooster is aangepast.';
export const AL_GERUILD_REDEN = 'De dienst is al met een andere collega geruild.';
export const AL_ONDERLING_GERUILD_REDEN = 'Jullie hebben die dienst intussen via een ander ruilverzoek al met elkaar geruild.';
export const DERDE_REDEN = 'Een van de diensten is intussen al met iemand anders geruild.';

export interface IngetrokkenRuil {
  r: RuilRij;
  reden: string;
  /** The requester is told as well: not when they took part in the swap that closed it. */
  aanvragerOok: boolean;
}

/**
 * Open requests that can never go through any more: one of their diensten
 * is with someone else now (a swap, the planner by hand). Withdrawn
 * (INGETROKKEN) with the reason; the caller mails them after its
 * transaction (meldAiosRuilenIngetrokken).
 */
export function trekOnmogelijkeAiosRuilenIn(
  periodId: string,
  now = new Date(),
  kies: (r: RuilRij) => { reden: string; aanvragerOok: boolean } = () => ({ reden: ROOSTER_AANGEPAST_REDEN, aanvragerOok: true })
): IngetrokkenRuil[] {
  const rooster = huidigRooster(periodId);
  const open = db.prepare(`SELECT * FROM dienstrooster_aios_ruil WHERE period_id = ? AND status = 'IN_BEHANDELING'`).all(periodId) as RuilRij[];
  const weg = open.filter(
    (r) =>
      lijstVan(r.aangeboden_json).some((id) => rooster.get(id) !== r.aanvrager_id) ||
      lijstVan(r.gevraagd_json).some((id) => rooster.get(id) !== r.respondent_id)
  );
  return zetIngetrokken(weg, now, kies);
}

/** The roster stops being definitief (the publication is taken back): nothing open can go through any more. */
export function trekAlleOpenAiosRuilenIn(periodId: string, now = new Date()): IngetrokkenRuil[] {
  const open = db.prepare(`SELECT * FROM dienstrooster_aios_ruil WHERE period_id = ? AND status = 'IN_BEHANDELING'`).all(periodId) as RuilRij[];
  return zetIngetrokken(open, now, () => ({ reden: ROOSTER_AANGEPAST_REDEN, aanvragerOok: true }));
}

function zetIngetrokken(rijen: RuilRij[], now: Date, kies: (r: RuilRij) => { reden: string; aanvragerOok: boolean }): IngetrokkenRuil[] {
  const zet = db.prepare(
    `UPDATE dienstrooster_aios_ruil SET status = 'INGETROKKEN', beantwoord_op = ?, reden_afwijzing = ? WHERE id = ? AND status = 'IN_BEHANDELING'`
  );
  return rijen.map((r) => {
    const k = kies(r);
    zet.run(now.toISOString(), k.reden, r.id);
    return { r, ...k };
  });
}

function beschrijf(ids: string[], slots: Map<string, Slot>): EenheidUit {
  const ds = ids.map((id) => slots.get(id)).filter((s): s is Slot => !!s);
  const eerste = ds[0];
  const blok = eerste && ds.length > 1 && eerste.soort && eerste.vorm;
  return {
    id: ids.join(','),
    naam: blok ? `${eerste.soort === 'AVOND' ? 'Avondblok' : 'Nachtblok'} ${BLOK_VORM_LABELS[eerste.vorm!]}` : eerste ? CODE_NAAM[eerste.code] : 'Dienst',
    van: eerste?.datum ?? '',
    tot: ds[ds.length - 1]?.datum ?? '',
  };
}

export interface RuilUit {
  id: string;
  status: RuilStatus;
  aanvrager: string;
  respondent: string;
  aangeboden: EenheidUit;
  gevraagd: EenheidUit;
  toelichting: string | null;
  reden_afwijzing: string | null;
  aangemaakt_op: string;
  beantwoord_op: string | null;
  /** When the colleague opened their requests on their own page: the planner's "gelezen". */
  gezien_op: string | null;
  laatste_herinnering_op: string | null;
  laatste_herinnering_door: HerinneringDoor | null;
}

function uitRijen(periodId: string, rijen: RuilRij[]): RuilUit[] {
  const slots = new Map(slotsVan(periodId).map((s) => [s.id, s]));
  const naam = codenamen([...new Set(rijen.flatMap((r) => [r.aanvrager_id, r.respondent_id]))]);
  return rijen.map((r) => ({
    id: r.id,
    status: r.status,
    aanvrager: naam.get(r.aanvrager_id) ?? r.aanvrager_id,
    respondent: naam.get(r.respondent_id) ?? r.respondent_id,
    aangeboden: beschrijf(lijstVan(r.aangeboden_json), slots),
    gevraagd: beschrijf(lijstVan(r.gevraagd_json), slots),
    toelichting: r.toelichting,
    reden_afwijzing: r.reden_afwijzing,
    aangemaakt_op: r.aangemaakt_op,
    beantwoord_op: r.beantwoord_op,
    gezien_op: r.gezien_op,
    laatste_herinnering_op: r.laatste_herinnering_op,
    laatste_herinnering_door: r.laatste_herinnering_door,
  }));
}

/** An AIOS's swap page: their own eenheden still to come, and the requests from and to them. */
export function aiosRuilOverzicht(
  period: AiosUitnodigPeriode,
  personId: string,
  now = new Date()
): { ruilen_kan: boolean; contact_planner: string | null; eenheden: EenheidUit[]; uit: RuilUit[]; in: RuilUit[] } {
  meldAiosRuilenIngetrokken(period, trekOnmogelijkeAiosRuilenIn(period.id, now));
  const s = stand(period);
  const dag = vandaag(now);
  // They opened their requests: what the planner reads as "gelezen".
  db.prepare(`UPDATE dienstrooster_aios_ruil SET gezien_op = ? WHERE period_id = ? AND respondent_id = ? AND gezien_op IS NULL`).run(
    now.toISOString(),
    period.id,
    personId
  );
  const rijen = db
    .prepare('SELECT * FROM dienstrooster_aios_ruil WHERE period_id = ? AND (aanvrager_id = ? OR respondent_id = ?) ORDER BY aangemaakt_op DESC')
    .all(period.id, personId, personId) as RuilRij[];
  const alle = uitRijen(period.id, rijen);
  const kan = ruilenKan(period);
  return {
    // A voorlopig roster: the page says so, nothing can be swapped yet.
    ruilen_kan: kan,
    contact_planner: aiosContactAdres(),
    eenheden: kan ? s.eenheden.filter((e) => e.houder === personId && e.van >= dag).map(uitgeschreven) : [],
    uit: alle.filter((_, i) => rijen[i].aanvrager_id === personId),
    in: alle.filter((_, i) => rijen[i].respondent_id === personId),
  };
}

/** The planner's view: every request of the period. */
export function aiosRuilenVoorPlanner(period: AiosUitnodigPeriode, now = new Date()): RuilUit[] {
  meldAiosRuilenIngetrokken(period, trekOnmogelijkeAiosRuilenIn(period.id, now));
  return uitRijen(
    period.id,
    db.prepare('SELECT * FROM dienstrooster_aios_ruil WHERE period_id = ? ORDER BY aangemaakt_op DESC').all(period.id) as RuilRij[]
  );
}

export type RuilUitkomst =
  | { ok: true; id: string; mail: boolean }
  | { ok: false; status: number; code: string; message: string; laatste_herinnering_op?: string | null };

const nee = (status: number, code: string, message: string, laatste?: string | null): RuilUitkomst => ({
  ok: false,
  status,
  code,
  message,
  ...(laatste !== undefined ? { laatste_herinnering_op: laatste } : {}),
});

/** What a participant reads when the roster is still voorlopig. The planner's address is added on the page. */
export const NOG_VOORLOPIG = 'Ruilen kan pas als het rooster definitief is. Klopt er iets niet in je voorlopige rooster? Meld dat bij de planner.';

/** Swapping needs a published roster that is definitief. */
export const ruilenKan = (period: AiosUitnodigPeriode): boolean => period.status === 'GEPUBLICEERD' && aiosIsDefinitief(period.id);

// ---- mail -------------------------------------------------------------------

const dienstTekst = (e: EenheidUit) =>
  e.van === e.tot ? `${e.naam.toLowerCase()} op ${formatSwapDate(e.van)}` : `${e.naam.toLowerCase()} van ${formatSwapDate(e.van)} tot en met ${formatSwapDate(e.tot)}`;

/** After the commit, not awaited: a mail that fails changes nothing about the swap. Whether the mail is set up is what the caller reports. */
function stuur(
  period: AiosUitnodigPeriode,
  ruilId: string,
  soort: VerzendlijstSoort,
  aan: { personId: string } | { codenaam: string },
  onderwerp: string,
  tekst: string,
  opties: { anderen?: string[]; cc?: string[] } = {}
): boolean {
  void mailAiosRuil({ periodId: period.id, ruilId, soort, aan, onderwerp, tekst, ...opties });
  return aiosMailIngesteld();
}

/** What the Planner and the Roosterbureau are mailed about a swap that went through. */
export const DOORGEVEN_AAN = 'Roosterbureau';
export const DOORGEVEN_CC_PLANNER = 'Planner';

const slotMap = (periodId: string) => new Map(slotsVan(periodId).map((x) => [x.id, x]));

/** Tells those involved their request is off, after the transaction that withdrew it. */
export function meldAiosRuilenIngetrokken(period: AiosUitnodigPeriode, rijen: IngetrokkenRuil[]): void {
  if (rijen.length === 0) return;
  const naam = codenamen([...new Set(rijen.flatMap((x) => [x.r.aanvrager_id, x.r.respondent_id]))]);
  const slots = slotMap(period.id);
  for (const { r, reden, aanvragerOok } of rijen) {
    const bied = dienstTekst(beschrijf(lijstVan(r.aangeboden_json), slots));
    const vraag = dienstTekst(beschrijf(lijstVan(r.gevraagd_json), slots));
    const collega = naam.get(r.respondent_id)!;
    stuur(
      period,
      r.id,
      'RUIL_INGETROKKEN',
      { personId: r.respondent_id },
      'Ruilverzoek ingetrokken',
      `Beste ${collega},\n\nEen ruilverzoek aan jou is ingetrokken. ${reden} Je hoeft niets meer te doen. Je rooster blijft zoals het was.\n\nJij zou geven: ${vraag}\nJij zou krijgen: ${bied}`
    );
    if (aanvragerOok) {
      const aanvrager = naam.get(r.aanvrager_id)!;
      stuur(
        period,
        r.id,
        'RUIL_UITKOMST',
        { personId: r.aanvrager_id },
        'Je ruilverzoek is ingetrokken',
        `Beste ${aanvrager},\n\nJe ruilverzoek is ingetrokken. ${reden} Je rooster blijft zoals het was.\n\nJe bood aan: ${bied}\nJe vroeg: ${vraag}`
      );
    }
  }
}

// ---- the steps --------------------------------------------------------------

/** A request: one of the AIOS's own eenheden for an equal one of a colleague's. */
export function vraagAiosRuilAan(
  period: AiosUitnodigPeriode,
  personId: string,
  aangebodenId: unknown,
  gevraagdId: unknown,
  toelichtingIn: unknown,
  now = new Date()
): RuilUitkomst {
  if (!ruilenKan(period)) return nee(409, 'NOT_DEFINITIEF', NOG_VOORLOPIG);
  if (typeof aangebodenId !== 'string' || typeof gevraagdId !== 'string') return nee(400, 'VALIDATION_ERROR', 'Kies wat je aanbiedt en wat je ervoor wilt.');
  if (toelichtingIn !== undefined && toelichtingIn !== null && typeof toelichtingIn !== 'string') {
    return nee(400, 'VALIDATION_ERROR', 'De toelichting moet tekst zijn.');
  }
  const toelichting = typeof toelichtingIn === 'string' && toelichtingIn.trim() ? toelichtingIn.trim().slice(0, RUIL_MAX_TOELICHTING) : null;
  const s = stand(period);
  const mijn = s.eenheden.find((e) => e.id === aangebodenId);
  const hun = s.eenheden.find((e) => e.id === gevraagdId);
  if (!mijn || mijn.houder !== personId) return nee(400, 'VALIDATION_ERROR', 'Dit is niet (meer) jouw dienst.');
  if (!hun || hun.houder === personId) return nee(400, 'VALIDATION_ERROR', 'Die dienst is niet (meer) van een collega.');
  if (mijn.sleutel !== hun.sleutel) return nee(400, 'NOT_EQUAL', 'Ruilen kan alleen tegen een gelijkwaardige dienst of een blok van dezelfde soort.');
  const dag = vandaag(now);
  if (mijn.van < dag || hun.van < dag) return nee(400, 'IN_PAST', 'Ruilen kan niet meer voor een dienst die al geweest is.');
  const regels = breekt(s, mijn, hun);
  if (regels.length > 0) return nee(409, 'HARD_RULE', `Deze ruil kan niet: ${regels.join(' ').replace(/\.$/, '')}.`);
  const bestaand = db
    .prepare(`SELECT 1 FROM dienstrooster_aios_ruil WHERE period_id = ? AND status = 'IN_BEHANDELING' AND aangeboden_json = ? AND gevraagd_json = ?`)
    .get(period.id, JSON.stringify(mijn.diensten), JSON.stringify(hun.diensten));
  if (bestaand) return nee(409, 'DUPLICATE', 'Dit ruilverzoek heb je al gedaan.');

  const id = randomUUID();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO dienstrooster_aios_ruil
         (id, period_id, aanvrager_id, respondent_id, aangeboden_json, gevraagd_json, status, toelichting, aangemaakt_op)
       VALUES (?, ?, ?, ?, ?, ?, 'IN_BEHANDELING', ?, ?)`
    ).run(id, period.id, personId, hun.houder, JSON.stringify(mijn.diensten), JSON.stringify(hun.diensten), toelichting, now.toISOString());
    writeAuditLog({ actorId: personId, entiteit: 'aios_ruil', entiteitId: id, actie: 'CREATE', nieuw: { status: 'IN_BEHANDELING', aangeboden: mijn.id, gevraagd: hun.id } });
  })();
  const naam = codenamen([personId, hun.houder]);
  const a = uitgeschreven(mijn);
  const b = uitgeschreven(hun);
  const extra = toelichting ? `\n\nToelichting: ${toelichting}` : '';
  // Anonymous until it goes through: the colleague can say no without knowing to whom.
  const mail = stuur(
    period,
    id,
    'RUILVERZOEK',
    { personId: hun.houder },
    'Nieuw ruilverzoek AIOS',
    `Beste ${naam.get(hun.houder)},\n\nEen collega vraagt je om te ruilen in het rooster van de AIOS voor ${period.naam}.\n\nJij geeft: ${dienstTekst(b)}\nJij krijgt: ${dienstTekst(a)}${extra}\n\nKeur het goed of wijs het af op je pagina.`
  );
  stuur(
    period,
    id,
    'RUIL_BEVESTIGING',
    { personId },
    'Je ruilverzoek is verstuurd',
    `Beste ${naam.get(personId)},\n\nJe ruilverzoek is verstuurd.\n\nJij geeft: ${dienstTekst(a)}\nJij krijgt: ${dienstTekst(b)}\n\nJe krijgt bericht zodra je collega heeft gereageerd. Tot die tijd blijft je rooster zoals het is.`
  );
  return { ok: true, id, mail };
}

function laadRuil(periodId: string, ruilId: unknown): RuilRij | undefined {
  if (typeof ruilId !== 'string') return undefined;
  return db.prepare('SELECT * FROM dienstrooster_aios_ruil WHERE id = ? AND period_id = ?').get(ruilId, periodId) as RuilRij | undefined;
}

/** The colleague says yes: the diensten change hands, if they still can. */
export function keurAiosRuilGoed(period: AiosUitnodigPeriode, personId: string, ruilId: unknown, now = new Date()): RuilUitkomst {
  if (!ruilenKan(period)) return nee(409, 'NOT_DEFINITIEF', NOG_VOORLOPIG);
  const r = laadRuil(period.id, ruilId);
  if (!r || r.respondent_id !== personId) return nee(404, 'NOT_FOUND', 'Ruilverzoek niet gevonden.');
  meldAiosRuilenIngetrokken(period, trekOnmogelijkeAiosRuilenIn(period.id, now));
  const nu = laadRuil(period.id, ruilId)!;
  if (nu.status === 'INGETROKKEN') return nee(409, 'WITHDRAWN', 'Dit ruilverzoek is ingetrokken.');
  if (nu.status !== 'IN_BEHANDELING') return nee(409, 'HANDLED', 'Dit ruilverzoek is al afgehandeld.');
  const s = stand(period);
  const aangeboden = lijstVan(r.aangeboden_json);
  const gevraagd = lijstVan(r.gevraagd_json);
  const a = { id: '', sleutel: '', naam: '', van: '', tot: '', diensten: aangeboden, houder: r.aanvrager_id };
  const b = { id: '', sleutel: '', naam: '', van: '', tot: '', diensten: gevraagd, houder: r.respondent_id };
  const dag = vandaag(now);
  const datum = new Map(s.slots.map((x) => [x.id, x.datum]));
  if ([...aangeboden, ...gevraagd].some((id) => (datum.get(id) ?? '') < dag)) {
    return nee(409, 'IN_PAST', 'Ruilen kan niet meer voor een dienst die al geweest is.');
  }
  const regels = breekt(s, a, b);
  if (regels.length > 0) return nee(409, 'HARD_RULE', `Deze ruil kan nu niet meer: ${regels.join(' ').replace(/\.$/, '')}. Wijs hem af.`);

  const op = now.toISOString();
  const partijen = [r.aanvrager_id, r.respondent_id];
  let gesloten: IngetrokkenRuil[] = [];
  db.transaction(() => {
    const zet = db.prepare(`UPDATE dienstrooster_assignment SET person_id = ?, bron = 'MANUAL' WHERE schedule_version_id = ? AND slot_id = ?`);
    const edit = db.prepare(
      `INSERT INTO dienstrooster_assignment_edit
         (id, toewijzing_id, periode_id, person_id, slot_id, edit_type, oorspronkelijke_person_id, reden, bewerkt_door_person_id, aangemaakt_op, row_version)
       VALUES (?, (SELECT id FROM dienstrooster_assignment WHERE schedule_version_id = ? AND slot_id = ?), ?, ?, ?, 'RUIL', ?, 'ruil tussen AIOS', ?, ?, 1)`
    );
    for (const id of aangeboden) {
      zet.run(r.respondent_id, period.id, id);
      edit.run(randomUUID(), period.id, id, period.id, r.respondent_id, id, r.aanvrager_id, personId, op);
    }
    for (const id of gevraagd) {
      zet.run(r.aanvrager_id, period.id, id);
      edit.run(randomUUID(), period.id, id, period.id, r.aanvrager_id, id, r.respondent_id, personId, op);
    }
    const klaar = db
      .prepare(`UPDATE dienstrooster_aios_ruil SET status = 'GOEDGEKEURD', beantwoord_op = ?, gezien_op = COALESCE(gezien_op, ?) WHERE id = ? AND status = 'IN_BEHANDELING'`)
      .run(op, op, r.id);
    if (klaar.changes !== 1) throw new Error('aios swap handled meanwhile');
    writeAuditLog({ actorId: personId, entiteit: 'aios_ruil', entiteitId: r.id, actie: 'APPROVE', oud: { status: 'IN_BEHANDELING' }, nieuw: { status: 'GOEDGEKEURD' } });
    // Others asking for these diensten can never go through now: withdrawn.
    gesloten = trekOnmogelijkeAiosRuilenIn(period.id, now, (x) =>
      partijen.includes(x.aanvrager_id)
        ? { reden: partijen.includes(x.respondent_id) ? AL_ONDERLING_GERUILD_REDEN : AL_GERUILD_REDEN, aanvragerOok: false }
        : { reden: DERDE_REDEN, aanvragerOok: true }
    );
  })();
  meldAiosRuilenIngetrokken(period, gesloten);
  const naam = codenamen([r.aanvrager_id, r.respondent_id]);
  const slots = slotMap(period.id);
  const ua = beschrijf(aangeboden, slots);
  const ub = beschrijf(gevraagd, slots);
  const aanvrager = naam.get(r.aanvrager_id)!;
  const collega = naam.get(r.respondent_id)!;
  const eigenIngetrokken = gesloten.filter((x) => x.r.aanvrager_id === r.aanvrager_id).length;
  const ingetrokkenRegel =
    eigenIngetrokken === 0
      ? ''
      : eigenIngetrokken === 1
        ? '\n\nJe andere ruilverzoek voor deze dienst is ingetrokken.'
        : `\n\nJe ${eigenIngetrokken} andere ruilverzoeken voor deze dienst zijn ingetrokken.`;
  const mail = stuur(
    period,
    r.id,
    'RUIL_UITKOMST',
    { personId: r.aanvrager_id },
    'Je ruil is goedgekeurd',
    `Beste ${aanvrager},\n\n${collega} heeft je ruil goedgekeurd. Je rooster is aangepast.\n\nJij gaf: ${dienstTekst(ua)}\nJij kreeg: ${dienstTekst(ub)}${ingetrokkenRegel}\n\nHet Roosterbureau en de planner zijn hiervan op de hoogte gebracht.`,
    { anderen: [collega] }
  );
  // The colleague who approved gets a confirmation as well.
  stuur(
    period,
    r.id,
    'RUIL_UITKOMST',
    { personId: r.respondent_id },
    'Je hebt een ruil goedgekeurd',
    `Beste ${collega},\n\nJe hebt het ruilverzoek van ${aanvrager} goedgekeurd. Je rooster is aangepast.\n\nJij gaf: ${dienstTekst(ub)}\nJij kreeg: ${dienstTekst(ua)}\n\nHet Roosterbureau en de planner zijn hiervan op de hoogte gebracht.`,
    { anderen: [aanvrager] }
  );
  // One bericht to the Roosterbureau, with the two who swapped and the Planner in the CC (the flow looks them up).
  stuur(
    period,
    r.id,
    'RUIL_DOORGEVEN',
    { codenaam: DOORGEVEN_AAN },
    `Ruil in het rooster van de AIOS ${period.naam}`,
    `Twee AIOS hebben geruild in het rooster voor ${period.naam}.\n\n${collega} doet nu: ${dienstTekst(ua)}\n${aanvrager} doet nu: ${dienstTekst(ub)}`,
    { anderen: [aanvrager, collega], cc: [aanvrager, collega, DOORGEVEN_CC_PLANNER] }
  );
  return { ok: true, id: r.id, mail };
}

/** The colleague says no, with a reason if they like. */
export function wijsAiosRuilAf(period: AiosUitnodigPeriode, personId: string, ruilId: unknown, redenIn: unknown, now = new Date()): RuilUitkomst {
  const r = laadRuil(period.id, ruilId);
  if (!r || r.respondent_id !== personId) return nee(404, 'NOT_FOUND', 'Ruilverzoek niet gevonden.');
  if (redenIn !== undefined && redenIn !== null && typeof redenIn !== 'string') return nee(400, 'VALIDATION_ERROR', 'De reden moet tekst zijn.');
  if (r.status !== 'IN_BEHANDELING') return nee(409, 'HANDLED', 'Dit ruilverzoek is al afgehandeld.');
  const reden = typeof redenIn === 'string' && redenIn.trim() ? redenIn.trim().slice(0, RUIL_MAX_TOELICHTING) : null;
  db.transaction(() => {
    db.prepare(
      `UPDATE dienstrooster_aios_ruil SET status = 'AFGEWEZEN', reden_afwijzing = ?, beantwoord_op = ?, gezien_op = COALESCE(gezien_op, ?) WHERE id = ?`
    ).run(reden, now.toISOString(), now.toISOString(), r.id);
    writeAuditLog({ actorId: personId, entiteit: 'aios_ruil', entiteitId: r.id, actie: 'REJECT', oud: { status: 'IN_BEHANDELING' }, nieuw: { status: 'AFGEWEZEN' } });
  })();
  const naam = codenamen([r.aanvrager_id]);
  const slots = slotMap(period.id);
  const aanvrager = naam.get(r.aanvrager_id)!;
  const mail = stuur(
    period,
    r.id,
    'RUIL_UITKOMST',
    { personId: r.aanvrager_id },
    'Je ruilverzoek is afgewezen',
    `Beste ${aanvrager},\n\nJe ruilverzoek is afgewezen. Je rooster blijft zoals het was.\n\nJe bood aan: ${dienstTekst(beschrijf(lijstVan(r.aangeboden_json), slots))}\nJe vroeg: ${dienstTekst(beschrijf(lijstVan(r.gevraagd_json), slots))}${reden ? `\n\nReden: ${reden}` : ''}`
  );
  return { ok: true, id: r.id, mail };
}

/** The requester takes it back; the colleague is told it is off. */
export function trekAiosRuilIn(period: AiosUitnodigPeriode, personId: string, ruilId: unknown, now = new Date()): RuilUitkomst {
  const r = laadRuil(period.id, ruilId);
  if (!r || r.aanvrager_id !== personId) return nee(404, 'NOT_FOUND', 'Ruilverzoek niet gevonden.');
  if (r.status !== 'IN_BEHANDELING') return nee(409, 'HANDLED', 'Dit ruilverzoek is al afgehandeld.');
  db.transaction(() => {
    db.prepare(`UPDATE dienstrooster_aios_ruil SET status = 'INGETROKKEN', beantwoord_op = ? WHERE id = ?`).run(now.toISOString(), r.id);
    writeAuditLog({ actorId: personId, entiteit: 'aios_ruil', entiteitId: r.id, actie: 'CANCEL', oud: { status: 'IN_BEHANDELING' }, nieuw: { status: 'INGETROKKEN' } });
  })();
  const naam = codenamen([r.respondent_id]);
  const slots = slotMap(period.id);
  const collega = naam.get(r.respondent_id)!;
  const mail = stuur(
    period,
    r.id,
    'RUIL_INGETROKKEN',
    { personId: r.respondent_id },
    'Ruilverzoek ingetrokken',
    `Beste ${collega},\n\nEen ruilverzoek aan jou is ingetrokken. Je hoeft niets te doen. Je rooster blijft zoals het was.\n\nJij zou geven: ${dienstTekst(beschrijf(lijstVan(r.gevraagd_json), slots))}\nJij zou krijgen: ${dienstTekst(beschrijf(lijstVan(r.aangeboden_json), slots))}`
  );
  return { ok: true, id: r.id, mail };
}

// ---- reminders --------------------------------------------------------------

const UUR_MS = 60 * 60 * 1000;
const DAG_MS = 24 * UUR_MS;
/** The hour of day (server-local) an automatic reminder goes out. */
const HERINNERING_UUR = 9;
/** After this many days open (rounded down to 09:00) the colleague is reminded once, automatically. */
export const HERINNERING_NA_DAGEN = 7;
/** By hand not more often than this: the colleague is not to be pestered. */
export const HERINNERING_MIN_TUSSENTIJD_MS = DAG_MS;

/**
 * The last 09:00 (server-local) at or before the request is 7 x 24 hours
 * old: a request made on a Friday afternoon is reminded the next Friday
 * morning, never on the Saturday.
 */
export function aiosRuilHerinneringMoment(aangemaaktOp: string): Date {
  const rijp = new Date(Date.parse(aangemaaktOp) + HERINNERING_NA_DAGEN * DAG_MS);
  const moment = new Date(rijp);
  moment.setHours(HERINNERING_UUR, 0, 0, 0);
  if (moment > rijp) moment.setDate(moment.getDate() - 1);
  return moment;
}

const DOOR_TEKST: Record<HerinneringDoor, string> = {
  AUTOMATISCH: 'Je verzoek stond al bijna 7 dagen open. Daarom is er automatisch een herinnering gestuurd.',
  AANVRAGER: 'Je hebt zelf een herinnering gestuurd.',
  PLANNER: 'De planner heeft een herinnering gestuurd.',
};

/** Reminds the colleague of an open request and tells the requester it was done. After the commit: mails only. */
function stuurHerinnering(period: AiosUitnodigPeriode, r: RuilRij, door: HerinneringDoor): boolean {
  const naam = codenamen([r.aanvrager_id, r.respondent_id]);
  const slots = slotMap(period.id);
  const a = dienstTekst(beschrijf(lijstVan(r.aangeboden_json), slots));
  const b = dienstTekst(beschrijf(lijstVan(r.gevraagd_json), slots));
  const extra = r.toelichting ? `\n\nToelichting: ${r.toelichting}` : '';
  const collega = naam.get(r.respondent_id)!;
  const aanvrager = naam.get(r.aanvrager_id)!;
  // Anonymous, like the request itself.
  const mail = stuur(
    period,
    r.id,
    'RUIL_HERINNERING',
    { personId: r.respondent_id },
    'Herinnering: een ruilverzoek wacht op jouw antwoord',
    `Beste ${collega},\n\nEen collega wacht nog op je antwoord op een ruilverzoek in het rooster van de AIOS voor ${period.naam}.\n\nJij geeft: ${b}\nJij krijgt: ${a}${extra}\n\nKeur het goed of wijs het af op je pagina.`
  );
  stuur(
    period,
    r.id,
    'RUIL_HERINNERING_BEVESTIGING',
    { personId: r.aanvrager_id },
    'Er is een herinnering gestuurd voor je ruilverzoek',
    `Beste ${aanvrager},\n\nEr is een herinnering gestuurd naar je collega voor je ruilverzoek. ${DOOR_TEKST[door]}\n\nJij geeft: ${a}\nJij krijgt: ${b}\n\nOverweeg de dienst ook te ruilen met een andere dag of collega. Je mag meer dan één verzoek tegelijk doen. Zodra iemand de ruil accepteert, wordt het andere verzoek automatisch ingetrokken.`
  );
  return mail;
}

function dienstenGeweest(r: RuilRij, now: Date): boolean {
  const dag = vandaag(now);
  const datum = new Map(slotsVan(r.period_id).map((x) => [x.id, x.datum]));
  return [...lijstVan(r.aangeboden_json), ...lijstVan(r.gevraagd_json)].some((id) => (datum.get(id) ?? '') < dag);
}

/**
 * A reminder by hand, for the requester or the planner: only after the
 * yes of whoever presses (`bevestigd`), which says when the last one went;
 * not within 24 hours of the last. The planner's own access is checked by
 * the route.
 */
export function herinnerAiosRuil(
  period: AiosUitnodigPeriode,
  ruilId: unknown,
  door: 'AANVRAGER' | 'PLANNER',
  actorId: string,
  bevestigd: boolean,
  now = new Date()
): RuilUitkomst {
  if (!ruilenKan(period)) return nee(409, 'NOT_DEFINITIEF', NOG_VOORLOPIG);
  const r = laadRuil(period.id, ruilId);
  if (!r || (door === 'AANVRAGER' && r.aanvrager_id !== actorId)) return nee(404, 'NOT_FOUND', 'Ruilverzoek niet gevonden.');
  if (r.status !== 'IN_BEHANDELING') return nee(409, 'HANDLED', 'Dit ruilverzoek is al afgehandeld. Er is geen herinnering meer nodig.');
  if (dienstenGeweest(r, now)) return nee(409, 'IN_PAST', 'Een van de diensten is al geweest. Er is geen herinnering meer nodig.');
  if (r.laatste_herinnering_op && now.getTime() - Date.parse(r.laatste_herinnering_op) < HERINNERING_MIN_TUSSENTIJD_MS) {
    return nee(409, 'TOO_SOON', 'Er is de afgelopen 24 uur al een herinnering gestuurd. Probeer het later opnieuw.', r.laatste_herinnering_op);
  }
  if (!bevestigd) {
    return nee(409, 'BEVESTIGING', 'Bevestig dat je een herinnering wilt sturen.', r.laatste_herinnering_op);
  }
  db.transaction(() => {
    db.prepare(`UPDATE dienstrooster_aios_ruil SET laatste_herinnering_op = ?, laatste_herinnering_door = ? WHERE id = ? AND status = 'IN_BEHANDELING'`).run(
      now.toISOString(),
      door,
      r.id
    );
    writeAuditLog({
      actorId,
      entiteit: 'aios_ruil',
      entiteitId: r.id,
      actie: 'UPDATE',
      oud: { laatste_herinnering_op: r.laatste_herinnering_op },
      nieuw: { herinnering: door, laatste_herinnering_op: now.toISOString() },
    });
  })();
  return { ok: true, id: r.id, mail: stuurHerinnering(period, r, door) };
}

/**
 * The automatic reminders: every open request on a definitief roster that
 * has been open 7 x 24 hours (rounded down to 09:00) and has not been
 * reminded yet, by anyone (the claim below says which are open and not
 * reminded). Run by the hourly check. Returns how many.
 */
export function stuurAutomatischeAiosRuilHerinneringen(now = new Date()): number {
  const rijen = db
    .prepare(
      `SELECT r.* FROM dienstrooster_aios_ruil r
       JOIN dienstrooster_schedule_period p ON p.id = r.period_id
       WHERE p.status = 'GEPUBLICEERD' AND p.definitief_op IS NOT NULL AND p.verwijderd_op IS NULL`
    )
    .all() as RuilRij[];
  let aantal = 0;
  for (const r of rijen) {
    if (now < aiosRuilHerinneringMoment(r.aangemaakt_op) || dienstenGeweest(r, now)) continue;
    const periode = db
      .prepare('SELECT id, naam, pool_id, start_datum, eind_datum, status FROM dienstrooster_schedule_period WHERE id = ?')
      .get(r.period_id) as AiosUitnodigPeriode;
    // The claim is the guard: only an open request nobody has reminded yet, one at a time.
    const geclaimd = db
      .prepare(`UPDATE dienstrooster_aios_ruil SET laatste_herinnering_op = ?, laatste_herinnering_door = 'AUTOMATISCH' WHERE id = ? AND laatste_herinnering_op IS NULL AND status = 'IN_BEHANDELING'`)
      .run(now.toISOString(), r.id).changes;
    if (geclaimd !== 1) continue;
    writeAuditLog({ actorId: r.aanvrager_id, entiteit: 'aios_ruil', entiteitId: r.id, actie: 'UPDATE', nieuw: { herinnering: 'AUTOMATISCH' } });
    stuurHerinnering(periode, r, 'AUTOMATISCH');
    aantal++;
  }
  return aantal;
}

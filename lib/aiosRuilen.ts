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
 * The AIOS's own copy of the achterwacht's swaps (app/api/person/.../
 * swap-requests, lib/swapLifecycle.ts), not a change to it
 * (docs/development/diensten.md, "Copied, not changed"): its own table,
 * statuses and words. Mail goes through the AIOS's flow after the commit,
 * not awaited and not queued (a request not mailed is still on their
 * page): a request anonymous by mail until it goes through, as there; then
 * the planner and the roosterbureau are told (RUIL_DOORGEVEN).
 */

import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import { buildVerzendlijst, verzendlijstPersonen, type VerzendlijstBericht, type VerzendlijstSoort } from '@/lib/aiosVerzendlijst';
import { formatSwapDate } from '@/lib/aiosTeksten';
import { aiosMailIngesteld, verstuurAiosVerzendlijst } from '@/lib/aiosMail';
import { aiosMailBasisUrl, aiosPersoonlijkeLink, type AiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
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

export type RuilStatus = 'IN_BEHANDELING' | 'GOEDGEKEURD' | 'AFGEWEZEN' | 'INGETROKKEN' | 'VERVALLEN';

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
}

const lijstVan = (json: string) => JSON.parse(json) as string[];

/**
 * Open requests that can never go through any more: one of their diensten
 * is with someone else now (a swap, the planner by hand). Closed as
 * vervallen, as the achterwacht's (lib/swapLifecycle.ts).
 */
export function sluitVervallenAiosRuilen(periodId: string, now = new Date()): number {
  const rooster = huidigRooster(periodId);
  const open = db.prepare(`SELECT * FROM dienstrooster_aios_ruil WHERE period_id = ? AND status = 'IN_BEHANDELING'`).all(periodId) as RuilRij[];
  const weg = open.filter(
    (r) =>
      lijstVan(r.aangeboden_json).some((id) => rooster.get(id) !== r.aanvrager_id) ||
      lijstVan(r.gevraagd_json).some((id) => rooster.get(id) !== r.respondent_id)
  );
  const zet = db.prepare(`UPDATE dienstrooster_aios_ruil SET status = 'VERVALLEN', beantwoord_op = ? WHERE id = ? AND status = 'IN_BEHANDELING'`);
  for (const r of weg) zet.run(now.toISOString(), r.id);
  return weg.length;
}

/** "Publicatie intrekken": nothing open can go through any more. */
export function vervalOpenAiosRuilen(periodId: string, now = new Date()): void {
  db.prepare(`UPDATE dienstrooster_aios_ruil SET status = 'VERVALLEN', beantwoord_op = ? WHERE period_id = ? AND status = 'IN_BEHANDELING'`).run(
    now.toISOString(),
    periodId
  );
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
  }));
}

/** An AIOS's swap page: their own eenheden still to come, and the requests from and to them. */
export function aiosRuilOverzicht(
  period: AiosUitnodigPeriode,
  personId: string,
  now = new Date()
): { eenheden: EenheidUit[]; uit: RuilUit[]; in: RuilUit[] } {
  sluitVervallenAiosRuilen(period.id, now);
  const s = stand(period);
  const dag = vandaag(now);
  const rijen = db
    .prepare('SELECT * FROM dienstrooster_aios_ruil WHERE period_id = ? AND (aanvrager_id = ? OR respondent_id = ?) ORDER BY aangemaakt_op DESC')
    .all(period.id, personId, personId) as RuilRij[];
  const alle = uitRijen(period.id, rijen);
  return {
    eenheden: s.eenheden.filter((e) => e.houder === personId && e.van >= dag).map(uitgeschreven),
    uit: alle.filter((_, i) => rijen[i].aanvrager_id === personId),
    in: alle.filter((_, i) => rijen[i].respondent_id === personId),
  };
}

/** The planner's view: every request of the period. */
export function aiosRuilenVoorPlanner(period: AiosUitnodigPeriode, now = new Date()): RuilUit[] {
  sluitVervallenAiosRuilen(period.id, now);
  return uitRijen(
    period.id,
    db.prepare('SELECT * FROM dienstrooster_aios_ruil WHERE period_id = ? ORDER BY aangemaakt_op DESC').all(period.id) as RuilRij[]
  );
}

export type RuilUitkomst = { ok: true; id: string; mail: boolean } | { ok: false; status: number; code: string; message: string };

const nee = (status: number, code: string, message: string): RuilUitkomst => ({ ok: false, status, code, message });

const GEPUBLICEERD = 'Ruilen kan als het rooster gepubliceerd is.';

// ---- mail -------------------------------------------------------------------

const DOORGEVEN_AAN = ['Planner', 'Roosterbureau'] as const;

const dienstTekst = (e: EenheidUit) =>
  e.van === e.tot ? `${e.naam.toLowerCase()} op ${formatSwapDate(e.van)}` : `${e.naam.toLowerCase()} van ${formatSwapDate(e.van)} tot en met ${formatSwapDate(e.tot)}`;

function bericht(soort: VerzendlijstSoort, codenaam: string, onderwerp: string, tekst: string, anderen: string[] = []): VerzendlijstBericht {
  return { soort, codenaam, personen: verzendlijstPersonen(codenaam, anderen), onderwerp, tekst };
}

function link(periodId: string, personId: string): string {
  const basis = aiosMailBasisUrl(periodId);
  return basis ? `\n\nJe pagina:\n${aiosPersoonlijkeLink(personId, periodId, basis)}\n\nDeze link is alleen voor jou. Stuur hem niet door.` : '';
}

/** After the commit, not awaited: a mail that fails changes nothing about the swap. */
function stuur(period: AiosUitnodigPeriode, soort: VerzendlijstSoort, berichten: VerzendlijstBericht[]): boolean {
  if (!aiosMailIngesteld()) return false;
  void verstuurAiosVerzendlijst(buildVerzendlijst({ soort, automatisch: false, periode: period.naam }, berichten)).catch((error) =>
    console.error('[aios-ruilen] mail failed', error)
  );
  return true;
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
  if (period.status !== 'GEPUBLICEERD') return nee(409, 'NOT_PUBLISHED', GEPUBLICEERD);
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
  const mail =
    stuur(period, 'RUILVERZOEK', [
      bericht(
        'RUILVERZOEK',
        naam.get(hun.houder)!,
        'Nieuw ruilverzoek AIOS',
        `Beste ${naam.get(hun.houder)},\n\nEen collega vraagt je om te ruilen in het rooster van de AIOS voor ${period.naam}.\n\nJij geeft: ${dienstTekst(b)}\nJij krijgt: ${dienstTekst(a)}${extra}\n\nKeur het goed of wijs het af op je pagina.${link(period.id, hun.houder)}`
      ),
    ]) &&
    stuur(period, 'RUIL_BEVESTIGING', [
      bericht(
        'RUIL_BEVESTIGING',
        naam.get(personId)!,
        'Je ruilverzoek is verstuurd',
        `Beste ${naam.get(personId)},\n\nJe ruilverzoek is verstuurd.\n\nJij geeft: ${dienstTekst(a)}\nJij krijgt: ${dienstTekst(b)}\n\nJe krijgt bericht zodra je collega heeft gereageerd. Tot die tijd blijft je rooster zoals het is.${link(period.id, personId)}`
      ),
    ]);
  return { ok: true, id, mail };
}

function laadRuil(periodId: string, ruilId: unknown): RuilRij | undefined {
  if (typeof ruilId !== 'string') return undefined;
  return db.prepare('SELECT * FROM dienstrooster_aios_ruil WHERE id = ? AND period_id = ?').get(ruilId, periodId) as RuilRij | undefined;
}

/** The colleague says yes: the diensten change hands, if they still can. */
export function keurAiosRuilGoed(period: AiosUitnodigPeriode, personId: string, ruilId: unknown, now = new Date()): RuilUitkomst {
  if (period.status !== 'GEPUBLICEERD') return nee(409, 'NOT_PUBLISHED', GEPUBLICEERD);
  const r = laadRuil(period.id, ruilId);
  if (!r || r.respondent_id !== personId) return nee(404, 'NOT_FOUND', 'Ruilverzoek niet gevonden.');
  sluitVervallenAiosRuilen(period.id, now);
  const nu = laadRuil(period.id, ruilId)!;
  if (nu.status === 'VERVALLEN') return nee(409, 'LAPSED', 'Dit ruilverzoek is vervallen: een van de diensten is intussen bij iemand anders.');
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
      .prepare(`UPDATE dienstrooster_aios_ruil SET status = 'GOEDGEKEURD', beantwoord_op = ? WHERE id = ? AND status = 'IN_BEHANDELING'`)
      .run(op, r.id);
    if (klaar.changes !== 1) throw new Error('aios swap handled meanwhile');
    writeAuditLog({ actorId: personId, entiteit: 'aios_ruil', entiteitId: r.id, actie: 'APPROVE', oud: { status: 'IN_BEHANDELING' }, nieuw: { status: 'GOEDGEKEURD' } });
    // Others asking for these diensten can never go through now.
    sluitVervallenAiosRuilen(period.id, now);
  })();
  const naam = codenamen([r.aanvrager_id, r.respondent_id]);
  const slots = new Map(s.slots.map((x) => [x.id, x]));
  const ua = beschrijf(aangeboden, slots);
  const ub = beschrijf(gevraagd, slots);
  const aanvrager = naam.get(r.aanvrager_id)!;
  const collega = naam.get(r.respondent_id)!;
  const mail =
    stuur(period, 'RUIL_UITKOMST', [
      bericht(
        'RUIL_UITKOMST',
        aanvrager,
        'Je ruil is goedgekeurd',
        `Beste ${aanvrager},\n\n${collega} heeft je ruil goedgekeurd. Je rooster is aangepast.\n\nJij gaf: ${dienstTekst(ua)}\nJij kreeg: ${dienstTekst(ub)}${link(period.id, r.aanvrager_id)}`,
        [collega]
      ),
    ]) &&
    stuur(
      period,
      'RUIL_DOORGEVEN',
      // personen: the two who swapped, as the achterwacht's (lib/meldingMail.ts DoorgevenMail); no link.
      DOORGEVEN_AAN.map((aan) => ({
        soort: 'RUIL_DOORGEVEN' as const,
        codenaam: aan,
        personen: verzendlijstPersonen(aanvrager, [collega]),
        onderwerp: `Ruil in het rooster van de AIOS ${period.naam}`,
        tekst: `Twee AIOS hebben geruild in het rooster voor ${period.naam}.\n\n${collega} doet nu: ${dienstTekst(ua)}\n${aanvrager} doet nu: ${dienstTekst(ub)}`,
      }))
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
    db.prepare(`UPDATE dienstrooster_aios_ruil SET status = 'AFGEWEZEN', reden_afwijzing = ?, beantwoord_op = ? WHERE id = ?`).run(reden, now.toISOString(), r.id);
    writeAuditLog({ actorId: personId, entiteit: 'aios_ruil', entiteitId: r.id, actie: 'REJECT', oud: { status: 'IN_BEHANDELING' }, nieuw: { status: 'AFGEWEZEN' } });
  })();
  const naam = codenamen([r.aanvrager_id]);
  const slots = new Map(slotsVan(period.id).map((x) => [x.id, x]));
  const aanvrager = naam.get(r.aanvrager_id)!;
  const mail = stuur(period, 'RUIL_UITKOMST', [
    bericht(
      'RUIL_UITKOMST',
      aanvrager,
      'Je ruilverzoek is afgewezen',
      `Beste ${aanvrager},\n\nJe ruilverzoek is afgewezen. Je rooster blijft zoals het was.\n\nJe bood aan: ${dienstTekst(beschrijf(lijstVan(r.aangeboden_json), slots))}\nJe vroeg: ${dienstTekst(beschrijf(lijstVan(r.gevraagd_json), slots))}${reden ? `\n\nReden: ${reden}` : ''}${link(period.id, r.aanvrager_id)}`
    ),
  ]);
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
  const slots = new Map(slotsVan(period.id).map((x) => [x.id, x]));
  const collega = naam.get(r.respondent_id)!;
  const mail = stuur(period, 'RUIL_INGETROKKEN', [
    bericht(
      'RUIL_INGETROKKEN',
      collega,
      'Ruilverzoek ingetrokken',
      `Beste ${collega},\n\nEen ruilverzoek aan jou is ingetrokken. Je hoeft niets te doen. Je rooster blijft zoals het was.\n\nJij zou geven: ${dienstTekst(beschrijf(lijstVan(r.gevraagd_json), slots))}\nJij zou krijgen: ${dienstTekst(beschrijf(lijstVan(r.aangeboden_json), slots))}${link(period.id, r.respondent_id)}`
    ),
  ]);
  return { ok: true, id: r.id, mail };
}

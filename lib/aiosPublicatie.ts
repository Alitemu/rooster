/**
 * Publishing the AIOS's roster (docs/aios-rooster.md, step 4d, K5): as the
 * achterwacht's, in two steps. Voorlopig: the period becomes GEPUBLICEERD,
 * what was published is kept (voorlopig_rooster_json) and every AIOS gets
 * their own diensten by mail to check. Definitief: by hand, never a timer;
 * every AIOS gets their final diensten with what changed for them since.
 * In between the planner corrects by hand, with a reason (lib/aiosHandmatig.ts).
 * "Publicatie intrekken" takes it back to gegenereerd: for a roster
 * published by mistake.
 *
 * The check before each step: an empty dienst stops it (D2: the planner
 * fills it by hand first); a hard rule the roster breaks (a change by hand)
 * and a dienstpercentage above 25% (G6) are warnings, published only when
 * the planner confirms them.
 *
 * The AIOS's own copy of lib/publication.ts, not a change to it
 * (docs/development/diensten.md, "Copied, not changed"): the same columns
 * of schedule_period, its own mail through the AIOS's flow
 * (lib/aiosMail.ts), its own words. The mail goes after the commit: one
 * that can't be sent is reported back, never a reason to undo it. A
 * withdrawal sends nothing: the verzendlijst has no kind for it, and the
 * AIOS's page shows the roster gone at once.
 */

import { db } from '@/db/client';
import { buildVerzendlijst, verzendlijstPersonen, type VerzendlijstBericht } from '@/lib/verzendlijst';
import { formatSwapDate } from '@/lib/swapMailDetails';
import { verstuurAiosVerzendlijst, aiosMailIngesteld } from '@/lib/aiosMail';
import { aiosDeelnemers, aiosMailBasisUrl, aiosPersoonlijkeLink, type AiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import { laadAiosRooster, type AiosRooster } from '@/lib/aiosRooster';
import { AIOS_GENERATIE_LOOPT, aiosGeneratieLoopt } from '@/lib/aiosGenereren';
import { PERCENTAGE_GRENS } from '@/lib/aiosFte';
import { writeAuditLog } from '@/lib/auditLog';
import { periodStatusLabel } from '@/lib/statusLabels';
import { BLOK_VORM_LABELS } from '@/lib/aiosDiensten';

export interface AiosGepubliceerd {
  person_id: string;
  dienst_id: string;
  datum: string;
  code: string;
}

const CODE_NAAM: Record<string, string> = {
  UD: 'uitloopdienst',
  DD: 'dagdienst',
  AD: 'avonddienst',
  ADW: 'avonddienst weekend',
  ND: 'nachtdienst',
};

const procent = (x: number) => `${(x * 100).toLocaleString('nl-NL', { maximumFractionDigits: 1 })}%`;
const datumKort = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });

/** Every dienst with its AIOS, by date. */
export function aiosMomentopname(periodId: string): AiosGepubliceerd[] {
  return db
    .prepare(
      `SELECT a.person_id, s.id AS dienst_id, s.datum, st.code
       FROM dienstrooster_assignment a
       JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       WHERE a.schedule_version_id = ?
       ORDER BY s.datum, st.start_tijd, a.person_id`
    )
    .all(periodId) as AiosGepubliceerd[];
}

function leesMomentopname(json: string | null): AiosGepubliceerd[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as AiosGepubliceerd[]) : [];
  } catch {
    return [];
  }
}

export interface AiosPublicatieControle {
  // Stop it: empty diensten.
  problemen: string[];
  // Published only when confirmed.
  waarschuwingen: string[];
}

export function aiosPublicatieControle(rooster: AiosRooster): AiosPublicatieControle {
  const problemen =
    rooster.leeg > 0
      ? [`${rooster.leeg === 1 ? '1 dienst is' : `${rooster.leeg} diensten zijn`} nog leeg. Vul ${rooster.leeg === 1 ? 'die' : 'ze'} eerst met de hand.`]
      : [];
  const waarschuwingen = [
    ...rooster.overtredingen.map((o) => `${o.wie.join(' en ')}: ${o.tekst}${o.datums.length ? ` (${o.datums.map(datumKort).join(', ')})` : ''}`),
    ...rooster.per_aios
      .filter((a) => a.dienstpercentage !== null && a.dienstpercentage > PERCENTAGE_GRENS)
      .map((a) => `${a.codenaam}: dienstpercentage ${procent(a.dienstpercentage!)}, boven 25%.`),
  ];
  return { problemen, waarschuwingen };
}

export interface AiosPublicatieStand {
  status: string;
  gepubliceerd_op: string | null;
  definitief_op: string | null;
  mail_ingesteld: boolean;
  controle: AiosPublicatieControle;
}

function stand(periodId: string): { status: string; gepubliceerd_op: string | null; definitief_op: string | null; voorlopig_rooster_json: string | null } {
  return db
    .prepare('SELECT status, gepubliceerd_op, definitief_op, voorlopig_rooster_json FROM dienstrooster_schedule_period WHERE id = ?')
    .get(periodId) as { status: string; gepubliceerd_op: string | null; definitief_op: string | null; voorlopig_rooster_json: string | null };
}

export function aiosPublicatieStand(period: AiosUitnodigPeriode): AiosPublicatieStand {
  const s = stand(period.id);
  return {
    status: s.status,
    gepubliceerd_op: s.gepubliceerd_op,
    definitief_op: s.definitief_op,
    mail_ingesteld: aiosMailIngesteld(),
    controle: aiosPublicatieControle(laadAiosRooster(period)),
  };
}

export type AiosMailUitslag = { verstuurd: true; aantal: number } | { verstuurd: false; melding: string };

export type AiosPublicatieUitkomst =
  | { ok: true; mail: AiosMailUitslag }
  | { ok: false; status: number; code: string; message: string; controle?: AiosPublicatieControle };

const nee = (status: number, code: string, message: string, controle?: AiosPublicatieControle): AiosPublicatieUitkomst => ({
  ok: false,
  status,
  code,
  message,
  ...(controle ? { controle } : {}),
});

/** The check's verdict: empty diensten stop it, warnings need the planner's yes. */
function controleer(period: AiosUitnodigPeriode, bevestigd: boolean): AiosPublicatieUitkomst | null {
  const controle = aiosPublicatieControle(laadAiosRooster(period));
  if (controle.problemen.length > 0) return nee(409, 'NOT_READY', controle.problemen.join(' '), controle);
  if (controle.waarschuwingen.length > 0 && !bevestigd) {
    return nee(409, 'WARNINGS', 'Het rooster heeft waarschuwingen. Bekijk ze en bevestig dat je toch wilt publiceren.', controle);
  }
  return null;
}

function dienstRegel(d: AiosGepubliceerd): string {
  return `- ${formatSwapDate(d.datum)}: ${CODE_NAAM[d.code] ?? 'dienst'}`;
}

function dienstenTekst(eigen: AiosGepubliceerd[], percentage: number | null): string {
  if (eigen.length === 0) return 'Je hebt in dit kwartaal geen diensten.';
  const aantal = eigen.length === 1 ? '1 dienst' : `${eigen.length} diensten`;
  const pct = percentage === null ? '' : `\n\nJe dienstpercentage dit kwartaal: ${procent(percentage)}.`;
  return `Je hebt ${aantal}:\n${eigen.map(dienstRegel).join('\n')}${pct}`;
}

function linkTekst(link: string | null): string {
  return link ? `\nJe rooster in de app:\n${link}\n` : '';
}

export function aiosVoorlopigBericht(
  period: { naam: string },
  codenaam: string,
  eigen: AiosGepubliceerd[],
  percentage: number | null,
  link: string | null
): VerzendlijstBericht {
  return {
    soort: 'ROOSTER_VOORLOPIG',
    codenaam,
    personen: verzendlijstPersonen(codenaam),
    onderwerp: `Voorlopig rooster AIOS ${period.naam}`,
    tekst: `Beste ${codenaam},

Het voorlopige rooster van de AIOS voor ${period.naam} staat klaar. ${dienstenTekst(eigen, percentage)}

Kijk je diensten goed na. Klopt er iets niet? Laat het de roosteraar zo snel mogelijk weten. Daarna wordt het rooster definitief. Je krijgt dan nog een bericht.
${linkTekst(link)}
Deze link is alleen voor jou. Stuur hem niet door.`,
  };
}

/** What one AIOS gained and lost between the two versions. */
export function aiosWijzigingen(
  personId: string,
  voorlopig: AiosGepubliceerd[],
  definitief: AiosGepubliceerd[]
): { erbij: AiosGepubliceerd[]; eraf: AiosGepubliceerd[] } {
  const oud = voorlopig.filter((d) => d.person_id === personId);
  const nieuw = definitief.filter((d) => d.person_id === personId);
  const oudeIds = new Set(oud.map((d) => d.dienst_id));
  const nieuweIds = new Set(nieuw.map((d) => d.dienst_id));
  return { erbij: nieuw.filter((d) => !oudeIds.has(d.dienst_id)), eraf: oud.filter((d) => !nieuweIds.has(d.dienst_id)) };
}

export function aiosDefinitiefBericht(
  period: { naam: string },
  codenaam: string,
  eigen: AiosGepubliceerd[],
  percentage: number | null,
  wijzigingen: { erbij: AiosGepubliceerd[]; eraf: AiosGepubliceerd[] },
  link: string | null
): VerzendlijstBericht {
  const gewijzigd = wijzigingen.erbij.length > 0 || wijzigingen.eraf.length > 0;
  const wat = gewijzigd
    ? [
        'Sinds het voorlopige rooster is voor jou iets veranderd.',
        ...(wijzigingen.erbij.length > 0 ? [`Erbij gekomen:\n${wijzigingen.erbij.map(dienstRegel).join('\n')}`] : []),
        ...(wijzigingen.eraf.length > 0 ? [`Vervallen:\n${wijzigingen.eraf.map(dienstRegel).join('\n')}`] : []),
      ].join('\n\n')
    : 'Voor jou is er niets veranderd sinds het voorlopige rooster.';
  return {
    soort: 'ROOSTER_DEFINITIEF',
    codenaam,
    personen: verzendlijstPersonen(codenaam),
    onderwerp: `Definitief rooster AIOS ${period.naam}`,
    tekst: `Beste ${codenaam},

Het rooster van de AIOS voor ${period.naam} is nu definitief. ${dienstenTekst(eigen, percentage)}

${wat}
${linkTekst(link)}
Deze link is alleen voor jou. Stuur hem niet door.`,
  };
}

/** Mails every AIOS taking part their own diensten, voorlopig or definitief. */
async function mail(period: AiosUitnodigPeriode, soort: 'ROOSTER_VOORLOPIG' | 'ROOSTER_DEFINITIEF', voorlopig: AiosGepubliceerd[]): Promise<AiosMailUitslag> {
  if (!aiosMailIngesteld()) {
    return {
      verstuurd: false,
      melding: 'Er is geen e-mail verstuurd, omdat de mail voor de AIOS nog niet is ingesteld. Dat doe je bij de mailinstellingen van de AIOS.',
    };
  }
  const rooster = aiosMomentopname(period.id);
  const percentage = new Map(laadAiosRooster(period).per_aios.map((a) => [a.person_id, a.dienstpercentage]));
  const basis = aiosMailBasisUrl(period.id);
  const berichten = db.transaction(() =>
    aiosDeelnemers(period).map((p) => {
      const eigen = rooster.filter((d) => d.person_id === p.id);
      const link = basis ? aiosPersoonlijkeLink(p.id, period.id, basis) : null;
      const pct = percentage.get(p.id) ?? null;
      return soort === 'ROOSTER_VOORLOPIG'
        ? aiosVoorlopigBericht(period, p.codenaam, eigen, pct, link)
        : aiosDefinitiefBericht(period, p.codenaam, eigen, pct, aiosWijzigingen(p.id, voorlopig, rooster), link);
    })
  )();
  if (berichten.length === 0) return { verstuurd: true, aantal: 0 };
  const uit = await verstuurAiosVerzendlijst(buildVerzendlijst({ soort, automatisch: false, periode: period.naam }, berichten));
  return uit.ok ? { verstuurd: true, aantal: uit.aantal } : { verstuurd: false, melding: `De e-mail is niet verstuurd: ${uit.message}` };
}

/** Voorlopig publiceren: from gegenereerd, the check passed or its warnings confirmed. */
export async function publiceerAiosRooster(period: AiosUitnodigPeriode, bevestigd: boolean, actorId: string): Promise<AiosPublicatieUitkomst> {
  if (period.status !== 'GEGENEREERD') {
    return nee(409, 'INVALID_STATUS', `Publiceren kan als het rooster gemaakt is, niet in status "${periodStatusLabel(period.status)}".`);
  }
  if (aiosGeneratieLoopt(period.id)) return nee(409, 'GENERATION_RUNNING', AIOS_GENERATIE_LOOPT);
  const weigering = controleer(period, bevestigd);
  if (weigering) return weigering;
  const op = new Date().toISOString();
  const gedaan = db.transaction(() => {
    if (stand(period.id).status !== 'GEGENEREERD') return false;
    db.prepare(
      `UPDATE dienstrooster_schedule_period
       SET status = 'GEPUBLICEERD', gepubliceerd_op = ?, gepubliceerd_door_person_id = ?,
           definitief_op = NULL, definitief_door_person_id = NULL, voorlopig_rooster_json = ?, row_version = row_version + 1
       WHERE id = ?`
    ).run(op, actorId, JSON.stringify(aiosMomentopname(period.id)), period.id);
    writeAuditLog({
      actorId,
      entiteit: 'period',
      entiteitId: period.id,
      actie: 'UPDATE',
      oud: { status: 'GEGENEREERD' },
      nieuw: { wijziging: 'rooster AIOS voorlopig gepubliceerd', status: 'GEPUBLICEERD', waarschuwingen_bevestigd: bevestigd },
    });
    return true;
  })();
  if (!gedaan) return nee(409, 'INVALID_STATUS', 'De periode is intussen gewijzigd. Laad de pagina opnieuw.');
  return { ok: true, mail: await mail(period, 'ROOSTER_VOORLOPIG', []) };
}

/** Definitief maken: a voorlopig published roster, the check again. */
export async function maakAiosDefinitief(period: AiosUitnodigPeriode, bevestigd: boolean, actorId: string): Promise<AiosPublicatieUitkomst> {
  const s = stand(period.id);
  if (s.status !== 'GEPUBLICEERD' || s.definitief_op) {
    return nee(409, 'INVALID_STATUS', s.definitief_op ? 'Het rooster is al definitief.' : 'Publiceer het rooster eerst voorlopig.');
  }
  const weigering = controleer(period, bevestigd);
  if (weigering) return weigering;
  const op = new Date().toISOString();
  const gedaan = db.transaction(() => {
    const nu = stand(period.id);
    if (nu.status !== 'GEPUBLICEERD' || nu.definitief_op) return false;
    db.prepare(
      `UPDATE dienstrooster_schedule_period SET definitief_op = ?, definitief_door_person_id = ?, row_version = row_version + 1 WHERE id = ?`
    ).run(op, actorId, period.id);
    writeAuditLog({
      actorId,
      entiteit: 'period',
      entiteitId: period.id,
      actie: 'UPDATE',
      nieuw: { wijziging: 'rooster AIOS definitief gemaakt', waarschuwingen_bevestigd: bevestigd },
    });
    return true;
  })();
  if (!gedaan) return nee(409, 'INVALID_STATUS', 'De periode is intussen gewijzigd. Laad de pagina opnieuw.');
  return { ok: true, mail: await mail(period, 'ROOSTER_DEFINITIEF', leesMomentopname(s.voorlopig_rooster_json)) };
}

/** "Publicatie intrekken": back to gegenereerd, every dienst kept; publishing again starts voorlopig. */
export function trekAiosPublicatieIn(period: AiosUitnodigPeriode, actorId: string): AiosPublicatieUitkomst {
  if (period.status !== 'GEPUBLICEERD') {
    return nee(409, 'INVALID_STATUS', `Intrekken kan alleen bij een gepubliceerd rooster, niet in status "${periodStatusLabel(period.status)}".`);
  }
  db.transaction(() => {
    db.prepare(
      `UPDATE dienstrooster_schedule_period
       SET status = 'GEGENEREERD', gepubliceerd_op = NULL, gepubliceerd_door_person_id = NULL,
           definitief_op = NULL, definitief_door_person_id = NULL, voorlopig_rooster_json = NULL, row_version = row_version + 1
       WHERE id = ?`
    ).run(period.id);
    writeAuditLog({
      actorId,
      entiteit: 'period',
      entiteitId: period.id,
      actie: 'UPDATE',
      oud: { status: 'GEPUBLICEERD' },
      nieuw: { wijziging: 'publicatie rooster AIOS ingetrokken', status: 'GEGENEREERD' },
    });
  })();
  return { ok: true, mail: { verstuurd: true, aantal: 0 } };
}

export interface AiosEigenRooster {
  voorlopig: boolean;
  diensten: Array<{
    dienst_id: string;
    datum: string;
    code: string;
    naam: string;
    start_tijd: string;
    eind_tijd: string;
    blok: string | null; // "nachtblok wo t/m vr"; null for a single dienst
    feestdag: string | null;
  }>;
  punten: number;
  dienstpercentage: number | null;
}

/** One AIOS's own diensten of a published quarter, with their points and dienstpercentage (G12). */
export function aiosEigenRooster(period: AiosUitnodigPeriode, personId: string): AiosEigenRooster {
  const rooster = laadAiosRooster(period);
  const mij = rooster.per_aios.find((a) => a.person_id === personId);
  return {
    voorlopig: stand(period.id).definitief_op === null,
    diensten: rooster.dagen.flatMap((d) =>
      d.diensten
        .filter((x) => x.aios?.id === personId)
        .map((x) => ({
          dienst_id: x.slot_id,
          datum: d.datum,
          code: x.code,
          naam: x.naam,
          start_tijd: x.start_tijd,
          eind_tijd: x.eind_tijd,
          blok: x.blok && x.blok.vorm !== 'LOS' ? `${x.blok.soort === 'AVOND' ? 'avondblok' : 'nachtblok'} ${BLOK_VORM_LABELS[x.blok.vorm]}` : null,
          feestdag: d.feestdag_naam,
        }))
    ),
    punten: mij?.punten ?? 0,
    dienstpercentage: mij?.dienstpercentage ?? null,
  };
}

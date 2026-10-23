/**
 * Bulk import of the AIOS's voorkeurenoverzicht ("Voorkeuren per dienst",
 * lib/aiosDownloads.ts) after it was filled in and saved in Excel: one row
 * per dienst, one column per AIOS, read from the .xlsx (lib/xlsx.ts). A
 * copy of what lib/preferencesImport.ts does for the achterwacht, on the
 * AIOS's own rules (docs/development/diensten.md, "Copied, not changed").
 * A test tool for the beheerder only (POST /api/aios/periode/[id]/
 * voorkeuren-import).
 *
 * - A cell is what the AIOS's own screen sets: "geblokkeerd", "liever niet"
 *   or "voorkeur", set as setAiosVoorkeur sets it (a block as a whole, the
 *   rules of a feestdag and of leave kept). An empty cell takes a hand mark
 *   away. A cell the export wrote with a reason, "(parttime)" or
 *   "(afwezig: vakantie)" or "(afwezig)" (the older file), comes from a part-time day or an absence, which keep it in
 *   step themselves: it is skipped, and an empty cell never clears one.
 * - The rows at the top that start with "Verzoek:" are what the AIOS asks
 *   besides their marks (lib/aiosDownloads.ts VERZOEK_RIJEN): "ja" or empty,
 *   or a period "dd-mm-jjjj t/m dd-mm-jjjj". A row that is not in the file
 *   leaves that request as it is; a file without any such row (one from
 *   before 0.98.0) touches no request.
 * - The rows "Parttime 1", "Parttime 2" ... are the AIOS's part-time days
 *   ("maandag", "dinsdag, even weken"). A column that holds none of them where
 *   the AIOS has none yet gets them, as the Deeltijd step would add them,
 *   before the marks are read (a part-time day sets its own marks). An AIOS who
 *   already has other part-time days in the quarter is a problem: nothing is
 *   removed or changed here. A file without such rows touches none.
 * - After a geblokkeerd or liever niet comes the AIOS's own toelichting of
 *   that day, as the export writes it: "geblokkeerd: ziek kind"
 *   (lib/aiosReden.ts). A day has one: a different text on two diensten of
 *   a day is a problem, and none takes the toelichting away.
 * - Checking (`toepassen` false) changes nothing and lists every change and
 *   every row, column or cell that can't be read. It is the very same work
 *   as applying, in a transaction that is rolled back, so what it says is
 *   what applying does. Applying refuses a file with problems: half an
 *   import is worse than none.
 * - Only before the roster is made: a roster rests on the preferences.
 */

import { db } from '@/db/client';
import { readFirstSheetMetRegels, XlsxError } from '@/lib/xlsx';
import { parseSheetDate } from '@/lib/isoDate';
import { withoutFormulaGuard } from '@/lib/csv';
import { aiosDeelnemers, type AiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import { loadAiosPeriode, loadAiosWens, saveAiosWens, setAiosVoorkeur, type Niveau } from '@/lib/aiosPreferences';
import { VERZOEK_RIJEN, laadDeeltijdVoorKwartaal, deeltijdCel, leesDeeltijdCel, verzoekPeriode, type DeeltijdPatroonRij } from '@/lib/aiosDownloads';
import { voegPatroonToe } from '@/lib/aiosDeeltijd';
import { loadAiosRedenen, saveAiosReden } from '@/lib/aiosReden';
import { isAiosPerson } from '@/lib/aiosPeriod';
import { schrijfAiosVoorkeurBackup } from '@/lib/aiosVoorkeurBackup';
import { AIOS_GENERATIE_LOOPT, aiosGeneratieLoopt } from '@/lib/aiosGenereren';

const NIVEAU_VAN_WOORD: Record<string, Niveau> = {
  geblokkeerd: 'ABSOLUUT',
  'liever niet': 'LIEVER_NIET',
  voorkeur: 'VOORKEUR',
};
const WOORD_VAN_NIVEAU: Record<Niveau, string> = {
  ABSOLUUT: 'geblokkeerd',
  LIEVER_NIET: 'liever niet',
  VOORKEUR: 'voorkeur',
};
const CEL = /^(geblokkeerd|liever niet|voorkeur)(?::\s*(.+))?$/;
const AUTOMATISCH = /^(geblokkeerd|liever niet|voorkeur) \((parttime|afwezig(: [^()]+)?)\)$/;

/** Statuses in which the preferences can still change; after them a roster rests on them. */
const INVOER_STATUSSEN = ['OPEN', 'GESLOTEN'];

export interface ImportWijziging {
  codenaam: string;
  datum: string;
  dienst: string;
  van: string;
  naar: string;
}

export interface ImportPlan {
  wijzigingen: ImportWijziging[];
  problemen: string[];
  overgeslagen: number;
  personen: number;
}

export type ImportUitkomst =
  | { ok: true; plan: ImportPlan; toegepast: boolean }
  | { ok: false; status: number; code: string; message: string };

interface Cel {
  personId: string;
  codenaam: string;
  slotId: string;
  datum: string;
  dienst: string;
  regel: number;
  doel: Niveau | null;
  tekst: string | null;
}

interface Verzoek {
  personId: string;
  codenaam: string;
  regel: number;
  veld: (typeof VERZOEK_RIJEN)[number]['veld'];
  /** true/false for a request, the period (or none) for inwerken and onderbreking. */
  waarde: boolean | { van: string; tot: string } | null;
}

interface DeeltijdCel {
  personId: string;
  codenaam: string;
  regel: number;
  patroon: DeeltijdPatroonRij;
}

interface Gelezen {
  /** Whether the file has rows Parttime N at all: without them no part-time day is looked at. */
  deeltijdRijen: boolean;
  deeltijd: DeeltijdCel[];
  personen: Array<{ id: string; codenaam: string }>;
  verzoeken: Verzoek[];
  cellen: Cel[];
  problemen: string[];
  overgeslagen: number;
}

/** What the person has now: per `${person}|${slot}` the level and where it came from. */
function huidigeMarkeringen(periodId: string): Map<string, { level: Niveau | null; bron: string }> {
  const rijen = db
    .prepare(
      `SELECT av.person_id, av.slot_id, av.blocking_level AS level, av.source AS bron
       FROM dienstrooster_availability av JOIN dienstrooster_shift_slot sl ON sl.id = av.slot_id
       WHERE sl.period_id = ?`
    )
    .all(periodId) as Array<{ person_id: string; slot_id: string; level: Niveau | null; bron: string }>;
  return new Map(rijen.map((r) => [`${r.person_id}|${r.slot_id}`, { level: r.level, bron: r.bron }]));
}

/** `regels`: the Excel row number of each row, so that a message points at the row the user sees. */
function lees(period: AiosUitnodigPeriode, rows: string[][], regels?: number[]): Gelezen {
  const problemen: string[] = [];
  const cellen: Cel[] = [];
  const verzoeken: Verzoek[] = [];
  const deeltijd: DeeltijdCel[] = [];
  let deeltijdRijen = false;
  let overgeslagen = 0;

  const kop = rows[0] ?? [];
  const klein = kop.map((h) => h.toLowerCase());
  const datumKol = klein.indexOf('datum');
  const dienstKol = klein.indexOf('dienst');
  if (datumKol === -1 || dienstKol === -1) {
    return {
      deeltijdRijen,
      deeltijd,
      personen: [],
      verzoeken,
      cellen,
      problemen: ['De kolommen Datum en Dienst ontbreken. Gebruik het bestand van "Voorkeurenoverzicht downloaden".'],
      overgeslagen,
    };
  }
  const eerstePersoonKol = Math.max(datumKol, dienstKol, klein.indexOf('dag'), klein.indexOf('week'), klein.indexOf('tijd'), klein.indexOf('blok'), klein.indexOf('feestdag')) + 1;

  const deelnemers = aiosDeelnemers(period);
  const exact = new Map(deelnemers.map((p) => [p.codenaam, p]));
  const hoofdletterloos = new Map(deelnemers.map((p) => [p.codenaam.toLowerCase(), p]));
  // Only the AIOS's own: a codenaam of the achterwacht is as unknown here as one that does not exist,
  // or this message would tell whether it exists.
  const alle = (db.prepare(`SELECT id, codenaam FROM dienstrooster_person WHERE rol = 'DEELNEMER'`).all() as Array<{ id: string; codenaam: string }>).filter((p) =>
    isAiosPerson(p.id)
  );
  const bekend = new Set(alle.map((p) => p.codenaam.toLowerCase()));

  const kolommen: Array<{ kol: number; id: string; codenaam: string }> = [];
  // The header row can be shorter than the rows under it: a column without a name has no cell there.
  const breedte = rows.reduce((m, rij) => Math.max(m, rij.length), kop.length);
  for (let kol = eerstePersoonKol; kol < breedte; kol++) {
    const naam = kop[kol];
    if (!naam) {
      // Without a name it cannot be read; with data in it that is not nothing to say.
      if (rows.slice(1).some((rij) => (rij[kol] ?? '').trim() !== '')) {
        problemen.push(`Kolom ${kol + 1} heeft geen kop maar wel gegevens. Zet er de codenaam van een AIOS boven of haal de kolom weg.`);
      }
      continue;
    }
    const zonderGuard = withoutFormulaGuard(naam);
    const persoon = exact.get(naam) ?? hoofdletterloos.get(naam.toLowerCase()) ?? exact.get(zonderGuard) ?? hoofdletterloos.get(zonderGuard.toLowerCase());
    if (!persoon) {
      problemen.push(
        bekend.has(naam.toLowerCase()) || bekend.has(zonderGuard.toLowerCase())
          ? `Kolom "${naam}": doet niet mee aan deze periode.`
          : `Kolom "${naam}": geen deelnemer met deze codenaam.`
      );
      continue;
    }
    if (kolommen.some((k) => k.id === persoon.id)) {
      problemen.push(`Kolom "${naam}" staat twee keer in het bestand.`);
      continue;
    }
    kolommen.push({ kol, id: persoon.id, codenaam: persoon.codenaam });
  }

  const slots = db
    .prepare(
      `SELECT sl.id, sl.datum, st.code FROM dienstrooster_shift_slot sl
       JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id WHERE sl.period_id = ?`
    )
    .all(period.id) as Array<{ id: string; datum: string; code: string }>;
  const slotVan = new Map(slots.map((s) => [`${s.datum}|${s.code}`, s.id]));
  const huidig = huidigeMarkeringen(period.id);

  const gezienOp = new Map<string, number>();
  for (let r = 1; r < rows.length; r++) {
    const rij = rows[r];
    const regel = regels?.[r] ?? r + 1;
    const dienstWoord = rij[dienstKol] ?? '';
    if (/^parttime \d+$/i.test(dienstWoord.trim())) {
      deeltijdRijen = true;
      for (const { kol, id, codenaam } of kolommen) {
        const ruw = (rij[kol] ?? '').trim();
        if (ruw === '') continue;
        const patroon = leesDeeltijdCel(ruw, period.start_datum, period.eind_datum);
        if (!patroon) {
          problemen.push(
            `Regel ${regel}, ${codenaam}: "${ruw}" is geen parttimedag. Schrijf bijvoorbeeld maandag of dinsdag, even weken (alleen maandag t/m vrijdag).`
          );
          continue;
        }
        deeltijd.push({ personId: id, codenaam, regel, patroon });
      }
      continue;
    }
    if (dienstWoord.trim().toLowerCase().startsWith('verzoek:')) {
      const rijInfo = VERZOEK_RIJEN.find((v) => v.label.toLowerCase() === dienstWoord.trim().toLowerCase());
      if (!rijInfo) {
        problemen.push(`Regel ${regel}: "${dienstWoord}" is geen verzoek dat bekend is.`);
        continue;
      }
      for (const { kol, id, codenaam } of kolommen) {
        const ruw = (rij[kol] ?? '').trim();
        if (rijInfo.soort === 'ja') {
          if (ruw !== '' && ruw.toLowerCase() !== 'ja') {
            problemen.push(`Regel ${regel}, ${codenaam}: "${ruw}" is geen ja. Laat de cel leeg als de AIOS dit niet vraagt.`);
            continue;
          }
          verzoeken.push({ personId: id, codenaam, regel, veld: rijInfo.veld, waarde: ruw !== '' });
          continue;
        }
        if (ruw === '') {
          verzoeken.push({ personId: id, codenaam, regel, veld: rijInfo.veld, waarde: null });
          continue;
        }
        const periode = /^(\d{2})-(\d{2})-(\d{4}) t\/m (\d{2})-(\d{2})-(\d{4})$/.exec(ruw);
        if (!periode) {
          problemen.push(`Regel ${regel}, ${codenaam}: "${ruw}" is geen periode. Schrijf dd-mm-jjjj t/m dd-mm-jjjj.`);
          continue;
        }
        verzoeken.push({
          personId: id,
          codenaam,
          regel,
          veld: rijInfo.veld,
          waarde: { van: `${periode[3]}-${periode[2]}-${periode[1]}`, tot: `${periode[6]}-${periode[5]}-${periode[4]}` },
        });
      }
      continue;
    }
    const datum = parseSheetDate(rij[datumKol] ?? '');
    const code = dienstWoord.split(' ')[0]?.toUpperCase() ?? '';
    if (!datum || !code) {
      problemen.push(`Regel ${regel}: datum "${rij[datumKol] ?? ''}" of dienst "${dienstWoord}" is niet te lezen.`);
      continue;
    }
    const slotId = slotVan.get(`${datum}|${code}`);
    if (!slotId) {
      problemen.push(`Regel ${regel}: geen ${dienstWoord.toLowerCase()} op ${datum} in deze periode.`);
      continue;
    }
    const eerder = gezienOp.get(slotId);
    if (eerder !== undefined) {
      problemen.push(`Regel ${regel}: de ${dienstWoord.toLowerCase()} op ${datum} staat ook op regel ${eerder}.`);
      continue;
    }
    gezienOp.set(slotId, regel);

    for (const { kol, id, codenaam } of kolommen) {
      const ruw = (rij[kol] ?? '').trim();
      const cel = ruw.toLowerCase();
      const nu = huidig.get(`${id}|${slotId}`);
      const automatisch = nu && nu.level && nu.bron !== 'MANUAL';
      if (AUTOMATISCH.test(cel)) {
        overgeslagen++;
        continue;
      }
      if (cel === '') {
        // Never clears a part-time or absence mark.
        if (automatisch) continue;
        cellen.push({ personId: id, codenaam, slotId, datum, dienst: dienstWoord, regel, doel: null, tekst: null });
        continue;
      }
      const gevonden = CEL.exec(cel);
      if (!gevonden) {
        problemen.push(`Regel ${regel}, ${codenaam}: "${ruw}" is geen geblokkeerd, liever niet of voorkeur.`);
        continue;
      }
      const niveau = NIVEAU_VAN_WOORD[gevonden[1]];
      // The text as typed, not lowercased: the part after the colon of the cell itself.
      const tekst = gevonden[2] ? ruw.slice(ruw.indexOf(':') + 1).trim() : null;
      if (automatisch) {
        // A mark of a part-time day or an absence stays as it is, and has no toelichting of the AIOS's to take.
        if (tekst) {
          problemen.push(
            `Regel ${regel}, ${codenaam}: een toelichting kan niet bij een parttimedag of afwezigheid. Haal de tekst weg of zet hem bij een keuze die de AIOS zelf deed.`
          );
          continue;
        }
        overgeslagen++;
        continue;
      }
      cellen.push({ personId: id, codenaam, slotId, datum, dienst: dienstWoord, regel, doel: niveau, tekst: tekst || null });
    }
  }
  return { deeltijdRijen, deeltijd, personen: kolommen.map((k) => ({ id: k.id, codenaam: k.codenaam })), verzoeken, cellen, problemen, overgeslagen };
}

/** Thrown to roll a transaction back after it was run to see what it does. */
class TerugDraaien extends Error {}

/**
 * Does what the file says, in a transaction; with `terug` it is rolled back
 * after the work, so checking and applying are the same work.
 */
function voerUit(period: AiosUitnodigPeriode, gelezen: Gelezen, terug: boolean): { plan: ImportPlan; aangeraakt: Set<string> } {
  const problemen = [...gelezen.problemen];
  const wijzigingen: ImportWijziging[] = [];
  const aangeraakt = new Set<string>();
  const aiosPeriode = loadAiosPeriode(period.id)!;
  const voor = huidigeMarkeringen(period.id);
  let cellen = gelezen.cellen;
  let overgeslagen = gelezen.overgeslagen;
  const redenVoor = new Map<string, Map<string, string>>();
  for (const id of new Set(cellen.map((c) => c.personId))) {
    redenVoor.set(id, new Map(loadAiosRedenen(id, period.id).map((r) => [r.datum, r.tekst])));
  }

  const werk = () => {
    // The part-time days first: they set marks of their own, which the cells below then find as they are.
    if (gelezen.deeltijdRijen) {
      for (const persoon of gelezen.personen) {
        const gewenst = gelezen.deeltijd.filter((d) => d.personId === persoon.id);
        const bestaand = laadDeeltijdVoorKwartaal(persoon.id, period.start_datum, period.eind_datum);
        const sleutel = (p: DeeltijdPatroonRij) => `${p.weekdag}|${p.frequentie}`;
        const vanBestand = gewenst.map((d) => sleutel(d.patroon)).sort().join(',');
        if (vanBestand === bestaand.map(sleutel).sort().join(',')) continue;
        if (bestaand.length > 0) {
          problemen.push(
            `${persoon.codenaam}: heeft al andere parttimedagen in dit kwartaal (${bestaand.map((p) => deeltijdCel(p, period.start_datum, period.eind_datum)).join('; ')}). Het bestand zegt: ${gewenst.map((d) => deeltijdCel(d.patroon, period.start_datum, period.eind_datum)).join('; ') || 'geen'}. Haal ze eerst weg bij de AIOS of pas het bestand aan.`
          );
          continue;
        }
        for (const d of gewenst) {
          const uitkomst = voegPatroonToe(persoon.id, { weekdag: d.patroon.weekdag, frequentie: d.patroon.frequentie, geldig_vanaf: d.patroon.geldig_vanaf, geldig_tot: d.patroon.geldig_tot });
          if (uitkomst.status >= 300) {
            const bericht = (uitkomst.body.error as { message?: string } | undefined)?.message ?? 'Kon de parttimedag niet toevoegen';
            problemen.push(`Regel ${d.regel}, ${d.codenaam}: ${bericht}`);
            continue;
          }
          aangeraakt.add(persoon.id);
          wijzigingen.push({ codenaam: d.codenaam, datum: '', dienst: 'parttimedag', van: 'leeg', naar: deeltijdCel(d.patroon, period.start_datum, period.eind_datum) });
        }
      }
    }
    // A part-time day just made has set marks on its own: the cells of those boxes are as the screen would
    // have them, skipped (an empty one does not clear them, a toelichting on one is a problem).
    if (wijzigingen.some((w) => w.dienst === 'parttimedag')) {
      const nu = huidigeMarkeringen(period.id);
      cellen = cellen.filter((cel) => {
        const er = nu.get(`${cel.personId}|${cel.slotId}`);
        if (!er?.level || er.bron === 'MANUAL') return true;
        if (cel.tekst) {
          problemen.push(
            `Regel ${cel.regel}, ${cel.codenaam}: een toelichting kan niet bij een parttimedag of afwezigheid. Haal de tekst weg of zet hem bij een keuze die de AIOS zelf deed.`
          );
        } else if (cel.doel !== null) {
          overgeslagen++;
        }
        return false;
      });
    }
    // The marks.
    const gevraagd = new Set<string>();
    for (const cel of cellen) {
      const nu = voor.get(`${cel.personId}|${cel.slotId}`)?.level ?? null;
      if (nu === cel.doel) continue;
      const uitkomst = setAiosVoorkeur(cel.personId, period.id, cel.slotId, cel.doel);
      if (!uitkomst.ok) {
        problemen.push(`Regel ${cel.regel}, ${cel.codenaam}: ${uitkomst.message}`);
        continue;
      }
      gevraagd.add(`${cel.personId}|${cel.slotId}`);
    }
    // A block is one choice: what the file says per dienst has to agree with what the block ended as.
    const na = huidigeMarkeringen(period.id);
    const gemeld = new Set<string>();
    for (const cel of cellen) {
      if (!gevraagd.has(`${cel.personId}|${cel.slotId}`) && (voor.get(`${cel.personId}|${cel.slotId}`)?.level ?? null) !== cel.doel) continue;
      const nu = na.get(`${cel.personId}|${cel.slotId}`)?.level ?? null;
      if (nu === cel.doel) continue;
      const sleutel = `${cel.personId}|${cel.datum}|${cel.dienst}`;
      if (gemeld.has(sleutel)) continue;
      gemeld.add(sleutel);
      problemen.push(`Regel ${cel.regel}, ${cel.codenaam}: de keuze voor de ${cel.dienst.toLowerCase()} op ${cel.datum} past niet bij de rest van het blok.`);
    }
    for (const cel of cellen) {
      const was = voor.get(`${cel.personId}|${cel.slotId}`)?.level ?? null;
      const wordt = na.get(`${cel.personId}|${cel.slotId}`)?.level ?? null;
      if (was === wordt) continue;
      aangeraakt.add(cel.personId);
      wijzigingen.push({
        codenaam: cel.codenaam,
        datum: cel.datum,
        dienst: cel.dienst.toLowerCase(),
        van: was ? WOORD_VAN_NIVEAU[was] : 'leeg',
        naar: wordt ? WOORD_VAN_NIVEAU[wordt] : 'leeg',
      });
    }

    // A block is set as a whole: the diensten of it that the file does not name change with it. Said too, or
    // "controleren" would show fewer changes than applying makes.
    const inBestand = new Set(cellen.map((c) => `${c.personId}|${c.slotId}`));
    const codenaamVan = new Map(cellen.map((c) => [c.personId, c.codenaam]));
    const slotTekst = new Map(
      (
        db
          .prepare(
            `SELECT sl.id, sl.datum, st.code, st.naam FROM dienstrooster_shift_slot sl
             JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id WHERE sl.period_id = ?`
          )
          .all(period.id) as Array<{ id: string; datum: string; code: string; naam: string }>
      ).map((s) => [s.id, s])
    );
    for (const sleutel of new Set([...voor.keys(), ...na.keys()])) {
      if (inBestand.has(sleutel)) continue;
      const [persoon, slot] = sleutel.split('|');
      const codenaam = codenaamVan.get(persoon);
      const info = slotTekst.get(slot);
      if (!codenaam || !info) continue;
      const was = voor.get(sleutel)?.level ?? null;
      const wordt = na.get(sleutel)?.level ?? null;
      if (was === wordt) continue;
      aangeraakt.add(persoon);
      wijzigingen.push({
        codenaam,
        datum: info.datum,
        dienst: `${info.code} ${info.naam.toLowerCase()} (rest van het blok)`,
        van: was ? WOORD_VAN_NIVEAU[was] : 'leeg',
        naar: wordt ? WOORD_VAN_NIVEAU[wordt] : 'leeg',
      });
    }

    // Then the toelichting per day: one text a day, from the cells of that day that carry one (the back-up
    // puts it after every mark of the day, a voorkeur included). A day needs a geblokkeerd or liever niet
    // for it to stand: saveAiosReden says so when it does not.
    const perDag = new Map<string, { cel: Cel; teksten: Set<string> }>();
    for (const cel of cellen) {
      if (cel.doel === null) continue;
      const sleutel = `${cel.personId}|${cel.datum}`;
      const groep = perDag.get(sleutel) ?? { cel, teksten: new Set<string>() };
      if (cel.tekst) groep.teksten.add(cel.tekst);
      perDag.set(sleutel, groep);
    }
    for (const { cel, teksten } of perDag.values()) {
      if (teksten.size > 1) {
        problemen.push(`${cel.codenaam}, ${cel.datum}: twee verschillende toelichtingen op één dag. Een dag heeft er één.`);
        continue;
      }
      const eerder = redenVoor.get(cel.personId)?.get(cel.datum) ?? null;
      const nieuw = [...teksten][0] ?? null;
      if (eerder === nieuw) continue;
      const uitkomst = saveAiosReden(cel.personId, aiosPeriode, cel.datum, nieuw);
      if (!uitkomst.ok) {
        problemen.push(`${cel.codenaam}, ${cel.datum}: ${uitkomst.message}`);
        continue;
      }
      aangeraakt.add(cel.personId);
      wijzigingen.push({ codenaam: cel.codenaam, datum: cel.datum, dienst: 'toelichting', van: eerder ?? 'leeg', naar: nieuw ?? 'leeg' });
    }

    // Last the requests, per AIOS all at once as the AIOS's own screen saves them.
    const perPersoon = new Map<string, Verzoek[]>();
    for (const v of gelezen.verzoeken) perPersoon.set(v.personId, [...(perPersoon.get(v.personId) ?? []), v]);
    for (const [personId, lijst] of perPersoon) {
      const nu = loadAiosWens(personId, period.id);
      const wordt = { ...nu };
      for (const v of lijst) {
        if (v.veld === 'inwerken' || v.veld === 'onderbreking') {
          const periode = v.waarde && typeof v.waarde === 'object' ? v.waarde : null;
          wordt[`${v.veld}_van`] = periode?.van ?? null;
          wordt[`${v.veld}_tot`] = periode?.tot ?? null;
        } else {
          wordt[v.veld] = v.waarde === true;
        }
      }
      const verschillen = VERZOEK_RIJEN.filter((rij) => {
        if (rij.veld === 'inwerken' || rij.veld === 'onderbreking') {
          return nu[`${rij.veld}_van`] !== wordt[`${rij.veld}_van`] || nu[`${rij.veld}_tot`] !== wordt[`${rij.veld}_tot`];
        }
        return nu[rij.veld] !== wordt[rij.veld];
      });
      if (verschillen.length === 0) continue;
      const uitkomst = saveAiosWens(personId, aiosPeriode, wordt);
      if (!uitkomst.ok) {
        problemen.push(`Regel ${lijst[0].regel}, ${lijst[0].codenaam}: ${uitkomst.message}`);
        continue;
      }
      aangeraakt.add(personId);
      for (const rij of verschillen) {
        const tekst = (w: typeof nu) =>
          rij.veld === 'inwerken' || rij.veld === 'onderbreking'
            ? (verzoekPeriode(w[`${rij.veld}_van`], w[`${rij.veld}_tot`]) ?? 'leeg')
            : w[rij.veld]
              ? 'ja'
              : 'leeg';
        wijzigingen.push({ codenaam: lijst[0].codenaam, datum: '', dienst: rij.label.toLowerCase(), van: tekst(nu), naar: tekst(wordt) });
      }
    }
    if (terug) throw new TerugDraaien();
  };

  try {
    db.transaction(werk)();
  } catch (error) {
    if (!(error instanceof TerugDraaien)) throw error;
  }
  return {
    plan: { wijzigingen, problemen, overgeslagen, personen: aangeraakt.size },
    aangeraakt,
  };
}

/** `bestand`: the .xlsx as base64, as the dialog sends it. */
export function importeerAiosVoorkeuren(period: AiosUitnodigPeriode, bestand: unknown, toepassen: boolean): ImportUitkomst {
  if (typeof bestand !== 'string' || bestand.trim() === '') {
    return { ok: false, status: 400, code: 'NO_FILE', message: 'Kies eerst een Excel-bestand.' };
  }
  if (!INVOER_STATUSSEN.includes(period.status)) {
    return {
      ok: false,
      status: 409,
      code: 'INVALID_STATUS',
      message:
        period.status === 'CONCEPT'
          ? 'Open de periode eerst. Dan pas kunnen voorkeuren worden ingelezen.'
          : 'Het rooster van deze periode is al gemaakt. Voorkeuren importeren kan alleen daarvoor.',
    };
  }
  // The generation read the preferences when it began and only looks at status and version when it ends:
  // preferences read in meanwhile would be left out of the roster without a word.
  if (aiosGeneratieLoopt(period.id)) return { ok: false, status: 409, code: 'GENERATION_RUNNING', message: AIOS_GENERATIE_LOOPT };
  let rows: string[][];
  let regels: number[];
  try {
    ({ rijen: rows, regels } = readFirstSheetMetRegels(Buffer.from(bestand, 'base64')));
  } catch (error) {
    if (error instanceof XlsxError) return { ok: false, status: 400, code: 'NOT_XLSX', message: error.message };
    throw error;
  }
  const gelezen = lees(period, rows, regels);
  // Always done once to see what it does; applying does it again, for real.
  const controle = voerUit(period, gelezen, true);
  if (!toepassen) return { ok: true, plan: controle.plan, toegepast: false };
  if (controle.plan.problemen.length > 0) {
    return {
      ok: false,
      status: 400,
      code: 'IMPORT_PROBLEMS',
      message: 'Het bestand heeft nog problemen. Er is niets veranderd. Los ze eerst op en controleer opnieuw.',
    };
  }
  const echt = voerUit(period, gelezen, false);
  for (const personId of echt.aangeraakt) {
    try {
      schrijfAiosVoorkeurBackup(personId, period.id);
    } catch (backupError) {
      console.error('aios-voorkeur-backup-write-failed', backupError);
    }
  }
  return { ok: true, plan: echt.plan, toegepast: true };
}

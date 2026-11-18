/**
 * The second tab of the AIOS's wijzigingsgeschiedenis, "Periode en instellingen" (1.13.0): what the audit
 * log holds about one quarter, in words. A copy of lib/periodeLogboek.ts, not shared with it
 * (docs/development/diensten.md "Copied, not changed"); lib/periodeLogboek.test.ts holds the two together.
 */

import { db } from '@/db/client';
import type { XlsxSheet } from '@/lib/xlsxWrite';

export interface LogRij {
  tijdstip: string;
  entiteit: string;
  actie: string;
  oud_json: string | null;
  nieuw_json: string | null;
  door: string;
}

const STATUS: Record<string, string> = {
  CONCEPT: 'concept',
  OPEN: 'open',
  GESLOTEN: 'gesloten',
  GEGENEREERD: 'gegenereerd',
  GEPUBLICEERD: 'gepubliceerd',
};

/** The words for a key of the log's JSON; a key that is not here is said as it is, without underscores. */
const VELD: Record<string, string> = {
  person_id: 'persoon',
  persoon: 'persoon',
  notifications_sent: 'meldingen verstuurd',
  assignments_created: 'diensten ingedeeld',
  unfilled_slots: 'lege diensten',
  overrides_confirmed: 'bevestigde afwijkingen',
  solver_diensten_verwijderd: 'diensten van de solver verwijderd',
  handmatige_diensten_verwijderd: 'diensten met de hand verwijderd',
  auto_herinneren: 'automatische herinneringen',
  overloop_bevestigd_op: 'bevestigd op',
  al_aanwezig: 'al aanwezig',
};

/** Keys that say nothing to a reader: ids of the period itself, and the solver's own cost. */
const WEG = new Set(['wijziging', 'id', 'pool_id', 'periode', 'periode_id', 'period_id', 'slot_id', 'cost', 'row_version']);

function parse(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const hoofdletter = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What happened, in words. */
export function watGebeurde(rij: Pick<LogRij, 'entiteit' | 'actie' | 'nieuw_json'>): string {
  const nieuw = parse(rij.nieuw_json);
  // The log's own words. "(test)" was the import's name while it was on trial.
  if (typeof nieuw?.wijziging === 'string' && nieuw.wijziging.trim() !== '') {
    return hoofdletter(nieuw.wijziging.replace(/_/g, ' ').replace(/\s*\(test\)$/, '').trim());
  }
  if (rij.actie === 'GENERATE_ROSTER') return 'Rooster gegenereerd';
  if (rij.actie === 'PUBLISH') return nieuw?.publicatie === 'definitief' ? 'Rooster definitief gemaakt' : 'Rooster voorlopig gepubliceerd';
  if (nieuw?.publicatie === 'definitief') return 'Rooster definitief gemaakt';
  if (rij.entiteit === 'period' && rij.actie === 'CREATE') return 'Periode aangemaakt';
  if (rij.entiteit === 'pool_membership') return rij.actie === 'DELETE' ? 'Lid verwijderd' : rij.actie === 'CREATE' ? 'Lid toegevoegd' : 'Lidmaatschap gewijzigd';
  if (rij.entiteit === 'person_access_link') return rij.actie === 'CREATE' ? 'Persoonlijke link aangemaakt' : 'Persoonlijke link gewijzigd';
  return rij.actie === 'CREATE' ? 'Aangemaakt' : rij.actie === 'DELETE' ? 'Verwijderd' : rij.actie === 'IMPORT' ? 'Geïmporteerd' : 'Gewijzigd';
}

/** One value as a reader wants it: a date as dd-mm-jjjj, a status in words, a person by codenaam. */
function waarde(sleutel: string, v: unknown, namen: ReadonlyMap<string, string>): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 'ja' : 'nee';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return String(v.length);
  if (typeof v !== 'string') return null; // a nested object (a whole ruleset): too much for a cell
  if (sleutel === 'status' && STATUS[v]) return STATUS[v];
  if (namen.has(v)) return namen.get(v)!;
  const datum = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(v);
  if (datum) {
    // A moment with a zone is said in Dutch time, as everywhere else in the app.
    if (datum[4] && /(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) {
        const p = Object.fromEntries(
          new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
            .formatToParts(d)
            .map((x) => [x.type, x.value])
        );
        return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}`;
      }
    }
    return `${datum[3]}-${datum[2]}-${datum[1]}${datum[4] ? ` ${datum[4]}:${datum[5]}` : ''}`;
  }
  return v;
}

/** The fields of one side of a change, "deadline: 15-12-2026 17:00; status: open", or null when there are none. */
export function inWoorden(json: string | null, namen: ReadonlyMap<string, string>): string | null {
  const o = parse(json);
  if (!o) return null;
  const delen: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (WEG.has(k)) continue;
    const w = waarde(k, v, namen);
    if (w !== null) delen.push(`${VELD[k] ?? k.replace(/_/g, ' ')}: ${w}`);
  }
  return delen.length > 0 ? delen.join('; ') : null;
}

/** The log's rows about one period, the oldest first. */
export function periodeLogRijen(periodId: string): LogRij[] {
  const period = db.prepare('SELECT pool_id, aangemaakt_op FROM dienstrooster_schedule_period WHERE id = ?').get(periodId) as
    | { pool_id: string; aangemaakt_op: string }
    | undefined;
  if (!period) return [];
  return db
    .prepare(
      `SELECT al.tijdstip, al.entiteit, al.actie, al.oud_json, al.nieuw_json, actor.codenaam AS door
       FROM dienstrooster_audit_log al
       JOIN dienstrooster_person actor ON actor.id = al.actor_id
       WHERE (al.entiteit IN ('period', 'schedule_period', 'holiday_history') AND al.entiteit_id = @periode)
          -- A link names its period in the row, not as its subject.
          OR (al.entiteit = 'person_access_link'
              AND (json_extract(al.nieuw_json, '$.periode') = @periode OR json_extract(al.nieuw_json, '$.periode_id') = @periode))
          -- Who is in the pool is not the period's own, but it decides who the period plans: what changed
          -- since this period was made.
          OR (al.entiteit = 'pool_membership' AND al.tijdstip >= @sinds
              AND (json_extract(al.nieuw_json, '$.pool_id') = @pool OR json_extract(al.oud_json, '$.pool_id') = @pool
                   OR EXISTS (SELECT 1 FROM dienstrooster_pool_membership m WHERE m.id = al.entiteit_id AND m.pool_id = @pool)))
       ORDER BY al.tijdstip, al.id`
    )
    .all({ periode: periodId, pool: period.pool_id, sinds: period.aangemaakt_op }) as LogRij[];
}

/** The tab itself. */
export function periodeLogboekSheet(periodId: string): XlsxSheet {
  const namen = new Map((db.prepare('SELECT id, codenaam FROM dienstrooster_person').all() as Array<{ id: string; codenaam: string }>).map((p) => [p.id, p.codenaam]));
  return {
    name: 'Periode en instellingen',
    columns: [{ header: 'Datum wijziging' }, { header: 'Wat' }, { header: 'Is nu', width: 60 }, { header: 'Was', width: 40 }, { header: 'Door' }],
    rows: periodeLogRijen(periodId).map((r) => [{ moment: r.tijdstip }, watGebeurde(r), inWoorden(r.nieuw_json, namen), inWoorden(r.oud_json, namen), r.door]),
  };
}

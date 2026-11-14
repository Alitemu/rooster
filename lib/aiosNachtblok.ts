/**
 * Enough part-timers for the night blocks of Sunday to Tuesday? (1.6.0)
 *
 * Hard rule 5 (docs/aios-rooster.md): whoever has 0,9 fte or more never
 * does the night block zo-di. An AIOS who entered no part-time days counts
 * as 1,0. With too few part-timers known the solver leaves those nights
 * empty, and the planner saw it only afterwards: 39 empty nights in a
 * quarter of twelve AIOS, none of whom had entered a day (audit per role,
 * R-02). The page now warns before the roster is made. It is a warning:
 * making the roster stays possible, and the rule itself is untouched
 * (aios-solver/model.py, aios-solver/controle.py, lib/aiosRegels.ts).
 *
 * The limit is the planner's (November 2026): three such blocks per
 * part-time AIOS in a quarter. A block cut up around feestdagen is loose
 * nights anyone may do, so it does not count. An AIOS who is being worked
 * in or has interrupted the training during a block cannot do that block.
 *
 * No db import: the count is tested on plain data.
 */

/** As in lib/aiosRegels.ts: from this fte on, no night block zo-di. */
const GEEN_NACHTBLOK_VANAF_FTE = 0.9;
/** More blocks than this per AIOS who may do them, and the page warns. */
export const NACHTBLOKKEN_PER_AIOS = 3;

type Tijdvak = { van: string; tot: string };

export interface NachtblokInvoer {
  blokken: ReadonlyArray<{ id: string; soort: string; vorm: string }>;
  diensten: ReadonlyArray<{ datum: string; blok_id: string | null }>;
  aios: ReadonlyArray<{ fte: number; beschikbaar: ReadonlyArray<Tijdvak>; onderbreking: Tijdvak | null; inwerken: Tijdvak | null }>;
}

export interface NachtblokStand {
  /** The night blocks zo-di of the quarter that are still a block. */
  blokken: number;
  /** The AIOS who may do at least one of them. */
  mogen: number;
  /** More than NACHTBLOKKEN_PER_AIOS blocks for each of them. */
  tekort: boolean;
}

const binnen = (dag: string, vak: Tijdvak | null) => vak !== null && dag >= vak.van && dag <= vak.tot;

export function nachtblokStand(invoer: NachtblokInvoer): NachtblokStand {
  const dagenPerBlok = new Map<string, string[]>();
  for (const b of invoer.blokken) if (b.soort === 'NACHT' && b.vorm === 'ZO_DI') dagenPerBlok.set(b.id, []);
  for (const d of invoer.diensten) if (d.blok_id !== null) dagenPerBlok.get(d.blok_id)?.push(d.datum);
  const blokken = [...dagenPerBlok.values()].filter((dagen) => dagen.length > 0);

  const kan = (a: NachtblokInvoer['aios'][number], dagen: string[]) =>
    dagen.every((dag) => a.beschikbaar.some((vak) => binnen(dag, vak)) && !binnen(dag, a.onderbreking) && !binnen(dag, a.inwerken));
  const mogen = invoer.aios.filter((a) => a.fte < GEEN_NACHTBLOK_VANAF_FTE && blokken.some((dagen) => kan(a, dagen))).length;

  return { blokken: blokken.length, mogen, tekort: blokken.length > NACHTBLOKKEN_PER_AIOS * mogen };
}

/** The warning on the page, or nothing when there are enough part-timers. */
export function nachtblokWaarschuwing(stand: NachtblokStand): string | null {
  if (!stand.tekort) return null;
  const wie =
    stand.mogen === 0
      ? 'Geen enkele AIOS mag die doen'
      : stand.mogen === 1
        ? 'Maar 1 AIOS mag die doen'
        : `Maar ${stand.mogen} AIOS mogen die doen`;
  return (
    `Te weinig AIOS in deeltijd voor de nachtblokken van zondag tot en met dinsdag. Dit kwartaal heeft er ${stand.blokken}. ` +
    `${wie}: alleen wie een deeltijdfactor lager dan 0,9 heeft, bijvoorbeeld 0,8. ` +
    `Dat is meer dan ${NACHTBLOKKEN_PER_AIOS} blokken per AIOS, dus een deel van deze nachten kan leeg blijven. ` +
    'Controleer of alle AIOS hun parttimedagen juist hebben opgegeven. Wie niets heeft opgegeven, telt als voltijd.'
  );
}

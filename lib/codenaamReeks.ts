/**
 * "Een reeks toevoegen" on Personeel beheren: aios01 tot en met aios30 is
 * aios01, aios02, ... aios30. The same letters in front, then a number; the
 * numbers keep the width of the first (aios01 to aios10 gives aios09, not
 * aios9), as the codenamen of a clean start do (staf01..staf30).
 *
 * Pure, no db: the page shows the list before anything is added, and the
 * route makes the same one.
 */

export const MAX_REEKS = 100;

const DEEL = /^(.*?)(\d+)$/;

export function codenaamReeks(van: string, tot: string): { ok: true; codenamen: string[] } | { ok: false; message: string } {
  const a = DEEL.exec(van.trim());
  const b = DEEL.exec(tot.trim());
  if (!a || !b) return { ok: false, message: 'Een reeks loopt van een codenaam met een nummer aan het eind tot een met hetzelfde begin, bijvoorbeeld aios01 tot en met aios30.' };
  if (a[1] !== b[1]) return { ok: false, message: `Het begin van de twee codenamen verschilt ("${a[1]}" en "${b[1]}"). Een reeks heeft één begin, bijvoorbeeld aios01 tot en met aios30.` };
  const begin = Number(a[2]);
  const eind = Number(b[2]);
  if (eind < begin) return { ok: false, message: 'Het tweede nummer is lager dan het eerste. Draai ze om.' };
  if (eind - begin + 1 > MAX_REEKS) return { ok: false, message: `Een reeks is hooguit ${MAX_REEKS} codenamen.` };
  const breedte = a[2].length;
  return {
    ok: true,
    codenamen: Array.from({ length: eind - begin + 1 }, (_, i) => `${a[1]}${String(begin + i).padStart(breedte, '0')}`),
  };
}

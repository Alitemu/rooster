/**
 * Which layout of the period page this browser last chose (1.10.0, lib/periodeIndeling.ts). Per browser,
 * not per account: it is a way of looking, and nothing on the server depends on it. Without it the choice
 * lived in the address only, so every link back to the period ("Terug naar periode", the list of
 * periods) showed the accordion again and nobody could really try the new layout.
 *
 * A browser that refuses storage (private mode) keeps the choice for as long as the tab lives.
 */
const SLEUTEL = 'dienstrooster.indeling';
const GEBEURTENIS = 'dienstrooster-indeling';

let zonderOpslag: string | null = null;

export function leesIndeling(): string | null {
  try {
    return window.localStorage.getItem(SLEUTEL) ?? zonderOpslag;
  } catch {
    return zonderOpslag;
  }
}

export function bewaarIndeling(keuze: 'nieuw' | 'oud'): void {
  zonderOpslag = keuze;
  try {
    window.localStorage.setItem(SLEUTEL, keuze);
  } catch {
    // Storage refused: zonderOpslag holds it for this tab.
  }
  window.dispatchEvent(new Event(GEBEURTENIS));
}

/** For useSyncExternalStore: this tab's own change and one made in another tab. */
export function volgIndeling(bijWijziging: () => void): () => void {
  window.addEventListener('storage', bijWijziging);
  window.addEventListener(GEBEURTENIS, bijWijziging);
  return () => {
    window.removeEventListener('storage', bijWijziging);
    window.removeEventListener(GEBEURTENIS, bijWijziging);
  };
}

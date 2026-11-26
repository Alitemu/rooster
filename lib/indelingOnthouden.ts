/**
 * The hidden way back to the accordion of the period page (2.0.0). Since 2.0.0 the new layout is the
 * layout (lib/periodeIndeling.ts); the accordion stays in the code, out of sight, so nothing important can
 * be lost with it. It shows only for `?indeling=oud` in the address, for that page, or in a browser whose
 * storage holds `dienstrooster.oudeIndeling` = `ja`. Nothing sets that, the browser checks neither (they go
 * through the new layout since 2.0.1): a beheerder could, by hand, in an emergency.
 *
 * Until 2.0.0 this remembered the planner's choice under another key, with a switch each way (1.10.0).
 * That key is not read any more: a browser that chose the accordion then sees the new layout now.
 */
const SLEUTEL = 'dienstrooster.oudeIndeling';

export function leesIndeling(): string | null {
  try {
    return window.localStorage.getItem(SLEUTEL);
  } catch {
    return null;
  }
}

/** For useSyncExternalStore: a change made in another tab. */
export function volgIndeling(bijWijziging: () => void): () => void {
  window.addEventListener('storage', bijWijziging);
  return () => window.removeEventListener('storage', bijWijziging);
}

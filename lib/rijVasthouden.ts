// Keeps one row of a list where it is on the screen for a moment, while what is above it changes: the
// "ongedaan maken" banner, a warning, a row above that wraps differently. The browser's own scroll
// anchoring did not do that in the new layout (2.0.1: the row just changed moved down by 152 pixels).
// Stops after `duurMs`, or as soon as the user scrolls or types, so it never fights them.
export function houdRijOpZijnPlek(vind: () => Element | null, duurMs = 3000): () => void {
  const eerst = vind();
  if (!eerst || typeof ResizeObserver === 'undefined') return () => {};
  const doel = eerst.getBoundingClientRect().top;
  const herstel = () => {
    const rij = vind();
    if (!rij) return;
    const verschil = rij.getBoundingClientRect().top - doel;
    if (Math.abs(verschil) >= 1) window.scrollBy(0, verschil);
  };
  const waarnemer = new ResizeObserver(herstel);
  waarnemer.observe(document.body);
  const stop = () => {
    clearTimeout(klok);
    waarnemer.disconnect();
    for (const soort of ['wheel', 'touchmove', 'keydown'] as const) window.removeEventListener(soort, stop);
  };
  const klok = setTimeout(stop, duurMs);
  for (const soort of ['wheel', 'touchmove', 'keydown'] as const) window.addEventListener(soort, stop, { passive: true });
  return stop;
}

/**
 * The "Fellow" label next to a codenaam (lib/fellows.ts). Text with a
 * border rather than colour alone, so it also reads in black and white.
 */
export function FellowBadge() {
  return (
    <span
      className="ml-1.5 inline-block rounded border border-violet-400 bg-violet-50 px-1 text-[10px] font-semibold uppercase tracking-wide text-violet-800 align-middle"
      title="Fellow: ondersteunt de AIOS op zaterdag, doet geen weekenddiensten"
    >
      Fellow
    </span>
  );
}

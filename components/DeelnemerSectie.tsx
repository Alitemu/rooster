'use client';

/**
 * The folding of the achterwacht participant's page once the roster is
 * published (0.110.0, layout only). A copy of the AIOS's DeelnemerSectie, not
 * shared with it (docs/development/diensten.md, "Copied, not changed"):
 * every section starts closed, opening one closes the others that are not
 * pinned, and the pin keeps one open. The title is a heading with a button
 * in it (the pattern for an accordion).
 */

import { createContext, useContext, useState, type ReactNode } from 'react';

interface HarmonicaStand {
  open: ReadonlySet<string>;
  vast: ReadonlySet<string>;
  wissel: (sleutel: string) => void;
  zetVast: (sleutel: string) => void;
}

const DeelnemerHarmonicaContext = createContext<HarmonicaStand | null>(null);

/** Holds which sections of the page are open and which are pinned. */
export function DeelnemerHarmonica({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [vast, setVast] = useState<Set<string>>(() => new Set());
  const wissel = (sleutel: string) =>
    setOpen((nu) => {
      if (nu.has(sleutel)) {
        const volgende = new Set(nu);
        volgende.delete(sleutel);
        return volgende;
      }
      // Opening: the pinned ones stay open, the rest closes.
      const volgende = new Set([...nu].filter((k) => vast.has(k)));
      volgende.add(sleutel);
      return volgende;
    });
  // Pinning opens or closes nothing itself: it only decides what the next opening of another section does.
  const zetVast = (sleutel: string) =>
    setVast((nu) => {
      const volgende = new Set(nu);
      if (volgende.has(sleutel)) volgende.delete(sleutel);
      else volgende.add(sleutel);
      return volgende;
    });
  return <DeelnemerHarmonicaContext.Provider value={{ open, vast, wissel, zetVast }}>{children}</DeelnemerHarmonicaContext.Provider>;
}

/**
 * One foldable card. `blijfGeladen` keeps the body mounted (hidden) while
 * closed: for a body whose state must survive closing (unsaved choices, a
 * generation that runs) or that tells the hint what to say.
 */
export function DeelnemerSectie({
  sleutel,
  titel,
  hint,
  testId,
  blijfGeladen = false,
  printOpen = false,
  children,
}: {
  sleutel: string;
  titel: string;
  hint?: string;
  testId?: string;
  blijfGeladen?: boolean;
  /** On paper the body is there although the section is closed (a roster to print, 0.111.0). */
  printOpen?: boolean;
  children: ReactNode;
}) {
  const harmonica = useContext(DeelnemerHarmonicaContext)!;
  const isOpen = harmonica.open.has(sleutel);
  const vast = harmonica.vast.has(sleutel);
  const bodyBestaat = isOpen || blijfGeladen || printOpen;
  const bodyId = `deelnemer-sectie-${sleutel}`;
  return (
    <div className="card overflow-hidden" data-testid={testId}>
      <div
        onClick={() => harmonica.wissel(sleutel)}
        className="flex items-center justify-between gap-3 p-4 cursor-pointer select-none hover:bg-neutral-50"
      >
        <h2 className="font-bold text-neutral-900">
          {/* The click bubbles to the row, which opens and closes it. */}
          <button type="button" aria-expanded={isOpen} aria-controls={bodyBestaat ? bodyId : undefined} className="flex items-center gap-2 text-left">
            <svg
              className={`w-4 h-4 text-neutral-500 shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                clipRule="evenodd"
              />
            </svg>
            {titel}
          </button>
        </h2>
        <span className="flex items-center gap-3 shrink-0">
          {hint && <span className="text-sm text-neutral-500 text-right">{hint}</span>}
          {isOpen && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                harmonica.zetVast(sleutel);
              }}
              title={vast ? 'Losmaken: klapt dicht zodra je een andere sectie opent' : 'Vastzetten: blijft open, ook als je een andere sectie opent'}
              aria-label="Vastzetten"
              aria-pressed={vast}
              className={`p-2.5 rounded transition-colors ${vast ? 'text-red-600 hover:text-red-800' : 'text-neutral-500 hover:text-neutral-700'}`}
            >
              {/* An SVG in currentColor, not 📌: an emoji keeps its own colour, so pinned would look like unpinned.
                  Pinned is filled, not pinned is an outline: not by colour alone. */}
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill={vast ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <circle cx="10" cy="7" r="4" />
                <rect x="9" y="10" width="2" height="7" rx="1" />
              </svg>
            </button>
          )}
        </span>
      </div>
      {bodyBestaat && (
        <div id={bodyId} className={isOpen ? 'border-t border-neutral-100 p-4 space-y-3' : printOpen ? 'hidden print:block border-t border-neutral-100 p-4 space-y-3' : 'hidden'}>
          {children}
        </div>
      )}
    </div>
  );
}

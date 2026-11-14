'use client';

/**
 * A file field in Dutch, for the achterwacht and the AIOS alike.
 *
 * The browser's own file input says "Choose File" and "No file chosen" in
 * the browser's language, not the page's: English on an English Chrome
 * (audit 1.2.2), like the date fields before 1.2.0 (components/DatumVeld.tsx).
 * Here the real input stays (so a label, getByLabel and setInputFiles reach
 * it, and Tab and Enter open the picker) but is visually hidden; next to it
 * stand a button "Bestand kiezen" and the name of the chosen file, or
 * "Geen bestand gekozen". A file dropped on the field is taken as well.
 *
 * The button is not a label of the input (that would add "Bestand kiezen"
 * to the field's name); it clicks the input, and shows its focus.
 */
import { useId, useRef, useState, type ReactNode } from 'react';

export function BestandKiezer({
  accept,
  onKies,
  id,
  disabled,
  wisNaKiezen,
  className,
  children,
  'aria-label': ariaLabel,
}: {
  accept: string;
  /** The chosen file, or null when the choice was cleared. */
  onKies: (bestand: File | null) => void;
  /** For a <label htmlFor> elsewhere; without it, give an aria-label. */
  id?: string;
  disabled?: boolean;
  /** Empty the input after each choice, so the same file can be chosen again. */
  wisNaKiezen?: boolean;
  className?: string;
  /** Shown above the button, inside the field (where a file can be dropped). */
  children?: ReactNode;
  'aria-label'?: string;
}) {
  const eigenId = useId();
  const veldId = id ?? eigenId;
  const veld = useRef<HTMLInputElement>(null);
  const [naam, setNaam] = useState<string | null>(null);

  const kies = (bestand: File | null) => {
    setNaam(bestand?.name ?? null);
    onKies(bestand);
  };

  return (
    <div
      className={className}
      onDragOver={(e) => {
        if (!disabled) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        const bestand = e.dataTransfer.files?.[0];
        if (!disabled && bestand) kies(bestand);
      }}
    >
      {children}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <input
          ref={veld}
          id={veldId}
          type="file"
          accept={accept}
          disabled={disabled}
          aria-label={ariaLabel}
          className="peer sr-only"
          onChange={(e) => {
            kies(e.target.files?.[0] ?? null);
            if (wisNaKiezen) e.target.value = '';
          }}
        />
        <span
          aria-hidden="true"
          onClick={() => !disabled && veld.current?.click()}
          className="px-3 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 cursor-pointer transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-blue-600 peer-focus-visible:ring-offset-2 peer-disabled:opacity-50 peer-disabled:cursor-not-allowed"
        >
          Bestand kiezen
        </span>
        <span className="text-neutral-700 break-all" data-testid="gekozen-bestand">
          {naam ?? 'Geen bestand gekozen'}
        </span>
      </div>
    </div>
  );
}

'use client';

/**
 * Date fields in dd-mm-jjjj, for the achterwacht and the AIOS alike.
 *
 * The browser's own date input follows the browser's language, not the
 * page's: on an English Chrome it asked for mm/dd/yyyy (1.2.0). These are
 * text fields that always read dd-mm-jjjj (and uu:mm on a 24-hour clock),
 * while the value going in and out stays YYYY-MM-DD and
 * YYYY-MM-DDTHH:MM, exactly as the native input gave it: no route changes.
 * A field that holds no real date gives '' like the native input did, and
 * shows that it is wrong once the user leaves it.
 *
 * The calendar button opens the browser's own date picker for whoever
 * prefers clicking; what it picks is written back as dd-mm-jjjj.
 */
import { useRef, useState } from 'react';
import { datumTijdNaarInvoer, invoerNaarDatumTijd, invoerNaarIso, isoNaarInvoer, tijdNaarIso } from '@/lib/datumInvoer';

type Gemeenschappelijk = {
  id?: string;
  className?: string;
  disabled?: boolean;
  'aria-label'?: string;
};

/** The width classes of a field are for the wrapper; the text field fills it. */
function wrapperKlasse(className: string | undefined): string {
  const breed = (className ?? '').split(/\s+/).filter((k) => /^w-/.test(k));
  return breed.length > 0 ? `relative inline-flex ${breed.join(' ')}` : 'relative inline-flex';
}

function zonderBreedte(className: string | undefined): string {
  return (className ?? '')
    .split(/\s+/)
    .filter((k) => k && !/^w-/.test(k))
    .join(' ');
}

function openKiezer(kiezer: HTMLInputElement | null) {
  if (!kiezer) return;
  try {
    kiezer.showPicker();
  } catch {
    // An older browser without showPicker: typing still works.
    kiezer.focus();
  }
}

export function DatumVeld({
  value,
  onChange,
  min,
  max,
  ...rest
}: Gemeenschappelijk & { value: string; onChange: (iso: string) => void; min?: string; max?: string }) {
  const [tekst, setTekst] = useState(() => isoNaarInvoer(value));
  const [vorige, setVorige] = useState(value);
  const [verlaten, setVerlaten] = useState(false);
  const kiezer = useRef<HTMLInputElement>(null);
  // A new value from outside (another field, a reset, an edit opened) replaces what the field shows.
  if (value !== vorige) {
    setVorige(value);
    if (value !== (invoerNaarIso(tekst) ?? '')) setTekst(isoNaarInvoer(value));
  }
  const fout = tekst.trim() !== '' && invoerNaarIso(tekst) === null;

  function zet(nieuw: string) {
    setTekst(nieuw);
    const iso = invoerNaarIso(nieuw) ?? '';
    setVorige(iso);
    if (iso !== value) onChange(iso);
  }

  return (
    <span className={wrapperKlasse(rest.className)}>
      <input
        id={rest.id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="dd-mm-jjjj"
        data-datumveld=""
        aria-label={rest['aria-label']}
        aria-invalid={fout && verlaten ? true : undefined}
        title={fout && verlaten ? 'Vul de datum in als dd-mm-jjjj, bijvoorbeeld 23-04-2027.' : undefined}
        disabled={rest.disabled}
        value={tekst}
        onChange={(e) => {
          setVerlaten(false);
          zet(e.target.value);
        }}
        onBlur={() => {
          setVerlaten(true);
          const iso = invoerNaarIso(tekst);
          if (iso) setTekst(isoNaarInvoer(iso));
        }}
        className={`${zonderBreedte(rest.className)} w-full pr-8 ${fout && verlaten ? 'border-red-600' : ''}`}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        disabled={rest.disabled}
        onClick={() => openKiezer(kiezer.current)}
        className="absolute right-1 top-1/2 -translate-y-1/2 px-1 text-neutral-600 hover:text-neutral-900 disabled:opacity-40"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <rect x="2" y="3" width="12" height="11" rx="1" />
          <path d="M2 6.5h12M5 1.5v3M11 1.5v3" />
        </svg>
      </button>
      <input
        ref={kiezer}
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        data-datumkiezer=""
        min={min}
        max={max}
        value={invoerNaarIso(tekst) ?? ''}
        onChange={(e) => {
          if (e.target.value) zet(isoNaarInvoer(e.target.value));
        }}
        className="absolute right-0 bottom-0 w-px h-px opacity-0 pointer-events-none"
      />
    </span>
  );
}

/** A deadline: a date and a time (uu:mm, 24-hour) in, YYYY-MM-DDTHH:MM out. */
export function DatumTijdVeld({ value, onChange, ...rest }: Gemeenschappelijk & { value: string; onChange: (waarde: string) => void }) {
  const [datum, setDatum] = useState(() => splits(value).datum);
  const [tijd, setTijd] = useState(() => splits(value).tijd);
  const [vorige, setVorige] = useState(value);
  const [tijdVerlaten, setTijdVerlaten] = useState(false);
  if (value !== vorige) {
    setVorige(value);
    if (value !== samen(datum, tijd)) {
      setDatum(splits(value).datum);
      setTijd(splits(value).tijd);
    }
  }

  function zet(d: string, t: string) {
    setDatum(d);
    setTijd(t);
    const waarde = samen(d, t);
    setVorige(waarde);
    if (waarde !== value) onChange(waarde);
  }

  const tijdFout = tijd.trim() !== '' && tijdNaarIso(tijd) === null;
  const label = rest['aria-label'];
  return (
    <span className={`${wrapperKlasse(rest.className)} gap-2`}>
      <span className="flex-1 min-w-0 inline-flex">
        <DatumVeld
          id={rest.id}
          aria-label={label}
          disabled={rest.disabled}
          className={`${zonderBreedte(rest.className)} w-full`}
          value={datum}
          onChange={(iso) => zet(iso, tijd)}
        />
      </span>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="uu:mm"
        data-tijdveld=""
        aria-label={label ? `${label}, tijd` : 'Tijd (uu:mm)'}
        aria-invalid={tijdFout && tijdVerlaten ? true : undefined}
        title={tijdFout && tijdVerlaten ? 'Vul de tijd in als uu:mm, bijvoorbeeld 17:00.' : undefined}
        disabled={rest.disabled}
        value={tijd}
        onChange={(e) => {
          setTijdVerlaten(false);
          zet(datum, e.target.value);
        }}
        onBlur={() => {
          setTijdVerlaten(true);
          const t = tijdNaarIso(tijd);
          if (t) setTijd(t);
        }}
        className={`${zonderBreedte(rest.className)} w-20 ${tijdFout && tijdVerlaten ? 'border-red-600' : ''}`}
      />
    </span>
  );
}

/** YYYY-MM-DDTHH:MM as the date (YYYY-MM-DD) and the time as shown (HH:MM). */
function splits(waarde: string): { datum: string; tijd: string } {
  const delen = datumTijdNaarInvoer(waarde);
  return { datum: invoerNaarIso(delen.datum) ?? '', tijd: delen.tijd };
}

function samen(datumIso: string, tijd: string): string {
  return invoerNaarDatumTijd(isoNaarInvoer(datumIso), tijd);
}

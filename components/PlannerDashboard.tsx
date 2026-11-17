'use client';

/**
 * Planner Dashboard Component
 *
 * Shows:
 * - Submission progress per staff member
 * - Live week coverage
 * - Large imbalances
 * - Part-time patterns status
 * - Submit on behalf button
 * - Export/reminder options
 * - Generate roster button
 */

import { createContext, useContext, useState, useEffect, useRef, useId, useSyncExternalStore, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useBodyScrollLock } from '@/lib/useBodyScrollLock';
import { useDialogDismiss } from '@/lib/useDialogDismiss';
import { ExportDialog, type ExportType } from './ExportDialog';
import { AutoReminderPanel } from './AutoReminderPanel';
import { RosterGenerationDialog } from './RosterGenerationDialog';
import { AssignmentGrid } from './AssignmentGrid';
import { AssignmentCalendar } from './AssignmentCalendar';
import { StaffingOverview } from './StaffingOverview';
import { ToegangslinksBeheer } from './ToegangslinksBeheer';
import { RosterPublicationDialog, mailControleZin } from './RosterPublicationDialog';
import { RebalanceSuggestions } from './RebalanceSuggestions';
import { FillGapsSummary } from './FillGapsSummary';
import { SwapRequestsOverview } from './SwapRequestsOverview';
import { hasUnappliedFillGapsDraft } from './FillGapsPanel';
import { periodeStatusTekst } from '@/lib/statusLabels';
import { FellowBadge } from './FellowBadge';
import { MailSettingsDialog } from './MailSettingsDialog';
import { MailWarning } from './MailWarning';
import { MailStatus } from './MailStatus';
import { PreferencesImportButton } from './PreferencesImportDialog';
import { withBasePath } from '@/lib/basePath';
import { herinnerdOpTekst, isRecentHerinnerd } from '@/lib/herinnerdOp';
import { foutTekst } from '@/lib/foutTekst';
import { telwoord } from '@/lib/telwoord';
import { ImportEnCorrecties } from '@/components/ImportEnCorrecties';
import { kanSaldoWijzigen, saldoInWoorden } from '@/lib/saldoWijzigen';
import { voorafNaam } from '@/lib/vooraf';
import { volgendeStap, type StapDoel } from '@/lib/volgendeStap';
import { ADRES, BOVENAAN, GROEPEN, actiefOnderdeel, nieuweIndeling, onderdeelVanStap, sleutelUitAdres, startOnderdeel, type OnderdeelSleutel } from '@/lib/periodeIndeling';
import { leesIndeling, volgIndeling } from '@/lib/indelingOnthouden';
import { InPlek } from './InPlek';

interface PersonProgress {
  person_id: string;
  codenaam: string;
  submission_status: string | null;
  submitted_at: string | null;
  deeltijd_gecontroleerd_op: string | null;
  has_parttime_patterns: boolean;
  blocked_days_count: number;
  has_absences: boolean;
  is_fellow: number;
  laatste_herinnering_op: string | null;
}

interface ImbalanceItem {
  person_id: string;
  codenaam: string;
  counter: string;
  delta: number;
  from_period: string;
}

interface DashboardData {
  period_id: string;
  period_name: string;
  status: string;
  deadline: string;
  pool_id: string;
  /** GEPUBLICEERD only: null while the roster is still voorlopig. */
  definitief_op: string | null;
  gepubliceerd_op: string | null;
  uitgenodigd_op: string | null;
  submission_stats: {
    not_started: number;
    in_progress: number;
    confirmed: number;
  };
  large_imbalances: ImbalanceItem[];
  large_balance_threshold: number;
  total_staff: number;
  staff_with_parttime: number;
  assignment_count: number;
}

/**
 * A collapsible card used to group secondary dashboard content (staff
 * status, export actions, rebalance suggestions, the roster itself) so the
 * period page isn't one long scroll of always-expanded cards.
 *
 * Fully controlled (open/pinned come from the parent, via PlannerDashboard's
 * openSections/pinnedSections) rather than native <details> state, because
 * the accordion behavior spans siblings - opening one section closes any
 * other open-but-unpinned one, which a single <details> element can't know
 * about on its own. The pin button only appears while open: pinning is a
 * "keep this open too" decision, meaningless on a section that's already
 * closed.
 */
/** What every Section reads: the layout, the sections with their titles and summaries, and the state of each layout. */
interface IndelingWaarde {
  modus: 'harmonica' | 'zijbalk';
  onderdelen: Record<SectionKey, { titel: string; hint?: string }>;
  // The accordion.
  openSections: Set<SectionKey>;
  pinnedSections: Set<SectionKey>;
  toggleOpen: (key: SectionKey) => void;
  togglePin: (key: SectionKey) => void;
  // The new layout (lib/periodeIndeling.ts).
  actief: SectionKey;
  inLijst: ReadonlySet<SectionKey>;
  adresVoor: (key: SectionKey) => string;
  kies: (key: SectionKey) => void;
}
const IndelingContext = createContext<IndelingWaarde | null>(null);

function Section({
  sleutel,
  keepMounted = false,
  children,
}: {
  sleutel: SectionKey;
  keepMounted?: boolean;
  children: ReactNode;
}) {
  const bodyId = useId();
  const ctx = useContext(IndelingContext)!;
  const { titel, hint } = ctx.onderdelen[sleutel];

  // The new layout (1.9.0): only the section that is chosen, with its title on top; one that reports its
  // summary (keepMounted) stays on the page unseen, as it does closed in the accordion.
  if (ctx.modus === 'zijbalk') {
    if (ctx.actief === sleutel) {
      // scroll-mt: under the app's blue bar, which sticks to the top below 1100 px with the period's name
      // in it (two rows on a phone). The title takes the focus after a choice (toonOnderdeel), so a
      // keyboard and a screen reader are in the section at once.
      return (
        <div className="card p-4 sm:p-6 scroll-mt-28 min-[1100px]:scroll-mt-4" data-testid={`onderdeel-${ADRES[sleutel]}`}>
          <h2 tabIndex={-1} className="text-xl font-bold text-neutral-900 focus:outline-none">
            {titel}
          </h2>
          {hint && <p className="text-sm text-neutral-500 mt-1">{hint}</p>}
          <div className="mt-4">{children}</div>
        </div>
      );
    }
    return keepMounted ? <div hidden>{children}</div> : null;
  }

  const isOpen = ctx.openSections.has(sleutel);
  const pinned = ctx.pinnedSections.has(sleutel);
  const onToggleOpen = () => ctx.toggleOpen(sleutel);
  const onTogglePin = () => ctx.togglePin(sleutel);
  const bodyExists = isOpen || keepMounted;
  return (
    <div className="card overflow-hidden">
      <div
        onClick={onToggleOpen}
        className="flex flex-wrap sm:flex-nowrap items-center justify-between gap-x-3 gap-y-1 p-4 cursor-pointer select-none hover:bg-neutral-50"
      >
        {/* The title is a heading with a button in it (the pattern for an accordion); the pin is next to it,
            not inside it, so Enter on the pin pins instead of folding. The click bubbles to the row. */}
        <h2 className="font-bold text-neutral-900">
          <button type="button" aria-expanded={isOpen} aria-controls={bodyExists ? bodyId : undefined} className="flex items-center gap-2 text-left">
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
        {/* On a phone the summary goes under the title instead of being cut off at the card's edge (1.6.1). */}
        <span className="flex items-center gap-3 min-w-0 sm:shrink-0">
          {hint && <span className="text-sm text-neutral-500 sm:text-right">{hint}</span>}
          {isOpen && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin();
              }}
              title={
                pinned
                  ? 'Losmaken: klapt dicht zodra je een andere sectie opent'
                  : 'Vastzetten: blijft open, ook als je een andere sectie opent'
              }
              aria-label={pinned ? 'Losmaken' : 'Vastzetten'}
              aria-pressed={pinned}
              className={`p-2.5 rounded transition-colors ${
                pinned ? 'text-red-600 hover:text-red-800' : 'text-neutral-500 hover:text-neutral-700'
              }`}
            >
              {/* A plain 📌 emoji doesn't work here - emoji glyphs carry
                  their own fixed color and ignore the text-color classes
                  above, so pinned/unpinned would look identical. This SVG
                  uses currentColor instead, so the color toggle above is
                  actually visible. Pinned is filled, not pinned an outline:
                  not by colour alone. */}
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <circle cx="10" cy="7" r="4" />
                <rect x="9" y="10" width="2" height="7" rx="1" />
              </svg>
            </button>
          )}
        </span>
      </div>
      {bodyExists && (
        <div id={bodyId} className={isOpen ? 'border-t border-neutral-100 p-4' : 'hidden'}>{children}</div>
      )}
    </div>
  );
}

/** Why a button that sends is off (0.87.0). */
const GEEN_MAIL = 'Versturen kan pas als de mail is ingesteld. Dat doet de beheerder bij Mailinstellingen.';

type SectionKey = OnderdeelSleutel;

/**
 * Brings the chosen section on screen with its title (1.10.0): the page stays where it was scrolled to,
 * so after a long section the next one began above the screen. Then the focus: the button a next step
 * points to, else the title.
 */
function toonOnderdeel(adres: string, elementId?: string, poging = 0) {
  const sectie = document.querySelector<HTMLElement>(`[data-testid="onderdeel-${adres}"]`);
  if (!sectie) return;
  const knop = elementId ? document.getElementById(elementId) : null;
  // The button of a section that still loads: a moment later, then the title after all.
  if (elementId && !knop && poging < 5) {
    window.setTimeout(() => toonOnderdeel(adres, elementId, poging + 1), 100);
    return;
  }
  if (knop) {
    knop.scrollIntoView({ block: 'center' });
    knop.focus({ preventScroll: true });
    return;
  }
  const marge = parseFloat(getComputedStyle(sectie).scrollMarginTop) || 0;
  const top = sectie.getBoundingClientRect().top;
  if (top < marge || top > window.innerHeight * 0.6) sectie.scrollIntoView({ block: 'start' });
  sectie.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
}

/** A click that opens the link elsewhere (new tab, new window) is the browser's. */
const gewoneKlik = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/**
 * The sections: the list all the way left on a wide screen, the menu behind the button in the blue bar on
 * a narrow one. "Periode" on top under no heading; the sections of a group moved in under its heading
 * with a thin line down the group (1.12.0, the planner's choice out of three sketches), so the headings
 * read as headings and it shows what belongs to each.
 */
function OnderdelenLijst({ naKeuze }: { naKeuze?: () => void }) {
  const ctx = useContext(IndelingContext)!;
  // A link with the section's address, so it opens in a new tab too. A plain click changes the address in
  // the browser itself (ctx.kies): no request to the server.
  const item = (k: SectionKey) => {
    const { titel, hint } = ctx.onderdelen[k];
    const actief = k === ctx.actief;
    return (
      <a
        key={k}
        href={ctx.adresVoor(k)}
        aria-current={actief ? 'page' : undefined}
        onClick={(e) => {
          if (!gewoneKlik(e)) return;
          e.preventDefault();
          naKeuze?.();
          ctx.kies(k);
        }}
        className={`block px-3 py-2.5 rounded-lg ${actief ? 'bg-blue-700 text-white' : 'hover:bg-neutral-50'}`}
      >
        <span className="block font-medium">{titel}</span>
        {hint && <span className={`block text-xs ${actief ? 'text-blue-100' : 'text-neutral-600'}`}>{hint}</span>}
      </a>
    );
  };
  return (
    <>
      {ctx.inLijst.has(BOVENAAN) && item(BOVENAAN)}
      {GROEPEN.map((groep) => {
        const items = groep.onderdelen.filter((k) => ctx.inLijst.has(k));
        if (items.length === 0) return null;
        return (
          <div key={groep.naam}>
            <p className="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-neutral-600">{groep.naam}</p>
            <div className="ml-4 pl-1.5 border-l-2 border-neutral-300">{items.map((k) => item(k))}</div>
          </div>
        );
      })}
    </>
  );
}

/**
 * The frame of the sections. The accordion: the sections as they were. The new layout (1.9.0): the list
 * of sections and the chosen section.
 *
 * 1.12.0 (the planner's wish): the list is no longer a column inside the page, below everything that
 * stood above the sections. On a wide screen it stands all the way left, from the blue bar down
 * (onderdelen-links, the page's own column). Below 1100 px its button is in the blue bar, left of
 * "Dienstrooster" (kop-links), and the list slides in from the left under that bar, which sticks to the
 * top there so the button is always in reach.
 */
function Onderdelen({ naWisselRef, children }: { naWisselRef: RefObject<{ sectie: SectionKey; element?: string } | null>; children: ReactNode }) {
  const ctx = useContext(IndelingContext)!;
  const [menuOpen, setMenuOpen] = useState(false);
  // Where the blue bar ends when the menu opened: the menu and the haze behind it start there.
  const [menuTop, setMenuTop] = useState(0);
  const menuKnopRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLElement>(null);
  const menuId = useId();
  const zijbalk = ctx.modus === 'zijbalk';

  // After the chosen section is on the page: its title in view and the focus there.
  useEffect(() => {
    const wacht = naWisselRef.current;
    if (!wacht || wacht.sectie !== ctx.actief) return;
    naWisselRef.current = null;
    toonOnderdeel(ADRES[wacht.sectie], wacht.element);
  }, [ctx.actief, naWisselRef]);

  // The blue bar sticks to the top below 1100 px while this layout is on the page (app/globals.css).
  useEffect(() => {
    if (!zijbalk) return;
    document.documentElement.dataset.kopPlakt = 'ja';
    return () => {
      delete document.documentElement.dataset.kopPlakt;
    };
  }, [zijbalk]);

  // The open menu: the focus goes to the section on screen, and Escape closes it.
  useEffect(() => {
    if (!menuOpen) return;
    (menuRef.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? menuRef.current?.querySelector<HTMLElement>('a'))?.focus();
    const toets = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenuOpen(false);
      menuKnopRef.current?.focus();
    };
    document.addEventListener('keydown', toets);
    return () => document.removeEventListener('keydown', toets);
  }, [menuOpen]);

  if (!zijbalk) return <>{children}</>;
  return (
    <div data-testid="indeling-nieuw">
      <InPlek plek="kop-links">
        <button
          ref={menuKnopRef}
          type="button"
          data-testid="onderdelen-menu"
          aria-label="Onderdelen van de periode"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          onClick={() => {
            if (!menuOpen) setMenuTop(Math.max(0, Math.round(menuKnopRef.current?.closest('header')?.getBoundingClientRect().bottom ?? 0)));
            setMenuOpen(!menuOpen);
          }}
          className="min-[1100px]:hidden -ml-2 w-11 h-11 flex items-center justify-center rounded hover:bg-white/10"
        >
          <svg className="w-7 h-7" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M3 5h14M3 10h14M3 15h14" />
          </svg>
        </button>
      </InPlek>
      {menuOpen && (
        <>
          {/* A tap next to the menu closes it. */}
          <div className="min-[1100px]:hidden fixed inset-x-0 bottom-0 z-30 bg-black/40" style={{ top: menuTop }} onClick={() => setMenuOpen(false)} data-testid="onderdelen-waas" />
          <nav
            ref={menuRef}
            id={menuId}
            aria-label="Onderdelen van de periode"
            className="min-[1100px]:hidden fixed left-0 bottom-0 z-30 w-[84%] max-w-xs bg-white shadow-xl p-2 overflow-y-auto overscroll-contain"
            style={{ top: menuTop }}
          >
            <OnderdelenLijst naKeuze={() => setMenuOpen(false)} />
          </nav>
        </>
      )}
      {/* Its own scroll bar: with ten sections the list is higher than a laptop screen, and stuck to the
          top its last items (the roster) could not be reached (1.10.0). */}
      <InPlek plek="onderdelen-links">
        <nav aria-label="Onderdelen van de periode" className="sticky top-0 max-h-screen overflow-y-auto px-2 py-4">
          <OnderdelenLijst />
        </nav>
      </InPlek>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * The period in the app's blue bar, between "Dienstrooster" and the version (1.12.0, the new layout): its
 * name, which is the page's heading there, and its status, which must stay in sight now that the block
 * with the status badge is a section of its own.
 */
function PeriodeInKop({ naam, status }: { naam: string; status: string }) {
  return (
    <InPlek plek="kop-midden">
      <div className="flex items-baseline gap-3 min-w-0 min-[1100px]:ml-2 min-[1100px]:pl-6 min-[1100px]:border-l min-[1100px]:border-white/40" data-testid="kop-periode">
        <h1 className="text-base min-[1100px]:text-lg font-semibold truncate">{naam}</h1>
        <span className="shrink-0 px-2.5 py-0.5 rounded-full border border-white/70 bg-white/15 text-[0.8125rem] font-semibold whitespace-nowrap">{status}</span>
      </div>
    </InPlek>
  );
}

/** Where each next step is on the page (lib/volgendeStap.ts): the section to open first, and the button to go to. */
const STAP_PLEK: Record<StapDoel, { sectie?: SectionKey; element: string }> = {
  uitnodigingen: { sectie: 'export', element: 'knop-uitnodigingen' },
  herinneringen: { sectie: 'export', element: 'knop-herinneringen' },
  // No section of its own: a button that changes the status. The accordion has them above the sections
  // (sluiten in the page's header, app/planner/period/[id]/page.tsx), the new layout in the section
  // "Periode" (onderdeelVanStap, lib/periodeIndeling.ts).
  sluiten: { element: 'knop-periode-sluiten' },
  genereren: { element: 'knop-genereren' },
  'lege-diensten': { sectie: 'vooraf', element: 'knop-lege-diensten' },
  publiceren: { element: 'knop-voorlopig-publiceren' },
  definitief: { element: 'knop-definitief-maken' },
};

interface Props {
  periodId: string;
  /**
   * Called when this dashboard changes the period's status (publishing,
   * generating). The surrounding page keeps its own copy of the period for
   * the header badge, so without this it would keep showing the old status
   * until a manual reload - you publish and the badge still says "Generated".
   */
  onPeriodChanged?: () => void;
  /** The status the page itself shows; a change made there (closing) reloads this dashboard. */
  periodStatus?: string;
  /**
   * The page's own block about the period: its name, dates, deadline, streefbereik, status and the buttons
   * that close and reopen it, with the notices under it (app/planner/period/[id]/page.tsx, which holds
   * their state). This dashboard decides where it goes, because it knows the layout: as the card on top
   * in the accordion ('kaart'), inside the section "Periode" in the new layout ('onderdeel', 1.12.0),
   * with this dashboard's own buttons (`acties`) under the status there.
   */
  periodeKop?: (vorm: 'kaart' | 'onderdeel', acties?: ReactNode) => ReactNode;
  /** For the blue bar in the new layout (PeriodeInKop). */
  periodeNaam?: string;
  periodeDefinitief?: boolean;
}

export function PlannerDashboard({ periodId, onPeriodChanged, periodStatus, periodeKop, periodeNaam, periodeDefinitief = false }: Props) {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [progress, setProgress] = useState<PersonProgress[]>([]);
  const [loading, setLoading] = useState(true);
  // loadError means the dashboard itself couldn't be fetched at all - fatal,
  // nothing else on this component can render meaningfully without it.
  // actionError is for an inline action failing (a reminder, the fellow box) with the
  // dashboard already showing - same split, and the same reasoning, as
  // AssignmentGrid's loadError/error: a rejected action isn't a reason to
  // blank out everything else the planner was looking at, and a planner
  // who fixes the underlying issue needs a way to dismiss it and try again
  // without a full page reload. Keyed by personId and rendered inside that
  // person's own row (see below), not as a page-level banner - the staff
  // table can run to 30+ rows, so a banner anywhere outside the row itself
  // (even at the top of this same card) can still land off-screen for
  // whichever row the planner actually scrolled to, making a real
  // rejection (e.g. no preferences to submit yet) look like the button did
  // nothing.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ personId: string; message: string } | null>(null);
  const [submittingFor, setSubmittingFor] = useState<string | null>(null);
  // Who got a reminder from this screen since it was opened ("Verstuurd ✓").
  const [remindedIds, setRemindedIds] = useState<Set<string>>(new Set());
  // Someone reminded in the last 24 hours (laatste_herinnering_op, also
  // after a refresh): the button asks first, with when that was.
  const [remindConfirm, setRemindConfirm] = useState<{ personId: string; op: string } | null>(null);
  const [remindAll, setRemindAll] = useState<
    { stage: 'idle' } | { stage: 'confirm' } | { stage: 'sending' } | { stage: 'done'; ok: boolean; message: string }
  >({ stage: 'idle' });
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  // Which screen ExportDialog opens straight to - null shows its own picker
  // (uitnodigingen/herinneringen/audit-trail). "Deadlineherinnering
  // versturen" below is a shortcut straight past that picker into
  // reminders, the same jump the period page used to offer on its own,
  // separate from this dashboard.
  const [exportInitialType, setExportInitialType] = useState<ExportType>(
    null
  );
  const [rosterDialogOpen, setRosterDialogOpen] = useState(false);
  // Shown instead of opening rosterDialogOpen when this browser is holding
  // staged-but-unapplied picks from "Rooster vooraf invullen" - see
  // hasUnappliedFillGapsDraft's own docstring for why generating without
  // applying them first silently throws them away.
  const [showUnappliedDraftWarning, setShowUnappliedDraftWarning] = useState(false);
  const [publicationDialogOpen, setPublicationDialogOpen] = useState(false);
  const [publicationStap, setPublicationStap] = useState<'voorlopig' | 'definitief'>('voorlopig');
  const [showUnpublishConfirm, setShowUnpublishConfirm] = useState(false);
  const [unpublishing, setUnpublishing] = useState(false);
  const [unpublishError, setUnpublishError] = useState<string | null>(null);
  // "Rooster opnieuw mailen": the first click asks, the second sends.
  const [roosterMailVraag, setRoosterMailVraag] = useState(false);
  const [roosterMailBezig, setRoosterMailBezig] = useState(false);
  const [roosterMailMelding, setRoosterMailMelding] = useState<{ fout: boolean; tekst: string } | null>(null);
  // Where the verzendlijst goes: the sentence after "Rooster opnieuw mailen" names that mailbox (mailControleZin).
  const [verzendlijstAan, setVerzendlijstAan] = useState<string | null>(null);
  // Accordion state for the four collapsible sections below (Personeel &
  // voortgang / Exporteren & communicatie / Voorstellen voor herverdeling /
  // Dienstrooster). At most one unpinned section is open at a time - opening
  // a section closes every other section that isn't pinned; a pinned one
  // stays open regardless of what else gets opened. Both start empty (every
  // section closed, nothing pinned) so the page loads as short as possible.
  const [openSections, setOpenSections] = useState<Set<SectionKey>>(() => new Set());
  const [pinnedSections, setPinnedSections] = useState<Set<SectionKey>>(() => new Set());
  // The new layout (1.9.0, lib/periodeIndeling.ts): ?indeling=nieuw while the accordion is the default,
  // ?onderdeel=... for the section on screen, so the back button and a link work.
  const searchParams = useSearchParams();
  // The layout: what the address says, else what this browser remembers (1.10.0, lib/indelingOnthouden.ts).
  // The new layout since 2.0.0; the accordion only for ?indeling=oud or the hidden flag (lib/indelingOnthouden.ts).
  const oudeIndeling = useSyncExternalStore(volgIndeling, leesIndeling, () => null);
  const zijbalk = nieuweIndeling(searchParams.get('indeling'), oudeIndeling);
  const gekozenOnderdeel = sleutelUitAdres(searchParams.get('onderdeel'));
  // Only the question mark and what follows: the browser keeps the page's own address, sub-folder included.
  const adresVoor = (key: SectionKey): string => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('onderdeel', ADRES[key]);
    return `?${params.toString()}`;
  };
  // The section a click just chose, and the button a next step points to in it (Onderdelen, toonOnderdeel).
  const naWisselRef = useRef<{ sectie: SectionKey; element?: string } | null>(null);

  const toggleSectionOpen = (key: SectionKey) => {
    setOpenSections((prev) => {
      if (prev.has(key)) {
        const next = new Set(prev);
        next.delete(key);
        return next;
      }
      // Opening: keep whichever currently-open sections are pinned, drop
      // the rest, add this one.
      const next = new Set<SectionKey>();
      prev.forEach((k) => {
        if (pinnedSections.has(k)) next.add(k);
      });
      next.add(key);
      return next;
    });
  };

  const toggleSectionPin = (key: SectionKey) => {
    // Pinning/unpinning never itself opens or closes anything - it only
    // changes what happens the next time some OTHER section is opened (see
    // toggleSectionOpen above). Unpinning an already-open section leaves it
    // open until that moment.
    setPinnedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Forces AssignmentGrid/AssignmentCalendar to remount (and so refetch)
  // after any roster (re)generation - their own fetch effects only depend
  // on periodId, which never changes across a regenerate, so without this
  // they'd keep showing the previous roster until an unrelated prop change
  // happened to remount them.
  const [assignmentsRefreshKey, setAssignmentsRefreshKey] = useState(0);
  const [assignmentsView, setAssignmentsView] = useState<'list' | 'calendar' | 'dienstdoende' | 'ruilverzoeken'>('list');
  // The single most recent reversible assign/reassign/remove for this
  // period, read from the server (lib/pendingUndo.ts). Only for the acute
  // moment (0.106.0, the planner's wish): what was already there when this
  // page opened stays hidden (undoBasis holds its id), so a reload or a new
  // login shows no button, and what is shown goes away after two minutes,
  // as the server stops accepting it by then.
  const [pendingUndo, setPendingUndo] = useState<{ id: string; label: string; onderdeel?: string; verloopt_over_seconden: number } | null>(null);
  // undefined: not read yet; null: nothing was there when the page opened.
  const undoBasis = useRef<string | null | undefined>(undefined);
  const [undoing, setUndoing] = useState(false);
  const [mailSettingsOpen, setMailSettingsOpen] = useState(false);
  // Bumped when the mail settings change, so the automatic-reminder panel
  // re-reads whether sending is set up.
  const [mailSettingsKey, setMailSettingsKey] = useState(0);
  // Only the beheerder sets up the mail (0.87.0): a planner sees how it stands.
  const [beheerder, setBeheerder] = useState(false);
  // Whether mail can go out (null: not known yet). Without it the buttons
  // that send are off and say why, as on the AIOS's page (0.87.0): they
  // used to answer with an error only after the click.
  const [mailIngesteld, setMailIngesteld] = useState<boolean | null>(null);
  // Whether the red notice about mail shows (MailWarning): the list says so at "Periode", where it is in the new layout.
  const [mailMeldingZichtbaar, setMailMeldingZichtbaar] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  // null = not known yet (still loading, or load failed) - the "Voorstellen
  // voor herverdeling" section stays visible in that case, so a load error
  // is never silently hidden. Only a confirmed 0 hides the section, so an
  // empty result doesn't cost a permanently-visible empty-state card (see
  // RebalanceSuggestions' own onCountChange call).
  const [suggestionCount, setSuggestionCount] = useState<number | null>(null);
  // Unfilled-slot count behind the "Rooster vooraf invullen" section hint,
  // reported by FillGapsSummary itself (its own dedicated endpoint, not
  // part of the /dashboard payload above).
  const [fillGapsCount, setFillGapsCount] = useState<number | null>(null);
  // Makes FillGapsSummary refetch in place. Deliberately separate from
  // assignmentsRefreshKey: a single reassign/remove (AssignmentGrid/
  // AssignmentCalendar's onChanged) can open or close a gap and so change
  // this count, but must NOT bump assignmentsRefreshKey too - that would
  // remount the assignments list/calendar on every pick, the exact
  // page-refresh-on-assign bug fixed earlier (see loadData's own comment).
  const [fillGapsRefreshKey, setFillGapsRefreshKey] = useState(0);

  // Called unconditionally, above every early return below (loading/error/
  // !dashboard) - both hooks are no-ops while showUnpublishConfirm is
  // false, but React requires the call itself to happen on every render.
  useBodyScrollLock(showUnpublishConfirm);
  const dismissUnpublishBackdrop = useDialogDismiss(showUnpublishConfirm, () => setShowUnpublishConfirm(false), !unpublishing);
  useBodyScrollLock(showUnappliedDraftWarning);
  const dismissUnappliedDraftBackdrop = useDialogDismiss(showUnappliedDraftWarning, () => setShowUnappliedDraftWarning(false));

  // bumpAssignmentsKey defaults to true - a full dashboard reload (mount,
  // a fellow change, or the roster dialog's own onSuccess) means the
  // assignments list/calendar's data could be stale in a way its own
  // fetch effect won't notice on its own (a genuinely new dataset after
  // regeneration), so remounting them is the safe default there.
  //
  // AssignmentGrid/AssignmentCalendar's own onChanged (a single right-click
  // assign/reassign/remove) passes false: both already call their own
  // load()/loadSlots() and update in place before calling onChanged, so
  // remounting them here on top of that threw away the state they'd just
  // fetched and fetched it again from scratch - visible as the whole
  // calendar/list flashing to a loading state and back on every single
  // pick, which read as "the page refreshes" even though no navigation
  // happened.
  const loadData = async (bumpAssignmentsKey: boolean = true) => {
    try {
      const [dashRes, progRes] = await Promise.all([
        fetch(withBasePath(`/api/planner/period/${periodId}/dashboard`)),
        fetch(withBasePath(`/api/planner/period/${periodId}/progress`)),
      ]);

      if (!dashRes.ok || !progRes.ok) throw new Error('Laden van dashboard mislukt');

      const dashData = await dashRes.json();
      const progData = await progRes.json();

      setLoadError(null);
      setDashboard(dashData.data);
      setProgress(progData.data);
      setLoading(false);
      if (bumpAssignmentsKey) setAssignmentsRefreshKey((k) => k + 1);
    } catch (err) {
      setLoadError(foutTekst(err, 'Laden van dashboard mislukt'));
      setLoading(false);
    }

    // Best-effort, on its own: this is an auxiliary affordance, not core
    // dashboard data, so a failure here must never block the rest of the
    // page from loading the way the checks above do.
    try {
      const pendingRes = await fetch(withBasePath(`/api/planner/period/${periodId}/assignments/pending-undo`));
      const pendingData = await pendingRes.json();
      const gelezen = pendingRes.ok ? pendingData.data?.pending ?? null : null;
      if (undoBasis.current === undefined) undoBasis.current = gelezen?.id ?? null;
      setPendingUndo(gelezen && gelezen.id !== undoBasis.current ? gelezen : null);
    } catch {
      setPendingUndo(null);
    }
  };

  useEffect(() => {
    setSuggestionCount(null);
    undoBasis.current = undefined;
    setPendingUndo(null);
    loadData();
  }, [periodId]);

  // The button goes away when the two minutes are over.
  useEffect(() => {
    if (!pendingUndo) return;
    const timer = setTimeout(() => setPendingUndo(null), pendingUndo.verloopt_over_seconden * 1000);
    return () => clearTimeout(timer);
  }, [pendingUndo]);

  useEffect(() => {
    fetch(withBasePath('/api/planner/mail-settings'))
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        setMailIngesteld(data?.success ? Boolean(data.data.ingesteld) : null);
        setVerzendlijstAan(data?.success ? (data.data.verzendlijst_aan ?? null) : null);
      })
      .catch(() => setMailIngesteld(null));
  }, [mailSettingsKey]);

  useEffect(() => {
    fetch(withBasePath('/api/auth/me'))
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setBeheerder(data?.data?.role === 'ADMIN'))
      .catch(() => setBeheerder(false));
  }, []);

  // Closing the period happens in the page header, outside this component.
  useEffect(() => {
    if (periodStatus && dashboard && periodStatus !== dashboard.status) loadData();
  }, [periodStatus]);

  // Only asked for on a GEPUBLICEERD period - every route this calls
  // requires a reason there, same as a direct reassign/remove would.
  const [undoReasonPromptOpen, setUndoReasonPromptOpen] = useState(false);
  const [undoReason, setUndoReason] = useState('');

  const handleUndoLast = async (reason?: string) => {
    setUndoing(true);
    setUndoError(null);
    try {
      const res = await fetch(withBasePath(`/api/planner/period/${periodId}/assignments/undo-last`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.error?.code === 'REASON_REQUIRED') {
          setUndoReasonPromptOpen(true);
          return;
        }
        throw new Error(data.error?.message || 'Ongedaan maken mislukt');
      }
      setUndoReasonPromptOpen(false);
      setUndoReason('');
      await loadData(false);
      setAssignmentsRefreshKey((k) => k + 1);
    } catch (err) {
      setUndoError(foutTekst(err, 'Ongedaan maken mislukt'));
    } finally {
      setUndoing(false);
    }
  };

  const handleUnpublish = async () => {
    setUnpublishing(true);
    setUnpublishError(null);
    try {
      const res = await fetch(withBasePath(`/api/planner/period/${periodId}/unpublish`), { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error((typeof data.error === 'string' ? data.error : data.error?.message) || 'Intrekken van publicatie mislukt');
      }
      setShowUnpublishConfirm(false);
      await loadData();
      // The status badge at the top of the page is the page's own state.
      onPeriodChanged?.();
    } catch (err) {
      setUnpublishError(foutTekst(err, 'Intrekken van publicatie mislukt'));
    } finally {
      setUnpublishing(false);
    }
  };

  // A reminder with the standard text, straight away (POST .../remind):
  // one person, or without personId everyone who hasn't handed in yet.
  // Without `opnieuw` the server skips (everyone) or refuses (one person)
  // whoever was reminded in the last 24 hours.
  type RemindResult =
    | { ok: true; aantal: number; overgeslagen: number }
    | { ok: false; message: string; recentOp?: string };
  const sendReminder = async (personId?: string, opnieuw = false): Promise<RemindResult> => {
    try {
      const res = await fetch(withBasePath(`/api/planner/period/${periodId}/remind`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(personId ? { person_id: personId } : {}), ...(opnieuw ? { opnieuw: true } : {}) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        return {
          ok: false,
          message: data?.error?.message || 'Versturen mislukt',
          recentOp: data?.error?.code === 'RECENT_HERINNERD' ? data.error.laatste_herinnering_op : undefined,
        };
      }
      return { ok: true, aantal: data.data.aantal, overgeslagen: data.data.overgeslagen ?? 0 };
    } catch {
      return { ok: false, message: 'Versturen mislukt. Controleer de verbinding en probeer het opnieuw.' };
    }
  };

  // Who was reminded when, straight from the server (also what another
  // planner or the automatic reminder sent meanwhile).
  const refreshProgress = async () => {
    try {
      const res = await fetch(withBasePath(`/api/planner/period/${periodId}/progress`));
      if (res.ok) setProgress((await res.json()).data);
    } catch {
      // The table keeps what it showed; the next load corrects it.
    }
  };

  const handleRemindOne = async (person: PersonProgress, opnieuw = false) => {
    const personId = person.person_id;
    setActionError(null);
    if (!opnieuw && isRecentHerinnerd(person.laatste_herinnering_op)) {
      setRemindConfirm({ personId, op: person.laatste_herinnering_op! });
      return;
    }
    setRemindConfirm(null);
    setSubmittingFor(personId);
    const result = await sendReminder(personId, opnieuw);
    if (result.ok) {
      setRemindedIds((prev) => new Set(prev).add(personId));
      await refreshProgress();
    } else if (result.recentOp) {
      // Someone else (or the automatic reminder) got there first.
      setRemindConfirm({ personId, op: result.recentOp });
      await refreshProgress();
    } else {
      setActionError({ personId, message: result.message });
    }
    setSubmittingFor(null);
  };

  const handleRemindAll = async (opnieuw: boolean) => {
    setRemindAll({ stage: 'sending' });
    const result = await sendReminder(undefined, opnieuw);
    if (result.ok) {
      const overgeslagen =
        result.overgeslagen > 0
          ? ` ${result.overgeslagen} ${result.overgeslagen === 1 ? 'persoon kreeg' : 'personen kregen'} de afgelopen 24 uur al een herinnering en ${result.overgeslagen === 1 ? 'is' : 'zijn'} overgeslagen.`
          : '';
      setRemindAll({
        stage: 'done',
        ok: true,
        message: `Herinnering verstuurd aan ${result.aantal} ${result.aantal === 1 ? 'persoon' : 'personen'}.${overgeslagen}`,
      });
    } else {
      setRemindAll({ stage: 'done', ok: false, message: result.message });
    }
    await refreshProgress();
  };

  // The planner may change who is a fellow (lib/fellows.ts) until the
  // roster is generated; the participant only until the deadline.
  const handleToggleFellow = async (personId: string, fellow: boolean) => {
    setSubmittingFor(personId);
    setActionError(null);
    // Ticked at once, put back if saving fails (the reload below re-sorts).
    const setLocal = (value: boolean) =>
      setProgress((prev) => prev.map((p) => (p.person_id === personId ? { ...p, is_fellow: value ? 1 : 0 } : p)));
    setLocal(fellow);
    try {
      const res = await fetch(withBasePath(`/api/person/${personId}/fellow`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period_id: periodId, fellow }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message || 'Aanpassen mislukt');
      }
      await loadData();
    } catch (err) {
      setLocal(!fellow);
      setActionError({ personId, message: foutTekst(err, 'Aanpassen mislukt') });
    } finally {
      setSubmittingFor(null);
    }
  };

  // What is on the page whatever this dashboard has to show: in the accordion the page's block about the
  // period on top, in the new layout the period in the blue bar and the room of the list on the left
  // kept, so the page does not jump when the list comes.
  const statusTekst = periodeStatusTekst(dashboard?.status ?? periodStatus ?? '', Boolean(dashboard ? dashboard.definitief_op : periodeDefinitief));
  const kader = zijbalk ? (
    <>
      {periodeNaam && <PeriodeInKop naam={periodeNaam} status={statusTekst} />}
      {!dashboard && (
        <InPlek plek="onderdelen-links">
          <div aria-hidden="true" />
        </InPlek>
      )}
    </>
  ) : (
    periodeKop?.('kaart')
  );

  if (loading) {
    return (
      <>
        {kader}
        <div className="card p-8 text-center">
          <p className="text-lg text-neutral-600">Dashboard laden...</p>
        </div>
      </>
    );
  }

  if (loadError) {
    return (
      <>
        {kader}
        <div className="card p-8 bg-red-50 border border-red-200 flex items-center justify-between gap-3">
          <p className="text-red-700">{loadError}</p>
          <button
            onClick={() => loadData()}
            className="shrink-0 px-3 py-1.5 rounded text-sm font-medium bg-red-600 text-white hover:bg-red-700"
          >
            Opnieuw proberen
          </button>
        </div>
      </>
    );
  }

  if (!dashboard) {
    return (
      <>
        {kader}
        <div className="card p-8">
          <p className="text-neutral-600">Geen dashboardgegevens beschikbaar</p>
        </div>
      </>
    );
  }

  // The "ongedaan maken" banner sits inside the section the change was
  // made in (pendingUndo.onderdeel, lib/pendingUndo.ts), so it folds away
  // with it. "Voorstellen voor herverdeling" hides itself once nothing is
  // left to suggest; its undo then goes under the roster instead.
  const herverdelingZichtbaar = dashboard.assignment_count > 0 && suggestionCount !== 0;
  const undoOnderdeel = !pendingUndo
    ? null
    : pendingUndo.onderdeel === 'VOORAF' || (pendingUndo.onderdeel === 'HERVERDELING' && herverdelingZichtbaar)
      ? pendingUndo.onderdeel
      : 'ROOSTER';
  const undoBanner = (onderdeel: 'ROOSTER' | 'VOORAF' | 'HERVERDELING') =>
    undoOnderdeel === onderdeel && pendingUndo ? (
      <div className="mb-4 space-y-2">
        <div className="p-3 rounded-lg bg-blue-50 border border-blue-200 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-sm text-blue-900">
            <span className="font-medium">Laatst gewijzigd:</span> {pendingUndo.label}
          </p>
          {undoReasonPromptOpen ? (
            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="text"
                value={undoReason}
                onChange={(e) => setUndoReason(e.target.value)}
                placeholder="Reden (verplicht bij gepubliceerd rooster)"
                className="px-2 py-1 border rounded text-sm"
                autoFocus
              />
              <button
                onClick={() => handleUndoLast(undoReason)}
                disabled={undoing || !undoReason.trim()}
                className="px-3 py-1.5 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {undoing ? 'Bezig…' : 'Bevestigen'}
              </button>
              <button
                onClick={() => {
                  setUndoReasonPromptOpen(false);
                  setUndoReason('');
                }}
                disabled={undoing}
                className="px-3 py-1.5 rounded text-sm font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300"
              >
                Annuleren
              </button>
            </div>
          ) : (
            <button
              onClick={() => handleUndoLast()}
              disabled={undoing}
              className="shrink-0 px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {undoing ? 'Bezig…' : '↩️ Ongedaan maken'}
            </button>
          )}
        </div>
        {undoError && (
          <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">{undoError}</div>
        )}
      </div>
    ) : onderdeel === 'ROOSTER' && !pendingUndo && undoError ? (
      // The undo went wrong and there is nothing left to undo (someone
      // else changed it meanwhile): the message still needs a place.
      <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">{undoError}</div>
    ) : null;

  const stats = dashboard.submission_stats;
  const totalSubmissions = stats.not_started + stats.in_progress + stats.confirmed;
  const submissionProgress =
    totalSubmissions > 0 ? Math.round((stats.confirmed / totalSubmissions) * 100) : 0;

  // Once GEGENEREERD/GEPUBLICEERD, the solver has run - status alone
  // already answers "how is this roster filled". Before that, the only
  // possible source is a planner's own manual pre-fill (see
  // generate-roster/route.ts's manual_assignments handling for why doing
  // that before generating is safe: the solver respects it).
  const verstuurRoosterMail = async () => {
    setRoosterMailBezig(true);
    setRoosterMailMelding(null);
    try {
      const res = await fetch(withBasePath(`/api/planner/period/${periodId}/rooster-mail`), { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setRoosterMailMelding({ fout: true, tekst: data?.error?.message ?? 'Opnieuw mailen is mislukt.' });
      } else if (data.data.mail.verstuurd) {
        setRoosterMailMelding({ fout: false, tekst: `De mail met het ${data.data.soort === 'definitief' ? 'definitieve' : 'voorlopige'} rooster is opnieuw verstuurd (${data.data.mail.aantal} personen). ${mailControleZin(verzendlijstAan)}` });
      } else {
        setRoosterMailMelding({ fout: true, tekst: data.data.mail.melding });
      }
    } catch {
      setRoosterMailMelding({ fout: true, tekst: 'Geen verbinding met de server. Controleer je netwerk.' });
    } finally {
      setRoosterMailBezig(false);
      setRoosterMailVraag(false);
    }
  };

  const isGenerated = dashboard.status === 'GEGENEREERD' || dashboard.status === 'GEPUBLICEERD';
  const rosterFillState: 'LEEG' | 'HANDMATIG_DEELS' | 'AUTOMATISCH' = isGenerated
    ? 'AUTOMATISCH'
    : dashboard.assignment_count > 0
      ? 'HANDMATIG_DEELS'
      : 'LEEG';
  const rosterHeading: Record<typeof rosterFillState, string> = {
    LEEG: 'Dienstrooster (nog niet ingevuld)',
    HANDMATIG_DEELS: 'Dienstrooster (handmatig deels ingevuld)',
    AUTOMATISCH: 'Dienstrooster (automatisch ingevuld)',
  };
  const generateButtonLabel: Record<typeof rosterFillState, string> = {
    LEEG: '🚀 Rooster genereren met solver',
    HANDMATIG_DEELS: '🚀 Rooster aanvullen met solver',
    AUTOMATISCH: '🔄 Rooster opnieuw genereren met solver',
  };

  // "Volgende stap" (1.8.0): what the planner does now, and the button that takes them there.
  const stapNu = volgendeStap({
    status: dashboard.status,
    deadline: dashboard.deadline,
    uitgenodigd_op: dashboard.uitgenodigd_op,
    gepubliceerd_op: dashboard.gepubliceerd_op,
    definitief_op: dashboard.definitief_op,
    submission_stats: dashboard.submission_stats,
    lege_diensten: fillGapsCount,
    mail_ingesteld: mailIngesteld,
  });
  // One list of the sections: the accordion and the new layout read title, summary and whether it is
  // there from here, so the two cannot drift apart.
  const naStart = ['OPEN', 'GESLOTEN', 'GEGENEREERD', 'GEPUBLICEERD'].includes(dashboard.status);
  // "Periode" (1.12.0): its summary is the status, and that a notice waits there (mail not going out,
  // large differences), which until then stood above every section.
  const meldingen = (mailMeldingZichtbaar ? 1 : 0) + (dashboard.large_imbalances.length > 0 ? 1 : 0);
  const onderdelen: Record<SectionKey, { titel: string; hint?: string; zichtbaar: boolean }> = {
    periode: {
      titel: 'Periode',
      hint: `${statusTekst.toLowerCase()}${meldingen > 0 ? ` · ${telwoord(meldingen, 'melding', 'meldingen')}` : ''}`,
      zichtbaar: zijbalk,
    },
    importcorrecties: {
      titel: 'Import en correcties',
      hint: kanSaldoWijzigen(dashboard.status) ? 'kan tot het genereren' : 'alleen vóór het genereren',
      zichtbaar: naStart,
    },
    overloop: { titel: 'Eerdere toewijzingen', zichtbaar: naStart },
    vooraf: {
      titel: voorafNaam(dashboard.status),
      hint:
        fillGapsCount === null
          ? undefined
          : fillGapsCount === 0
            ? 'alles ingevuld'
            : `${fillGapsCount} dienst${fillGapsCount === 1 ? '' : 'en'} nog niet ingevuld`,
      zichtbaar: naStart,
    },
    personeel: {
      titel: 'Status voorkeuren',
      hint: `${telwoord(dashboard.total_staff, 'persoon', 'personen')} · ${stats.confirmed} bevestigd, ${stats.in_progress} bezig, ${stats.not_started} niet begonnen`,
      zichtbaar: true,
    },
    personeelbeheren: { titel: 'Personeel beheren', zichtbaar: true },
    export: {
      titel: 'Exporteren & communicatie',
      hint: `uitnodigingen, herinneringen, statusrapport, voorkeurenoverzicht, wijzigingsgeschiedenis, ${beheerder ? 'mailinstellingen' : 'mail'}`,
      zichtbaar: true,
    },
    links: { titel: 'Persoonlijke links', hint: 'uitgegeven links en intrekken', zichtbaar: beheerder },
    // Mounted (keepMounted) until it reports nothing to suggest, as before; in the list only with something in it.
    voorstellen: {
      titel: 'Voorstellen voor herverdeling',
      hint: suggestionCount ? `${suggestionCount} voorstel${suggestionCount === 1 ? '' : 'len'}` : undefined,
      zichtbaar: dashboard.assignment_count > 0 && suggestionCount !== 0,
    },
    rooster: { titel: rosterHeading[rosterFillState], zichtbaar: naStart },
  };
  const zichtbaar = new Set((Object.keys(onderdelen) as SectionKey[]).filter((k) => onderdelen[k].zichtbaar));
  const inLijst = new Set([...zichtbaar].filter((k) => k !== 'voorstellen' || Boolean(suggestionCount)));
  const actiefOnderdeelNu = actiefOnderdeel(gekozenOnderdeel, startOnderdeel(stapNu?.doel, dashboard.status), inLijst);
  // Another section: the address changes in the browser itself (Next follows history.pushState), so
  // nothing waits for the server. Until 1.10.0 it was a navigation: every click asked the server for the
  // page again, a slow one made each section slow and without a connection the whole page was gone.
  const kiesOnderdeel = (key: SectionKey, element?: string) => {
    if (key === actiefOnderdeelNu) {
      toonOnderdeel(ADRES[key], element);
      return;
    }
    naWisselRef.current = { sectie: key, element };
    window.history.pushState(null, '', adresVoor(key));
  };
  const indeling = {
    modus: zijbalk ? ('zijbalk' as const) : ('harmonica' as const),
    onderdelen,
    openSections,
    pinnedSections,
    toggleOpen: toggleSectionOpen,
    togglePin: toggleSectionPin,
    actief: actiefOnderdeelNu,
    inLijst,
    adresVoor,
    kies: (key: SectionKey) => kiesOnderdeel(key),
  };

  const gaNaarStap = (doel: StapDoel) => {
    const { sectie, element } = STAP_PLEK[doel];
    // The new layout shows the section by its address and gives the button the focus once it is there
    // (a timer lost that race against any real network, 1.10.0). The accordion opens it.
    if (zijbalk) {
      kiesOnderdeel(onderdeelVanStap(sectie), element);
      return;
    }
    if (sectie && !openSections.has(sectie)) toggleSectionOpen(sectie);
    // After the section has opened: the button there gets the focus, so Enter does it.
    window.setTimeout(() => {
      const doelElement = document.getElementById(element);
      doelElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      doelElement?.focus();
    }, 50);
  };

  // What stood above the sections until 1.12.0, as pieces: the accordion still puts them there, the new
  // layout inside the section "Periode".
  const kanGenereren = ['GESLOTEN', 'GEGENEREERD'].includes(dashboard.status);
  // Mail not going out: period-wide.
  const mailMelding = (
    <MailWarning
      refreshKey={`${mailSettingsKey}|${exportDialogOpen}`}
      onOpenSettings={beheerder ? () => setMailSettingsOpen(true) : undefined}
      onStand={setMailMeldingZichtbaar}
    />
  );
  // Large imbalances: an actionable warning, not a summary stat.
  const groteVerschillen = (
    <>
      {dashboard.large_imbalances.length > 0 && (
        <div className="card p-6 bg-amber-50 border border-amber-200">
          <h3 className="font-bold text-lg mb-3">
            ⚠️ Grote verschillen (≥{telwoord(dashboard.large_balance_threshold, 'dienst', 'diensten')} verschil)
          </h3>
          <div className="space-y-2">
            {dashboard.large_imbalances.slice(0, 8).map((item) => (
              <div key={`${item.person_id}-${item.counter}`} className="flex justify-between text-sm">
                <span className="font-medium">{item.codenaam}</span>
                <span className="text-amber-800">
                  {/* "2 weekenddiensten extra", not "2 weekenddienst extra" (audit 1.2.2). */}
                  {saldoInWoorden(item.counter, item.delta)}
                </span>
              </div>
            ))}
            {dashboard.large_imbalances.length > 8 && (
              <p className="text-xs text-amber-700 pt-2">
                ... en {dashboard.large_imbalances.length - 8} meer verschillen
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
  // The buttons that change the status. In the section a button that can't be pressed in this status is
  // left out: Volgende stap says what comes first.
  const statusKnoppen = (
    <>
          {(!zijbalk || kanGenereren) && (
          <button
            onClick={() => {
              if (hasUnappliedFillGapsDraft(periodId)) {
                setShowUnappliedDraftWarning(true);
              } else {
                setRosterDialogOpen(true);
              }
            }}
            disabled={!kanGenereren}
            title={
              dashboard.status === 'GEPUBLICEERD'
                ? 'Een gepubliceerd rooster is bevroren en kan niet meer opnieuw gegenereerd worden'
                : !kanGenereren
                  ? 'Sluit de periode eerst. Dan staan voorkeuren en afwezigheid vast.'
                  : undefined
            }
            id="knop-genereren"
            className="px-4 py-2 rounded font-medium bg-purple-600 text-white hover:bg-purple-700 disabled:bg-neutral-400 transition-colors"
          >
            {generateButtonLabel[rosterFillState]}
          </button>
          )}
          {dashboard.status === 'GEGENEREERD' && (
            <button
              onClick={() => {
                setPublicationStap('voorlopig');
                setPublicationDialogOpen(true);
              }}
              id="knop-voorlopig-publiceren"
              className="px-4 py-2 rounded font-medium bg-emerald-700 text-white hover:bg-emerald-800 transition-colors"
            >
              ✅ Voorlopig publiceren
            </button>
          )}
          {dashboard.status === 'GEPUBLICEERD' && !dashboard.definitief_op && (
            <button
              onClick={() => {
                setPublicationStap('definitief');
                setPublicationDialogOpen(true);
              }}
              id="knop-definitief-maken"
              className="px-4 py-2 rounded font-medium bg-emerald-700 text-white hover:bg-emerald-800 transition-colors"
            >
              🔏 Definitief maken
            </button>
          )}
          {dashboard.status === 'GEPUBLICEERD' && (
            <button
              onClick={() => {
                setUnpublishError(null);
                setShowUnpublishConfirm(true);
              }}
              className="px-4 py-2 rounded font-medium bg-white border border-red-300 text-red-700 hover:bg-red-50 transition-colors"
            >
              ↩️ Publicatie intrekken
            </button>
          )}
          {dashboard.status === 'GEPUBLICEERD' && (
            <button
              disabled={roosterMailBezig}
              onClick={() => (roosterMailVraag ? verstuurRoosterMail() : setRoosterMailVraag(true))}
              className="px-4 py-2 rounded font-medium bg-white border border-neutral-300 text-neutral-800 hover:bg-neutral-50 disabled:opacity-50 transition-colors"
            >
              {roosterMailBezig ? 'Bezig…' : roosterMailVraag ? 'Zeker weten? Iedereen krijgt de mail opnieuw' : '✉️ Rooster opnieuw mailen'}
            </button>
          )}
    </>
  );
  const roosterMailUitkomst = roosterMailMelding && (
    <p role="status" className={`text-sm mt-2 ${roosterMailMelding.fout ? 'text-red-700' : 'text-emerald-800'}`}>
      {roosterMailMelding.tekst}
    </p>
  );
  const voorlopigUitleg = dashboard.status === 'GEPUBLICEERD' && !dashboard.definitief_op && (
    <p className="text-xs text-neutral-600 mt-1">
      Iedereen kan het rooster nu controleren. Voer correcties gewoon in het rooster in. Komen er
      geen reacties meer, bijvoorbeeld na twee weken? Maak het rooster dan definitief. Iedereen
      krijgt dan het definitieve rooster met de wijzigingen.
    </p>
  );

  return (
    <>
    {kader}
    <div className="space-y-4">
      {stapNu && (
        <div className="card p-4 border-l-4 border-blue-700 bg-blue-50" data-testid="volgende-stap" role="status">
          <p className="text-sm text-neutral-900">
            <span className="font-semibold">Volgende stap: </span>
            {stapNu.tekst}
          </p>
          {stapNu.doel && (
            <button
              onClick={() => gaNaarStap(stapNu.doel!)}
              className="mt-2 text-sm font-medium text-blue-800 underline hover:text-blue-900"
            >
              {stapNu.knop}
            </button>
          )}
        </div>
      )}

      {/* No separate stats-summary card here anymore - it duplicated
          exactly what "Status voorkeuren" already shows in its own
          section hint below (visible whether that section is open or
          closed), just phrased slightly differently. */}

      {/* The accordion: the notices and the buttons a planner reaches for on every visit stay above the
          sections, directly visible. The new layout has them in the section "Periode" (1.12.0). */}
      {!zijbalk && mailMelding}
      {!zijbalk && groteVerschillen}
      {!zijbalk && (
        <div className="card p-4">
          <div className="flex gap-3 flex-wrap">{statusKnoppen}</div>
          {roosterMailUitkomst}
          <p className="text-xs text-neutral-500 mt-2">
            Status: <span className="font-semibold">{statusTekst}</span>
          </p>
          {voorlopigUitleg}
        </div>
      )}


      <IndelingContext.Provider value={indeling}>
      <Onderdelen naWisselRef={naWisselRef}>
      {/* The period itself (1.12.0, the new layout only): what stood above the sections. Kept on the page
          unseen (keepMounted), so the notice about mail keeps telling the list whether it shows. */}
      {onderdelen.periode.zichtbaar && (
        <Section sleutel="periode" keepMounted>
          <div className="space-y-4">
            {periodeKop?.('onderdeel', kanGenereren || dashboard.status === 'GEPUBLICEERD' ? <div className="flex flex-wrap gap-2">{statusKnoppen}</div> : undefined)}
            {roosterMailUitkomst}
            {voorlopigUitleg}
            {mailMelding}
            {groteVerschillen}
          </div>
        </Section>
      )}
      {/* The first section (1.1.0): a beginsaldo or correctie forgotten in the
          wizard can still go in until the roster is generated. */}
      {onderdelen.importcorrecties.zichtbaar && (
        <Section sleutel="importcorrecties">
          <ImportEnCorrecties
            periodId={periodId}
            status={dashboard.status}
            mensen={progress.map((p) => ({ person_id: p.person_id, codenaam: p.codenaam }))}
            onGewijzigd={() => loadData(false)}
          />
        </Section>
      )}

      {/* Same status gate as the page's old link used ("niet CONCEPT") -
          equivalent to Dienstrooster's own gate below, since a CONCEPT
          period has no shift_slot rows yet either. */}
      {onderdelen.overloop.zichtbaar && (
        <Section sleutel="overloop">
          <p className="text-sm text-neutral-600 mb-3">
            De vensterregel (niemand twee keer binnen het ingestelde venster) geldt ook over de
            grens van de vorige periode heen. De solver moet dus weten wie aan het eind daarvan
            welke dienst had. Hier leg je dat vast. Dat gaat automatisch vanuit de vorige
            gepubliceerde periode, met een geüpload rooster of met de hand. Bevestigen is verplicht
            voordat je het rooster kunt genereren. Alleen de allereerste periode van een team slaat
            dit over, want die heeft niets om over te dragen.
          </p>
          <div className="flex justify-end">
            <Link
              href={`/planner/period/${periodId}/prior-assignments`}
              className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
            >
              🔁 Eerdere toewijzingen
            </Link>
          </div>
        </Section>
      )}

      {/* Same status gate as Dienstrooster below - a CONCEPT period has no
          shift_slot rows yet, so "unfilled slots" is meaningless there. */}
      {onderdelen.vooraf.zichtbaar && (
        <Section
          sleutel="vooraf"
          keepMounted
        >
          {undoBanner('VOORAF')}
          <FillGapsSummary refreshKey={fillGapsRefreshKey} periodId={periodId} status={dashboard.status} onCountChange={setFillGapsCount} />
        </Section>
      )}

      <Section sleutel="personeel">
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="text-center">
            <div className="text-3xl font-bold text-blue-600">{stats.not_started}</div>
            <div className="text-sm text-neutral-600">Niet begonnen</div>
          </div>
          <div className="text-center">
            <div className="text-3xl font-bold text-amber-600">{stats.in_progress}</div>
            <div className="text-sm text-neutral-600">Bezig</div>
          </div>
          <div className="text-center">
            <div className="text-3xl font-bold text-green-600">{stats.confirmed}</div>
            <div className="text-sm text-neutral-600">Bevestigd</div>
          </div>
        </div>

        {/* Progress bar */}
        <div className="w-full bg-neutral-200 rounded-full h-2 mb-2">
          <div
            className="bg-green-600 h-2 rounded-full transition-all"
            style={{ width: `${submissionProgress}%` }}
          />
        </div>
        <p className="text-sm text-neutral-600 text-center mb-4">
          {submissionProgress}% bevestigd ({stats.confirmed} van {totalSubmissions})
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Naam</th>
                <th className="px-3 py-2 text-left font-semibold">Status</th>
                <th className="px-3 py-2 text-center font-semibold">Geblokkeerde dagen</th>
                <th className="px-3 py-2 text-center font-semibold">Deeltijd</th>
                <th
                  className="px-3 py-2 text-center font-semibold"
                  title="Of de medewerker bij de stap Deeltijd heeft bevestigd dat deeltijd en afwezigheid kloppen"
                >
                  Deeltijd gecontroleerd
                </th>
                <th className="px-3 py-2 text-center font-semibold">Fellow</th>
                <th className="px-3 py-2 text-center font-semibold">Acties</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {progress.map((person) => (
                <tr key={person.person_id} className="hover:bg-neutral-50">
                  <td className="px-3 py-2 font-medium">
                    <Link
                      href={`/planner/period/${periodId}/person/${person.person_id}`}
                      className="text-blue-700 hover:underline"
                      title="Bekijk voorkeurenkalender (alleen-lezen)"
                    >
                      {person.codenaam}
                    </Link>
                    {person.is_fellow ? <FellowBadge /> : null}
                  </td>
                  <td className="px-3 py-2">
                    {!person.submission_status || person.submission_status === 'NIET_BEGONNEN' ? (
                      <span className="inline-block px-2 py-1 rounded-full text-xs bg-red-100 text-red-800">
                        Niet begonnen
                      </span>
                    ) : person.submission_status === 'BEZIG' ? (
                      <span className="inline-block px-2 py-1 rounded-full text-xs bg-amber-100 text-amber-800">
                        Bezig
                      </span>
                    ) : (
                      <span className="inline-block px-2 py-1 rounded-full text-xs bg-green-100 text-green-800">
                        ✓ Bevestigd
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">{person.blocked_days_count}</td>
                  <td className="px-3 py-2 text-center">
                    {person.has_parttime_patterns ? (
                      <span className="text-green-600 font-bold">✓</span>
                    ) : (
                      <span className="text-neutral-400">−</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {person.deeltijd_gecontroleerd_op ? (
                      <span
                        className="text-green-600 font-bold"
                        title={`Gecontroleerd op ${new Date(person.deeltijd_gecontroleerd_op).toLocaleString('nl-NL', {
                          day: 'numeric',
                          month: 'long',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}`}
                      >
                        ✓
                      </span>
                    ) : (
                      <span className="text-neutral-500 text-xs">nog niet</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={Boolean(person.is_fellow)}
                      // Fixed once the roster is made (the API refuses it too, see the fellow route).
                      disabled={submittingFor === person.person_id || isGenerated}
                      onChange={(e) => handleToggleFellow(person.person_id, e.target.checked)}
                      aria-label={`${person.codenaam} is fellow`}
                      title={
                        isGenerated
                          ? 'Het rooster is al gemaakt. Wie fellow is, ligt nu vast.'
                          : 'Fellow: weekenden geblokkeerd voor de AIOS-ondersteuning op zaterdag'
                      }
                    />
                  </td>
                  <td className="px-3 py-2 text-center">
                    {/* Reminders only while preferences can still be handed
                        in (the API refuses otherwise, lib/reminderGate.ts). */}
                    {dashboard.status === 'OPEN' && (() => {
                      const ingediend = person.submission_status === 'BEVESTIGD';
                      const verstuurd = remindedIds.has(person.person_id);
                      if (remindConfirm?.personId === person.person_id) {
                        return (
                          <div className="max-w-[14rem] mx-auto text-left space-y-2" role="alert">
                            <p className="text-xs text-amber-900">
                              {person.codenaam} kreeg {herinnerdOpTekst(remindConfirm.op)} al een herinnering. Toch nog
                              een sturen?
                            </p>
                            <div className="flex gap-2">
                              <button
                                onClick={() => handleRemindOne(person, true)}
                                className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 whitespace-nowrap"
                              >
                                Toch versturen
                              </button>
                              <button
                                onClick={() => setRemindConfirm(null)}
                                className="text-xs px-2 py-1 rounded bg-neutral-200 text-neutral-900 hover:bg-neutral-300"
                              >
                                Annuleren
                              </button>
                            </div>
                          </div>
                        );
                      }
                      return (
                        <>
                          <button
                            onClick={() => handleRemindOne(person)}
                            disabled={ingediend || submittingFor === person.person_id || mailIngesteld === false}
                            title={
                              ingediend
                                ? 'Deze persoon heeft de voorkeuren al ingediend.'
                                : mailIngesteld === false
                                  ? GEEN_MAIL
                                  : 'Stuurt een herinnering met een persoonlijke link.'
                            }
                            className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-neutral-300 disabled:text-neutral-600 transition-colors whitespace-nowrap"
                          >
                            {submittingFor === person.person_id ? 'Bezig...' : 'Herinnering sturen'}
                          </button>
                          {verstuurd && <p className="mt-1 text-xs text-green-700">Verstuurd ✓</p>}
                          {person.laatste_herinnering_op && (
                            <p className="mt-1 text-xs text-neutral-600 whitespace-nowrap">
                              Laatst herinnerd: {herinnerdOpTekst(person.laatste_herinnering_op)}
                            </p>
                          )}
                        </>
                      );
                    })()}
                    {actionError?.personId === person.person_id && (
                      <div className="mt-2 p-2 rounded border border-red-200 bg-red-50 text-left flex items-start gap-2 max-w-xs mx-auto">
                        <p className="text-xs text-red-800">{actionError.message}</p>
                        <button
                          onClick={() => setActionError(null)}
                          className="shrink-0 px-2 py-0.5 rounded border border-red-300 bg-white text-red-700 text-xs font-medium hover:bg-red-100"
                        >
                          Sluiten
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {dashboard.status === 'OPEN' && (() => {
          const open = progress.filter((p) => p.submission_status !== 'BEVESTIGD');
          const recent = open.filter((p) => isRecentHerinnerd(p.laatste_herinnering_op)).length;
          const anderen = open.length - recent;
          const aantal = `${open.length} ${open.length === 1 ? 'persoon' : 'personen'}`;
          return (
            <div className="mt-4 border-t pt-4">
              {remindAll.stage === 'confirm' ? (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-sm text-neutral-800">
                    {aantal} {open.length === 1 ? 'krijgt' : 'krijgen'} een herinnering met een persoonlijke link.
                    {recent > 0 &&
                      (recent === open.length
                        ? ` ${open.length === 1 ? 'Die kreeg' : 'Zij kregen allemaal'} de afgelopen 24 uur al een herinnering.`
                        : ` ${recent} van hen ${recent === 1 ? 'kreeg' : 'kregen'} de afgelopen 24 uur al een herinnering.`)}
                  </p>
                  {recent > 0 && anderen > 0 && (
                    <button
                      onClick={() => handleRemindAll(false)}
                      className="px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                    >
                      Alleen de {anderen === 1 ? 'andere' : `andere ${anderen}`}
                    </button>
                  )}
                  <button
                    onClick={() => handleRemindAll(true)}
                    className={`px-4 py-2 rounded font-medium transition-colors ${
                      recent > 0 && anderen > 0
                        ? 'bg-neutral-200 text-neutral-900 hover:bg-neutral-300'
                        : 'bg-blue-600 text-white hover:bg-blue-700'
                    }`}
                  >
                    {recent > 0 ? `Iedereen (${open.length})` : 'Versturen'}
                  </button>
                  <button
                    onClick={() => setRemindAll({ stage: 'idle' })}
                    className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
                  >
                    Annuleren
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setRemindAll({ stage: 'confirm' })}
                  disabled={open.length === 0 || remindAll.stage === 'sending' || mailIngesteld === false}
                  className="px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-neutral-300 disabled:text-neutral-600 transition-colors"
                >
                  {remindAll.stage === 'sending'
                    ? 'Bezig met versturen...'
                    : open.length === 0
                      ? 'Iedereen heeft ingediend'
                      : `📧 Herinnering sturen aan iedereen die nog niet heeft ingediend (${open.length})`}
                </button>
              )}
              {remindAll.stage === 'done' && (
                <p className={`mt-2 text-sm ${remindAll.ok ? 'text-green-700' : 'text-red-700'}`} role="status">
                  {remindAll.message}
                </p>
              )}
              {mailIngesteld === false && open.length > 0 && (
                <p className="mt-2 text-sm text-amber-900" data-testid="mail-nog-niet">
                  {GEEN_MAIL}
                </p>
              )}
            </div>
          );
        })()}
      </Section>

      {/* Always shown, regardless of period status - unlike the ruleset,
          pool membership was never actually period-scoped server-side.
          getEligiblePeopleForSlot (lib/rosterGaps.ts) only checks whether
          someone's geldig_vanaf/geldig_tot overlaps this period's dates,
          nothing about the period's own status - so adding someone here
          after publication (a fellow starting partway through the year,
          say) makes them show up in the manual-assign dropdown right away,
          exactly when a planner needs to hand-schedule them into the rest
          of an already-published roster. Hiding this for GEPUBLICEERD
          (as an earlier version of this section did, reasoning from the
          ruleset being frozen - a real but unrelated restriction) would
          have blocked exactly that. Links to the standalone pool-wide
          staff page (not the setup wizard's "Personeel" step) - that step
          only exists to walk through when opening a new period, and
          dropping a planner into it mid-tab for an already-open period
          made it look like part of a multi-step flow they still needed to
          click through, rather than a direct edit. */}
      <Section sleutel="personeelbeheren">
        {/* Text and button stacked, not side-by-side - this paragraph is
            long enough to wrap at normal card widths, and a wrapped
            justify-between row drops the button onto its own line flush
            LEFT (nothing left to space it against there), not right. A
            dedicated justify-end row underneath keeps it at the right
            regardless of how many lines the text takes. */}
        <p className="text-sm text-neutral-600 mb-3">
          Voeg hier personeel toe of verwijder ze. Per persoon pas je hier ook de geldigheidsperiode
          aan. De deelnamefactor volgt uit de deeltijddagen die de medewerker zelf opgeeft. Dit werkt op elk moment, ook in een al gepubliceerd rooster. Dat is
          handig als iemand halverwege start: voeg diegene hier toe met de juiste
          geldig-vanaf-datum. Die persoon verschijnt dan meteen in de keuzelijst bij het handmatig
          toewijzen van diensten in deze periode.
        </p>
        <div className="flex justify-end">
          <Link
            href={`/planner/pool/${dashboard.pool_id}/staff`}
            className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
          >
            👥 Personeel beheren
          </Link>
        </div>
      </Section>

      <Section sleutel="export">
        <div className="flex gap-3 flex-wrap">
          <button
            onClick={() => {
              setExportInitialType(null);
              setExportDialogOpen(true);
            }}
            id="knop-uitnodigingen"
            className="px-4 py-2 rounded font-medium bg-green-700 text-white hover:bg-green-800 transition-colors"
          >
            📧 Uitnodigingen en herinneringen
          </button>
          {/* Herinneren heeft alleen zin zolang de periode nog open staat
              voor indiening - zelfde voorwaarde als "Periode sluiten" op de
              periodepagina zelf. */}
          {dashboard.status === 'OPEN' && (
            <button
              onClick={() => {
                setExportInitialType('reminders');
                setExportDialogOpen(true);
              }}
              id="knop-herinneringen"
              disabled={mailIngesteld === false}
              title={mailIngesteld === false ? GEEN_MAIL : undefined}
              className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              📧 Deadlineherinnering versturen
            </button>
          )}
          {beheerder && (
            <button
              onClick={() => setMailSettingsOpen(true)}
              className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
            >
              ⚙️ Mailinstellingen
            </button>
          )}
          <a
            href={withBasePath(`/api/exports/status-report/${periodId}`)}
            className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
          >
            📋 Statusrapport downloaden
          </a>
          <a
            href={withBasePath(`/api/exports/preferences/${periodId}`)}
            className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
          >
            🗓️ Voorkeurenoverzicht downloaden (Excel)
          </a>
          <PreferencesImportButton periodId={periodId} periodStatus={dashboard.status} onImported={loadData} />
          {/* Only meaningful once there's something in it - bewaar dit
              bestand ergens veilig: het is de aanbevolen manier om een
              toekomstige periode's "Eerdere toewijzingen" in te vullen als
              deze periode dan zelf niet meer opvraagbaar is (zie de
              uitleg bij dat kopje). */}
          {dashboard.assignment_count > 0 && (
            <a
              href={withBasePath(`/api/exports/assignments/${periodId}`)}
              className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
            >
              📅 Rooster downloaden (Excel)
            </a>
          )}
          {/* Also in the dialog behind "Uitnodigingen en herinneringen", where nobody looked for it (audit 1.2.2). */}
          <a
            href={withBasePath(`/api/exports/audit-trail/${periodId}`)}
            className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
          >
            📄 Wijzigingsgeschiedenis downloaden (Excel)
          </a>
        </div>
        {!beheerder && (
          <div className="mt-4">
            <MailStatus refreshKey={`${mailSettingsKey}|${exportDialogOpen}`} />
          </div>
        )}
        <div className="mt-4">
          {/* Reloaded after a new deadline, a submission or closing the
              export dialog (a reminder sent by hand moves people out of
              the next automatic one). */}
          <AutoReminderPanel
            periodId={periodId}
            refreshKey={`${dashboard.deadline}|${dashboard.status}|${dashboard.submission_stats.confirmed}|${dashboard.submission_stats.in_progress}|${exportDialogOpen}|${mailSettingsKey}`}
          />
        </div>
      </Section>

      {/* The beheerder only: the personal links of this period and revoking one (lib/toegangslinks.ts). */}
      {onderdelen.links.zichtbaar && (
        <Section sleutel="links">
          <ToegangslinksBeheer periodId={periodId} />
        </Section>
      )}

      {/* Only meaningful once there's an actual roster to rebalance -
          suggestions need existing assignments to move around. Also hidden
          once RebalanceSuggestions has confirmed there's nothing to show
          (suggestionCount === 0) - a permanently-visible empty-state card
          was exactly the kind of clutter this reorganization removes
          elsewhere; suggestionCount stays null (so this stays visible)
          while that hasn't been confirmed yet, including on a load error. */}
      {onderdelen.voorstellen.zichtbaar && (
        <Section
          sleutel="voorstellen"
          keepMounted
        >
          {undoBanner('HERVERDELING')}
          <RebalanceSuggestions
            periodId={periodId}
            isPublished={dashboard.status === 'GEPUBLICEERD'}
            onApplied={loadData}
            onCountChange={setSuggestionCount}
          />
        </Section>
      )}

      {/* Dienstrooster - visible from OPEN onward (not just after the
          solver has run) so a planner can pre-fill strong preferences by
          hand before generating; CONCEPT stays excluded since no
          shift_slot rows exist yet at that point. */}
      {onderdelen.rooster.zichtbaar && (
        <Section sleutel="rooster">
          {undoBanner('ROOSTER')}
          {/* overflow-x-auto on its own is enough here (unlike the old
              header-row version of this button group) - this is a plain
              block-level div now, not a flex sibling fighting a title for
              space, so it doesn't need the min-w-0 workaround too. Still
              needed at all: the four buttons together are wider
              than a 375px screen's content width once this section's own
              padding is subtracted. */}
          <div className="overflow-x-auto mb-4">
          <div className="inline-flex rounded overflow-hidden border border-neutral-300">
            <button
              onClick={() => setAssignmentsView('list')}
              className={`px-3 py-1 text-sm font-medium transition-colors ${
                assignmentsView === 'list'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-neutral-700 hover:bg-neutral-100'
              }`}
            >
              📋 Lijst
            </button>
            <button
              onClick={() => setAssignmentsView('calendar')}
              className={`px-3 py-1 text-sm font-medium transition-colors border-l border-neutral-300 ${
                assignmentsView === 'calendar'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-neutral-700 hover:bg-neutral-100'
              }`}
            >
              📅 Kalender
            </button>
            <button
              onClick={() => setAssignmentsView('dienstdoende')}
              className={`px-3 py-1 text-sm font-medium transition-colors border-l border-neutral-300 ${
                assignmentsView === 'dienstdoende'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-neutral-700 hover:bg-neutral-100'
              }`}
            >
              🧑‍⚕️ Dienstdoende
            </button>
            <button
              onClick={() => setAssignmentsView('ruilverzoeken')}
              className={`px-3 py-1 text-sm font-medium transition-colors border-l border-neutral-300 ${
                assignmentsView === 'ruilverzoeken'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-neutral-700 hover:bg-neutral-100'
              }`}
            >
              🔁 Ruilverzoeken
            </button>
          </div>
          </div>

          {assignmentsView === 'list' ? (
            <AssignmentGrid
              key={assignmentsRefreshKey}
              periodId={periodId}
              periodStatus={dashboard.status}
              onChanged={() => {
                // A reassign/remove here can open (or close) a gap - the
                // "Rooster vooraf invullen" section's count has no other way
                // to find out. loadData(false) also refreshes this
                // dashboard's own imbalance/staff-status numbers, which a
                // reassign can change too - false because AssignmentGrid
                // already reloaded its own rows before calling this, so
                // remounting it here on top of that would throw that away
                // and fetch it all over again for nothing.
                loadData(false);
                setFillGapsRefreshKey((k) => k + 1);
              }}
            />
          ) : assignmentsView === 'calendar' ? (
            <AssignmentCalendar
              key={assignmentsRefreshKey}
              periodId={periodId}
              periodStatus={dashboard.status}
              onChanged={() => {
                // Same reasoning as AssignmentGrid's onChanged above - a
                // right-click assign/reassign/remove here can open or close
                // a gap the "Rooster vooraf invullen" count needs to know
                // about, and can change this dashboard's own
                // imbalance/staff numbers. false because AssignmentCalendar
                // already reloaded its own slots before calling this.
                loadData(false);
                setFillGapsRefreshKey((k) => k + 1);
              }}
            />
          ) : assignmentsView === 'dienstdoende' ? (
            <StaffingOverview key={assignmentsRefreshKey} periodId={periodId} />
          ) : (
            <SwapRequestsOverview key={assignmentsRefreshKey} periodId={periodId} />
          )}
        </Section>
      )}
      </Onderdelen>
      </IndelingContext.Provider>

      {/* Roster Generation Dialog */}
      <RosterGenerationDialog
        periodId={periodId}
        isOpen={rosterDialogOpen}
        onClose={() => setRosterDialogOpen(false)}
        onSuccess={() => {
          // Deliberately does NOT close the dialog - it switches to its own
          // result view (assignments created, solver status, cost) that the
          // planner needs to actually see; closing here immediately would
          // hide that report until they reopened the dialog. The dialog's
          // own "Sluiten" button is how they dismiss it once they've seen it.
          loadData();
          onPeriodChanged?.();
          setFillGapsRefreshKey((k) => k + 1);
        }}
      />

      {/* Publication Dialog */}
      <RosterPublicationDialog
        periodId={periodId}
        isOpen={publicationDialogOpen}
        onClose={() => setPublicationDialogOpen(false)}
        stap={publicationStap}
        onSuccess={() => {
          // The dialog stays open on its own outcome (who got a mail).
          loadData();
          onPeriodChanged?.();
        }}
      />

      {/* Export Dialog */}
      <MailSettingsDialog
        isOpen={beheerder && mailSettingsOpen}
        onClose={() => setMailSettingsOpen(false)}
        onChanged={() => setMailSettingsKey((k) => k + 1)}
      />
      <ExportDialog
        periodId={periodId}
        periodName={dashboard.period_name}
        deadline={dashboard.deadline}
        periodStatus={dashboard.status}
        isOpen={exportDialogOpen}
        onClose={() => setExportDialogOpen(false)}
        onDeadlineChanged={() => {
          loadData();
          onPeriodChanged?.();
        }}
        initialType={exportInitialType}
      />

      {/* Unpublish confirmation - the one way back out of GEPUBLICEERD.
          Assignments and already-sent notifications stay; every pool
          member gets told the publication was withdrawn. */}
      {showUnpublishConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Publicatie intrekken"
          onClick={dismissUnpublishBackdrop}
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
        >
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <h2 className="text-xl font-bold mb-2 text-red-700">Publicatie intrekken?</h2>
            <p className="text-sm text-neutral-700 mb-2">
              Het rooster voor &quot;{dashboard.period_name}&quot; gaat terug naar de status
              &quot;Gegenereerd&quot;. De toewijzingen blijven staan. Je kunt ze aanpassen en het
              rooster later opnieuw publiceren.
            </p>
            <p className="text-sm text-neutral-700 mb-4">
              Er gaat geen mail. Wie het rooster kon zien, krijgt in de app een melding dat de
              publicatie is ingetrokken. Die zien ze pas als ze hun link openen. Laat het zo nodig
              zelf weten.
            </p>
            {unpublishError && (
              <div className="bg-red-50 border border-red-200 rounded p-3 mb-4">
                <p className="text-sm text-red-800">{unpublishError}</p>
              </div>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => setShowUnpublishConfirm(false)}
                disabled={unpublishing}
                className="flex-1 py-2 px-4 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors disabled:opacity-50"
              >
                Annuleren
              </button>
              <button
                onClick={handleUnpublish}
                disabled={unpublishing}
                className="flex-1 py-2 px-4 rounded font-medium bg-red-700 text-white hover:bg-red-800 transition-colors disabled:opacity-50"
              >
                {unpublishing ? 'Bezig...' : 'Ja, publicatie intrekken'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showUnappliedDraftWarning && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Niet-toegepaste toewijzingen"
          onClick={dismissUnappliedDraftBackdrop}
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
        >
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <h2 className="text-xl font-bold mb-2 text-amber-800">⚠️ Niet-toegepaste toewijzingen</h2>
            <p className="text-sm text-neutral-700 mb-4">
              Bij &quot;{voorafNaam(dashboard.status)}&quot; staan nog keuzes klaar die niet zijn toegepast.
              De solver ziet deze pas zodra je op &quot;Alle toewijzingen toepassen&quot; hebt geklikt.
              Ga je nu verder met genereren, dan worden deze keuzes genegeerd.
            </p>
            <div className="flex gap-3">
              <Link
                href={`/planner/period/${periodId}/fill-gaps`}
                className="flex-1 py-2 px-4 rounded font-medium bg-amber-700 text-white hover:bg-amber-800 transition-colors text-center"
              >
                📝 Ga naar {voorafNaam(dashboard.status)}
              </Link>
              <button
                onClick={() => {
                  setShowUnappliedDraftWarning(false);
                  setRosterDialogOpen(true);
                }}
                className="flex-1 py-2 px-4 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
              >
                Toch doorgaan
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  );
}

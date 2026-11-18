/**
 * The words of Rooster instellen around the settings it took over from the
 * previous period (lib/vorigeInstellingen.ts). Without the database, for the
 * browser.
 */
import type { VorigeInstellingen } from './vorigeInstellingen';

export type WizardInstellingen = Omit<VorigeInstellingen, 'periode_naam'>;

const VERDELING: Record<string, string> = { GELIJK: 'Gelijk', NAAR_RATO: 'Naar rato' };

const weken = (n: number) => (n <= 0 ? 'uit' : n === 1 ? '1 week' : `${n} weken`);

/** "hoogstens 10%", or "zonder limiet" at 100%. */
export function budgetTekst(percent: number): string {
  return percent >= 100 ? 'zonder limiet' : `hoogstens ${percent}%`;
}

/**
 * What the planner set differently from the previous period, each as the
 * previous period had it ("verdeling Naar rato"). Empty when nothing differs.
 */
export function verschillenMetVorige(vorige: VorigeInstellingen, nu: WizardInstellingen): string[] {
  const anders: string[] = [];
  if (nu.distributionMode !== vorige.distributionMode) {
    anders.push(`verdeling ${VERDELING[vorige.distributionMode] ?? vorige.distributionMode}`);
  }
  if (nu.windowWeeksAvond !== vorige.windowWeeksAvond) anders.push(`venster avond ${weken(vorige.windowWeeksAvond)}`);
  if (nu.windowWeeksWeekendFeestdag !== vorige.windowWeeksWeekendFeestdag) {
    anders.push(`venster weekend/feestdag ${weken(vorige.windowWeeksWeekendFeestdag)}`);
  }
  if (nu.hardPercent !== vorige.hardPercent) anders.push(`geblokkeerd ${budgetTekst(vorige.hardPercent)}`);
  if (nu.softPercent !== vorige.softPercent) anders.push(`liever niet ${budgetTekst(vorige.softPercent)}`);
  if (nu.parttimeExempt !== vorige.parttimeExempt) {
    anders.push(vorige.parttimeExempt ? 'deeltijddagen telden niet mee' : 'deeltijddagen telden mee');
  }
  return anders;
}

/** The line under the summary when something differs, or null. */
export function verschilMelding(vorige: VorigeInstellingen, nu: WizardInstellingen): string | null {
  const anders = verschillenMetVorige(vorige, nu);
  if (anders.length === 0) return null;
  const lijst = anders.length === 1 ? anders[0] : `${anders.slice(0, -1).join(', ')} en ${anders[anders.length - 1]}`;
  return `Anders dan in ${vorige.periode_naam}. Daar was het: ${lijst}. Klopt dat zo voor deze periode?`;
}

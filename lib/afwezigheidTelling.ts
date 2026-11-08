/**
 * The absence days of a participant, counted the same way on the card of each absence
 * (components/AbsenceManager.tsx) and in the line under the calendar
 * (components/PartTimeCheckStep.tsx). The card said "7 van de 12 dagen" and the line "10
 * afwezigheidsdagen" for the same absence (audit 1.2.2): the card counted what the absence itself
 * blocked, the line left out the deeltijddagen. Both now name every day of the absence inside the
 * period, and say apart how many of those were blocked otherwise. Without the database, for the
 * browser.
 */
import { telwoord } from './telwoord';

/** The words on the card of one absence: its days in the period, and how many it blocked itself. */
export function afwezigheidKaartTekst(geblokkeerd: number, totaal: number): { volledig: boolean; tekst: string } {
  if (geblokkeerd >= totaal) return { volledig: true, tekst: `✓ ${telwoord(totaal, 'dag', 'dagen')} in deze periode, alle geblokkeerd` };
  const anders = totaal - geblokkeerd;
  return {
    volledig: false,
    tekst:
      `⚠ ${telwoord(totaal, 'dag', 'dagen')} in deze periode. ` +
      `${geblokkeerd === 1 ? '1 daarvan is' : `${geblokkeerd} daarvan zijn`} door deze afwezigheid geblokkeerd. ` +
      `${anders === 1 ? 'De andere dag was' : `De andere ${anders} waren`} al om een andere reden geblokkeerd, bijvoorbeeld een deeltijddag of een eigen blokkade.`,
  };
}

/** Every absence day inside the period, and how many of those are also a deeltijddag. */
export function afwezigheidsdagenInPeriode(
  datums: Iterable<string>,
  periodStart: string,
  periodEnd: string,
  deeltijd: (datum: string) => boolean
): { totaal: number; ookDeeltijd: number } {
  const binnen = [...new Set(datums)].filter((d) => d >= periodStart && d <= periodEnd);
  return { totaal: binnen.length, ookDeeltijd: binnen.filter(deeltijd).length };
}

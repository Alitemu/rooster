/**
 * "Volgende stap" on the period page of the achterwacht (1.8.0, the planner's wish): one sentence with
 * what the planner does now, and where on the page that is. A signpost, never an action: the button
 * goes to the section or the button that does it. It says only what the app knows for sure, and
 * nothing when it does not (a concept is the wizard's, a status it does not know gets no line).
 *
 * The order is the planner's own: open, invitations, reminders until the deadline, close, generate,
 * fill what stayed empty, voorlopig, definitief.
 */
import { deadlineTekst } from './verzendlijst';
import { deadlinePassed } from './periodInputGate';

export type StapDoel = 'uitnodigingen' | 'herinneringen' | 'sluiten' | 'genereren' | 'lege-diensten' | 'publiceren' | 'definitief';

export interface PeriodeStand {
  status: string;
  deadline: string;
  uitgenodigd_op: string | null;
  gepubliceerd_op: string | null;
  definitief_op: string | null;
  submission_stats: { not_started: number; in_progress: number; confirmed: number };
  /** Empty diensten, null while not known yet. */
  lege_diensten: number | null;
  /** Whether the mail is set up, null while not known yet. */
  mail_ingesteld: boolean | null;
}

export interface VolgendeStap {
  tekst: string;
  doel: StapDoel | null;
  /** What the button says. */
  knop: string | null;
}

const KNOP: Record<StapDoel, string> = {
  uitnodigingen: 'Naar de uitnodigingen',
  herinneringen: 'Naar de herinneringen',
  sluiten: 'Naar Periode sluiten',
  genereren: 'Naar Rooster genereren',
  'lege-diensten': 'Naar Lege diensten aanvullen',
  publiceren: 'Naar Voorlopig publiceren',
  definitief: 'Naar Definitief maken',
};

const stap = (tekst: string, doel: StapDoel | null = null): VolgendeStap => ({ tekst, doel, knop: doel ? KNOP[doel] : null });

export function volgendeStap(p: PeriodeStand, nu: Date = new Date()): VolgendeStap | null {
  switch (p.status) {
    case 'OPEN': {
      if (!p.uitgenodigd_op) {
        if (p.mail_ingesteld === false) return stap('De uitnodigingen kunnen pas weg als de beheerder de mail heeft ingesteld.');
        return stap('Verstuur de uitnodigingen. Tot dan weet niemand dat de periode open is.', 'uitnodigingen');
      }
      if (deadlinePassed(p.deadline, nu)) return stap('De deadline is verstreken. Sluit de periode om het rooster te maken.', 'sluiten');
      const { not_started, in_progress, confirmed } = p.submission_stats;
      const totaal = not_started + in_progress + confirmed;
      const open = not_started + in_progress;
      const deadline = deadlineTekst(p.deadline);
      if (totaal > 0 && open === 0) {
        return stap(`Iedereen heeft bevestigd. Sluit de periode nu of wacht tot de deadline van ${deadline}.`, 'sluiten');
      }
      const wie =
        open === 1 ? `1 van de ${totaal} deelnemers heeft de voorkeuren nog niet bevestigd.` : `${open} van de ${totaal} deelnemers hebben hun voorkeuren nog niet bevestigd.`;
      // Without mail no reminder can go out (its button is off): the line says so instead of pointing there.
      if (p.mail_ingesteld === false) return stap(`${wie} De deadline is ${deadline}. Herinneringen kunnen pas weg als de beheerder de mail heeft ingesteld.`);
      return stap(`${wie} De deadline is ${deadline}. Stuur zo nodig een herinnering.`, 'herinneringen');
    }
    case 'GESLOTEN':
      return stap('De periode is gesloten. Maak nu het rooster.', 'genereren');
    case 'GEGENEREERD':
      if (p.lege_diensten === null) return stap('Het rooster is gemaakt. Kijk het na en publiceer het voorlopig.', 'publiceren');
      if (p.lege_diensten > 0) {
        const leeg = p.lege_diensten === 1 ? '1 dienst is nog leeg.' : `${p.lege_diensten} diensten zijn nog leeg.`;
        return stap(`${leeg} Vul ze aan of publiceer het rooster met lege diensten.`, 'lege-diensten');
      }
      return stap('Het rooster is klaar. Publiceer het voorlopig, zodat iedereen het kan nakijken.', 'publiceren');
    case 'GEPUBLICEERD':
      if (p.definitief_op) return stap('Klaar: er is niets meer te doen. Ruilen regelen de deelnemers zelf in de app.');
      return stap(
        `${p.gepubliceerd_op ? `Voorlopig gepubliceerd sinds ${deadlineTekst(p.gepubliceerd_op)}.` : 'Het rooster is voorlopig gepubliceerd.'} Komen er geen reacties meer, maak het rooster dan definitief.`,
        'definitief'
      );
    default:
      return null;
  }
}

/**
 * What "Periode sluiten" says before the second click (audit per role R-08, 1.7.0). It asked only
 * "Zeker weten?", while 29 of the 30 participants had filled in nothing; Rooster genereren said so
 * afterwards, when closing had already happened. The counts are those of the dashboard
 * (submission_stats): niet begonnen, bezig and bevestigd.
 */
export interface InvulStand {
  not_started: number;
  in_progress: number;
  confirmed: number;
}

const NA_SLUITEN = 'Na het sluiten kan niemand meer iets invullen of wijzigen.';

export function sluitVraag(stand: InvulStand): string {
  const totaal = stand.not_started + stand.in_progress + stand.confirmed;
  const open = stand.not_started + stand.in_progress;
  if (totaal === 0) return NA_SLUITEN;
  if (open === 0) return `Alle ${totaal} deelnemers hebben hun voorkeuren bevestigd. ${NA_SLUITEN}`;
  const nietBevestigd =
    open === 1 ? `1 van de ${totaal} deelnemers heeft de voorkeuren nog niet bevestigd.` : `${open} van de ${totaal} deelnemers hebben hun voorkeuren nog niet bevestigd.`;
  const niets =
    stand.not_started === 0
      ? ''
      : stand.not_started === open
        ? open === 1
          ? ' Die heeft nog niets ingevuld.'
          : ' Zij hebben nog niets ingevuld.'
        : stand.not_started === 1
          ? ' Daarvan heeft 1 nog niets ingevuld.'
          : ` Daarvan hebben ${stand.not_started} nog niets ingevuld.`;
  return `${nietBevestigd}${niets} ${NA_SLUITEN}`;
}

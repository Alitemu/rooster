/**
 * Why a participant of the achterwacht can only look at their preferences: the one sentence above the
 * steps. A period that was not open yet read "De planner heeft deze periode gesloten" (functional audit
 * F-04, 1.7.0), which it never was. The AIOS has its own copy (lib/aiosInvoerDichtMelding.ts).
 */
export function invoerDichtMelding(status: string, deadlineVoorbij: boolean): string {
  if (status === 'CONCEPT') {
    return '📝 Deze periode is nog niet geopend. Je kunt je voorkeuren opgeven zodra de planner de periode opent.';
  }
  if (deadlineVoorbij) {
    return '⏰ De deadline voor deze periode is verstreken. Je kunt hieronder nog zien wat je hebt ingevuld, maar wijzigen kan niet meer.';
  }
  return '🔒 De planner heeft deze periode gesloten. Je kunt hieronder nog zien wat je hebt ingevuld, maar wijzigen kan niet meer. Neem contact op met de planner als er nog iets aangepast moet worden.';
}

/**
 * Why an AIOS can only look at their preferences: the one sentence above the steps, the AIOS's own copy
 * of lib/invoerDichtMelding.ts (docs/development/diensten.md, "Copied, not changed"). A period that was
 * not open yet read "De planner heeft deze periode gesloten" (functional audit F-04, 1.7.0).
 */
export function aiosInvoerDichtMelding(status: string, deadlineVoorbij: boolean): string {
  if (status === 'CONCEPT') {
    return '📝 Deze periode is nog niet geopend. Je kunt je voorkeuren opgeven zodra de planner de periode opent.';
  }
  if (deadlineVoorbij) {
    return '⏰ De deadline voor deze periode is verstreken. Je kunt hieronder nog zien wat je hebt ingevuld, maar wijzigen kan niet meer.';
  }
  return '🔒 De planner heeft deze periode gesloten. Je kunt hieronder nog zien wat je hebt ingevuld, maar wijzigen kan niet meer.';
}

import { describe, expect, it } from 'vitest';
import { mailControleZin } from './RosterPublicationDialog';
import { aiosMailControleZin } from './AiosPubliceren';

/**
 * 1.6.0 (the user's wording): after a roster mail the planner is told to
 * look in the sent items of the flow's mailbox. The app knows the
 * verzendlijst reached that mailbox, not that the flow mailed everyone.
 */
describe('the sentence after a roster mail', () => {
  it('names the mailbox the verzendlijst goes to and says when to look', () => {
    expect(mailControleZin('stroom@example.test')).toBe(
      'Controleer over 30 minuten of de e-mails zichtbaar zijn in de verzonden items van de mailbox stroom@example.test.'
    );
  });

  it('names the flow when no address is known', () => {
    for (const leeg of [null, undefined, '', '   ']) {
      expect(mailControleZin(leeg)).toBe(
        'Controleer over 30 minuten of de e-mails zichtbaar zijn in de verzonden items van de mailbox van de Power Automate-stroom.'
      );
    }
  });

  it("the AIOS's copy names the AIOS's own mailbox", () => {
    expect(aiosMailControleZin('stroom-aios@example.test')).toBe(
      'Controleer over 30 minuten of de e-mails zichtbaar zijn in de verzonden items van de mailbox stroom-aios@example.test.'
    );
    expect(aiosMailControleZin(null)).toBe(
      'Controleer over 30 minuten of de e-mails zichtbaar zijn in de verzonden items van de mailbox van de Power Automate-stroom van de AIOS.'
    );
  });
});

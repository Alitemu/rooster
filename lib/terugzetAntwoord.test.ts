import { describe, it, expect } from 'vitest';
import { backupFoutmelding } from '@/lib/terugzetAntwoord';

/**
 * The Back-up dialog's message for a failed call (0.904.0): the app's own message when there is one, otherwise what
 * the status means. An empty 413 from Caddy (an old docker-compose.yml, 1 MB for every request) said only "Dat is
 * niet gelukt."
 */

describe('what the Back-up dialog says when a call fails', () => {
  it("the app's own message goes first, also on a 413 of its own", () => {
    expect(backupFoutmelding(400, { success: false, error: { code: 'INVALID_INPUT', message: 'Kies eerst een back-upbestand.' } })).toBe(
      'Kies eerst een back-upbestand.'
    );
    expect(backupFoutmelding(413, { success: false, error: { message: 'Dit bestand is te groot voor een back-up van Dienstrooster.' } })).toBe(
      'Dit bestand is te groot voor een back-up van Dienstrooster.'
    );
  });

  it('an empty 413 from in front of the app says the server refuses the size and what to do', () => {
    for (const data of [null, {}, { error: {} }, { error: { message: '' } }]) {
      expect(backupFoutmelding(413, data)).toBe(
        'De server weigert dit bestand, omdat het te groot is. Neem het nieuwe docker-compose.yml over (README, bij versie 0.904.0) en probeer het opnieuw.'
      );
    }
  });

  it('no answer from the app, or anything else without a message', () => {
    for (const status of [502, 503, 504]) expect(backupFoutmelding(status, null)).toBe('De app gaf geen antwoord. Wacht even en probeer het opnieuw.');
    expect(backupFoutmelding(500, null)).toBe('Dat is niet gelukt.');
  });
});

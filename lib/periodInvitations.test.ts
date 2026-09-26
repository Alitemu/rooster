import { describe, it, expect } from 'vitest';
import { invitationBericht, formatDeadline } from './periodInvitations';

/**
 * The invitation is the first thing a participant reads: it has to carry
 * their own link, the deadline in words, where part-time and leave go, and
 * where to get the link again - pointing at this installation's own start
 * page, taken from the link itself.
 */

const period = {
  id: 'p',
  naam: 'Najaar 2099',
  status: 'OPEN',
  deadline: '2099-06-15T17:00',
  pool_id: 'pool',
  start_datum: '2099-07-06',
  eind_datum: '2099-12-27',
};

describe('invitationBericht', () => {
  const link = 'https://rooster.test/person/' + 'a'.repeat(64);
  const bericht = invitationBericht(period, 'Persoon-07', link);

  it('carries the link and the deadline written out', () => {
    expect(bericht.tekst).toContain(link);
    expect(bericht.tekst).toContain('uiterlijk maandag 15 juni 2099 om 17:00 binnen');
    expect(formatDeadline(period.deadline)).toBe('maandag 15 juni 2099 om 17:00');
  });

  it('says where part-time and leave go, and where to ask for the link again', () => {
    expect(bericht.tekst).toContain('Geef dat op bij de eerste stap, Deeltijd.');
    expect(bericht.tekst).toContain('Op https://rooster.test vraag je bij "Link kwijt?" een nieuwe aan');
  });

  it('keeps a sub-folder in the start page address', () => {
    const inSubmap = invitationBericht(period, 'Persoon-07', 'https://nas.test/achterwacht/person/' + 'b'.repeat(64));
    expect(inSubmap.tekst).toContain('Op https://nas.test/achterwacht vraag je');
  });
});

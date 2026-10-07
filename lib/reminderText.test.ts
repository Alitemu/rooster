import { describe, it, expect } from 'vitest';
import { personaliseReminder } from './reminderText';

/**
 * The rule: every recipient's reminder names them and carries their own
 * link, never the first person's, whose text the planner edits.
 */

const template = { codenaam: 'Persoon-01', link: 'https://x/person/aaa' };

describe('personaliseReminder', () => {
  it('puts the recipient in the place of the first person, name and link', () => {
    const tekst = 'Beste Persoon-01,\n\nJe link:\nhttps://x/person/aaa\n\nGroet';
    expect(personaliseReminder(tekst, template, { codenaam: 'Persoon-31', link: 'https://x/person/zzz' })).toBe(
      'Beste Persoon-31,\n\nJe link:\nhttps://x/person/zzz\n\nGroet'
    );
  });

  it('leaves the first person their own text', () => {
    const tekst = 'Beste Persoon-01, https://x/person/aaa';
    expect(personaliseReminder(tekst, template, template)).toBe(tekst);
  });

  it('replaces the codenaam only as a whole word', () => {
    const t = { codenaam: 'Persoon-1', link: 'L1' };
    expect(personaliseReminder('Beste Persoon-1, ook Persoon-10 en Persoon-1x. L1', t, { codenaam: 'Persoon-7', link: 'L7' })).toBe(
      'Beste Persoon-7, ook Persoon-10 en Persoon-1x. L7'
    );
  });

  it('keeps a recipient codenaam with $ signs literal', () => {
    expect(personaliseReminder('Beste Persoon-01,', template, { codenaam: 'A$&B', link: 'x' })).toBe('Beste A$&B,');
  });
});

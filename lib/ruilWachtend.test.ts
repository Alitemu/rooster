import { describe, expect, it } from 'vitest';
import { aantalWachtend, goedkeurVraag, wachtHint } from './ruilWachtend';

/**
 * 1.5.0: a participant sees on the page that a colleague's swap request
 * waits, and approving asks first (lib/ruilWachtend.ts).
 */
const ik = 'p1';
const verzoek = (status: string, respondent: string) => ({ status, respondent_person_id: respondent });

describe('aantalWachtend', () => {
  it('counts the open requests this person has to answer', () => {
    expect(aantalWachtend([verzoek('PENDING', ik), verzoek('PENDING', ik)], ik)).toBe(2);
  });

  it('leaves out what is answered or withdrawn', () => {
    expect(aantalWachtend([verzoek('GOEDGEKEURD', ik), verzoek('AFGEWEZEN', ik), verzoek('INGETROKKEN', ik)], ik)).toBe(0);
  });

  it("leaves out the person's own requests, which wait for a colleague", () => {
    expect(aantalWachtend([verzoek('PENDING', 'p2')], ik)).toBe(0);
  });
});

describe('wachtHint', () => {
  it('says nothing when no request waits', () => {
    expect(wachtHint(0)).toBeUndefined();
  });

  it('is in words, singular and plural', () => {
    expect(wachtHint(1)).toBe('1 verzoek wacht op je antwoord');
    expect(wachtHint(3)).toBe('3 verzoeken wachten op je antwoord');
  });
});

describe('goedkeurVraag', () => {
  it('names what the approver gives, to whom, what comes back and that it is final', () => {
    const vraag = goedkeurVraag({ geef: 'di 5 jan 2027', krijg: 'wo 20 jan 2027', van: 'staf01' });
    expect(vraag).toBe('Je geeft je dienst op di 5 jan 2027 aan staf01 en krijgt de dienst op wo 20 jan 2027. Daarna is de ruil definitief.');
  });

  it('does not swap the two days around', () => {
    const vraag = goedkeurVraag({ geef: 'GEEF', krijg: 'KRIJG', van: 'x' });
    expect(vraag.indexOf('GEEF')).toBeLessThan(vraag.indexOf('KRIJG'));
    expect(vraag).toMatch(/geeft je dienst op GEEF/);
  });
});

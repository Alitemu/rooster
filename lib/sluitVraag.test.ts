import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sluitVraag } from './sluitVraag';

/**
 * Audit per role R-08 (1.7.0): "Periode sluiten" asked "Zeker weten?" without a word about the 29 of the
 * 30 participants who had filled in nothing. The question now says how many have not confirmed and how
 * many of them have filled in nothing at all.
 */
describe('sluitVraag', () => {
  it('names who has not confirmed and who filled in nothing', () => {
    expect(sluitVraag({ not_started: 21, in_progress: 0, confirmed: 10 })).toBe(
      '21 van de 31 deelnemers hebben hun voorkeuren nog niet bevestigd. Zij hebben nog niets ingevuld. Na het sluiten kan niemand meer iets invullen of wijzigen.'
    );
    expect(sluitVraag({ not_started: 21, in_progress: 5, confirmed: 4 })).toBe(
      '26 van de 30 deelnemers hebben hun voorkeuren nog niet bevestigd. Daarvan hebben 21 nog niets ingevuld. Na het sluiten kan niemand meer iets invullen of wijzigen.'
    );
  });

  it('counts the ones still busy as not confirmed', () => {
    expect(sluitVraag({ not_started: 0, in_progress: 3, confirmed: 27 })).toMatch(/^3 van de 30 deelnemers hebben hun voorkeuren nog niet bevestigd\. Na het sluiten/);
  });

  it('says one in the singular', () => {
    expect(sluitVraag({ not_started: 1, in_progress: 0, confirmed: 29 })).toMatch(/^1 van de 30 deelnemers heeft de voorkeuren nog niet bevestigd\. Die heeft nog niets ingevuld\./);
    expect(sluitVraag({ not_started: 1, in_progress: 2, confirmed: 27 })).toContain('Daarvan heeft 1 nog niets ingevuld.');
  });

  it('says when everyone has confirmed', () => {
    expect(sluitVraag({ not_started: 0, in_progress: 0, confirmed: 30 })).toBe(
      'Alle 30 deelnemers hebben hun voorkeuren bevestigd. Na het sluiten kan niemand meer iets invullen of wijzigen.'
    );
  });

  it('the period page asks the counts at the first click and shows them under the button', () => {
    const pagina = fs.readFileSync(path.resolve(__dirname, '..', 'app/planner/period/[id]/page.tsx'), 'utf8');
    const eersteKlik = pagina.slice(pagina.indexOf('const handleClosePeriod'), pagina.indexOf('setCloseConfirmArmed(false);\n    setClosing(true)'));
    expect(eersteKlik).toContain('/dashboard`');
    expect(eersteKlik).toContain('setSluitStand(data?.data?.submission_stats ?? null)');
    expect(pagina).toMatch(/\{closeConfirmArmed && sluitStand && \(/);
    expect(pagina).toContain('{sluitVraag(sluitStand)}');
  });
});

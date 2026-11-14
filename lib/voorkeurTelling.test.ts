import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { telVoorkeuren } from './voorkeurTelling';

/**
 * Audit per role R-09 (1.7.0): the summary at Bevestigen counted the days geblokkeerd and the days with
 * a voorkeur, not the days on liever niet. They are counted now and the step shows them.
 */
const v = (teller: string, blocking_level: string | null) => ({ teller, blocking_level });

describe('telVoorkeuren', () => {
  it('counts every level apart, liever niet included', () => {
    const t = telVoorkeuren([
      v('AVOND', 'ABSOLUUT'),
      v('AVOND', 'ABSOLUUT'),
      v('WEEKEND', 'ABSOLUUT'),
      v('AVOND', 'LIEVER_NIET'),
      v('FEESTDAG', 'LIEVER_NIET'),
      v('WEEKEND', 'LIEVER_NIET'),
      v('AVOND', 'VOORKEUR'),
      v('AVOND', null),
    ]);
    expect(t).toEqual({ geblokkeerd: { AVOND: 2, WEEKEND: 1, FEESTDAG: 0, total: 3 }, voorkeur: 1, lieverNiet: 3 });
  });

  it('a day on liever niet is not counted as geblokkeerd, and nothing gives nothing', () => {
    expect(telVoorkeuren([v('AVOND', 'LIEVER_NIET')]).geblokkeerd.total).toBe(0);
    expect(telVoorkeuren([])).toEqual({ geblokkeerd: { AVOND: 0, WEEKEND: 0, FEESTDAG: 0, total: 0 }, voorkeur: 0, lieverNiet: 0 });
  });

  it('the page passes the count on and the step shows it', () => {
    const pagina = fs.readFileSync(path.resolve(__dirname, '..', 'app/person/[token]/page.tsx'), 'utf8');
    expect(pagina).toContain('telVoorkeuren(');
    expect(pagina).toContain('setLieverNietDays(telling.lieverNiet)');
    expect(pagina).toContain('lieverNietDays={lieverNietDays}');
    const stap = fs.readFileSync(path.resolve(__dirname, '..', 'components/PreferencesConfirmation.tsx'), 'utf8');
    expect(stap).toMatch(/\{lieverNietDays > 0 && \(/);
    expect(stap).toContain('als liever niet opgegeven');
  });
});

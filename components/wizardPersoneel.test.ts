import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Stap 2 "Personeel" of the setup wizard keeps what the planner set (1.1.3).
 *
 * The planner's report: "bij het instellen van een nieuwe periode ben ik de
 * begin- en einddata van stafleden aan het aanpassen, maar die data worden
 * niet opgeslagen". Two causes:
 * - loading the step widened every membership that did not cover the whole
 *   period, at every new page load, so an end date inside the period, a later
 *   start and an unticked "Actief" were undone and an open end was cut to the
 *   period's end;
 * - a change that reaches a period with a roster is refused until confirmed
 *   (409 LIDMAATSCHAP_RAAKT_ROOSTER), and the wizard had no way to confirm and
 *   showed the refusal above a list of 30 people, out of sight.
 *
 * That it works in the browser is tests/e2e/wizard-personeel.e2e.ts; this
 * holds the code in place without one.
 */
describe('wizard, stap Personeel', () => {
  const bron = readFileSync('components/SetupWizard.tsx', 'utf8');
  const functie = (naam: string) => {
    const begin = bron.indexOf(`const ${naam} = async`);
    expect(begin, naam).toBeGreaterThan(-1);
    const eind = bron.indexOf('\n  };\n', begin);
    return bron.slice(begin, eind);
  };

  it('writes nothing when the step loads', () => {
    const laden = functie('loadStaff');
    expect(laden).not.toMatch(/patchMembership\(|computeActivationPatch\(|method: '(PATCH|POST|PUT|DELETE)'/);
    // And nothing else on the way in either: the effect that loads the step only loads.
    const effect = bron.slice(bron.indexOf("if ((currentStep !== 'staff' && currentStep !== 'corrections')"));
    expect(effect.slice(0, effect.indexOf('}, [currentStep'))).not.toMatch(/patchMembership\(|fetch\(/);
  });

  it('gives a new member the open end, as Personeel beheren does', () => {
    expect(bron).toContain("import { OPEN_EINDE } from '@/lib/membershipDefaults';");
    expect(functie('handleAddMember')).toContain('geldig_tot: OPEN_EINDE');
    expect(bron).toContain('geldig_tot: prev.geldig_tot || OPEN_EINDE');
    expect(bron).not.toMatch(/geldig_tot:\s*periodData\.eind_datum/);
  });

  it('asks in the row when a change reaches a roster, and sends the yes', () => {
    const actie = { handleSaveMembership: 'opslaan', handleToggleActive: 'actief', handleRemoveMembership: 'verwijderen' };
    for (const [naam, soort] of Object.entries(actie)) {
      const f = functie(naam);
      expect(f, naam).toContain("data.error?.code === 'LIDMAATSCHAP_RAAKT_ROOSTER'");
      // The question itself, not only the clearing of an earlier one.
      expect(f, naam).toMatch(new RegExp(`setBevestigVraag\\(\\{[^}]*actie: '${soort}' \\}\\);\\s*return;`));
      expect(f, naam).toContain('bevestigd');
    }
    expect(bron).toContain('body: JSON.stringify(bevestigd ? { ...patch, bevestigd: true } : patch)');
    expect(bron).toContain("bevestigd ? '?bevestigd=1' : ''");
    expect(bron).toContain('data-testid="rooster-bevestiging"');
    expect(bron).toContain('Toch doorgaan');
  });

  it('tells a mistake where it was made, not above the list', () => {
    for (const naam of ['handleAddMember', 'handleSaveMembership', 'handleToggleActive', 'handleRemoveMembership']) {
      expect(functie(naam), naam).not.toContain('setStaffError(');
    }
    expect(bron).toContain('data-testid="rij-fout"');
    expect(bron).toContain('data-testid="toevoegen-fout"');
  });
});

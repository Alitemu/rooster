import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The participant's page after "Publicatie intrekken" (audit 1.2.2).
 *
 * The unpublish route leaves a melding "publicatie ingetrokken", but the Meldingen button and panel
 * were drawn only while the period was GEPUBLICEERD: nobody could read it until the roster came out
 * again. And the GEGENEREERD banner said changes saved now were kept, under the one saying nothing
 * can be changed. tests/e2e/publication-workflow.e2e.ts walks the same through the browser; this
 * reads the page so scripts/mutation-check.mjs can break it.
 */
const bron = fs.readFileSync(path.resolve(__dirname, 'page.tsx'), 'utf-8');

describe('Meldingen on the participant page', () => {
  it('draws the Meldingen button and panel in every status', () => {
    const knop = bron.indexOf('🔔 Meldingen');
    expect(knop).toBeGreaterThan(0);
    const ervoor = bron.slice(Math.max(0, knop - 400), knop);
    expect(ervoor).not.toMatch(/status === 'GEPUBLICEERD' && \(\s*<button/);
    expect(bron).toMatch(/\{notificationsOpen && personId && \(/);
  });

  it('says a generated roster is not published yet, never that changes are still kept', () => {
    expect(bron).not.toMatch(/Wijzigingen die je nu opslaat/);
    expect(bron).toMatch(/Het rooster is gemaakt, maar nog niet gepubliceerd/);
  });

  // Audit 1.3.0: after unpublishing, "De planner heeft deze periode gesloten" stood above it as well.
  it('shows only that banner then, which also says nothing can be changed', () => {
    expect(bron).toMatch(/\{inputClosed && !rosterAlreadyGenerated && \(/);
    expect(bron).toMatch(/Wat je hebt ingevuld, kun je hieronder nog zien, maar niet meer wijzigen\./);
  });
});

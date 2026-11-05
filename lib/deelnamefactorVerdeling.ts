/**
 * Whether the deelnamefactor counts, said in words on Personeel beheren (1.1.2).
 *
 * The factor scales a person's streefbereik only when the period's
 * verdeelmodus (wizard step 4, the frozen ruleset's distributionMode) is
 * NAAR_RATO (lib/rosterBands.ts scaledBandForMember, solver/constraints.py).
 * Under GELIJK everyone gets the same bereik and the factor changes nothing;
 * the part-time days themselves are still never rostered either way.
 *
 * No db import: the staff page imports the text.
 */

export type Verdeling = 'GELIJK' | 'NAAR_RATO';

/** The verdeelmodus as the band code reads it: anything but NAAR_RATO is GELIJK. */
export function verdelingUitConfig(config: Record<string, unknown>): Verdeling {
  return config.distributionMode === 'NAAR_RATO' ? 'NAAR_RATO' : 'GELIJK';
}

export function verdelingTekst(verdeling: Verdeling, periode: string): string {
  return verdeling === 'NAAR_RATO'
    ? `De periode ${periode} verdeelt naar rato. De factor telt mee: iemand met 0,8 krijgt naar verhouding minder diensten dan iemand met 1,0.`
    : `De periode ${periode} verdeelt gelijk. De factor telt dan niet mee: iedereen krijgt hetzelfde streefbereik. Alleen bij de verdeling Naar rato (stap 4 van de wizard) krijgt iemand met een lagere factor minder diensten.`;
}

export const PARTTIMEDAGEN_TELLEN = 'Op de parttimedagen zelf wordt bij beide verdelingen niemand ingeroosterd.';

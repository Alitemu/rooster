/**
 * Small rules of the section "Import en correcties" (components/ImportEnCorrecties.tsx),
 * apart so a test can hold them without a browser.
 */

import { telwoord } from '@/lib/telwoord';

const DIENST: Record<string, [string, string]> = {
  AVOND: ['avonddienst', 'avonddiensten'],
  WEEKEND: ['weekenddienst', 'weekenddiensten'],
  FEESTDAG: ['feestdagdienst', 'feestdagdiensten'],
};

/** "1 avonddienst minder", "2 weekenddiensten extra": a saldo in words, never "-1". */
export function saldoInWoorden(teller: string, delta: number): string {
  const [een, meer] = DIENST[teller] ?? ['dienst', 'diensten'];
  return `${telwoord(Math.abs(delta), een, meer)} ${delta < 0 ? 'minder' : 'extra'}`;
}

/** What a period in this status allows here: only before a roster is generated. */
export function kanSaldoWijzigen(status: string): boolean {
  return status === 'OPEN' || status === 'GESLOTEN';
}


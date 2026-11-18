/**
 * The tab Lijst of the roster of the achterwacht (components/AssignmentGrid.tsx) shows the empty diensten
 * as their own row once the roster is made (functional audit F-03, 1.7.0). Before that every dienst is
 * still empty and the list is the place for what was entered in advance, not for 150 rows "nog niemand".
 */
export function toonLegeDiensten(status: string | null | undefined): boolean {
  return status === 'GEGENEREERD' || status === 'GEPUBLICEERD';
}

/** One row of the list: a toewijzing, or an empty dienst (id null). */
export interface LijstRij {
  id: string | null;
  slot_id: string;
  leeg?: boolean;
}

/** The key of a row: the toewijzing, or the dienst for an empty one. */
export function rijSleutel(rij: LijstRij): string {
  return rij.id ?? `leeg-${rij.slot_id}`;
}

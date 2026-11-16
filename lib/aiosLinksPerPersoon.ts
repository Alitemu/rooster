/**
 * The personal links of an AIOS period, one line per person (1.13.0). A copy of lib/linksPerPersoon.ts,
 * not shared with it (docs/development/diensten.md "Copied, not changed"); lib/linksPerPersoon.test.ts
 * holds the two together.
 */

export interface LinkRij {
  id: string;
  person_id: string;
  codenaam: string;
  aangemaakt_op: string;
  laatst_gebruikt_op: string | null;
  ingetrokken_op: string | null;
}

export interface PersoonLinks<T extends LinkRij = LinkRij> {
  person_id: string;
  codenaam: string;
  /** Links that still work, and links that were revoked. */
  werkend: number;
  ingetrokken: number;
  /** When the newest link was made, and when any of them was last used. */
  laatst_gemaakt: string;
  laatst_gebruikt: string | null;
  /** Every link of the person, the newest first. */
  links: T[];
}

/** One entry per person, by codenaam. */
export function linksPerPersoon<T extends LinkRij>(links: readonly T[]): PersoonLinks<T>[] {
  const per = new Map<string, PersoonLinks<T>>();
  for (const link of links) {
    const p = per.get(link.person_id) ?? {
      person_id: link.person_id,
      codenaam: link.codenaam,
      werkend: 0,
      ingetrokken: 0,
      laatst_gemaakt: link.aangemaakt_op,
      laatst_gebruikt: null,
      links: [],
    };
    if (link.ingetrokken_op === null) p.werkend += 1;
    else p.ingetrokken += 1;
    if (link.aangemaakt_op > p.laatst_gemaakt) p.laatst_gemaakt = link.aangemaakt_op;
    if (link.laatst_gebruikt_op && (!p.laatst_gebruikt || link.laatst_gebruikt_op > p.laatst_gebruikt)) p.laatst_gebruikt = link.laatst_gebruikt_op;
    p.links.push(link);
    per.set(link.person_id, p);
  }
  return [...per.values()]
    .map((p) => ({ ...p, links: [...p.links].sort((a, b) => b.aangemaakt_op.localeCompare(a.aangemaakt_op)) }))
    .sort((a, b) => a.codenaam.localeCompare(b.codenaam));
}

/** "4 werkende links", "1 werkende link en 2 ingetrokken", "Geen werkende link meer, 3 ingetrokken". */
export function aantalLinksTekst(p: { werkend: number; ingetrokken: number }): string {
  const werkend = p.werkend === 1 ? '1 werkende link' : `${p.werkend} werkende links`;
  if (p.werkend === 0) return `Geen werkende link meer, ${p.ingetrokken} ingetrokken`;
  return p.ingetrokken > 0 ? `${werkend} en ${p.ingetrokken} ingetrokken` : werkend;
}

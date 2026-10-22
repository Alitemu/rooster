'use client';

/**
 * An AIOS's own diensten of a published quarter (docs/aios-rooster.md,
 * step 4d): voorlopig with a notice to check them, then definitief; their
 * points and dienstpercentage (G12). Per dienst a line, readable at 375
 * pixels and on paper.
 */

import { useEffect, useState } from 'react';
import { withBasePath } from '@/lib/basePath';
import type { AiosEigenRooster } from '@/lib/aiosPublicatie';
import { KWARTALEN_WOORD } from '@/lib/aiosFte';

const datumLang = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
const procent = (x: number) => `${(x * 100).toLocaleString('nl-NL', { maximumFractionDigits: 1 })}%`;

/** `inSectie`: on the page's foldable section, which has the title and the frame (0.110.0). */
export function AiosMijnRooster({ personId, periodId, inSectie = false }: { personId: string; periodId: string; inSectie?: boolean }) {
  const [rooster, setRooster] = useState<AiosEigenRooster | null>(null);
  const [fout, setFout] = useState<string | null>(null);

  useEffect(() => {
    fetch(withBasePath(`/api/aios/deelnemer/${personId}/periode/${periodId}/rooster`))
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) throw new Error(data?.error?.message || 'Laden van je rooster is mislukt.');
        setRooster(data.data);
      })
      .catch((err) => setFout(err instanceof Error ? err.message : 'Laden van je rooster is mislukt.'));
  }, [personId, periodId]);

  if (fout) {
    return (
      <div className="card p-4" role="alert">
        <p className="text-sm text-red-700">{fout}</p>
      </div>
    );
  }
  if (!rooster) return <div className="card p-4 text-sm text-neutral-600">Je rooster laden...</div>;

  return (
    <div className={inSectie ? 'space-y-3' : 'card p-4 space-y-3'} data-testid="aios-mijn-rooster">
      {!inSectie && <h2 className="text-xl font-semibold">Jouw rooster</h2>}
      {rooster.voorlopig ? (
        <div className="rounded border-2 border-dashed border-neutral-800 p-3 text-sm" data-testid="aios-voorlopig">
          <p className="font-semibold">Dit is het voorlopige rooster.</p>
          <p>Kijk je diensten goed na. Klopt er iets niet? Laat het de roosteraar zo snel mogelijk weten. Daarna wordt het rooster definitief.</p>
        </div>
      ) : (
        <p className="text-sm font-medium">Dit rooster is definitief.</p>
      )}
      {rooster.diensten.length === 0 ? (
        <p className="text-sm text-neutral-700">Je hebt in dit kwartaal geen diensten.</p>
      ) : (
        <ul className="divide-y text-sm">
          {rooster.diensten.map((d) => (
            <li key={d.dienst_id} className="py-1.5">
              <span className="font-medium">{datumLang(d.datum)}</span>
              {d.feestdag && <span> ★ {d.feestdag}</span>}
              <span className="block text-neutral-700">
                {d.naam}, {d.start_tijd} tot {d.eind_tijd}
                {d.blok ? ` · ${d.blok}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm text-neutral-800">
        {rooster.diensten.length === 1 ? '1 dienst' : `${rooster.diensten.length} diensten`}, {rooster.punten.toLocaleString('nl-NL')} punten.
        {rooster.dienstpercentage !== null &&
          ` Je dienstpercentage dit kwartaal: ${procent(rooster.dienstpercentage)}${rooster.dienstpercentage > 0.25 ? ', boven 25%' : ''}.`}
        {rooster.jaar_kwartalen > 1 &&
          rooster.jaar_percentage !== null &&
          ` Over de laatste ${KWARTALEN_WOORD[rooster.jaar_kwartalen]} kwartalen samen: ${procent(rooster.jaar_percentage)}${rooster.jaar_percentage > 0.25 ? ', boven 25%' : ''}.`}
      </p>
    </div>
  );
}

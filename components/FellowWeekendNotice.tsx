'use client';

/**
 * In the roster generation dialog, next to the window and band settings:
 * what this period's fellows (lib/fellows.ts) mean for the weekends. Their
 * weekends are blocked, so the others' weekend band is raised at
 * generation, and fewer people may no longer fit the weekend/feestdag
 * window. The window stays the planner's to change; this only says
 * whether it fits and which value would (lib/fellowSummary.ts).
 * Renders nothing when there are no fellows.
 */

import { useEffect, useState } from 'react';

interface Summary {
  fellows: Array<{ person_id: string; codenaam: string; vrije_weekenddagen: number }>;
  weekend: {
    mensen: number;
    diensten: number;
    venster: number;
    past: boolean;
    voorgesteld_venster: number | null;
    bereik: [number, number];
    bereik_zonder_fellows: [number, number];
  };
}

const weken = (n: number) => (n === 1 ? '1 week' : `${n} weken`);
const bereikTekst = ([min, max]: [number, number]) =>
  min === max ? `${min} weekenddiensten` : `${min} tot ${max} weekenddiensten`;

export function FellowWeekendNotice({ periodId, vensterWeekend }: { periodId: string; vensterWeekend: number }) {
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    let current = true;
    fetch(`/api/planner/period/${periodId}/fellows?venster_weekend=${vensterWeekend}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (current && data?.success) setSummary(data.data);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [periodId, vensterWeekend]);

  if (!summary || summary.fellows.length === 0) return null;
  const { weekend, fellows } = summary;
  const aantal = fellows.length === 1 ? '1 fellow' : `${fellows.length} fellows`;
  const verhoogd =
    weekend.bereik[0] !== weekend.bereik_zonder_fellows[0] || weekend.bereik[1] !== weekend.bereik_zonder_fellows[1];

  return (
    <div className="rounded border border-violet-300 bg-violet-50 p-3 text-sm text-violet-950 space-y-1" data-testid="fellow-weekend">
      <p>
        Deze periode {fellows.length === 1 ? 'is er' : 'zijn er'} {aantal} ({fellows.map((f) => f.codenaam).join(', ')}).
        Zij ondersteunen op zaterdag de AIOS en tellen niet mee voor de weekenden.
      </p>
      <p>
        {verhoogd
          ? `Het weekendbereik van de anderen gaat bij het genereren daarom van ${bereikTekst(weekend.bereik_zonder_fellows)} naar ${bereikTekst(weekend.bereik)}.`
          : `Het weekendbereik van de anderen blijft ${bereikTekst(weekend.bereik)}.`}
      </p>
      <p className={weekend.past ? '' : 'font-semibold'}>
        {weekend.past
          ? `Een weekendvenster van ${weken(weekend.venster)} past bij de ${weekend.mensen} mensen die weekenden doen.`
          : weekend.voorgesteld_venster !== null
            ? `Een weekendvenster van ${weken(weekend.venster)} past niet bij ${weekend.mensen} mensen voor ${weekend.diensten} weekenddagen. Een venster van ${weken(weekend.voorgesteld_venster)} past wel.`
            : `Ook met een weekendvenster van 1 week zijn ${weekend.mensen} mensen te weinig voor ${weekend.diensten} weekenddagen.`}
      </p>
    </div>
  );
}

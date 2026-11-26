import { withBasePath } from '@/lib/basePath';

/**
 * The page of a period that is in the prullenbak, for a participant who
 * opens their link and for a planner who opens a bookmark. Shared by the
 * achterwacht and the AIOS like the rest of the start: it shows nothing of
 * the period, only where to go. A planner or the beheerder gets the period
 * back through the Prullenbak on the overview (lib/periodTrash.ts).
 */
export function PeriodeVerwijderd({ voorPlanner = false }: { voorPlanner?: boolean }) {
  return (
    <div className="container-main py-12">
      <div className="card p-8" data-testid="periode-verwijderd">
        <h1 className="text-2xl font-bold text-neutral-900 mb-4">Deze periode is verwijderd</h1>
        {voorPlanner ? (
          <p className="text-neutral-700">
            Zet hem terug via de{' '}
            <a href={withBasePath('/planner')} className="text-blue-600 underline hover:no-underline">
              Prullenbak op het overzicht
            </a>
            .
          </p>
        ) : (
          <p className="text-neutral-700">
            Je persoonlijke link hoort bij een periode die niet meer bestaat. Een nieuwe link vraag je aan op de{' '}
            <a href={withBasePath('/')} className="text-blue-600 underline hover:no-underline">
              startpagina
            </a>{' '}
            bij &quot;Link kwijt?&quot;, met je werk-e-mailadres.
          </p>
        )}
      </div>
    </div>
  );
}

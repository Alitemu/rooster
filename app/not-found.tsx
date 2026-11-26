import type { Metadata } from 'next';
import Link from 'next/link';

/**
 * Every address the app does not know (functional audit F-01): Next's own
 * page said "404, This page could not be found." in English, the one screen
 * that broke the rule that everything a user sees is Dutch. Next answers it
 * with status 404 and the app's own header around it (app/layout.tsx).
 *
 * Link, not a plain <a>: it puts the sub-folder in front (lib/basePath.ts).
 */
export const metadata: Metadata = { title: 'Pagina niet gevonden' };

export default function NotFound() {
  return (
    <div className="container-main">
      <div className="card card-padding" data-testid="niet-gevonden">
        <h2 className="text-2xl font-bold text-neutral-900 mb-2">Deze pagina bestaat niet</h2>
        <p className="text-neutral-600 mb-4">
          Controleer het adres. Kwam je hier via een link uit een mail? Op de startpagina vraag je bij <em>Link kwijt?</em>{' '}
          een nieuwe persoonlijke link aan.
        </p>
        <Link href="/" className="btn-primary inline-block">
          Naar de startpagina
        </Link>
      </div>
    </div>
  );
}

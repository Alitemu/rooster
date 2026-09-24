import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { AppHeader } from '@/components/AppHeader';
import packageJson from '../package.json';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Dienstrooster',
  description: 'Eerlijke roosterplanning voor medische afdelingen',
};

/**
 * Its own export, not a field inside `metadata`.
 *
 * This version of Next.js no longer reads it there and logs "Unsupported
 * metadata viewport is configured in metadata export" on every render. It
 * was not simply ignored: Next fell back to its own default tag, so the
 * part that matters for a mobile-first grid (width=device-width,
 * initial-scale=1) happened to be right anyway, while the configured
 * maximum-scale silently never reached the page.
 *
 * maximumScale is deliberately not carried over. It was never in effect,
 * and pinning the maximum scale blocks pinch-zoom - which on a roster grid
 * read on a phone, by people who may need to enlarge it, is the wrong
 * thing to take away (WCAG 1.4.4). The app now says what it already did.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="nl" suppressHydrationWarning>
      <body className={inter.className}>
        <div className="min-h-screen flex flex-col">
          <header className="bg-primary-600 text-white shadow-md">
            <div className="max-w-7xl mx-auto px-4 py-4 flex items-baseline justify-between gap-4">
              <AppHeader />
              {/* Which version is running, from package.json - handy when
                  asking whether an update has landed on the server. */}
              <span className="text-sm italic text-white/90" data-testid="app-versie">
                versie {packageJson.version}
              </span>
            </div>
          </header>
          <main className="flex-1">
            {children}
          </main>
          <footer className="bg-neutral-100 border-t border-neutral-200 mt-8">
            <div className="max-w-7xl mx-auto px-4 py-6 text-center text-sm text-neutral-600">
              <p>Dienstrooster: eerlijke roosterplanning</p>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}

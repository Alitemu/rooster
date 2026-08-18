import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Dienstrooster',
  description: 'Eerlijke roosterplanning voor medische afdelingen',
  viewport: {
    width: 'device-width',
    initialScale: 1,
    maximumScale: 1,
  },
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
            <div className="max-w-7xl mx-auto px-4 py-4">
              <h1 className="text-2xl font-bold">Dienstrooster</h1>
            </div>
          </header>
          <main className="flex-1">
            {children}
          </main>
          <footer className="bg-neutral-100 border-t border-neutral-200 mt-8">
            <div className="max-w-7xl mx-auto px-4 py-6 text-center text-sm text-neutral-600">
              <p>Dienstrooster - Eerlijke roosterplanning</p>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}

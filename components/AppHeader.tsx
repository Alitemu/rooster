'use client';

/**
 * App Header
 *
 * The "Dienstrooster" title in the site-wide header (app/layout.tsx) used
 * to be plain text - when a multi-step process (the setup wizard, a
 * participant's Deeltijd/Voorkeuren/Bevestigen flow) got stuck, there was
 * no way back except the browser's own back button, which - see the
 * earlier "browser-terugknop" fix - doesn't always land somewhere useful
 * either. Making the title a link back to that role's own main page (the
 * planner's period list, or a participant's own token page) gives a
 * always-available way out, without needing to know or guess a URL.
 */

import { usePathname } from 'next/navigation';
import Link from 'next/link';

export function AppHeader() {
  const pathname = usePathname();

  let href = '/';
  if (pathname.startsWith('/planner')) {
    href = '/planner';
  } else {
    // /person/<token> or /person/<token>/anything - the token is always
    // the second path segment.
    const match = pathname.match(/^\/person\/([^/]+)/);
    if (match) href = `/person/${match[1]}`;
  }

  return (
    <Link href={href} className="inline-block hover:opacity-90 transition-opacity">
      <h1 className="text-2xl font-bold">Dienstrooster</h1>
    </Link>
  );
}

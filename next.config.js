/** @type {import('next').NextConfig} */

// Next.js inlines its own hydration/bootstrap scripts and injects styles,
// neither of which carries a nonce without moving CSP generation into
// proxy.ts - so 'unsafe-inline' stays for now. The directives that do the
// real work here are the ones that don't depend on that: frame-ancestors
// (clickjacking), object-src (plugin-based injection), base-uri (stops a
// injected <base> repointing every relative URL) and form-action (stops a
// form posting credentials off-site). No user-supplied HTML is ever
// rendered - there is no dangerouslySetInnerHTML anywhere in this app - so
// script-src is defence in depth rather than the primary control.
//
// `next dev` compiles with eval, hence the extra source outside production.
const scriptSrc =
  process.env.NODE_ENV === 'production'
    ? "script-src 'self' 'unsafe-inline'"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";

const contentSecurityPolicy = [
  "default-src 'self'",
  scriptSrc,
  "style-src 'self' 'unsafe-inline'",
  // blob: covers the client-built CSV/JSON download blobs (see
  // ExportDialog.tsx); data: is kept for inline images and CSS.
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

// The sub-folder the app runs under (lib/basePath.ts), e.g. "/achterwacht".
// Empty: the root of its address, exactly as before.
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').trim().replace(/\/+$/, '');

const nextConfig = {
  reactStrictMode: true,
  // No "X-Powered-By: Next.js": it only tells a visitor which software to look up.
  poweredByHeader: false,
  ...(basePath ? { basePath } : {}),
  experimental: {
    optimizePackageImports: ['@radix-ui'],
    // proxy.ts makes Next buffer every /api body, 10 MB by default, and quietly cut off past that. The restore of
    // a backup carries the file (lib/api-errors.ts MAX_BACKUP_UPLOAD_BYTES); every other route still reads 1 MB at most.
    proxyClientMaxBodySize: '32mb',
  },
  headers: async () => [
    {
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        // A participant's personal link carries its token in the path
        // (/person/<token>), so any outbound request from that page must
        // not be allowed to carry the URL along in a Referer header.
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
        { key: 'Content-Security-Policy', value: contentSecurityPolicy },
      ],
    },
  ],
};

export default nextConfig;

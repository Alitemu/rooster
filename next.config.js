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
  // data:/blob: cover the QR code shown during TOTP enrollment and the
  // client-built CSV/JSON download blobs (see ExportDialog.tsx).
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

const nextConfig = {
  reactStrictMode: true,
  experimental: {
    optimizePackageImports: ['@radix-ui'],
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

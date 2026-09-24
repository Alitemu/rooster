/**
 * The sub-folder the app runs under, e.g. "/achterwacht" for
 * https://nas/achterwacht, or "" when it runs at the root of its address.
 *
 * Set at build time with NEXT_PUBLIC_BASE_PATH (next.config.mjs basePath;
 * the Dockerfile's BASE_PATH build argument, "Bouwen (test)"'s basispad).
 * Next.js puts it in front of <Link> and router.push itself, but not in
 * front of fetch() or a plain <a href> or window.location: those go
 * through withBasePath. Empty by default, so without the variable
 * everything is exactly as before.
 */

export function normalizeBasePath(raw: string | undefined): string {
  const value = (raw ?? '').trim().replace(/\/+$/, '');
  if (value === '') return '';
  if (!/^(\/[A-Za-z0-9._-]+)+$/.test(value) || value.split('/').some((part) => /^\.+$/.test(part))) {
    throw new Error(`NEXT_PUBLIC_BASE_PATH "${raw}" is not a path like /achterwacht`);
  }
  return value;
}

export const BASE_PATH = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH);

/** "/api/x" -> "/achterwacht/api/x" (or unchanged without a base path). */
export function withBasePath(path: string): string {
  return `${BASE_PATH}${path}`;
}

/** The reverse: a browser pathname ("/achterwacht/planner") as the app's own path ("/planner"). */
export function withoutBasePath(pathname: string): string {
  if (BASE_PATH && (pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`))) {
    return pathname.slice(BASE_PATH.length) || '/';
  }
  return pathname;
}

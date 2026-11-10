/**
 * Single source of truth for the public website origin.
 *
 * - Every user-facing URL generation MUST resolve through `BASE_URL` (or the
 *   `buildAppRedirect()` helper in `utils/authEnv.ts` which is layered on
 *   top of this). The configured public origin is used for the active market;
 *   the global BZEAD.COM origin remains the default outside market builds.
 */
export const BASE_URL: string = (() => {
  const market = import.meta.env.VITE_MARKET;
  const fallback = market === 'MV'
    ? ''
    : market === 'IN'
      ? 'https://www.bzead.in'
      : 'https://bzead.com';
  const raw = (import.meta.env.VITE_PUBLIC_APP_URL?.trim()
    || import.meta.env.VITE_DOMAIN?.trim()
    || fallback);
  try {
    return new URL(raw).origin;
  } catch {
    return fallback;
  }
})();

/** Join `BASE_URL` with a path, ensuring exactly one slash between them. */
export function withBase(path: string = '/'): string {
  const safePath = path.startsWith('/') ? path : `/${path}`;
  return `${BASE_URL.replace(/\/+$/, '')}${safePath}`;
}

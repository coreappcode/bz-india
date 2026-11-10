import { BASE_URL } from '../config/baseUrl';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email.trim());
}

/**
 * Returns the public-facing origin to use when building user-visible URLs
 * (share links, OAuth/email redirects, deep links, canonical URLs, etc.).
 *
 * On web we honour the env override, then `window.location.origin`
 * (useful for previews/staging), then fall back to `BASE_URL`.
 */
export function getAppBaseUrl(): string {
  const envUrl = import.meta.env.VITE_PUBLIC_APP_URL?.trim() || import.meta.env.VITE_DOMAIN?.trim();
  if (envUrl) {
    try {
      return new URL(envUrl).origin;
    } catch {
      // fallback below
    }
  }

  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }

  return BASE_URL;
}

export function buildAppRedirect(path: string): string {
  const baseUrl = getAppBaseUrl().replace(/\/+$/, '');
  const safePath = path.startsWith('/') ? path : `/${path}`;
  return `${baseUrl}${safePath}`;
}

// OneSignal Web Push initialization (browsers).
// Uses `react-onesignal` which wraps the OneSignal Web SDK v16.
//
// Only initialized on real browsers — Capacitor native builds use the
// Cordova plugin via `nativePushNotifications.ts`.
import logger from '../utils/logger';
import { isNativePlatform } from '../mobile/nativePlatform';
import { ONESIGNAL_APP_ID, isOneSignalConfigured } from './oneSignalConfig';

/**
 * Minimal structural type of the OneSignal Web SDK v16 surface we use.
 * Kept narrow so we don't pull a full @types dependency.
 */
export interface OneSignalSdk {
  init: (opts: Record<string, unknown>) => Promise<void>;
  login: (externalId: string) => Promise<void>;
  logout: () => Promise<void>;
  Slidedown?: {
    promptPush?: (opts?: { force?: boolean }) => Promise<void>;
  };
  Notifications?: {
    permission: boolean | 'default' | 'granted' | 'denied';
    permissionNative?: NotificationPermission;
    requestPermission?: () => Promise<NotificationPermission>;
    addEventListener?: (event: string, cb: (...args: unknown[]) => void) => void;
    removeEventListener?: (event: string, cb: (...args: unknown[]) => void) => void;
  };
  User?: {
    PushSubscription?: {
      id?: string | null;
      token?: string | null;
      optedIn?: boolean;
      optIn?: () => Promise<void>;
      optOut?: () => Promise<void>;
      addEventListener?: (event: 'change', cb: (state: unknown) => void) => void;
      removeEventListener?: (event: 'change', cb: (state: unknown) => void) => void;
    };
  };
}

let currentExternalId: string | null = null;
let readyPromise: Promise<OneSignalSdk | null> | null = null;

async function loadSdk(): Promise<OneSignalSdk | null> {
  try {
    const mod = await import('react-onesignal');
    const sdk = ((mod as unknown as { default?: OneSignalSdk }).default
      || (mod as unknown as OneSignalSdk)) as OneSignalSdk | undefined;
    return sdk ?? null;
  } catch (error) {
    logger.warn('react-onesignal not available', { error });
    return null;
  }
}

/**
 * Idempotent: initializes OneSignal at most once per page load and returns
 * the same promise on subsequent calls. Resolves to `null` when running in
 * an environment where web push is not applicable (native shell, missing
 * config, SSR, SDK load failure) so callers can no-op safely.
 */
export function initializeOneSignalWeb(): Promise<OneSignalSdk | null> {
  if (readyPromise) return readyPromise;
  if (isNativePlatform || !isOneSignalConfigured || typeof window === 'undefined') {
    readyPromise = Promise.resolve(null);
    return readyPromise;
  }
  readyPromise = (async (): Promise<OneSignalSdk | null> => {
    const OneSignal = await loadSdk();
    if (!OneSignal) return null;
    try {
      await OneSignal.init({
        appId: ONESIGNAL_APP_ID,
        // Slide prompt is configured in the OneSignal dashboard; the
        // in-app Settings UI uses the explicit optIn/optOut API instead.
        notifyButton: { enable: false },
        allowLocalhostAsSecureOrigin: true,
      });
      if (currentExternalId) {
        try { await OneSignal.login(currentExternalId); } catch { /* ignore */ }
      }
      return OneSignal;
    } catch (error) {
      logger.error('OneSignal Web init failed', { error });
      return null;
    }
  })();
  return readyPromise;
}

/**
 * Returns the initialized OneSignal SDK once ready, or `null` if web push
 * isn't applicable in this environment. Triggers init lazily if needed.
 */
export function whenWebPushReady(): Promise<OneSignalSdk | null> {
  return initializeOneSignalWeb();
}

export async function setWebPushExternalId(userId: string | null): Promise<void> {
  currentExternalId = userId;
  const OneSignal = await whenWebPushReady();
  if (!OneSignal) return;
  try {
    if (userId) {
      await OneSignal.login(userId);
    } else {
      await OneSignal.logout();
    }
  } catch (error) {
    logger.error('OneSignal Web login/logout failed', { error });
  }
}

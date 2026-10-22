/**
 * webPush.ts
 * ----------
 * High-level browser-only API for managing the user's OneSignal Web push
 * subscription from inside the app (e.g. a Settings toggle).
 *
 * Wraps the OneSignal Web SDK v16 surface so callers don't have to deal
 * with availability checks, partial API support across SDK versions, or
 * native-platform no-ops.
 *
 * All functions are safe to call in any environment: when running inside
 * a Capacitor native shell, when OneSignal isn't configured, when the
 * browser lacks Notification API support, or when the SDK fails to load,
 * they degrade gracefully (return a `null`/`unsupported` state and never
 * throw).
 */

import logger from '../utils/logger';
import { isNativePlatform } from '../mobile/nativePlatform';
import { isOneSignalConfigured } from './oneSignalConfig';
import { whenWebPushReady, type OneSignalSdk } from './oneSignalWeb';

export type WebPushPermission = 'default' | 'granted' | 'denied' | 'unsupported';

export interface WebPushState {
  /** False when web push cannot be used in this environment at all. */
  supported: boolean;
  /** Current browser-level Notification permission. */
  permission: WebPushPermission;
  /** True when the user is currently subscribed in OneSignal. */
  optedIn: boolean;
}

const UNSUPPORTED_STATE: WebPushState = Object.freeze({
  supported: false,
  permission: 'unsupported',
  optedIn: false,
});

/** True only on a real browser tab where web push is even possible. */
export function isWebPushApplicable(): boolean {
  if (isNativePlatform) return false;
  if (!isOneSignalConfigured) return false;
  if (typeof window === 'undefined') return false;
  if (typeof Notification === 'undefined') return false;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
  return true;
}

function readPermission(sdk: OneSignalSdk | null): WebPushPermission {
  // Prefer SDK-reported permission, fall back to the standard Notification API.
  const native = sdk?.Notifications?.permissionNative;
  if (native === 'granted' || native === 'denied' || native === 'default') {
    return native;
  }
  if (typeof Notification !== 'undefined') {
    const p = Notification.permission;
    if (p === 'granted' || p === 'denied' || p === 'default') return p;
  }
  return 'default';
}

function readOptedIn(sdk: OneSignalSdk | null): boolean {
  return sdk?.User?.PushSubscription?.optedIn === true;
}

export async function getWebPushState(): Promise<WebPushState> {
  if (!isWebPushApplicable()) return UNSUPPORTED_STATE;
  const sdk = await whenWebPushReady();
  if (!sdk) return UNSUPPORTED_STATE;
  return {
    supported: true,
    permission: readPermission(sdk),
    optedIn: readOptedIn(sdk),
  };
}

/**
 * Attempts to subscribe the user to web push.
 *  - If browser permission is `denied`, returns without prompting (the
 *    user must re-enable from browser site settings — the UI surfaces this).
 *  - If permission is `default`, requests it and then opts in.
 *  - If permission is `granted`, opts in directly.
 */
export async function enableWebPush(): Promise<WebPushState> {
  if (!isWebPushApplicable()) return UNSUPPORTED_STATE;
  const sdk = await whenWebPushReady();
  if (!sdk) return UNSUPPORTED_STATE;

  let permission = readPermission(sdk);
  if (permission === 'denied') {
    return { supported: true, permission, optedIn: readOptedIn(sdk) };
  }

  try {
    if (permission !== 'granted') {
      // Prefer the SDK helper (also registers the OneSignal SW) and fall
      // back to the standard browser request if unavailable.
      if (typeof sdk.Notifications?.requestPermission === 'function') {
        const res = await sdk.Notifications.requestPermission();
        if (res === 'granted' || res === 'denied' || res === 'default') {
          permission = res;
        }
      } else if (typeof Notification !== 'undefined'
        && typeof Notification.requestPermission === 'function') {
        const res = await Notification.requestPermission();
        if (res === 'granted' || res === 'denied' || res === 'default') {
          permission = res;
        }
      }
    }

    if (permission === 'granted'
      && typeof sdk.User?.PushSubscription?.optIn === 'function') {
      await sdk.User.PushSubscription.optIn();
    }
  } catch (error) {
    logger.error('enableWebPush failed', { error });
  }

  return {
    supported: true,
    permission: readPermission(sdk),
    optedIn: readOptedIn(sdk),
  };
}

export async function disableWebPush(): Promise<WebPushState> {
  if (!isWebPushApplicable()) return UNSUPPORTED_STATE;
  const sdk = await whenWebPushReady();
  if (!sdk) return UNSUPPORTED_STATE;

  try {
    if (typeof sdk.User?.PushSubscription?.optOut === 'function') {
      await sdk.User.PushSubscription.optOut();
    }
  } catch (error) {
    logger.error('disableWebPush failed', { error });
  }

  return {
    supported: true,
    permission: readPermission(sdk),
    optedIn: readOptedIn(sdk),
  };
}

/**
 * Subscribes to push-subscription state changes. Returns an unsubscribe
 * function. Safe to call when web push isn't applicable (no-op).
 */
export function onWebPushStateChange(
  callback: (state: WebPushState) => void,
): () => void {
  if (!isWebPushApplicable()) return () => undefined;

  let active = true;
  let sdkRef: OneSignalSdk | null = null;

  const subHandler = (): void => {
    if (!active) return;
    callback({
      supported: true,
      permission: readPermission(sdkRef),
      optedIn: readOptedIn(sdkRef),
    });
  };
  const permHandler = subHandler;

  void whenWebPushReady().then((sdk) => {
    if (!active) return;
    sdkRef = sdk;
    if (!sdk) return;
    sdk.User?.PushSubscription?.addEventListener?.('change', subHandler);
    sdk.Notifications?.addEventListener?.('permissionChange', permHandler);
    // Emit an initial snapshot so consumers don't have to call getWebPushState separately.
    subHandler();
  });

  return () => {
    active = false;
    const sdk = sdkRef;
    if (!sdk) return;
    sdk.User?.PushSubscription?.removeEventListener?.('change', subHandler);
    sdk.Notifications?.removeEventListener?.('permissionChange', permHandler);
  };
}

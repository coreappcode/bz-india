// Unified OneSignal external_id sync — calls both web and native helpers.
// One of them is a no-op depending on the current platform.
import { setNativePushExternalId } from '../mobile/nativePushNotifications';
import { setWebPushExternalId } from './oneSignalWeb';

export async function syncOneSignalExternalId(userId: string | null): Promise<void> {
  await Promise.allSettled([
    setNativePushExternalId(userId),
    setWebPushExternalId(userId),
  ]);
}

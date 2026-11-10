// Keep the signed-in web push subscription associated with the current user.
import { setWebPushExternalId } from './oneSignalWeb';

export async function syncOneSignalExternalId(userId: string | null): Promise<void> {
  await setWebPushExternalId(userId);
}

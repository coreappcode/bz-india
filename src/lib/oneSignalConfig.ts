// OneSignal shared config — App ID is the only public value.
// REST API Key stays in Supabase secrets (see send-push-notification function).
export const ONESIGNAL_APP_ID =
  (import.meta.env.VITE_ONESIGNAL_APP_ID as string | undefined)?.trim() || '';

export const isOneSignalConfigured = ONESIGNAL_APP_ID.length > 0;

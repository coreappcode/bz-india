// send-push-notification edge function — OneSignal web push delivery.
//
// Required Supabase secrets:
//   ONESIGNAL_APP_ID       — OneSignal App ID (UUID)
//   ONESIGNAL_REST_API_KEY — OneSignal REST API Key (os_v2_app_...)
//
// The client SDK tags subscriptions with external_id = profiles.id; we forward
// recipientUserIds via include_aliases.external_id.
export {};

declare const Deno: {
  env: { get: (name: string) => string | undefined };
  serve: (handler: (req: Request) => Response | Promise<Response>) => void;
};

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const ALLOWED_ORIGINS = [
  'https://www.bzead.com',
  'https://bzead.com',
  'https://www.bzead.in',
  'https://bzead.in',
  'https://bzead.asia',
  'https://www.bzead.asia',
  'https://bzead.uk',
  'https://www.bzead.uk',
  'https://main.dodpm249jwwgd.amplifyapp.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RECIPIENTS = 50;
const MAX_TITLE_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 500;
const ONESIGNAL_API_URL = 'https://api.onesignal.com/notifications';

interface PushRequestBody {
  orderId: string;
  recipientUserIds: string[];
  title: string;
  message: string;
  type: string;
  metadata: Record<string, unknown>;
}

function getCorsHeaders(req?: Request) {
  const origin = req?.headers.get('origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function json(body: unknown, status = 200, req?: Request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...getCorsHeaders(req),
      'Content-Type': 'application/json',
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeText(raw: unknown, maxLength: number): string {
  return String(raw || '').trim().slice(0, maxLength);
}

function normalizeRecipientIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const deduped = new Set<string>();
  for (const value of raw) {
    const id = String(value || '').trim();
    if (UUID_REGEX.test(id)) {
      deduped.add(id);
    }
  }
  return Array.from(deduped);
}

function normalizeMetadata(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  return raw;
}

function buildDataPayload(
  type: string,
  orderId: string,
  metadata: Record<string, unknown>,
): Record<string, string> {
  // Flat string-to-string map for OneSignal `data`.
  const payload: Record<string, string> = {
    type: sanitizeText(type, 80),
    orderId,
  };
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') {
      payload[key] = value.slice(0, 500);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      payload[key] = String(value);
    } else {
      try {
        payload[key] = JSON.stringify(value).slice(0, 500);
      } catch {
        // Ignore values that cannot be stringified.
      }
    }
  }
  return payload;
}

async function authenticateUser(req: Request, supabaseUrl: string, serviceRoleKey: string): Promise<string | null> {
  const authHeader = req.headers.get('Authorization') || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return null;

  const authRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    method: 'GET',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${jwt}`,
    },
  });

  if (!authRes.ok) return null;

  const authUser = await authRes.json() as { id?: string };
  return authUser?.id || null;
}

async function loadOrderParticipants(
  adminClient: ReturnType<typeof createClient>,
  orderId: string,
): Promise<{ buyerId: string; sellerIds: string[]; adminIds: string[] } | null> {
  const { data: orderRow, error: orderError } = await adminClient
    .from('orders')
    .select('id, user_id')
    .eq('id', orderId)
    .maybeSingle();

  if (orderError || !orderRow?.user_id) {
    return null;
  }

  const { data: itemRows, error: itemError } = await adminClient
    .from('order_items')
    .select('seller_id')
    .eq('order_id', orderId)
    .not('seller_id', 'is', null);

  if (itemError) {
    throw new Error('Failed to resolve order participants');
  }

  const sellerIds = Array.from(
    new Set(
      (itemRows || [])
        .map((row) => String((row as { seller_id?: string | null }).seller_id || '').trim())
        .filter((id) => UUID_REGEX.test(id)),
    ),
  );

  const { data: adminRows, error: adminError } = await adminClient
    .from('profiles')
    .select('id')
    .eq('role', 'admin');

  if (adminError) {
    throw new Error('Failed to resolve admin recipients');
  }

  const adminIds = Array.from(
    new Set(
      (adminRows || [])
        .map((row) => String((row as { id?: string | null }).id || '').trim())
        .filter((id) => UUID_REGEX.test(id)),
    ),
  );

  return {
    buyerId: String(orderRow.user_id),
    sellerIds,
    adminIds,
  };
}

/**
 * Map a NotificationType → user-facing category. Kept in sync with
 * `src/lib/notificationPreferences.ts` on the client. Unknown types
 * default to `system`, which is enabled by default.
 */
function getCategoryForType(type: string): 'orders' | 'returns' | 'account' | 'system' | 'promotions' {
  if (type.startsWith('order_') || type === 'label_ready') return 'orders';
  if (type.startsWith('return_') || type === 'refund_processed') return 'returns';
  if (type.startsWith('identity_') || type.startsWith('product_') || type.startsWith('payout_')) return 'account';
  if (type === 'promotion' || type === 'promotional') return 'promotions';
  return 'system';
}

/**
 * Returns the subset of `recipientIds` whose `notification_preferences`
 * allow a push for the given category. Missing rows / missing keys fall
 * back to defaults: master push enabled, all categories enabled EXCEPT
 * promotions (which defaults to disabled).
 */
async function filterRecipientsByPreferences(
  adminClient: ReturnType<typeof createClient>,
  recipientIds: string[],
  category: 'orders' | 'returns' | 'account' | 'system' | 'promotions',
): Promise<string[]> {
  if (recipientIds.length === 0) return [];

  const { data, error } = await adminClient
    .from('profiles')
    .select('id, notification_preferences')
    .in('id', recipientIds);

  if (error) {
    // Fail open on a server-side query error: it's safer to deliver a
    // transactional notification than to silently drop it. We still log
    // for observability via the function logs.
    console.error('filterRecipientsByPreferences read failed', error);
    return recipientIds;
  }

  const categoryKey = `push_${category}` as const;
  const promotionDefault = category === 'promotions' ? false : true;

  const allowedById = new Map<string, boolean>();
  for (const row of (data || []) as Array<{ id?: string | null; notification_preferences?: unknown }>) {
    const id = String(row.id || '');
    if (!id) continue;
    const prefs = isRecord(row.notification_preferences) ? row.notification_preferences : {};
    const masterRaw = prefs['push_enabled'];
    const master = typeof masterRaw === 'boolean' ? masterRaw : true;
    const catRaw = prefs[categoryKey];
    const cat = typeof catRaw === 'boolean' ? catRaw : promotionDefault;
    allowedById.set(id, master && cat);
  }

  return recipientIds.filter((id) => {
    // If we have no row for the user (shouldn't happen, but guard anyway)
    // treat them as allowed (fail open for transactional events).
    if (!allowedById.has(id)) return true;
    return allowedById.get(id) === true;
  });
}

async function loadActorIsAdmin(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
): Promise<boolean> {
  const { data, error } = await adminClient
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle();
  if (error || !data) return false;
  return String((data as { role?: string }).role || '').toLowerCase() === 'admin';
}

function parseRequestBody(rawBody: unknown): PushRequestBody | null {
  if (!isRecord(rawBody)) return null;

  const orderId = sanitizeText(rawBody.orderId, 64);
  const title = sanitizeText(rawBody.title, MAX_TITLE_LENGTH);
  const message = sanitizeText(rawBody.message, MAX_MESSAGE_LENGTH);
  const type = sanitizeText(rawBody.type, 80) || 'info';
  const recipientUserIds = normalizeRecipientIds(rawBody.recipientUserIds);
  const metadata = normalizeMetadata(rawBody.metadata);

  if (!UUID_REGEX.test(orderId)) return null;
  if (!title || !message) return null;
  if (recipientUserIds.length === 0 || recipientUserIds.length > MAX_RECIPIENTS) return null;

  return {
    orderId,
    recipientUserIds,
    title,
    message,
    type,
    metadata,
  };
}

interface OneSignalResponse {
  id?: string;
  recipients?: number;
  errors?: unknown;
  external_id?: string;
}

async function sendOneSignalNotification(params: {
  appId: string;
  restApiKey: string;
  externalIds: string[];
  title: string;
  message: string;
  data: Record<string, string>;
}): Promise<{ success: boolean; recipients: number; errorMessage?: string }> {
  try {
    const response = await fetch(ONESIGNAL_API_URL, {
      method: 'POST',
      headers: {
        // OneSignal v2 REST keys (os_v2_app_...) use Basic auth scheme.
        'Authorization': `Basic ${params.restApiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        app_id: params.appId,
        target_channel: 'push',
        include_aliases: { external_id: params.externalIds },
        headings: { en: params.title },
        contents: { en: params.message },
        data: params.data,
      }),
    });

    const responseText = await response.text();
    let parsed: OneSignalResponse | null = null;
    try { parsed = responseText ? JSON.parse(responseText) as OneSignalResponse : null; } catch { /* ignore */ }

    if (!response.ok) {
      const errorsField = (parsed as { errors?: unknown } | null)?.errors;
      const errorMessage = Array.isArray(errorsField)
        ? String(errorsField.join('; '))
        : (responseText || `OneSignal HTTP ${response.status}`);
      return { success: false, recipients: 0, errorMessage: errorMessage.slice(0, 500) };
    }

    const recipients = Number(parsed?.recipients || 0) || 0;
    return { success: true, recipients };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'OneSignal request failed';
    return { success: false, recipients: 0, errorMessage: sanitizeText(message, 500) };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, req);
  }

  try {
    const supabaseUrl = sanitizeText(Deno.env.get('SUPABASE_URL'), 300);
    const serviceRoleKey = sanitizeText(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), 5000);
    const oneSignalAppId = sanitizeText(Deno.env.get('ONESIGNAL_APP_ID'), 100);
    const oneSignalRestApiKey = String(Deno.env.get('ONESIGNAL_REST_API_KEY') || '').trim();

    if (!supabaseUrl || !serviceRoleKey) {
      return json({ error: 'Server configuration error' }, 500, req);
    }
    if (!oneSignalAppId || !oneSignalRestApiKey) {
      return json({ error: 'OneSignal credentials not configured' }, 500, req);
    }

    const senderUserId = await authenticateUser(req, supabaseUrl, serviceRoleKey);
    if (!senderUserId) {
      return json({ error: 'Unauthorized' }, 401, req);
    }

    const rawBody = await req.json().catch(() => null);
    const parsedBody = parseRequestBody(rawBody);
    if (!parsedBody) {
      return json({ error: 'Invalid request payload' }, 400, req);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const senderIsAdmin = await loadActorIsAdmin(adminClient, senderUserId);

    const participants = await loadOrderParticipants(adminClient, parsedBody.orderId);
    if (!participants) {
      return json({ error: 'Order not found' }, 404, req);
    }

    if (!senderIsAdmin) {
      const senderIsBuyer = participants.buyerId === senderUserId;
      const senderIsSeller = participants.sellerIds.includes(senderUserId);
      if (!senderIsBuyer && !senderIsSeller) {
        return json({ error: 'Forbidden' }, 403, req);
      }

      const allowedRecipientIds = new Set<string>([
        participants.buyerId,
        ...participants.sellerIds,
        ...participants.adminIds,
      ]);

      const unauthorizedRecipient = parsedBody.recipientUserIds.find(
        (recipientId) => !allowedRecipientIds.has(recipientId),
      );

      if (unauthorizedRecipient) {
        return json({ error: 'Forbidden recipient list' }, 403, req);
      }
    }

    const dataPayload = buildDataPayload(
      parsedBody.type,
      parsedBody.orderId,
      parsedBody.metadata,
    );

    const category = getCategoryForType(parsedBody.type);
    const allowedRecipients = await filterRecipientsByPreferences(
      adminClient,
      parsedBody.recipientUserIds,
      category,
    );

    if (allowedRecipients.length === 0) {
      // Everyone opted out — succeed silently with zero recipients so
      // upstream callers don't treat this as an error.
      return json({
        success: true,
        requestedRecipients: parsedBody.recipientUserIds.length,
        filteredRecipients: 0,
        recipients: 0,
        skipped: 'all_recipients_opted_out',
      }, 200, req);
    }

    const sendResult = await sendOneSignalNotification({
      appId: oneSignalAppId,
      restApiKey: oneSignalRestApiKey,
      externalIds: allowedRecipients,
      title: parsedBody.title,
      message: parsedBody.message,
      data: dataPayload,
    });

    return json({
      success: sendResult.recipients > 0,
      requestedRecipients: parsedBody.recipientUserIds.length,
      filteredRecipients: allowedRecipients.length,
      recipients: sendResult.recipients,
      oneSignal: {
        recipients: sendResult.recipients,
        ...(sendResult.errorMessage ? { error: sendResult.errorMessage } : {}),
      },
    }, sendResult.recipients > 0 ? 200 : 502, req);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unexpected server error';
    return json({ error: message }, 500, req);
  }
});

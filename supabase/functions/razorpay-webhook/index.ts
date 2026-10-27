// supabase/functions/razorpay-webhook/index.ts
// Razorpay payment settlement for INR checkouts (bzead.in). Stripe is not touched.
//
// Deploy: supabase functions deploy razorpay-webhook --no-verify-jwt --use-api
// Secrets: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
//
// Two entry points, both ending in the same idempotent settlement:
//  1. Razorpay webhook  (header x-razorpay-signature)  events: payment.captured, order.paid, payment.failed
//  2. Browser verify    (POST { action: 'verify', razorpay_order_id, razorpay_payment_id, razorpay_signature }
//                        with the user's Bearer token)
//
// The Razorpay order id is stored as orders.payment_intent_id, so the existing
// checkout snapshot / recovery / confirmation flow is reused as-is.

const ALLOWED_ORIGINS = [
  'https://bzead.in',
  'https://www.bzead.in',
  'https://bzead.asia',
  'https://www.bzead.asia',
  'https://bzead.uk',
  'https://www.bzead.uk',
  'https://bzead.com',
  'https://www.bzead.com',
  'https://main.dodpm249jwwgd.amplifyapp.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function supabaseUrl(): string {
  return (Deno.env.get('SUPABASE_URL') || '').trim().replace(/\/+$/, '');
}

function serviceKey(): string {
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim() || '';
}

function supabaseHeaders(): Record<string, string> {
  return {
    apikey: serviceKey(),
    Authorization: `Bearer ${serviceKey()}`,
    'Content-Type': 'application/json',
  };
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function fetchMany<T = any>(url: string): Promise<T[]> {
  try {
    const r = await fetch(url, { method: 'GET', headers: supabaseHeaders() });
    if (!r.ok) return [];
    const rows = await r.json();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function fetchOne<T = any>(url: string): Promise<T | null> {
  const rows = await fetchMany<T>(url);
  return rows.length > 0 ? rows[0] : null;
}

async function logEvent(event: {
  event_id: string;
  event_type: string;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  status: 'processed' | 'failed' | 'skipped';
  error_message?: string;
  payload?: unknown;
}) {
  try {
    await fetch(`${supabaseUrl()}/rest/v1/razorpay_webhook_events`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({ ...event, error_message: event.error_message || null, processed_at: new Date().toISOString() }),
    });
  } catch (err) {
    console.error('[razorpay-webhook] Failed to log event:', err);
  }
}

async function isEventProcessed(eventId: string): Promise<boolean> {
  const row = await fetchOne(
    `${supabaseUrl()}/rest/v1/razorpay_webhook_events?event_id=eq.${encodeURIComponent(eventId)}&status=eq.processed&select=id&limit=1`,
  );
  return !!row;
}

type OrderRow = { id: string; payment_status: string | null; status: string | null; total_amount: number; currency: string | null; user_id: string };

const ORDER_SELECT = 'id,payment_status,status,total_amount,currency,user_id';

async function findOrderByRazorpayOrder(razorpayOrderId: string): Promise<OrderRow | null> {
  return fetchOne<OrderRow>(
    `${supabaseUrl()}/rest/v1/orders?payment_intent_id=eq.${encodeURIComponent(razorpayOrderId)}&select=${ORDER_SELECT}&limit=1`,
  );
}

async function recoverOrderFromSnapshot(razorpayOrderId: string): Promise<void> {
  const resp = await fetch(`${supabaseUrl()}/rest/v1/rpc/recover_paid_order_from_snapshot`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify({ p_payment_intent_id: razorpayOrderId }),
  });
  if (!resp.ok) {
    throw new Error(`recover_paid_order_from_snapshot failed: ${(await resp.text()).slice(0, 300)}`);
  }
}

async function patchSnapshot(razorpayOrderId: string, patch: Record<string, unknown>) {
  try {
    await fetch(
      `${supabaseUrl()}/rest/v1/checkout_payment_snapshots?payment_intent_id=eq.${encodeURIComponent(razorpayOrderId)}`,
      {
        method: 'PATCH',
        headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
        body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
      },
    );
  } catch {
    // observability only
  }
}

function rzpAuth(): string {
  const id = Deno.env.get('RAZORPAY_KEY_ID')?.trim() || '';
  const secret = Deno.env.get('RAZORPAY_KEY_SECRET')?.trim() || '';
  return `Basic ${btoa(`${id}:${secret}`)}`;
}

type RzpPayment = {
  id: string;
  order_id: string | null;
  status: string;
  amount: number;
  currency: string;
};

async function fetchRazorpayPayment(paymentId: string): Promise<RzpPayment | null> {
  const r = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: rzpAuth() },
  });
  if (!r.ok) {
    console.error('[razorpay-webhook] fetch payment failed:', r.status);
    return null;
  }
  return await r.json() as RzpPayment;
}

async function captureIfAuthorized(payment: RzpPayment): Promise<RzpPayment> {
  if (payment.status !== 'authorized') return payment;
  const r = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(payment.id)}/capture`, {
    method: 'POST',
    headers: { Authorization: rzpAuth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: payment.amount, currency: payment.currency }),
  });
  if (!r.ok) {
    console.error('[razorpay-webhook] capture failed:', r.status, (await r.text()).slice(0, 300));
    return payment;
  }
  return await r.json() as RzpPayment;
}

type SettleResult =
  | { ok: true; orderId: string; alreadyConfirmed: boolean }
  | { ok: false; code: 'pending' | 'invalid' | 'forbidden' | 'amount_mismatch' | 'no_snapshot' | 'error'; message: string };

// Verifies the payment with Razorpay directly (never trusts browser-supplied amounts),
// creates the order from the pre-payment snapshot if needed, checks the paid amount
// against the order total, then marks the order paid. Safe to run repeatedly.
async function settlePayment(
  razorpayOrderId: string,
  razorpayPaymentId: string,
  opts: { requiredUserId?: string },
): Promise<SettleResult> {
  let payment = await fetchRazorpayPayment(razorpayPaymentId);
  if (!payment) return { ok: false, code: 'error', message: 'Unable to verify payment with Razorpay' };
  if (payment.order_id !== razorpayOrderId) {
    return { ok: false, code: 'invalid', message: 'Payment does not belong to this order' };
  }
  payment = await captureIfAuthorized(payment);
  if (payment.status !== 'captured') {
    return { ok: false, code: 'pending', message: `Payment status is ${payment.status}` };
  }
  if (String(payment.currency).toUpperCase() !== 'INR') {
    return { ok: false, code: 'invalid', message: 'Unexpected payment currency' };
  }

  if (opts.requiredUserId) {
    const snap = await fetchOne<{ user_id: string }>(
      `${supabaseUrl()}/rest/v1/checkout_payment_snapshots?payment_intent_id=eq.${encodeURIComponent(razorpayOrderId)}&select=user_id&limit=1`,
    );
    if (snap && snap.user_id !== opts.requiredUserId) {
      return { ok: false, code: 'forbidden', message: 'Order does not belong to this user' };
    }
  }

  let order = await findOrderByRazorpayOrder(razorpayOrderId);
  if (!order) {
    const snap = await fetchOne(
      `${supabaseUrl()}/rest/v1/checkout_payment_snapshots?payment_intent_id=eq.${encodeURIComponent(razorpayOrderId)}&select=user_id&limit=1`,
    );
    if (!snap) return { ok: false, code: 'no_snapshot', message: 'Checkout snapshot not found' };
    try {
      await recoverOrderFromSnapshot(razorpayOrderId);
    } catch (err) {
      // A concurrent call (webhook vs browser) may have created it already.
      order = await findOrderByRazorpayOrder(razorpayOrderId);
      if (!order) {
        const message = err instanceof Error ? err.message : 'Order creation failed';
        await patchSnapshot(razorpayOrderId, { recovery_status: 'failed', last_error: message.slice(0, 500) });
        return { ok: false, code: 'error', message };
      }
    }
    order = order || await findOrderByRazorpayOrder(razorpayOrderId);
    if (!order) return { ok: false, code: 'error', message: 'Order not found after creation' };
    await patchSnapshot(razorpayOrderId, { recovery_status: 'recovered', recovered_order_id: order.id, last_error: null });
  }

  if (opts.requiredUserId && order.user_id !== opts.requiredUserId) {
    return { ok: false, code: 'forbidden', message: 'Order does not belong to this user' };
  }

  if (['completed', 'succeeded', 'paid'].includes(String(order.payment_status))) {
    return { ok: true, orderId: order.id, alreadyConfirmed: true };
  }

  // Tolerate up to Rs 1 of rounding drift between the checkout quote and the server-priced order.
  const expectedPaise = Math.round(Number(order.total_amount) * 100);
  if (String(order.currency || 'INR').toUpperCase() !== 'INR' || Math.abs(expectedPaise - payment.amount) > 100) {
    return {
      ok: false,
      code: 'amount_mismatch',
      message: `Paid ${payment.amount} paise but order total is ${expectedPaise} paise (order ${order.id})`,
    };
  }

  const patch = await fetch(
    `${supabaseUrl()}/rest/v1/orders?id=eq.${encodeURIComponent(order.id)}&or=(payment_status.is.null,payment_status.neq.completed)`,
    {
      method: 'PATCH',
      headers: { ...supabaseHeaders(), Prefer: 'return=representation' },
      body: JSON.stringify({
        payment_status: 'completed',
        payment_method: 'razorpay',
        payment_provider: 'razorpay',
        razorpay_payment_id: payment.id,
        updated_at: new Date().toISOString(),
      }),
    },
  );
  if (!patch.ok) {
    return { ok: false, code: 'error', message: `Order update failed: ${(await patch.text()).slice(0, 300)}` };
  }
  const updated = await patch.json().catch(() => []);

  if (order.status === 'pending') {
    await fetch(`${supabaseUrl()}/rest/v1/orders?id=eq.${encodeURIComponent(order.id)}&status=eq.pending`, {
      method: 'PATCH',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'processing', updated_at: new Date().toISOString() }),
    }).catch(() => {});
  }

  const justConfirmed = Array.isArray(updated) && updated.length > 0;
  if (justConfirmed) await sendOrderPlacedEmail(order.id);
  return { ok: true, orderId: order.id, alreadyConfirmed: !justConfirmed };
}

// Same order_placed emails as the Stripe flow (send-email dedupes per order/recipient).
async function sendOrderPlacedEmail(orderId: string): Promise<void> {
  try {
    const order = await fetchOne<{
      id: string; user_id: string; total_amount: number; currency: string | null;
      shipping_carrier: string | null; shipping_service_level: string | null;
      expected_delivery_date: string | null; shipping_address: Record<string, unknown> | null; created_at: string;
    }>(
      `${supabaseUrl()}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}` +
      `&select=id,user_id,total_amount,currency,shipping_carrier,shipping_service_level,expected_delivery_date,shipping_address,created_at&limit=1`,
    );
    if (!order) return;

    const buyer = await fetchOne<{ id: string; email: string; full_name: string | null }>(
      `${supabaseUrl()}/rest/v1/profiles?id=eq.${encodeURIComponent(order.user_id)}&select=id,email,full_name&limit=1`,
    );

    const items = await fetchMany<{
      product_name: string | null; quantity: number; price: number | null; seller_id: string | null;
      customer_unit_price: number | null; customer_line_total: number | null;
      seller_unit_price: number | null; seller_line_total: number | null; seller_currency: string | null;
    }>(
      `${supabaseUrl()}/rest/v1/order_items?order_id=eq.${encodeURIComponent(orderId)}` +
      `&select=product_name,quantity,price,seller_id,customer_unit_price,customer_line_total,seller_unit_price,seller_line_total,seller_currency`,
    );

    const buyerCcy = String(order.currency || 'INR').toUpperCase();
    const buyerItems = items.map((it) => {
      const line = Number(it.customer_line_total ?? ((it.customer_unit_price ?? it.price ?? 0) * (it.quantity || 1)));
      return { name: it.product_name || 'Item', quantity: it.quantity, price: `${buyerCcy} ${line.toFixed(2)}` };
    });

    const sellerIds = Array.from(new Set(items.map((it) => it.seller_id).filter((x): x is string => !!x)));
    const sellers = sellerIds.length > 0
      ? await fetchMany<{ id: string; email: string; full_name: string | null }>(
          `${supabaseUrl()}/rest/v1/profiles?id=in.(${sellerIds.map(encodeURIComponent).join(',')})&select=id,email,full_name`,
        )
      : [];
    const admins = await fetchMany<{ id: string; email: string; full_name: string | null }>(
      `${supabaseUrl()}/rest/v1/profiles?role=eq.admin&select=id,email,full_name`,
    );

    const sa = order.shipping_address || {};
    const pick = (...keys: string[]): string => {
      for (const k of keys) {
        const v = (sa as Record<string, unknown>)[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
      return '';
    };
    const buyerName = pick('full_name', 'name', 'fullName') || buyer?.full_name || 'Customer';
    const buyerAddressStr = [
      buyerName,
      pick('address_line1', 'addressLine1', 'line1', 'street', 'address'),
      pick('address_line2', 'addressLine2', 'line2'),
      [pick('city', 'town'), pick('state', 'region'), pick('postal_code', 'postalCode', 'zip')].filter(Boolean).join(', '),
      pick('country', 'countryName'),
      pick('phone', 'mobile') ? `Phone: ${pick('phone', 'mobile')}` : '',
    ].filter(Boolean).join('\n');

    const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const orderIdShort = order.id.slice(0, 8).toUpperCase();
    const orderDateStr = fmtDate(order.created_at);

    const buyerData: Record<string, unknown> = {
      order_id: orderIdShort,
      order_date: orderDateStr,
      customer_name: buyerName,
      currency: buyerCcy,
      order_total: Number(order.total_amount || 0).toFixed(2),
      payment_method: 'Razorpay',
      items: buyerItems,
    };
    if (order.shipping_carrier) buyerData.carrier = order.shipping_carrier;
    if (order.shipping_service_level) buyerData.service_level = order.shipping_service_level;
    if (order.expected_delivery_date) buyerData.delivery_date = fmtDate(order.expected_delivery_date);

    const sendEmailUrl = `${supabaseUrl()}/functions/v1/send-email`;
    const callSendEmail = async (label: string, payload: unknown) => {
      try {
        const resp = await fetch(sendEmailUrl, { method: 'POST', headers: supabaseHeaders(), body: JSON.stringify(payload) });
        if (!resp.ok) {
          console.error(`[razorpay-webhook] email[${label}] HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
        }
      } catch (e) {
        console.error(`[razorpay-webhook] email[${label}] error:`, e);
      }
    };

    if (buyer?.email) {
      await callSendEmail('buyer', {
        eventType: 'order_placed',
        data: buyerData,
        recipients: [{ email: buyer.email, recipientType: 'buyer', recipientName: buyer.full_name || 'Customer', recipientUserId: buyer.id }],
      });
    }

    for (const s of sellers) {
      if (!s.email) continue;
      const mine = items.filter((it) => it.seller_id === s.id);
      if (mine.length === 0) continue;
      const ccy = String(mine[0].seller_currency || 'INR').toUpperCase();
      await callSendEmail(`seller:${s.id}`, {
        eventType: 'order_placed',
        data: {
          order_id: orderIdShort,
          order_date: orderDateStr,
          customer_name: buyerName,
          buyer_address: buyerAddressStr,
          items: mine.map((it) => {
            const qty = Number(it.quantity || 1);
            const line = Number(it.seller_line_total ?? (Number(it.seller_unit_price ?? 0) * qty));
            return { name: it.product_name || 'Item', quantity: qty, price: `${ccy} ${line.toFixed(2)}` };
          }),
        },
        recipients: [{ email: s.email, recipientType: 'seller', recipientName: s.full_name || 'Seller', recipientUserId: s.id }],
      });
    }

    const adminRecipients = admins
      .filter((a) => a.email)
      .map((a) => ({ email: a.email, recipientType: 'admin' as const, recipientName: a.full_name || 'Admin', recipientUserId: a.id }));
    if (adminRecipients.length > 0) {
      await callSendEmail('admins', { eventType: 'order_placed', data: { ...buyerData }, recipients: adminRecipients });
    }
  } catch (err) {
    console.error('[razorpay-webhook] sendOrderPlacedEmail error:', err);
  }
}

async function handleWebhook(req: Request, signature: string): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const webhookSecret = Deno.env.get('RAZORPAY_WEBHOOK_SECRET')?.trim();
  if (!webhookSecret) {
    console.error('[razorpay-webhook] RAZORPAY_WEBHOOK_SECRET missing');
    return json({ error: 'Webhook not configured' }, 500);
  }

  const contentLength = Number(req.headers.get('content-length') || '0');
  if (contentLength > 1_048_576) return json({ error: 'Payload too large' }, 413);

  const rawBody = await req.text();
  const expected = await hmacHex(webhookSecret, rawBody);
  if (!safeEqual(expected, signature)) {
    console.error('[razorpay-webhook] Invalid signature');
    return json({ error: 'Invalid signature' }, 400);
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: 'Invalid payload' }, 400);
  }

  const eventType: string = String(event?.event || '');
  const payment = event?.payload?.payment?.entity;
  const razorpayOrderId: string | null = payment?.order_id || event?.payload?.order?.entity?.id || null;
  const razorpayPaymentId: string | null = payment?.id || null;
  const eventId = req.headers.get('x-razorpay-event-id')
    || `${eventType}:${razorpayPaymentId || razorpayOrderId || crypto.randomUUID()}`;

  if (await isEventProcessed(eventId)) return json({ received: true, skipped: true });

  const record = (status: 'processed' | 'failed' | 'skipped', error_message?: string) =>
    logEvent({ event_id: eventId, event_type: eventType, razorpay_order_id: razorpayOrderId, razorpay_payment_id: razorpayPaymentId, status, error_message, payload: event });

  try {
    if (eventType === 'payment.captured' || eventType === 'order.paid') {
      if (!razorpayOrderId || !razorpayPaymentId) {
        await record('failed', 'Missing order or payment id');
        return json({ received: true, error: 'Missing ids' });
      }
      const result = await settlePayment(razorpayOrderId, razorpayPaymentId, {});
      if (result.ok) {
        await record(result.alreadyConfirmed ? 'skipped' : 'processed', result.alreadyConfirmed ? 'Already confirmed' : undefined);
        return json({ received: true });
      }
      await record('failed', `${result.code}: ${result.message}`);
      // Retry only for transient problems; mismatches need a human, retrying won't help.
      const retryable = result.code === 'error' || result.code === 'pending' || result.code === 'no_snapshot';
      return json({ received: false, error: result.code }, retryable ? 500 : 200);
    }

    // payment.failed and everything else: log only. The buyer can retry on the same
    // Razorpay order, so the order/snapshot is intentionally left alone.
    await record('processed');
    return json({ received: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unhandled error';
    console.error('[razorpay-webhook] Unhandled error:', message);
    await record('failed', message);
    return json({ received: false, error: 'Internal error' }, 500);
  }
}

async function handleVerify(req: Request, cors: Record<string, string>): Promise<Response> {
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return reply({ error: 'Authentication required' }, 401);

  const authRes = await fetch(`${supabaseUrl()}/auth/v1/user`, {
    headers: { apikey: serviceKey(), Authorization: authHeader },
  });
  if (!authRes.ok) return reply({ error: 'Invalid authentication token' }, 401);
  const authUser = await authRes.json() as { id?: string };
  if (!authUser?.id) return reply({ error: 'Invalid authentication token' }, 401);

  const body = await req.json().catch(() => ({}));
  const orderId = String(body?.razorpay_order_id || '');
  const paymentId = String(body?.razorpay_payment_id || '');
  const signature = String(body?.razorpay_signature || '');
  if (!orderId || !paymentId || !signature) return reply({ error: 'Missing payment details' }, 400);

  const keySecret = Deno.env.get('RAZORPAY_KEY_SECRET')?.trim();
  if (!keySecret) return reply({ error: 'Razorpay is not configured' }, 500);
  const expected = await hmacHex(keySecret, `${orderId}|${paymentId}`);
  if (!safeEqual(expected, signature)) return reply({ error: 'Invalid payment signature' }, 400);

  const result = await settlePayment(orderId, paymentId, { requiredUserId: authUser.id });
  if (result.ok) return reply({ status: 'confirmed', orderId: result.orderId });

  await logEvent({
    event_id: `verify:${paymentId}:${Date.now()}`,
    event_type: 'client.verify',
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    status: 'failed',
    error_message: `${result.code}: ${result.message}`,
  });
  console.error('[razorpay-webhook] verify failed:', result.code, result.message);
  if (result.code === 'pending') return reply({ status: 'pending' }, 202);
  if (result.code === 'forbidden') return reply({ error: 'Forbidden' }, 403);
  if (result.code === 'amount_mismatch') {
    return reply({ error: 'Payment amount does not match the order. Our team has been alerted.' }, 409);
  }
  return reply({ error: 'Unable to confirm payment yet', status: 'error' }, 500);
}

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const webhookSignature = req.headers.get('x-razorpay-signature');
  try {
    if (webhookSignature) return await handleWebhook(req, webhookSignature);
    return await handleVerify(req, cors);
  } catch (err) {
    console.error('[razorpay-webhook] Fatal error:', err);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});

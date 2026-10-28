// supabase/functions/create-razorpay-order/index.ts
// Creates a Razorpay order for INR checkouts (bzead.in). Stripe is not touched.
//
// Deploy: supabase functions deploy create-razorpay-order --no-verify-jwt --use-api
// Secrets: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
//
// Request:  { amount: number (paise), currency: 'INR', notes?: Record<string,string> }
// Response: { orderId, keyId, amount, currency }

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
  // Capacitor Android WebView (com.bzead.india)
  'https://localhost',
  'capacitor://localhost',
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

// 5,00,000 INR in paise
const MAX_AMOUNT_PAISE = 50_000_000;

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);

  try {
    const keyId = Deno.env.get('RAZORPAY_KEY_ID')?.trim();
    const keySecret = Deno.env.get('RAZORPAY_KEY_SECRET')?.trim();
    if (!keyId || !keySecret) return reply({ error: 'Razorpay is not configured' }, 500);

    const contentLength = Number(req.headers.get('content-length') || '0');
    if (contentLength > 65_536) return reply({ error: 'Request too large' }, 413);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return reply({ error: 'Authentication required' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) return reply({ error: 'Server configuration error' }, 500);

    const authRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: serviceRoleKey, Authorization: authHeader },
    });
    if (!authRes.ok) return reply({ error: 'Invalid authentication token' }, 401);
    const authUser = await authRes.json() as { id?: string };
    if (!authUser?.id) return reply({ error: 'Invalid authentication token' }, 401);

    const { amount, currency, notes } = await req.json();

    if (String(currency || '').toUpperCase() !== 'INR') {
      return reply({ error: 'Razorpay supports INR checkouts only' }, 400);
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 100) {
      return reply({ error: 'Invalid amount' }, 400);
    }
    const amountPaise = Math.round(amount);
    if (amountPaise > MAX_AMOUNT_PAISE) {
      return reply({ error: 'Amount exceeds maximum allowed' }, 400);
    }

    const safeNotes: Record<string, string> = {};
    if (notes && typeof notes === 'object') {
      for (const [k, v] of Object.entries(notes as Record<string, unknown>).slice(0, 10)) {
        safeNotes[String(k).slice(0, 40)] = String(v ?? '').slice(0, 250);
      }
    }
    // Set after the spread so a caller cannot override them.
    safeNotes.user_id = authUser.id;
    safeNotes.source = 'bzeadstore';

    const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`,
      },
      body: JSON.stringify({
        amount: amountPaise,
        currency: 'INR',
        receipt: `bz_${Date.now()}`.slice(0, 40),
        notes: safeNotes,
      }),
    });

    const order = await rzpRes.json().catch(() => ({})) as { id?: string };
    if (!rzpRes.ok || !order?.id) {
      console.error('[create-razorpay-order] Razorpay error:', rzpRes.status, JSON.stringify(order).slice(0, 500));
      return reply({ error: 'Unable to start payment. Please try again.' }, 502);
    }

    return reply({ orderId: order.id, keyId, amount: amountPaise, currency: 'INR' });
  } catch (err) {
    console.error('[create-razorpay-order] Unhandled error:', err);
    return reply({ error: 'Unable to start payment. Please try again.' }, 500);
  }
});

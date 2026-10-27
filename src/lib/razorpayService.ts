/**
 * Razorpay client-side service (bzead.in, INR checkouts only).
 * Stripe code paths are not touched; callers decide between providers with
 * shouldUseRazorpay().
 */

import { supabase } from './supabase';
import { isNativePlatform } from '../mobile/nativePlatform';

const RAZORPAY_HOSTS = new Set(['bzead.in', 'www.bzead.in']);
const CHECKOUT_SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

export class RazorpayDismissedError extends Error {
  constructor() {
    super('Payment window was closed');
    this.name = 'RazorpayDismissedError';
  }
}

export interface RazorpayPaymentResult {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

export interface RazorpayOrder {
  orderId: string;
  keyId: string;
  amount: number;
  currency: string;
}

export type RazorpayVerifyOutcome =
  | { status: 'confirmed'; orderId: string }
  | { status: 'pending' }
  | { status: 'error'; message: string; fatal?: boolean };

/**
 * Razorpay is used only on bzead.in, only for INR, only on the web.
 * VITE_DISABLE_RAZORPAY=true is a kill switch that falls back to Stripe.
 * VITE_FORCE_RAZORPAY=true enables it on any host (local testing).
 */
export function shouldUseRazorpay(currency: string): boolean {
  if (isNativePlatform) return false;
  if (String(import.meta.env.VITE_DISABLE_RAZORPAY || '').toLowerCase() === 'true') return false;
  if (String(currency || '').toUpperCase() !== 'INR') return false;
  if (String(import.meta.env.VITE_FORCE_RAZORPAY || '').toLowerCase() === 'true') return true;
  if (typeof window === 'undefined') return false;
  return RAZORPAY_HOSTS.has(window.location.hostname.toLowerCase());
}

let scriptPromise: Promise<void> | null = null;

function loadCheckoutScript(): Promise<void> {
  if (typeof window !== 'undefined' && (window as any).Razorpay) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = CHECKOUT_SCRIPT_SRC;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        scriptPromise = null;
        reject(new Error('Unable to load the payment window. Check your connection and try again.'));
      };
      document.body.appendChild(script);
    });
  }
  return scriptPromise;
}

async function getAccessToken(): Promise<string> {
  const { data: { session }, error } = await supabase.auth.refreshSession();
  if (!error && session?.access_token) return session.access_token;
  const { data: { session: fallback } } = await supabase.auth.getSession();
  if (!fallback?.access_token) throw new Error('Authentication expired. Please log in again.');
  return fallback.access_token;
}

async function readFunctionError(error: any, fallback: string): Promise<string> {
  const context = error?.context;
  if (context instanceof Response) {
    try {
      const payload = await context.clone().json();
      if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error;
    } catch {
      /* ignore */
    }
  }
  return fallback;
}

/** amountPaise is the order total in paise (INR x 100). */
export async function createRazorpayOrder(
  amountPaise: number,
  notes?: Record<string, string>,
): Promise<RazorpayOrder> {
  const token = await getAccessToken();
  const { data, error } = await supabase.functions.invoke('create-razorpay-order', {
    body: { amount: amountPaise, currency: 'INR', notes },
    headers: { Authorization: `Bearer ${token}` },
  });
  if (error) {
    throw new Error(await readFunctionError(error, 'Failed to initialize payment'));
  }
  if (!data?.orderId || !data?.keyId) {
    throw new Error(data?.error || 'Failed to initialize payment');
  }
  return data as RazorpayOrder;
}

export async function verifyRazorpayPayment(payment: RazorpayPaymentResult): Promise<RazorpayVerifyOutcome> {
  try {
    const token = await getAccessToken();
    const { data, error } = await supabase.functions.invoke('razorpay-webhook', {
      body: { action: 'verify', ...payment },
      headers: { Authorization: `Bearer ${token}` },
    });
    if (error) {
      const status = (error as any)?.context instanceof Response ? (error as any).context.status : 0;
      if (status === 202) return { status: 'pending' };
      const message = await readFunctionError(error, 'Unable to confirm payment yet');
      // 4xx other than auth/timeouts will not fix themselves on retry
      return { status: 'error', message, fatal: status === 409 || status === 403 };
    }
    if (data?.status === 'confirmed' && data?.orderId) {
      return { status: 'confirmed', orderId: String(data.orderId) };
    }
    if (data?.status === 'pending') return { status: 'pending' };
    return { status: 'error', message: data?.error || 'Unable to confirm payment yet' };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : 'Unable to confirm payment yet' };
  }
}

export async function openRazorpayCheckout(params: {
  order: RazorpayOrder;
  name: string;
  email: string;
  phone?: string | null;
  description?: string;
}): Promise<RazorpayPaymentResult> {
  await loadCheckoutScript();
  const Razorpay = (window as any).Razorpay;
  if (!Razorpay) throw new Error('Payment window is unavailable. Please try again.');

  return new Promise<RazorpayPaymentResult>((resolve, reject) => {
    const instance = new Razorpay({
      key: params.order.keyId,
      amount: params.order.amount,
      currency: params.order.currency,
      order_id: params.order.orderId,
      name: 'BZEAD',
      description: params.description || 'Order payment',
      prefill: {
        name: params.name || undefined,
        email: params.email || undefined,
        contact: params.phone || undefined,
      },
      theme: { color: '#2563eb' },
      handler: (response: RazorpayPaymentResult) => resolve(response),
      modal: { ondismiss: () => reject(new RazorpayDismissedError()) },
    });
    // A failed attempt keeps the modal open so the buyer can retry another method.
    instance.on('payment.failed', (resp: any) => {
      console.warn('[Razorpay] payment attempt failed:', resp?.error?.code, resp?.error?.reason);
    });
    instance.open();
  });
}

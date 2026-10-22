/**
 * Stripe client-side service
 *
 * Development: calls Vite dev middleware at /api/create-payment-intent
 * Production: calls Supabase Edge Function via supabase.functions.invoke()
 */

import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { supabase } from './supabase';
import { isNativePlatform } from '../mobile/nativePlatform';

// Singleton Stripe instance
let stripePromise: Promise<Stripe | null> | null = null;

export function getStripe(): Promise<Stripe | null> {
  if (!stripePromise) {
    const key = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;
    if (!key) {
      console.error('VITE_STRIPE_PUBLISHABLE_KEY is not set');
      return Promise.resolve(null);
    }
    stripePromise = loadStripe(key);
  }
  return stripePromise;
}

interface CreatePaymentIntentParams {
  /** Amount in the smallest currency unit (e.g. cents for USD, paise for INR) */
  amount: number;
  /** ISO 4217 currency code, lowercase (e.g. 'usd', 'inr') */
  currency: string;
  /** Optional metadata to attach to the PaymentIntent */
  metadata?: Record<string, string>;
}

interface PaymentIntentResult {
  clientSecret: string;
  paymentIntentId: string;
}

const extractFunctionErrorMessage = async (error: any): Promise<string> => {
  if (!error) return 'Failed to create payment intent';

  const context = error?.context;
  if (context instanceof Response) {
    try {
      const payload = await context.clone().json();
      if (typeof payload?.error === 'string' && payload.error.trim()) {
        return payload.error;
      }
      if (typeof payload?.message === 'string' && payload.message.trim()) {
        return payload.message;
      }
    } catch {
      try {
        const text = await context.clone().text();
        if (text.trim()) return text;
      } catch {
        /* ignore */
      }
    }

    return `Payment function failed with HTTP ${context.status}`;
  }

  if (typeof context === 'string' && context.trim()) return context;
  if (typeof error.message === 'string' && error.message.trim()) return error.message;
  return 'Failed to create payment intent';
};

/**
 * Create a Stripe PaymentIntent.
 *
 * - In development, hits the Vite dev middleware (/api/create-payment-intent)
 * - In production, calls the Supabase Edge Function
 */
export async function createPaymentIntent(
  params: CreatePaymentIntentParams
): Promise<PaymentIntentResult> {
  // Tag the request so the edge function can disable redirect-based payment methods
  // when called from inside the Capacitor WebView (where Stripe's off-site redirect
  // would land on https://localhost and never return to the app).
  const requestBody = {
    ...params,
    client: isNativePlatform ? 'native' : 'web',
  };

  if (import.meta.env.DEV) {
    // Development: use Vite dev middleware
    const res = await fetch('/api/create-payment-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Network error' }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const result = await res.json();
    if (!result?.clientSecret || !result?.paymentIntentId) {
      throw new Error('Missing client secret or payment intent ID in dev response');
    }
    return result as PaymentIntentResult;
  } else {
    // Production: use Supabase Edge Function
    // Force-refresh the session so the JWT is always fresh (WebViews cache aggressively)
    const { data: { session }, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError || !session?.access_token) {
      // Fallback: try getSession in case refreshSession fails but token is still valid
      const { data: { session: fallbackSession } } = await supabase.auth.getSession();
      if (!fallbackSession?.access_token) {
        throw new Error('Authentication expired. Please log in again.');
      }
      const headers: Record<string, string> = {
        Authorization: `Bearer ${fallbackSession.access_token}`,
      };

      const { data, error } = await supabase.functions.invoke('create-payment-intent', {
        body: requestBody,
        headers,
      });

      if (error) {
        const detailedMessage = await extractFunctionErrorMessage(error);
        throw new Error(detailedMessage || 'Failed to create payment intent');
      }

      if (!data?.clientSecret || !data?.paymentIntentId) {
        throw new Error(data?.error || 'Missing client secret or payment intent ID in response');
      }

      return data as PaymentIntentResult;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${session.access_token}`,
    };

    const { data, error } = await supabase.functions.invoke('create-payment-intent', {
      body: requestBody,
      headers,
    });

    if (error) {
      const detailedMessage = await extractFunctionErrorMessage(error);
      throw new Error(detailedMessage || 'Failed to create payment intent');
    }

    if (!data?.clientSecret || !data?.paymentIntentId) {
      throw new Error(data?.error || 'Missing client secret or payment intent ID in response');
    }

    return data as PaymentIntentResult;
  }
}

/**
 * Convert a display-level amount to Stripe's smallest currency unit.
 * e.g. $10.50 USD → 1050 cents, ¥1000 JPY → 1000 (JPY has no decimals)
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

export function toStripeAmount(displayAmount: number, currency: string): number {
  const lc = currency.toLowerCase();
  if (ZERO_DECIMAL_CURRENCIES.has(lc)) {
    return Math.round(displayAmount);
  }
  return Math.round(displayAmount * 100);
}

/**
 * Convert Stripe's smallest-unit amount back to a display amount.
 */
export function fromStripeAmount(stripeAmount: number, currency: string): number {
  const lc = currency.toLowerCase();
  if (ZERO_DECIMAL_CURRENCIES.has(lc)) {
    return stripeAmount;
  }
  return stripeAmount / 100;
}

import { afterEach, describe, it, expect, vi } from 'vitest';
import { createPaymentIntent, toStripeAmount, fromStripeAmount } from '../lib/stripeService';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createPaymentIntent', () => {
  it('forwards MVR payment requests to the configured payment endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ clientSecret: 'secret', paymentIntentId: 'pi_test' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(createPaymentIntent({ amount: 1000, currency: 'mvr' }))
      .resolves.toEqual({ clientSecret: 'secret', paymentIntentId: 'pi_test' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      body: expect.stringContaining('"currency":"mvr"'),
    });
  });
});

describe('toStripeAmount', () => {
  it('converts USD dollars to cents', () => {
    expect(toStripeAmount(10.50, 'USD')).toBe(1050);
  });

  it('converts INR to paise', () => {
    expect(toStripeAmount(499.99, 'INR')).toBe(49999);
  });

  it('handles zero-decimal currency (JPY)', () => {
    expect(toStripeAmount(1000, 'JPY')).toBe(1000);
  });

  it('handles zero-decimal currency (KRW)', () => {
    expect(toStripeAmount(5000, 'KRW')).toBe(5000);
  });

  it('rounds to nearest integer', () => {
    expect(toStripeAmount(10.555, 'USD')).toBe(1056);
  });

  it('handles zero amount', () => {
    expect(toStripeAmount(0, 'USD')).toBe(0);
  });

  it('is case-insensitive for currency', () => {
    expect(toStripeAmount(10, 'usd')).toBe(1000);
    expect(toStripeAmount(10, 'Usd')).toBe(1000);
  });
});

describe('fromStripeAmount', () => {
  it('converts cents back to USD', () => {
    expect(fromStripeAmount(1050, 'USD')).toBe(10.50);
  });

  it('converts paise back to INR', () => {
    expect(fromStripeAmount(49999, 'INR')).toBe(499.99);
  });

  it('handles zero-decimal currency (JPY)', () => {
    expect(fromStripeAmount(1000, 'JPY')).toBe(1000);
  });

  it('round-trips correctly', () => {
    const original = 99.99;
    const stripe = toStripeAmount(original, 'EUR');
    const back = fromStripeAmount(stripe, 'EUR');
    expect(back).toBe(original);
  });
});

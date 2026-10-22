import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  convertAmount,
  convertAmountStrict,
  formatCurrency,
  currencyForCountry,
  fetchExchangeRates,
  isExchangeRateUnavailable,
} from '../utils/currency';
import { IS_FIXED_COUNTRY_STOREFRONT, IS_INDIA_STOREFRONT, isIndiaCountry } from '../config/market';

// Mock supabase so DB queries fail immediately (no real network calls in tests)
vi.mock('../lib/supabase', () => {
  const makeBuilder = (): any => {
    const p = Promise.resolve({ data: null, error: { message: 'DB unavailable in tests' } });
    return Object.assign(p, {
      select: () => makeBuilder(),
      eq: () => makeBuilder(),
      not: () => makeBuilder(),
    });
  };
  return { supabase: { from: () => makeBuilder() } };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── convertAmount ─────────────────────────────────────────────────────
describe('convertAmount', () => {
  const rates = { USD: 1, INR: 83.5, EUR: 0.92, GBP: 0.79, JPY: 149.5 };

  it('returns same amount when currencies match', () => {
    expect(convertAmount(100, 'USD', 'USD', rates)).toBe(100);
  });

  it('converts USD to INR', () => {
    const result = convertAmount(10, 'USD', 'INR', rates);
    expect(result).toBe(835);
  });

  it('converts INR to USD', () => {
    const result = convertAmount(835, 'INR', 'USD', rates);
    expect(result).toBe(10);
  });

  it('converts between two non-USD currencies via USD', () => {
    const result = convertAmount(100, 'EUR', 'GBP', rates);
    // 100 EUR → USD = 100 / 0.92 ≈ 108.70, → GBP = 108.70 * 0.79 ≈ 85.87
    expect(result).toBeCloseTo(85.87, 1);
  });

  it('does not substitute the source amount when a fixed-market conversion rate is missing', () => {
    const result = convertAmount(100, 'XXX', 'USD', rates);
    expect(result).toBe(IS_FIXED_COUNTRY_STOREFRONT ? Number.NaN : 100);
  });

  it('does not substitute the source amount when the target rate is missing in a fixed market', () => {
    const result = convertAmount(100, 'USD', 'XXX', rates);
    expect(result).toBe(IS_FIXED_COUNTRY_STOREFRONT ? Number.NaN : 100);
  });

  it('handles zero amount', () => {
    expect(convertAmount(0, 'USD', 'INR', rates)).toBe(0);
  });
});

// ── formatCurrency ────────────────────────────────────────────────────
describe('formatCurrency', () => {
  it('formats USD correctly', () => {
    const result = formatCurrency(10.5, 'USD');
    expect(result).toContain('10.50');
    expect(result).toContain('$');
  });

  it('formats INR correctly', () => {
    const result = formatCurrency(1000, 'INR');
    expect(result).toContain('₹');
  });

  it('uses Indian digit grouping for INR in the India storefront', () => {
    const result = formatCurrency(12345678, 'INR');
    expect(result).toContain(IS_INDIA_STOREFRONT ? '1,23,45,678' : '12,345,678');
  });

  it('formats JPY without decimals', () => {
    const result = formatCurrency(1000, 'JPY');
    expect(result).toContain('1,000');
    expect(result).not.toContain('.00');
  });

  it('handles invalid currency gracefully', () => {
    const result = formatCurrency(50, 'ZZZZ');
    expect(result).toContain('50');
  });

  it('formats MVR as Maldivian Rufiyaa', () => {
    const result = formatCurrency(1234.5, 'MVR');
    expect(result).toContain('Rf');
    expect(result).toContain('1,234.50');
  });

  it('does not render an unavailable MVR price as a number', () => {
    expect(formatCurrency(Number.NaN, 'MVR')).toBe('MVR price unavailable');
  });
});

describe('India storefront country matching', () => {
  it('accepts India country names and ISO codes', () => {
    expect(isIndiaCountry('India')).toBe(true);
    expect(isIndiaCountry('IN')).toBe(true);
    expect(isIndiaCountry('IND')).toBe(true);
    expect(isIndiaCountry('United Kingdom')).toBe(false);
  });
});

describe('strict currency conversion', () => {
  it('converts between INR and MVR using available rates', () => {
    const rates = { USD: 1, INR: 83.5, MVR: 15.4485 };
    expect(convertAmountStrict(835, 'INR', 'MVR', rates)).toBeCloseTo(154.485);
  });

  it('returns null when a required exchange rate is missing', () => {
    expect(convertAmountStrict(835, 'INR', 'MVR', { USD: 1, INR: 83.5 })).toBeNull();
  });
});

// ── currencyForCountry ────────────────────────────────────────────────
describe('currencyForCountry', () => {
  it('returns INR for country tokens in sync mode', () => {
    expect(currencyForCountry('IN')).toBe('INR');
    expect(currencyForCountry('GB')).toBe('INR');
    expect(currencyForCountry('ZZ')).toBe('INR');
  });

  it('returns INR for empty string', () => {
    expect(currencyForCountry('')).toBe('INR');
  });

  it('returns the currency code if already a valid currency', () => {
    expect(currencyForCountry('USD')).toBe('USD');
    expect(currencyForCountry('EUR')).toBe('EUR');
    expect(currencyForCountry('gbp')).toBe('GBP');
  });
});

describe('exchange rate availability', () => {
  it('reports unavailable when all rate sources are unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')));

    const rates = await fetchExchangeRates();

    // No hardcoded fallback — returns empty object when all sources fail
    expect(Object.keys(rates).length).toBe(0);
    expect(isExchangeRateUnavailable()).toBe(true);
  });
});

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, Loader2, ShieldCheck } from 'lucide-react';
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';
import type { StripePaymentElementOptions } from '@stripe/stripe-js';
import type { OrderData } from '../../types';
import { supabase } from '../../lib/supabase';
import { formatCurrency as fmtCurrency } from '../../utils/currency';
import {
  getStripe,
  createPaymentIntent,
  toStripeAmount,
} from '../../lib/stripeService';
import { fetchMultiSellerTat, checkDeliveryServiceability } from '../../lib/tatService';
import { calculateDestinationCheckoutPricing, type DestinationCheckoutPricing } from '../../lib/checkoutPricingService';
import { useCurrency } from '../../contexts/CurrencyContext';
import { useCart } from '../../contexts/CartContext';
import { Header } from '../../components/layout/Header';
import { Footer } from '../../components/layout/Footer';
import { MobileNav } from '../../components/layout/MobileNav';
import { notifyOrderEvent } from '../../lib/notificationService';
import { generateInvoicePdfBase64, type InvoicePdfData } from '../../utils/invoicePdf';
import { buildInvoiceNumber } from '../../utils/idFormatter';
import { isNativePlatform } from '../../mobile/nativePlatform';
import { buildAppRedirect } from '../../utils/authEnv';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Platform fee rate applied to the product subtotal (3%). */
const PLATFORM_FEE_RATE = 0.03;

/**
 * Build the order invoice as a PDF email attachment (base64). Returns undefined
 * on any failure so the order-confirmation email still goes out without it.
 */
async function buildOrderInvoiceAttachment(args: {
  orderId: string;
  orderDate: string;
  paymentMethod: string;
  buyerName: string;
  buyerAddress: string;
  buyerPhone?: string;
  items: Array<{ name: string; qty: number; unitPrice: number }>;
  currency: string;
  totalPaid: number;
  shippingCharge?: number;
  formatPrice: (value: number, currency?: string) => string;
}): Promise<{ filename: string; base64: string; contentType: string } | undefined> {
  try {
    const invoiceData: InvoicePdfData = {
      invoiceNumber: buildInvoiceNumber(new Date().toISOString(), undefined, args.orderId),
      orderId: args.orderId.slice(0, 8).toUpperCase(),
      orderDate: args.orderDate,
      paymentMethod: args.paymentMethod,
      buyerName: args.buyerName,
      buyerAddress: args.buyerAddress,
      buyerPhone: args.buyerPhone,
      items: args.items.map((i) => ({ name: i.name, qty: i.qty, unitPrice: i.unitPrice, total: i.unitPrice * i.qty })),
      currency: args.currency,
      totalPaid: args.totalPaid,
      platformFeeRate: PLATFORM_FEE_RATE,
      shippingCharge: args.shippingCharge ?? 0,
      summaryMode: 'customer',
    };
    const { base64, filename } = await generateInvoicePdfBase64(invoiceData, args.formatPrice);
    return { base64, filename, contentType: 'application/pdf' };
  } catch (err) {
    console.error('[buildOrderInvoiceAttachment] failed:', err);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CheckoutItem {
  cartItemId?: string;
  productId: string;
  productName: string;
  quantity: number;
  // Seller base selling price (for payout)
  price: number;
  // Buyer-facing unit price (same as seller selling price)
  buyerUnitPrice?: number;
  sellerId?: string;
  selectedSize?: string;
  selectedColor?: string;
  selectedVariantId?: string;
  selectedVariantSku?: string;
  productImage?: string;
}

type CheckoutResultItem = {
  productId: string;
  productName: string;
  quantity: number;
  price: number;
  productImage?: string;
  selectedSize?: string;
  selectedColor?: string;
};

type CheckoutResultState = {
  paymentResult: 'success' | 'failed';
  paymentIntentId: string;
  orderId?: string;
  tempOrderId?: string;
  items: CheckoutResultItem[];
  totalAmount: number;
  currency: string;
  failureReason?: string;
};

interface ShippingAddr {
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  countryCode?: string;
  [key: string]: unknown;
}

// ISO 3166-1 alpha-3 → alpha-2 conversion (covers all countries in our DB)
const ISO3_TO_ISO2: Record<string, string> = {
  IND: 'IN', GBR: 'GB', USA: 'US', ARE: 'AE', SAU: 'SA', QAT: 'QA',
  KWT: 'KW', BHR: 'BH', OMN: 'OM', DEU: 'DE', FRA: 'FR', ITA: 'IT',
  ESP: 'ES', NLD: 'NL', BEL: 'BE', AUT: 'AT', CHE: 'CH', SWE: 'SE',
  NOR: 'NO', DNK: 'DK', FIN: 'FI', POL: 'PL', PRT: 'PT', IRL: 'IE',
  GRC: 'GR', CZE: 'CZ', ROU: 'RO', HUN: 'HU', BGR: 'BG', HRV: 'HR',
  SVK: 'SK', SVN: 'SI', LTU: 'LT', LVA: 'LV', EST: 'EE', LUX: 'LU',
  MLT: 'MT', CYP: 'CY', ISL: 'IS', GTM: 'GT', CAN: 'CA', AUS: 'AU',
  NZL: 'NZ', JPN: 'JP', KOR: 'KR', SGP: 'SG', MYS: 'MY', THA: 'TH',
  IDN: 'ID', PHL: 'PH', VNM: 'VN', ZAF: 'ZA', BRA: 'BR', MEX: 'MX',
  ARG: 'AR', CHL: 'CL', COL: 'CO', PER: 'PE', TUR: 'TR', ISR: 'IL',
  EGY: 'EG', NGA: 'NG', KEN: 'KE', GHA: 'GH', LKA: 'LK', BGD: 'BD',
  PAK: 'PK', NPL: 'NP', MDV: 'MV', MMR: 'MM', CHN: 'CN', HKG: 'HK', TWN: 'TW',
  RUS: 'RU', UKR: 'UA',
};

const STRIPE_COUNTRY_FALLBACK_MAP: Record<string, string> = {
  india: 'IN',
  guatemala: 'GT',
  uk: 'GB',
  'united kingdom': 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'northern ireland': 'GB',
  usa: 'US',
  'united states': 'US',
  'united states of america': 'US',
  uae: 'AE',
  'united arab emirates': 'AE',
  germany: 'DE',
  france: 'FR',
  italy: 'IT',
  spain: 'ES',
  netherlands: 'NL',
  belgium: 'BE',
  austria: 'AT',
  switzerland: 'CH',
  sweden: 'SE',
  norway: 'NO',
  denmark: 'DK',
  finland: 'FI',
  poland: 'PL',
  portugal: 'PT',
  ireland: 'IE',
  greece: 'GR',
  'saudi arabia': 'SA',
  qatar: 'QA',
  kuwait: 'KW',
  bahrain: 'BH',
  oman: 'OM',
  canada: 'CA',
  australia: 'AU',
  'new zealand': 'NZ',
  japan: 'JP',
  singapore: 'SG',
  malaysia: 'MY',
  maldives: 'MV',
  'south africa': 'ZA',
  brazil: 'BR',
  mexico: 'MX',
};

const toStripeCountryCode = (country?: string, countryCode?: string) => {
  const directCode = String(countryCode || '').trim().toUpperCase();
  // Already 2-letter
  if (/^[A-Z]{2}$/.test(directCode)) return directCode;
  // Convert 3-letter to 2-letter
  if (/^[A-Z]{3}$/.test(directCode) && ISO3_TO_ISO2[directCode]) return ISO3_TO_ISO2[directCode];

  const countryValue = String(country || '').trim();
  if (/^[A-Za-z]{2}$/.test(countryValue)) return countryValue.toUpperCase();
  // Try 3-letter country value
  const upper3 = countryValue.toUpperCase();
  if (/^[A-Z]{3}$/.test(upper3) && ISO3_TO_ISO2[upper3]) return ISO3_TO_ISO2[upper3];

  const normalizedCountry = countryValue.toLowerCase().replace(/\s+/g, ' ');
  return STRIPE_COUNTRY_FALLBACK_MAP[normalizedCountry] || '';
};

const INDIA_COUNTRY_TOKENS = new Set(['INDIA', 'IN', 'IND']);

const normalizeCountryToken = (value?: string) =>
  String(value || '').trim().toUpperCase().replace(/\s+/g, '');

const resolveCheckoutShippingProvider = (
  provider?: string,
  country?: string,
  countryCode?: string,
): string | null => {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  if (normalizedProvider) return normalizedProvider;

  const countryCodeToken = normalizeCountryToken(countryCode);
  const countryToken = normalizeCountryToken(country);
  if (INDIA_COUNTRY_TOKENS.has(countryCodeToken) || INDIA_COUNTRY_TOKENS.has(countryToken)) {
    return 'shiprocket';
  }

  return null;
};

const shouldRetryCreateOrderWithoutCountry = (message: string): boolean => {
  const normalized = String(message || '').toLowerCase();
  return normalized.includes('create_order_secure')
    && normalized.includes('p_country')
    && (normalized.includes('function') || normalized.includes('parameter') || normalized.includes('signature'));
};

const callCreateOrderSecure = async (params: Record<string, unknown>) => {
  const payload: Record<string, unknown> = { ...params };
  const shippingAddress = payload.p_shipping_address as Record<string, unknown> | null | undefined;
  const explicitCountry = String(payload.p_country || '').trim();
  const inferredCountry = String(shippingAddress?.country || '').trim();
  const destinationCountry = explicitCountry || inferredCountry;

  if (destinationCountry) {
    payload.p_country = destinationCountry;
  }

  let result = await supabase.rpc('create_order_secure', payload);

  if (result.error && destinationCountry) {
    const message = String(result.error.message || '');
    if (shouldRetryCreateOrderWithoutCountry(message)) {
      const { p_country, ...legacyPayload } = payload;
      result = await supabase.rpc('create_order_secure', legacyPayload);
    }
  }

  return result;
};

const waitForRecoveredOrder = async (
  paymentIntentId: string,
  timeoutMs = 30_000,
  intervalMs = 2_000,
) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const { data, error } = await supabase
      .from('orders')
      .select('id, status, payment_status')
      .eq('payment_intent_id', paymentIntentId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!error && data) {
      return data;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return null;
};

const TEMP_PENDING_ORDERS_KEY = 'beauzead_temp_pending_orders';

type TempPendingOrderRecord = {
  tempOrderId: string;
  paymentIntentId: string;
  userId: string;
  totalAmount: number;
  currency: string;
  createdAt: string;
  status: 'processing';
  paymentStatus: 'pending' | 'completed';
  items: Array<{
    productId: string;
    productName: string;
    quantity: number;
    price: number;
    productImage?: string;
  }>;
};

const readTempPendingOrders = (): TempPendingOrderRecord[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(TEMP_PENDING_ORDERS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeTempPendingOrders = (orders: TempPendingOrderRecord[]) => {
  if (typeof window === 'undefined') return;
  localStorage.setItem(TEMP_PENDING_ORDERS_KEY, JSON.stringify(orders));
};

const removeTempPendingOrder = (paymentIntentId: string) => {
  const next = readTempPendingOrders().filter((order) => order.paymentIntentId !== paymentIntentId);
  writeTempPendingOrders(next);
};

const upsertTempPendingOrder = (record: TempPendingOrderRecord) => {
  const existing = readTempPendingOrders().filter((order) => order.paymentIntentId !== record.paymentIntentId);
  existing.unshift(record);
  writeTempPendingOrders(existing.slice(0, 20));
};

const getTempOrderDateToken = (date = new Date()) => {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yy = String(date.getFullYear()).slice(-2);
  return `${dd}${mm}${yy}`;
};

const getTemporaryOrderId = (isInternational: boolean) => {
  const typeToken = isInternational ? 'INT' : 'DOM';
  const dateToken = getTempOrderDateToken();
  const sequenceKey = `beauzead_temp_order_seq_${typeToken}_${dateToken}`;
  const current = Number(localStorage.getItem(sequenceKey) || '0') || 0;
  const next = current + 1;
  localStorage.setItem(sequenceKey, String(next));
  return `TM${typeToken}${dateToken}${String(next).padStart(7, '0')}`;
};

const buildCheckoutRpcItems = (
  items: CheckoutItem[],
  productMeta?: Map<string, { sku: string | null; hsn_code: string | null }>,
) => items.map((item) => {
  const meta = productMeta?.get(item.productId);
  return {
    product_id: String(item.productId),
    quantity: item.quantity,
    product_name: item.productName,
    product_image: item.productImage || '',
    variant_info: {
      size: item.selectedSize || null,
      color: item.selectedColor || null,
      sku: item.selectedVariantId || item.selectedVariantSku || item.selectedSize || item.selectedColor
        ? item.selectedVariantSku || null
        : meta?.sku || null,
      hsn_code: meta?.hsn_code || null,
    },
  };
});

const buildCheckoutRpcParams = ({
  customerId,
  items,
  productMeta,
  shippingAddress,
  billingAddress,
  customerPhone,
  notes,
  paymentIntentId,
  paymentMethod,
  paymentStatus,
  orderStatus,
  checkoutCurrency,
  shippingAmount,
  actualShippingCost,
  platformShippingMargin,
  shippingCarrier,
  shippingServiceLevel,
  shippingProvider,
  shippingRateId,
  expectedDeliveryDateIso,
  expectedDeliveryDays,
}: {
  customerId: string;
  items: CheckoutItem[];
  productMeta?: Map<string, { sku: string | null; hsn_code: string | null }>;
  shippingAddress: Record<string, unknown>;
  billingAddress: Record<string, unknown> | null;
  customerPhone?: string | null;
  notes?: string | null;
  paymentIntentId: string;
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  orderStatus?: string | null;
  checkoutCurrency: string;
  shippingAmount?: number;
  actualShippingCost?: number;
  platformShippingMargin?: number;
  shippingCarrier?: string | null;
  shippingServiceLevel?: string | null;
  shippingProvider?: string | null;
  shippingRateId?: string | null;
  expectedDeliveryDateIso?: string | null;
  expectedDeliveryDays?: number | null;
}) => {
  const params: Record<string, unknown> = {
    p_user_id: customerId,
    p_items: buildCheckoutRpcItems(items, productMeta),
    p_shipping_address: shippingAddress,
    p_billing_address: billingAddress,
    p_country: String(shippingAddress.country || '').trim() || null,
    p_phone: customerPhone || null,
    p_notes: notes || null,
    p_payment_intent_id: paymentIntentId,
    p_currency: checkoutCurrency,
    p_shipping_charge: shippingAmount ?? 0,
    p_actual_shipping_cost: actualShippingCost ?? 0,
    p_platform_shipping_margin: platformShippingMargin ?? 0,
    // p_fx_rate omitted: derived server-side from countries.exchange_rate (audit rule C/D)
    p_idempotency_key: `stripe_${paymentIntentId}`,
    p_shipping_carrier: shippingCarrier || null,
    p_shipping_service_level: shippingServiceLevel || null,
    p_shipping_provider: shippingProvider || null,
    p_shipping_rate_id: shippingRateId || null,
    p_expected_delivery_date: expectedDeliveryDateIso || null,
    p_expected_delivery_days: expectedDeliveryDays ?? null,
  };

  if (paymentMethod) params.p_payment_method = paymentMethod;
  if (paymentStatus) params.p_payment_status = paymentStatus;
  if (orderStatus) params.p_order_status = orderStatus;

  return params;
};

const upsertCheckoutRecoverySnapshot = async ({
  userId,
  paymentIntentId,
  rpcParams,
}: {
  userId: string;
  paymentIntentId: string;
  rpcParams: Record<string, unknown>;
}) => supabase
  .from('checkout_payment_snapshots')
  .upsert(
    {
      user_id: userId,
      payment_intent_id: paymentIntentId,
      rpc_params: rpcParams,
      recovery_status: 'pending',
      last_error: null,
    },
    { onConflict: 'payment_intent_id' },
  );

// Legacy helpers removed — order creation now uses create_order_secure RPC

interface CheckoutLocationState {
  items: CheckoutItem[];
  totalAmount: number;
  currency?: string;
  subtotalAmount?: number;
  buyerProductSubtotalAmount?: number;
  shippingAmount?: number;
  platformChargeAmount?: number;
  actualShippingCost?: number;
  platformShippingMargin?: number;
  customerId: string;
  customerEmail: string;
  customerName: string;
  shippingAddress: ShippingAddr;
  customerPhone?: string;
  notes?: string;
  codEligible?: boolean;
  codIneligibleItems?: Array<{ productId: string; productName: string }>;
  estimatedDeliveryDate?: string;
  estimatedDeliveryDays?: string;
  shippingTier?: 'standard' | 'premium' | 'express';
  shippingCarrier?: string;
  shippingServiceLevel?: string;
  shippingRateId?: string;
  shippingProvider?: string;
}

// ---------------------------------------------------------------------------
// Inner form rendered inside <Elements> (has access to stripe & elements)
// ---------------------------------------------------------------------------

const CheckoutForm: React.FC<
  CheckoutLocationState & {
    paymentIntentId: string;
    onSuccess?: (order: OrderData) => void;
    onCancel?: () => void;
    productMeta?: Map<string, { sku: string | null; hsn_code: string | null }>;
    codEligible?: boolean;
    isInternational?: boolean;
    codSurcharge?: number;
    codPricingLoading?: boolean;
    actualShippingCost?: number;
    platformShippingMargin?: number;
  }
> = ({
  items,
  totalAmount,
  subtotalAmount: _subtotalAmount,
  buyerProductSubtotalAmount,
  shippingAmount,
  platformChargeAmount: _platformChargeAmount,
  actualShippingCost,
  platformShippingMargin,
  customerId,
  customerEmail,
  customerName,
  shippingAddress,
  customerPhone,
  notes,
  currency: checkoutCurrency = 'INR',
  paymentIntentId,
  onSuccess,
  onCancel: _onCancel,
  productMeta,
  codEligible = false,
  isInternational = false,
  codSurcharge: _codSurcharge = 0,
  codPricingLoading = false,
  estimatedDeliveryDate,
  estimatedDeliveryDays,
  shippingTier,
  shippingCarrier,
  shippingServiceLevel,
  shippingRateId,
  shippingProvider,
}) => {
  const { clearCart } = useCart();
  const stripe = useStripe();
  const elements = useElements();
  const navigate = useNavigate();
  const { rates, formatPrice } = useCurrency();
  const effectiveShippingProvider = resolveCheckoutShippingProvider(
    shippingProvider,
    shippingAddress?.country,
    shippingAddress?.countryCode,
  );

  // FX is derived server-side in create_order_secure (audit rule C/D); no client computation.

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const clearCheckoutCartState = useCallback(() => {
    clearCart();
    if (typeof window !== 'undefined') {
      localStorage.removeItem('beauzead_checkout_shipping');
      localStorage.removeItem('beauzead_checkout_selected_cart_ids');
    }
  }, [clearCart]);

  const [billingAddress, setBillingAddress] = useState<ShippingAddr>({ ...shippingAddress });
  const [sameAsShipping, setSameAsShipping] = useState(true);

  // The web checkout accepts cards only; wallet buttons are not offered.
  const paymentElementOptions: StripePaymentElementOptions = {
    layout: 'tabs',
    wallets: { applePay: 'never', googlePay: 'never' },
  };

  // COD vs Stripe toggle
  const [payViaCod, setPayViaCod] = useState(false);

  type CodLiveQuote = {
    totalAmount: number;
    shippingAmount: number;
    actualShippingCost: number;
    platformShippingMargin: number;
    codSurcharge: number;
  };

  const [codLiveQuote, setCodLiveQuote] = useState<CodLiveQuote | null>(null);
  const [codLiveQuoteLoading, setCodLiveQuoteLoading] = useState(false);
  const [codLiveQuoteError, setCodLiveQuoteError] = useState<string | null>(null);

  const fetchCodLiveQuote = useCallback(async (): Promise<CodLiveQuote> => {
    const quote = await calculateDestinationCheckoutPricing({
      items: items.map((item) => ({
        cartItemId: item.cartItemId,
        productId: item.productId,
        productName: item.productName,
        quantity: item.quantity,
        unitPrice: item.price,
        currency: checkoutCurrency || 'INR',
        selectedVariantId: item.selectedVariantId,
        selectedVariantSku: item.selectedVariantSku,
        selectedSize: item.selectedSize,
        selectedColor: item.selectedColor,
      })),
      destinationCountry: shippingAddress.country || '',
      destinationPostalCode: shippingAddress.postalCode || '',
      rates,
      isCod: true,
    });

    const selectedTier = shippingTier || 'standard';
    let selectedShipping = quote.shipping;
    let selectedTotal = quote.total;

    if (selectedTier !== 'standard' && quote.intlShippingOptions) {
      const tierOption = quote.intlShippingOptions[selectedTier];
      if (tierOption) {
        selectedShipping = tierOption.shipping;
        selectedTotal = tierOption.total;
      }
    }

    const prepaidShipping = shippingAmount ?? 0;
    return {
      totalAmount: selectedTotal,
      shippingAmount: selectedShipping,
      actualShippingCost: quote.actualShippingCost,
      platformShippingMargin: quote.platformShippingMargin,
      codSurcharge: Math.max(0, selectedShipping - prepaidShipping),
    };
  }, [items, checkoutCurrency, shippingAddress.country, shippingAddress.postalCode, rates, shippingTier, shippingAmount]);

  useEffect(() => {
    let cancelled = false;

    if (!payViaCod || !codEligible || isInternational) {
      setCodLiveQuote(null);
      setCodLiveQuoteError(null);
      setCodLiveQuoteLoading(false);
      return;
    }

    setCodLiveQuoteLoading(true);
    setCodLiveQuoteError(null);

    void (async () => {
      try {
        const quote = await fetchCodLiveQuote();
        if (!cancelled) {
          setCodLiveQuote(quote);
        }
      } catch (quoteErr) {
        if (!cancelled) {
          console.error('Failed to fetch COD live quote:', quoteErr);
          setCodLiveQuote(null);
          setCodLiveQuoteError('Unable to fetch COD shipping charges right now. Please try again.');
        }
      } finally {
        if (!cancelled) {
          setCodLiveQuoteLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [payViaCod, codEligible, isInternational, fetchCodLiveQuote]);

  const codPricingInProgress = codPricingLoading || codLiveQuoteLoading;
  const codDisplayTotalAmount = codLiveQuote?.totalAmount ?? totalAmount;

  // ---- Leave-page confirmation dialog (replaces window.confirm) ----
  const [leaveDialog, setLeaveDialog] = useState<{ destination: string } | null>(null);

  const confirmLeave = useCallback((destination: string) => {
    setLeaveDialog({ destination });
  }, []);

  const handleLeaveConfirm = useCallback(() => {
    const dest = leaveDialog?.destination || '/checkout/review';
    setLeaveDialog(null);
    navigate(dest);
  }, [leaveDialog, navigate]);

  const handleLeaveCancel = useCallback(() => {
    setLeaveDialog(null);
  }, []);

  // Block browser back button / tab close
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };

    const handlePopState = () => {
      // Push state back so the user stays on the current page
      window.history.pushState(null, '', window.location.href);
      setLeaveDialog({ destination: '/checkout/review' });
    };

    // Push an extra history entry so browser back triggers popstate instead of navigating away
    window.history.pushState(null, '', window.location.href);
    window.addEventListener('popstate', handlePopState);
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [navigate]);

  // ------ Submit handler ------
  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!stripe || !elements) return;

      setIsLoading(true);
      setError(null);

      try {
        const billing = sameAsShipping ? shippingAddress : billingAddress;
        const checkoutResultItems: CheckoutResultItem[] = items.map((item) => ({
          productId: item.productId,
          productName: item.productName,
          quantity: item.quantity,
          price: item.price,
          productImage: item.productImage,
          selectedSize: item.selectedSize,
          selectedColor: item.selectedColor,
        }));
        const shippingAddressAny = shippingAddress as any;
        const productIds = items.map((item) => item.productId);
        const destinationPin = String(shippingAddress.postalCode || '').replace(/\s+/g, '');

        // Determine if this is an international order
        const destCountryTokenOnline = (shippingAddress.country || '').trim().toUpperCase().replace(/\s+/g, '');
        const isIntlOnline = Boolean(destCountryTokenOnline) && !['INDIA', 'IN', 'IND'].includes(destCountryTokenOnline);

        // Serviceability and delivery estimation must happen before payment capture,
        // otherwise a paid order can become unrecoverable if the client dies here.
        const onlineSellerId = items[0]?.sellerId || customerId;
        if (!isIntlOnline && destinationPin.length === 6) {
          const svcResult = await checkDeliveryServiceability(destinationPin, onlineSellerId);
          if (!svcResult.serviceable) {
            console.warn('[Checkout] Pincode not serviceable:', destinationPin);
            setError('Your pincode is not a serviceable area. Please try with another pincode.');
            setIsLoading(false);
            return;
          }
        }

        let maxDeliveryDays = 0;
        let expectedDeliveryDateIso: string | null = null;
        if (!isIntlOnline) {
          const tatResult = await fetchMultiSellerTat(productIds, destinationPin, customerId);
          maxDeliveryDays = tatResult.maxTatDays;
          expectedDeliveryDateIso = tatResult.maxExpectedDate || null;
        } else {
          const rawEtd = estimatedDeliveryDate || null;
          expectedDeliveryDateIso = (rawEtd && !isNaN(Date.parse(rawEtd))) ? rawEtd : null;
          maxDeliveryDays = parseInt(estimatedDeliveryDays || '0', 10) || 0;
        }

        const enrichedShippingAddress = {
          ...shippingAddress,
          full_name: customerName || shippingAddressAny.full_name || shippingAddressAny.fullName || shippingAddressAny.name || null,
          phone: customerPhone || shippingAddressAny.phone || shippingAddressAny.phone_number || null,
          expected_delivery_days: maxDeliveryDays || null,
          expected_delivery_date: expectedDeliveryDateIso || null,
        };

        const recoveryRpcParams = buildCheckoutRpcParams({
          customerId,
          items,
          productMeta,
          shippingAddress: enrichedShippingAddress,
          billingAddress: billing,
          customerPhone,
          notes,
          paymentIntentId,
          checkoutCurrency,
          shippingAmount,
          actualShippingCost,
          platformShippingMargin,
          shippingCarrier: shippingCarrier || null,
          shippingServiceLevel: shippingServiceLevel || null,
          shippingProvider: effectiveShippingProvider,
          shippingRateId: shippingRateId || null,
          expectedDeliveryDateIso,
          expectedDeliveryDays: maxDeliveryDays || null,
        });

        const { error: preSnapshotErr } = await upsertCheckoutRecoverySnapshot({
          userId: customerId,
          paymentIntentId,
          rpcParams: recoveryRpcParams,
        });
        if (preSnapshotErr) {
          console.error('Failed to persist checkout snapshot before payment:', preSnapshotErr);
          setError('Unable to prepare secure order recovery right now. Please try again.');
          setIsLoading(false);
          return;
        }

        // 1. Validate PaymentElement fields
        const { error: submitErr } = await elements.submit();
        if (submitErr) {
          setError(submitErr.message || 'Validation error');
          setIsLoading(false);
          return;
        }

        // 2. Confirm payment (Stripe handles 3-D Secure etc.)
        const billingCountryCode = toStripeCountryCode(billing.country, billing.countryCode);

        const billingAddressForStripe: {
          line1?: string;
          city?: string;
          state?: string;
          postal_code?: string;
          country?: string;
        } = {
          line1: billing.street,
          city: billing.city,
          state: billing.state,
          postal_code: billing.postalCode,
        };

        if (billingCountryCode) {
          billingAddressForStripe.country = billingCountryCode;
        }

        const { error: confirmErr, paymentIntent } = await stripe.confirmPayment({
          elements,
          confirmParams: {
            payment_method_data: {
              billing_details: {
                name: customerName,
                email: customerEmail,
                address: billingAddressForStripe,
              },
            },
            // On native the WebView origin is `https://localhost` (internal Capacitor bundle).
            // Using `https://localhost` as return_url means any 3DS/UPI redirect lands back
            // inside the same WebView and React Router handles it — the app never leaves the bundle.
            // On web, use the public domain.
            return_url: isNativePlatform
              ? 'https://localhost/checkout/confirmation'
              : buildAppRedirect('/checkout/confirmation'),
          },
          redirect: 'if_required',
        });

        if (confirmErr) {
          const recoveredOrder = await waitForRecoveredOrder(paymentIntentId, 12_000, 1_500);
          if (recoveredOrder?.id) {
            clearCheckoutCartState();
            const successResult: CheckoutResultState = {
              paymentResult: 'success',
              paymentIntentId,
              orderId: String(recoveredOrder.id),
              items: checkoutResultItems,
              totalAmount,
              currency: checkoutCurrency,
            };
            navigate('/checkout/confirmation', { state: { checkoutResult: successResult } });
            setIsLoading(false);
            return;
          }

          const failedResult: CheckoutResultState = {
            paymentResult: 'failed',
            paymentIntentId,
            items: checkoutResultItems,
            totalAmount,
            currency: checkoutCurrency,
            failureReason: confirmErr.message || 'Payment failed',
          };
          navigate('/checkout/confirmation', { state: { checkoutResult: failedResult } });
          setIsLoading(false);
          return;
        }

        if (paymentIntent?.status === 'succeeded' || paymentIntent?.status === 'processing') {
          const computedOrderStatus = paymentIntent.status === 'succeeded' ? 'processing' : 'pending';
          const computedPaymentStatus = paymentIntent.status === 'succeeded' ? 'completed' : 'pending';
          const computedPaymentMethod =
            paymentIntent.payment_method_types?.[0]
            || (typeof paymentIntent.payment_method === 'string' ? paymentIntent.payment_method : null)
            || 'card';
          const rpcParams = buildCheckoutRpcParams({
            customerId,
            items,
            productMeta,
            shippingAddress: enrichedShippingAddress,
            billingAddress: billing,
            customerPhone,
            notes,
            paymentIntentId,
            paymentMethod: computedPaymentMethod,
            paymentStatus: computedPaymentStatus,
            orderStatus: computedOrderStatus,
            checkoutCurrency,
            shippingAmount,
            actualShippingCost,
            platformShippingMargin,
            shippingCarrier: shippingCarrier || null,
            shippingServiceLevel: shippingServiceLevel || null,
            shippingProvider: effectiveShippingProvider,
            shippingRateId: shippingRateId || null,
            expectedDeliveryDateIso,
            expectedDeliveryDays: maxDeliveryDays || null,
          });

          const { error: snapshotErr } = await upsertCheckoutRecoverySnapshot({
            userId: customerId,
            paymentIntentId,
            rpcParams,
          });

          if (snapshotErr) {
            console.error('Failed to persist finalized checkout snapshot:', snapshotErr);
          }

          // M5: Retry order creation up to 3 times since payment is already captured
          let order: any = null;
          let orderErr: any = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            const result = await callCreateOrderSecure(rpcParams);
            order = result.data;
            orderErr = result.error;
            if (!orderErr && order) break;
            if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          }

          if (orderErr || !order) {
            console.error('Order insert failed after Stripe capture. PaymentIntent:', paymentIntentId);
            const destinationCountryToken = normalizeCountryToken(
              shippingAddress.countryCode || shippingAddress.country,
            );
            const isInternationalOrder = !INDIA_COUNTRY_TOKENS.has(destinationCountryToken);
            const tempOrderId = getTemporaryOrderId(isInternationalOrder);

            upsertTempPendingOrder({
              tempOrderId,
              paymentIntentId,
              userId: customerId,
              totalAmount,
              currency: checkoutCurrency,
              createdAt: new Date().toISOString(),
              status: 'processing',
              paymentStatus: computedPaymentStatus,
              items: items.map((item) => ({
                productId: item.productId,
                productName: item.productName,
                quantity: item.quantity,
                price: item.price,
                productImage: item.productImage,
              })),
            });

            const successResult: CheckoutResultState = {
              paymentResult: 'success',
              paymentIntentId,
              tempOrderId,
              items: checkoutResultItems,
              totalAmount,
              currency: checkoutCurrency,
            };

            clearCheckoutCartState();

            navigate(
              `/checkout/confirmation?payment_intent=${encodeURIComponent(paymentIntentId)}&temp_order_id=${encodeURIComponent(tempOrderId)}`,
              { state: { checkoutResult: successResult } },
            );
            setIsLoading(false);
            return;
          }

          removeTempPendingOrder(paymentIntentId);

          // Record payment
          const { error: paymentRecordErr } = await supabase
            .from('payment_intents')
            .upsert(
              {
                order_id: order.id,
                stripe_payment_intent_id: paymentIntentId,
                status: paymentIntent.status,
                amount: totalAmount,
                currency: checkoutCurrency.toLowerCase(),
              },
              { onConflict: 'stripe_payment_intent_id' },
            );
          if (paymentRecordErr) {
            console.error('Payment record insert failed:', paymentRecordErr);
          }

          // Confirm payment server-side (sets payment_status='paid' securely)
          if (paymentIntent.status === 'succeeded') {
            const { error: confirmPayErr } = await supabase.rpc('confirm_order_payment', {
              p_order_id: order.id,
              p_payment_intent_id: paymentIntentId,
            });
            if (confirmPayErr) {
              console.error('Payment confirmation failed (order still created):', confirmPayErr);
              // Non-fatal: admin can confirm manually. Order exists.
            }
          }

          setSuccess(true);

          // Fire order_placed notification (non-blocking)
          const sellerIds = [...new Set(items.map(i => i.sellerId).filter((id): id is string => !!id))];
          const productSubtotal = buyerProductSubtotalAmount ?? items.reduce((s, i) => s + i.price * i.quantity, 0);
          const platformCharge9 = productSubtotal * PLATFORM_FEE_RATE;
          const shippingExtra = platformShippingMargin ?? 0;
          const platformProfit = platformCharge9 + shippingExtra;
          const deliveryDateStr = expectedDeliveryDateIso
            ? new Date(expectedDeliveryDateIso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
            : maxDeliveryDays ? `~${maxDeliveryDays} days` : undefined;
          const invoiceAttachment = await buildOrderInvoiceAttachment({
            orderId: order.id,
            orderDate: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
            paymentMethod: 'Card',
            buyerName: customerName,
            buyerAddress: [shippingAddress.street, shippingAddress.city, shippingAddress.state, shippingAddress.postalCode, shippingAddress.country].filter(Boolean).join(', '),
            buyerPhone: customerPhone || undefined,
            items: items.map(i => ({ name: i.productName, qty: i.quantity, unitPrice: i.price })),
            currency: checkoutCurrency.toUpperCase(),
            totalPaid: totalAmount,
            shippingCharge: shippingAmount ?? 0,
            formatPrice,
          });
          notifyOrderEvent({
            type: 'order_placed',
            orderId: order.id,
            orderNumber: order.id,
            buyerId: customerId,
            buyerEmail: customerEmail,
            buyerName: customerName,
            sellerIds,
            adminNotify: true,
            title: 'Order Placed Successfully',
            message: `Your order has been placed and is being processed.`,
            emailAttachment: invoiceAttachment,
            emailData: {
              order_id: order.id.slice(0, 8).toUpperCase(),
              order_date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
              customer_name: customerName,
              currency: checkoutCurrency.toUpperCase(),
              order_total: totalAmount.toFixed(2),
              payment_method: 'Card',
              carrier: shippingCarrier || undefined,
              service_level: shippingServiceLevel || undefined,
              delivery_date: deliveryDateStr,
              items: items.map(i => ({
                name: i.productName,
                quantity: i.quantity,
                price: `${checkoutCurrency.toUpperCase()} ${(i.price * i.quantity).toFixed(2)}`,
                variant: [i.selectedSize, i.selectedColor].filter(Boolean).join(' / ') || undefined,
              })),
              // Admin-only fields
              buyer_address: [shippingAddress.street, shippingAddress.city, shippingAddress.state, shippingAddress.postalCode, shippingAddress.country].filter(Boolean).join(', '),
              buyer_email: customerEmail,
              buyer_phone: customerPhone || undefined,
              product_subtotal: productSubtotal.toFixed(2),
              platform_charge: platformCharge9.toFixed(2),
              shipping_charge_actual: (actualShippingCost ?? 0).toFixed(2),
              shipping_charge_extra: shippingExtra.toFixed(2),
              shipping_charge_total: (shippingAmount ?? 0).toFixed(2),
              carrier_actual_name: effectiveShippingProvider || shippingCarrier || undefined,
              platform_profit: platformProfit.toFixed(2),
            },
          }).catch(() => {});

          const orderData: OrderData = {
            id: order.id,
            customerId,
            customerEmail,
            totalAmount,
            orderStatus: computedOrderStatus,
            paymentStatus: computedPaymentStatus,
            paymentIntentId,
            items,
            shippingAddress,
            billingAddress: billing,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            notes,
          };

          const successResult: CheckoutResultState = {
            paymentResult: 'success',
            paymentIntentId,
            orderId: String(order.id),
            items: checkoutResultItems,
            totalAmount,
            currency: checkoutCurrency,
          };

          clearCheckoutCartState();

          navigate('/checkout/confirmation', { state: { orderData, checkoutResult: successResult } });
          onSuccess?.(orderData);
        } else {
          const failedResult: CheckoutResultState = {
            paymentResult: 'failed',
            paymentIntentId,
            items: checkoutResultItems,
            totalAmount,
            currency: checkoutCurrency,
            failureReason: `Unexpected payment status: ${paymentIntent?.status}`,
          };
          navigate('/checkout/confirmation', { state: { checkoutResult: failedResult } });
        }
      } catch (err) {
        console.error('Checkout submit error:', err);

        const recoveredOrder = await waitForRecoveredOrder(paymentIntentId, 12_000, 1_500);
        if (recoveredOrder?.id) {
          clearCheckoutCartState();
          const successResult: CheckoutResultState = {
            paymentResult: 'success',
            paymentIntentId,
            orderId: String(recoveredOrder.id),
            items: items.map((item) => ({
              productId: item.productId,
              productName: item.productName,
              quantity: item.quantity,
              price: item.price,
              productImage: item.productImage,
              selectedSize: item.selectedSize,
              selectedColor: item.selectedColor,
            })),
            totalAmount,
            currency: checkoutCurrency,
          };
          navigate('/checkout/confirmation', { state: { checkoutResult: successResult } });
          return;
        }

        const failedResult: CheckoutResultState = {
          paymentResult: 'failed',
          paymentIntentId,
          items: items.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            price: item.price,
            productImage: item.productImage,
            selectedSize: item.selectedSize,
            selectedColor: item.selectedColor,
          })),
          totalAmount,
          currency: checkoutCurrency,
          failureReason: 'Payment could not be completed right now. Please try again.',
        };
        navigate('/checkout/confirmation', { state: { checkoutResult: failedResult } });
      } finally {
        setIsLoading(false);
      }
    },
    [
      stripe,
      elements,
      sameAsShipping,
      billingAddress,
      shippingAddress,
      customerName,
      customerEmail,
      customerId,
      customerPhone,
      notes,
      totalAmount,
      items,
      paymentIntentId,
      checkoutCurrency,
      navigate,
      onSuccess,
      shippingAmount,
      actualShippingCost,
      platformShippingMargin,
      clearCheckoutCartState,
    ]
  );

  // ------ COD order placement (inline) ------
  const handleCodOrder = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const shippingAddressAny = shippingAddress as any;
      const productIds = items.map((item) => item.productId);
      const destinationPin = String(shippingAddress.postalCode || '').replace(/\s+/g, '');
      const destCountryToken = (shippingAddress.country || '').trim().toUpperCase().replace(/\s+/g, '');
      const isIntl = Boolean(destCountryToken) && !['INDIA', 'IN', 'IND'].includes(destCountryToken);

      let resolvedCodQuote: CodLiveQuote | null = codLiveQuote;
      if (!isIntl && !resolvedCodQuote) {
        try {
          setCodLiveQuoteLoading(true);
          resolvedCodQuote = await fetchCodLiveQuote();
          setCodLiveQuote(resolvedCodQuote);
          setCodLiveQuoteError(null);
        } catch (quoteErr) {
          console.error('Failed to fetch COD quote before order placement:', quoteErr);
          setError('Unable to fetch COD shipping charges right now. Please try again.');
          return;
        } finally {
          setCodLiveQuoteLoading(false);
        }
      }

      const finalTotalAmount = resolvedCodQuote?.totalAmount ?? totalAmount;
      const finalShippingAmount = resolvedCodQuote?.shippingAmount ?? (shippingAmount ?? 0);
      const finalActualShippingCost = resolvedCodQuote?.actualShippingCost ?? (actualShippingCost ?? 0);
      const finalPlatformShippingMargin = resolvedCodQuote?.platformShippingMargin ?? (platformShippingMargin ?? 0);

      const codSellerId = items[0]?.sellerId || customerId;
      if (!isIntl && destinationPin.length === 6) {
        const svcResult = await checkDeliveryServiceability(destinationPin, codSellerId);
        if (!svcResult.serviceable) {
          setError('Your pincode is not a serviceable area. Please try with another pincode.');
          setIsLoading(false);
          return;
        }
      }

      let maxDeliveryDays = 0;
      let expectedDeliveryDateIso: string | null = null;
      if (!isIntl) {
        const tatResult = await fetchMultiSellerTat(productIds, destinationPin, customerId);
        maxDeliveryDays = tatResult.maxTatDays;
        expectedDeliveryDateIso = tatResult.maxExpectedDate || null;
      } else {
        // Sanitize: ensure it parses as a valid date (e.g. not "13 - 15 DAYS")
        const rawEtd = estimatedDeliveryDate || null;
        expectedDeliveryDateIso = (rawEtd && !isNaN(Date.parse(rawEtd))) ? rawEtd : null;
        maxDeliveryDays = parseInt(estimatedDeliveryDays || '0', 10) || 0;
      }

      const codReference = `COD-${customerId}-${items.map(i => i.productId).sort().join('-')}`;
      const enrichedShippingAddress = {
        ...shippingAddress,
        full_name: customerName || shippingAddressAny.full_name || shippingAddressAny.fullName || shippingAddressAny.name || null,
        phone: customerPhone || shippingAddressAny.phone || shippingAddressAny.phone_number || null,
        expected_delivery_days: maxDeliveryDays || null,
        expected_delivery_date: expectedDeliveryDateIso || null,
      };

      const codRpcItems = items.map((item) => {
        const meta = productMeta?.get(item.productId);
        return {
          product_id: String(item.productId),
          quantity: item.quantity,
          product_name: item.productName,
          product_image: item.productImage || '',
          variant_info: {
            size: item.selectedSize || null,
            color: item.selectedColor || null,
            sku: item.selectedVariantId || item.selectedVariantSku || item.selectedSize || item.selectedColor
              ? item.selectedVariantSku || null
              : meta?.sku || null,
            hsn_code: meta?.hsn_code || null,
          },
        };
      });

      const { data: order, error: orderErr } = await callCreateOrderSecure({
        p_user_id: customerId,
        p_items: codRpcItems,
        p_shipping_address: enrichedShippingAddress,
        p_billing_address: shippingAddress,
        p_phone: customerPhone || null,
        p_notes: notes || null,
        p_payment_intent_id: codReference,
        p_payment_method: 'cod',
        p_payment_status: 'pending',
        p_order_status: 'pending',
        p_currency: checkoutCurrency,
        p_shipping_charge: finalShippingAmount,
        p_actual_shipping_cost: finalActualShippingCost,
        p_platform_shipping_margin: finalPlatformShippingMargin,
        // p_fx_rate omitted: derived server-side
        p_idempotency_key: `cod_${codReference}`,
        p_shipping_carrier: shippingCarrier || null,
        p_shipping_service_level: shippingServiceLevel || null,
        p_shipping_provider: effectiveShippingProvider,
        p_shipping_rate_id: shippingRateId || null,
        p_expected_delivery_date: expectedDeliveryDateIso || null,
        p_expected_delivery_days: maxDeliveryDays || null,
      });

      if (orderErr || !order) {
        console.error('COD order insert failed:', orderErr);
        setError('Unable to place COD order right now. Please try again.');
        return;
      }

      setSuccess(true);

      // Fire order_placed notification (non-blocking)
      const codSellerIds = [...new Set(items.map(i => i.sellerId).filter((id): id is string => !!id))];
      const codProductSubtotal = buyerProductSubtotalAmount ?? items.reduce((s, i) => s + i.price * i.quantity, 0);
      const codPlatformCharge9 = codProductSubtotal * PLATFORM_FEE_RATE;
      const codShippingExtra = finalPlatformShippingMargin;
      const codPlatformProfit = codPlatformCharge9 + codShippingExtra;
      const codDeliveryDateStr = expectedDeliveryDateIso
        ? new Date(expectedDeliveryDateIso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
        : maxDeliveryDays ? `~${maxDeliveryDays} days` : undefined;
      const codInvoiceAttachment = await buildOrderInvoiceAttachment({
        orderId: order.id,
        orderDate: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
        paymentMethod: 'Cash on Delivery',
        buyerName: customerName,
        buyerAddress: [shippingAddress.street, shippingAddress.city, shippingAddress.state, shippingAddress.postalCode, shippingAddress.country].filter(Boolean).join(', '),
        buyerPhone: customerPhone || undefined,
        items: items.map(i => ({ name: i.productName, qty: i.quantity, unitPrice: i.price })),
        currency: checkoutCurrency.toUpperCase(),
        totalPaid: finalTotalAmount,
        shippingCharge: finalShippingAmount ?? 0,
        formatPrice,
      });
      notifyOrderEvent({
        type: 'order_placed',
        orderId: order.id,
        orderNumber: order.id,
        buyerId: customerId,
        buyerEmail: customerEmail,
        buyerName: customerName,
        sellerIds: codSellerIds,
        adminNotify: true,
        title: 'Order Placed Successfully',
        message: `Your COD order has been placed and is being processed.`,
        emailAttachment: codInvoiceAttachment,
        emailData: {
          order_id: order.id.slice(0, 8).toUpperCase(),
          order_date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
          customer_name: customerName,
          currency: checkoutCurrency.toUpperCase(),
          order_total: finalTotalAmount.toFixed(2),
          payment_method: 'Cash on Delivery',
          carrier: shippingCarrier || undefined,
          service_level: shippingServiceLevel || undefined,
          delivery_date: codDeliveryDateStr,
          items: items.map(i => ({
            name: i.productName,
            quantity: i.quantity,
            price: `${checkoutCurrency.toUpperCase()} ${(i.price * i.quantity).toFixed(2)}`,
            variant: [i.selectedSize, i.selectedColor].filter(Boolean).join(' / ') || undefined,
          })),
          // Admin-only fields
          buyer_address: [shippingAddress.street, shippingAddress.city, shippingAddress.state, shippingAddress.postalCode, shippingAddress.country].filter(Boolean).join(', '),
          buyer_email: customerEmail,
          buyer_phone: customerPhone || undefined,
          product_subtotal: codProductSubtotal.toFixed(2),
          platform_charge: codPlatformCharge9.toFixed(2),
          shipping_charge_actual: finalActualShippingCost.toFixed(2),
          shipping_charge_extra: codShippingExtra.toFixed(2),
          shipping_charge_total: finalShippingAmount.toFixed(2),
          carrier_actual_name: effectiveShippingProvider || shippingCarrier || undefined,
          platform_profit: codPlatformProfit.toFixed(2),
        },
      }).catch(() => {});

      const orderData: OrderData = {
        id: order.id,
        customerId,
        customerEmail,
        totalAmount: finalTotalAmount,
        orderStatus: 'pending',
        paymentStatus: 'pending',
        paymentIntentId: codReference,
        items,
        shippingAddress,
        billingAddress: shippingAddress,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        notes,
      };
      navigate('/checkout/confirmation', { state: { orderData } });
      onSuccess?.(orderData);
    } catch (err) {
      console.error('COD checkout error:', err);
      setError('Unable to place COD order right now. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, [items, totalAmount, customerId, customerEmail, customerName, shippingAddress, customerPhone, notes, checkoutCurrency, shippingAmount, actualShippingCost, platformShippingMargin, navigate, onSuccess, codLiveQuote, fetchCodLiveQuote, shippingCarrier, shippingServiceLevel, shippingRateId, effectiveShippingProvider, productMeta, buyerProductSubtotalAmount, estimatedDeliveryDate, estimatedDeliveryDays]);

  // ------ Success: redirect already happened, show minimal fallback ------
  if (success) {
    return (
      <div className="w-full max-w-2xl mx-auto py-16 text-center">
        <Loader2 size={32} className="animate-spin mx-auto mb-4 text-green-600" />
        <p className="text-gray-600">Redirecting to order confirmation...</p>
      </div>
    );
  }

  // ------ Checkout form ------
  return (
    <div className="w-full max-w-2xl mx-auto space-y-4">

      {/* Error — shown at the top so it's always visible */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex items-start gap-2.5">
          <AlertCircle size={18} className="text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Compact sticky order total bar — stacks directly below the global Header */}
      <div
        className="bg-white border border-[#ddd] rounded-lg p-4 flex items-center justify-between sticky z-[60] shadow-sm"
        style={{ top: 'var(--bz-header-offset)' }}
      >
        <div className="text-sm text-gray-600">
          <span>{items.length} item{items.length !== 1 ? 's' : ''}</span>
          <span className="mx-1.5 text-gray-300">|</span>
          <button type="button" onClick={() => confirmLeave('/checkout/review')} className="text-[#007185] hover:underline font-medium">View details</button>
        </div>
        <div className="text-right">
          <span className="text-xs text-gray-500 block leading-tight">Total</span>
          <span className="text-lg font-bold text-[#b12704]">{fmtCurrency(totalAmount, checkoutCurrency)}</span>
        </div>
      </div>

      {/* Billing Address */}
      <div className="bg-white border border-[#ddd] rounded-lg p-5">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={sameAsShipping}
            onChange={(e) => setSameAsShipping(e.target.checked)}
            className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
          />
          <span className="text-sm font-medium text-gray-700">Billing address same as shipping</span>
        </label>

        {!sameAsShipping && (
          <div className="space-y-3 mt-4 pt-4 border-t border-gray-100">
            <input
              type="text"
              placeholder="Street Address"
              value={billingAddress.street}
              onChange={(e) => setBillingAddress({ ...billingAddress, street: e.target.value })}
              className="w-full px-3 py-2.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                type="text"
                placeholder="City"
                value={billingAddress.city}
                onChange={(e) => setBillingAddress({ ...billingAddress, city: e.target.value })}
                className="px-3 py-2.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
              />
              <input
                type="text"
                placeholder="State"
                value={billingAddress.state}
                onChange={(e) => setBillingAddress({ ...billingAddress, state: e.target.value })}
                className="px-3 py-2.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                type="text"
                placeholder="Postal Code"
                value={billingAddress.postalCode}
                onChange={(e) =>
                  setBillingAddress({ ...billingAddress, postalCode: e.target.value })
                }
                className="px-3 py-2.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
              />
              <input
                type="text"
                placeholder="Country"
                value={billingAddress.country}
                onChange={(e) =>
                  setBillingAddress({ ...billingAddress, country: e.target.value })
                }
                className="px-3 py-2.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          </div>
        )}
      </div>

      {/* COD toggle — only if eligible and domestic */}
      {codEligible && !isInternational && (
        <div className="bg-white border border-[#ddd] rounded-lg p-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setPayViaCod(false)}
              className={`flex-1 py-2.5 rounded-md text-sm font-semibold border-2 transition-all ${!payViaCod ? 'border-[#ff9900] bg-[#fffbf0] text-[#0f1111]' : 'border-[#ddd] text-gray-500 hover:border-[#ccc]'}`}
            >
              Pay Online
            </button>
            <button
              type="button"
              onClick={() => setPayViaCod(true)}
              className={`flex-1 py-2.5 rounded-md text-sm font-semibold border-2 transition-all ${payViaCod ? 'border-[#ff9900] bg-[#fffbf0] text-[#0f1111]' : 'border-[#ddd] text-gray-500 hover:border-[#ccc]'}`}
            >
              Cash on Delivery
            </button>
          </div>
        </div>
      )}

      {/* Payment — Stripe PaymentElement (auto-renders only available methods) */}
      {!payViaCod && (
        <form onSubmit={handleSubmit} className="bg-white border border-[#ddd] rounded-lg p-5 space-y-4">
          <h3 className="text-sm font-bold text-[#0f1111] uppercase tracking-wide">Payment Method</h3>
          <PaymentElement options={paymentElementOptions} />
          <button
            type="submit"
            disabled={!stripe || !elements || isLoading}
            className="w-full py-3.5 bg-[#ffd814] hover:bg-[#f7ca00] border border-[#fcd200] disabled:bg-gray-200 disabled:border-gray-300 disabled:cursor-not-allowed text-[#0f1111] rounded-lg text-[15px] font-bold cursor-pointer transition-colors flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <><Loader2 size={16} className="animate-spin" /> Processing...</>
            ) : (
              `PAY NOW — ${fmtCurrency(totalAmount, checkoutCurrency)}`
            )}
          </button>
        </form>
      )}

      {/* COD Place Order */}
      {payViaCod && codEligible && !isInternational && (
        <div className="bg-white border border-[#ddd] rounded-lg p-5 space-y-4">
          <h3 className="text-sm font-bold text-[#0f1111] uppercase tracking-wide">Cash on Delivery</h3>
          <p className="text-sm text-gray-600">Pay in cash when your order is delivered. No online payment required.</p>
          {codLiveQuoteError && (
            <div className="bg-red-50 border border-red-200 rounded-md px-3 py-2 text-sm text-red-700">
              {codLiveQuoteError}
            </div>
          )}
          {codLiveQuote && codLiveQuote.codSurcharge > 0 && (
            <p className="text-sm text-gray-700">
              COD shipping difference: +{fmtCurrency(codLiveQuote.codSurcharge, checkoutCurrency)}
            </p>
          )}
          <button
            type="button"
            onClick={handleCodOrder}
            disabled={isLoading || codPricingInProgress}
            className="w-full py-3.5 bg-[#ffd814] hover:bg-[#f7ca00] border border-[#fcd200] disabled:bg-gray-200 disabled:border-gray-300 disabled:cursor-not-allowed text-[#0f1111] rounded-lg text-[15px] font-bold cursor-pointer transition-colors flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <><Loader2 size={18} className="animate-spin" /> Placing Order...</>
            ) : codPricingInProgress ? (
              <><Loader2 size={18} className="animate-spin" /> Calculating...</>
            ) : (
              `Place COD Order — ${fmtCurrency(codDisplayTotalAmount, checkoutCurrency)}`
            )}
          </button>
        </div>
      )}

      {/* Back + security */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => confirmLeave('/checkout/review')}
          className="text-sm text-[#007185] hover:underline font-medium"
        >
          ← Back to Review
        </button>
        <div className="flex items-center gap-1.5">
          <ShieldCheck size={14} className="text-[#555]" />
          <span className="text-[11px] text-[#555] font-medium">256-bit SSL · Powered by Stripe</span>
        </div>
      </div>

      {/* Leave-page confirmation dialog */}
      {leaveDialog && (
        <div className="fixed inset-0 z-[9999] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6 space-y-4">
            <h3 className="text-lg font-bold text-gray-900">Leave Checkout?</h3>
            <p className="text-sm text-gray-600">
              Are you sure you want to leave? Your payment will be cancelled and the order will not be placed.
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleLeaveCancel}
                className="flex-1 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold text-sm rounded-lg transition-colors"
              >
                Stay
              </button>
              <button
                type="button"
                onClick={handleLeaveConfirm}
                className="flex-1 py-2.5 bg-red-600 hover:bg-red-700 text-white font-semibold text-sm rounded-lg transition-colors"
              >
                Leave
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Outer wrapper — loads Stripe, creates PaymentIntent, wraps in <Elements>
// ---------------------------------------------------------------------------

const Checkout: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const checkoutData = location.state as CheckoutLocationState | undefined;

  const { rates, formatPrice } = useCurrency();
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [liveQuoteError, setLiveQuoteError] = useState<string | null>(null);
  const [liveQuote, setLiveQuote] = useState<{
    totalAmount: number;
    shippingAmount: number;
    codSurcharge: number;
    actualShippingCost: number;
    platformShippingMargin: number;
    minimumOrderConstraint?: DestinationCheckoutPricing['minimumOrderConstraint'];
  } | null>(null);
  const [liveQuoteLoading, setLiveQuoteLoading] = useState(true);
  const [productMeta, setProductMeta] = useState<Map<string, { sku: string | null; hsn_code: string | null }>>(new Map());
  // Bump this token (via the "Try Again" button) to re-run the live-quote fetch
  // and the PaymentIntent creation effect without leaving the page. Lets users
  // recover from transient backend / network failures on slow mobile links.
  const [paymentInitRetryToken, setPaymentInitRetryToken] = useState(0);
  const quoteRequestRef = useRef(0);
  // M7: Track last PI signature to avoid creating orphaned PaymentIntents
  const lastPiSignatureRef = useRef<string | null>(null);

  // Fetch SKU/HSN for display
  useEffect(() => {
    if (!checkoutData) return;
    const productIds = checkoutData.items.map((i) => i.productId);
    if (productIds.length === 0) return;
    supabase.from('products').select('id, hsn_code, sku').in('id', productIds).then(({ data }) => {
      if (data) {
        setProductMeta(new Map(data.map((r: any) => [String(r.id), { sku: r.sku || null, hsn_code: r.hsn_code || null }])));
      }
    });
  }, [checkoutData]);

  // Redirect if no checkout data
  useEffect(() => {
    if (!checkoutData) {
      navigate('/cart');
    }
  }, [checkoutData, navigate]);

  // Recalculate destination quote on payment page for both online and COD.
  // This prevents stale review-state totals from becoming final billing values.
  useEffect(() => {
    if (!checkoutData) {
      setLiveQuote(null);
      return;
    }

    const requestId = quoteRequestRef.current + 1;
    quoteRequestRef.current = requestId;
    setLiveQuoteLoading(true);
    setLiveQuoteError(null);

    void (async () => {
      try {
        const quote = await calculateDestinationCheckoutPricing({
          items: checkoutData.items.map((item) => ({
            cartItemId: item.cartItemId,
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            unitPrice: item.price,
            currency: checkoutData.currency || 'INR',
            selectedVariantId: item.selectedVariantId,
            selectedVariantSku: item.selectedVariantSku,
            selectedSize: item.selectedSize,
            selectedColor: item.selectedColor,
          })),
          destinationCountry: checkoutData.shippingAddress.country || '',
          destinationPostalCode: checkoutData.shippingAddress.postalCode || '',
          rates,
          isCod: false,
        });
        if (quoteRequestRef.current !== requestId) return;

        // Determine the shipping/total for the tier selected in OrderSummary.
        // The base quote.shipping/quote.total are always standard tier.
        // If user chose premium or express, use the matching intlShippingOptions entry.
        const tier = checkoutData.shippingTier || 'standard';
        let tierShipping = quote.shipping;
        let tierTotal = quote.total;
        if (tier !== 'standard' && quote.intlShippingOptions) {
          const tierOption = quote.intlShippingOptions[tier];
          if (tierOption) {
            tierShipping = tierOption.shipping;
            tierTotal = tierOption.total;
          }
        }

        const prepaidShipping = checkoutData.shippingAmount ?? 0;
        const currentShipping = tierShipping;
        const surcharge = Math.max(0, currentShipping - prepaidShipping);
        setLiveQuote({
          totalAmount: tierTotal,
          shippingAmount: currentShipping,
          codSurcharge: surcharge,
          actualShippingCost: quote.actualShippingCost,
          platformShippingMargin: quote.platformShippingMargin,
          minimumOrderConstraint: quote.minimumOrderConstraint,
        });
      } catch (err) {
        console.error('[Checkout] Failed to refresh live checkout quote:', err);
        if (quoteRequestRef.current === requestId) {
          setLiveQuoteError('Unable to load backend checkout configuration. Please return to review and try again.');
        }
      } finally {
        if (quoteRequestRef.current === requestId) {
          setLiveQuoteLoading(false);
        }
      }
    })();
  }, [checkoutData, rates, paymentInitRetryToken]);

  // Create PaymentIntent on mount
  useEffect(() => {
    if (!checkoutData) return;

    if (liveQuoteLoading) return;

    if (!liveQuote) {
      setLoading(false);
      setInitError(liveQuoteError || 'Unable to refresh live shipping quote. Please go back to review and try again.');
      setClientSecret(null);
      setPaymentIntentId(null);
      return;
    }

    if (liveQuote.minimumOrderConstraint && !liveQuote.minimumOrderConstraint.isMet) {
      const remaining = Math.max(
        0,
        liveQuote.minimumOrderConstraint.minimumInCheckoutCurrency
          - liveQuote.minimumOrderConstraint.currentSubtotalInCheckoutCurrency
      );
      const destinationCountryLabel =
        String(checkoutData?.shippingAddress?.country || '').trim() || 'selected destination';
      setLoading(false);
      setInitError(
        `Minimum order for India-origin products shipping to ${destinationCountryLabel} is ${fmtCurrency(liveQuote.minimumOrderConstraint.minimumInCheckoutCurrency, checkoutData.currency || 'INR')} (${fmtCurrency(liveQuote.minimumOrderConstraint.minimumInr, 'INR')}). Add ${fmtCurrency(remaining, checkoutData.currency || 'INR')} more to continue.`
      );
      setClientSecret(null);
      setPaymentIntentId(null);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setInitError(null);

        const checkoutCurrency = (checkoutData.currency || 'INR').toUpperCase();

        const stripePublishableKey = String(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || '').trim();
        if (!stripePublishableKey) {
          throw new Error('Online payments are temporarily unavailable. Stripe is not configured.');
        }

        const billedTotal = liveQuote.totalAmount;
        const stripeAmount = toStripeAmount(billedTotal, checkoutCurrency);
        if (!Number.isFinite(stripeAmount) || stripeAmount <= 0) {
          throw new Error('Invalid checkout total. Please return to review and try again.');
        }

        // M7: Skip if PI already exists for same amount+currency (avoid orphaned intents)
        const piSignature = `${stripeAmount}-${checkoutCurrency}`;
        if (lastPiSignatureRef.current === piSignature && clientSecret) {
          setLoading(false);
          return;
        }

        const result = await createPaymentIntent({
          amount: stripeAmount,
          currency: checkoutCurrency.toLowerCase(),
          metadata: {
            customer_id: checkoutData.customerId,
            customer_email: checkoutData.customerEmail,
            item_count: String(checkoutData.items.length),
          },
        });

        if (!cancelled) {
          setClientSecret(result.clientSecret);
          setPaymentIntentId(result.paymentIntentId);
          lastPiSignatureRef.current = piSignature;
        }
      } catch (err) {
        if (!cancelled) {
          console.error('[Checkout] createPaymentIntent failed:', err);
          setInitError(err instanceof Error ? err.message : 'Failed to initialize payment');
          setClientSecret(null);
          setPaymentIntentId(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [checkoutData, liveQuote, liveQuoteLoading, liveQuoteError, paymentInitRetryToken]);

  // --- Derived values (computed before early returns so hooks below are always called) ---
  // Cash on Delivery is not offered by the web checkout.
  const codEligible = false;
  const destCountryToken = (checkoutData?.shippingAddress?.country || '').trim().toUpperCase().replace(/\s+/g, '');
  const isInternational = Boolean(destCountryToken) && !['INDIA', 'IN', 'IND'].includes(destCountryToken);
  const minimumOrderNotMet = Boolean(
    liveQuote?.minimumOrderConstraint && !liveQuote.minimumOrderConstraint.isMet
  );

  // SL6: Standalone COD state + handler for initError fallback (no Stripe context needed)
  const [codFallbackLoading, setCodFallbackLoading] = useState(false);
  const [codFallbackError, setCodFallbackError] = useState<string | null>(null);
  const [outerLeaveDialog, setOuterLeaveDialog] = useState<{ destination: string } | null>(null);

  // SL6: Standalone COD handler for initError fallback (no Stripe context needed)
  const handleCodFallbackOrder = useCallback(async () => {
    if (!checkoutData) return;
    setCodFallbackLoading(true);
    setCodFallbackError(null);
    try {
      const { items, shippingAddress, customerId, customerEmail, customerName, customerPhone, notes, currency: checkoutCurrency = 'INR' } = checkoutData;
      const destinationPin = String(shippingAddress.postalCode || '').replace(/\s+/g, '');

      const fallbackSellerId = items[0]?.sellerId || customerId;
      if (destinationPin.length === 6) {
        const svcResult = await checkDeliveryServiceability(destinationPin, fallbackSellerId);
        if (!svcResult.serviceable) {
          setCodFallbackError('Your pincode is not a serviceable area. Please try with another pincode.');
          setCodFallbackLoading(false);
          return;
        }
      }

      const productIds = items.map((i) => i.productId);
      let maxDeliveryDays = 0;
      let expectedDeliveryDateIso: string | null = null;
      const tatResult = await fetchMultiSellerTat(productIds, destinationPin, customerId);
      maxDeliveryDays = tatResult.maxTatDays;
      expectedDeliveryDateIso = tatResult.maxExpectedDate || null;

      const codReference = `COD-${customerId}-${items.map((i: any) => i.productId).sort().join('-')}`;
      const effectiveShippingProvider = resolveCheckoutShippingProvider(
        checkoutData.shippingProvider,
        shippingAddress.country,
        shippingAddress.countryCode,
      );
      const enrichedShippingAddress = {
        ...shippingAddress,
        full_name: customerName || (shippingAddress as any).full_name || (shippingAddress as any).fullName || null,
        phone: customerPhone || (shippingAddress as any).phone || null,
        expected_delivery_days: maxDeliveryDays || null,
        expected_delivery_date: expectedDeliveryDateIso || null,
      };

      const codQuote = await calculateDestinationCheckoutPricing({
        items: items.map((item) => ({
          cartItemId: item.cartItemId,
          productId: item.productId,
          productName: item.productName,
          quantity: item.quantity,
          unitPrice: item.price,
          currency: checkoutCurrency || 'INR',
          selectedVariantId: item.selectedVariantId,
          selectedVariantSku: item.selectedVariantSku,
          selectedSize: item.selectedSize,
          selectedColor: item.selectedColor,
        })),
        destinationCountry: shippingAddress.country || '',
        destinationPostalCode: shippingAddress.postalCode || '',
        rates,
        isCod: true,
      });

      const selectedTier = checkoutData.shippingTier || 'standard';
      let totalAmount = codQuote.total;
      let shippingAmount = codQuote.shipping;
      if (selectedTier !== 'standard' && codQuote.intlShippingOptions) {
        const tierOption = codQuote.intlShippingOptions[selectedTier];
        if (tierOption) {
          totalAmount = tierOption.total;
          shippingAmount = tierOption.shipping;
        }
      }

      const codRpcItems = items.map((item) => {
        const meta = productMeta?.get(item.productId);
        return {
          product_id: String(item.productId),
          quantity: item.quantity,
          product_name: item.productName,
          product_image: item.productImage || '',
          variant_info: {
            size: item.selectedSize || null,
            color: item.selectedColor || null,
            sku: item.selectedVariantId || item.selectedVariantSku || item.selectedSize || item.selectedColor
              ? item.selectedVariantSku || null
              : meta?.sku || null,
            hsn_code: meta?.hsn_code || null,
          },
        };
      });

      const { data: order, error: orderErr } = await callCreateOrderSecure({
        p_user_id: customerId,
        p_items: codRpcItems,
        p_shipping_address: enrichedShippingAddress,
        p_billing_address: shippingAddress,
        p_phone: customerPhone || null,
        p_notes: notes || null,
        p_payment_intent_id: codReference,
        p_payment_method: 'cod',
        p_payment_status: 'pending',
        p_order_status: 'pending',
        p_currency: checkoutCurrency,
        p_shipping_charge: shippingAmount,
        p_actual_shipping_cost: codQuote.actualShippingCost,
        p_platform_shipping_margin: codQuote.platformShippingMargin,
        // p_fx_rate omitted: derived server-side
        p_idempotency_key: `cod_${codReference}`,
        p_shipping_carrier: checkoutData.shippingCarrier || null,
        p_shipping_service_level: checkoutData.shippingServiceLevel || null,
        p_shipping_provider: effectiveShippingProvider,
        p_shipping_rate_id: checkoutData.shippingRateId || null,
        p_expected_delivery_date: expectedDeliveryDateIso || null,
        p_expected_delivery_days: maxDeliveryDays || null,
      });

      if (orderErr || !order) {
        setCodFallbackError('Unable to place COD order right now. Please try again.');
        return;
      }

      // Notify + navigate to confirmation
      const codSellerIds = [...new Set(items.map(i => i.sellerId).filter((id): id is string => !!id))];
      const buyerProductSubtotal = checkoutData.buyerProductSubtotalAmount ?? items.reduce((s, i) => s + i.price * i.quantity, 0);
      const codDeliveryDateStr = expectedDeliveryDateIso
        ? new Date(expectedDeliveryDateIso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
        : maxDeliveryDays ? `~${maxDeliveryDays} days` : undefined;
      const codFallbackInvoiceAttachment = await buildOrderInvoiceAttachment({
        orderId: order.id,
        orderDate: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
        paymentMethod: 'Cash on Delivery',
        buyerName: customerName,
        buyerAddress: [shippingAddress.street, shippingAddress.city, shippingAddress.state, shippingAddress.postalCode, shippingAddress.country].filter(Boolean).join(', '),
        buyerPhone: customerPhone || undefined,
        items: items.map(i => ({ name: i.productName, qty: i.quantity, unitPrice: i.price })),
        currency: checkoutCurrency.toUpperCase(),
        totalPaid: totalAmount,
        formatPrice,
      });
      notifyOrderEvent({
        type: 'order_placed',
        orderId: order.id,
        orderNumber: order.id,
        buyerId: customerId,
        buyerEmail: customerEmail,
        buyerName: customerName,
        sellerIds: codSellerIds,
        adminNotify: true,
        title: 'Order Placed Successfully',
        message: 'Your COD order has been placed and is being processed.',
        emailAttachment: codFallbackInvoiceAttachment,
        emailData: {
          order_id: order.id.slice(0, 8).toUpperCase(),
          order_date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
          customer_name: customerName,
          currency: checkoutCurrency.toUpperCase(),
          order_total: totalAmount.toFixed(2),
          payment_method: 'Cash on Delivery',
          carrier: checkoutData.shippingCarrier || undefined,
          service_level: checkoutData.shippingServiceLevel || undefined,
          delivery_date: codDeliveryDateStr,
          items: items.map(i => ({
            name: i.productName,
            quantity: i.quantity,
            price: `${checkoutCurrency.toUpperCase()} ${(i.price * i.quantity).toFixed(2)}`,
            variant: [i.selectedSize, i.selectedColor].filter(Boolean).join(' / ') || undefined,
          })),
          buyer_address: [shippingAddress.street, shippingAddress.city, shippingAddress.state, shippingAddress.postalCode, shippingAddress.country].filter(Boolean).join(', '),
          buyer_email: customerEmail,
          buyer_phone: customerPhone || undefined,
          product_subtotal: buyerProductSubtotal.toFixed(2),
        },
      }).catch(() => {});

      navigate('/checkout/confirmation', {
        state: {
          orderData: {
            id: order.id,
            customerId,
            customerEmail,
            totalAmount,
            orderStatus: 'pending' as const,
            paymentStatus: 'pending' as const,
            paymentIntentId: codReference,
            items,
            shippingAddress,
            billingAddress: shippingAddress,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            notes,
          },
        },
        replace: true,
      });
    } catch (err) {
      console.error('COD fallback order error:', err);
      setCodFallbackError('Something went wrong. Please try again.');
    } finally {
      setCodFallbackLoading(false);
    }
  }, [checkoutData, liveQuote, productMeta, rates, navigate]);

  // --- Loading / error states ---
  if (!checkoutData) {
    return (
      <>
        <Header />
        <div className="min-h-screen bg-gray-50 py-8 flex items-center justify-center pb-24 md:pb-8">
          <p className="text-gray-600">Redirecting to cart...</p>
        </div>
        <MobileNav />
      </>
    );
  }

  if (loading || liveQuoteLoading) {
    const loadingMessage = liveQuoteLoading
      ? 'Checking configured shipping rates and live carrier fallback...'
      : 'Initializing secure payment...';
    return (
      <>
        <Header />
        <div className="min-h-screen bg-gray-50 py-8 flex items-center justify-center pb-24 md:pb-8">
          <div className="text-center">
            <Loader2 size={36} className="animate-spin mx-auto mb-4 text-blue-600" />
            <p className="text-gray-600">{loadingMessage}</p>
          </div>
        </div>
        <MobileNav />
      </>
    );
  }

  if (initError) {
    if (codEligible && !minimumOrderNotMet) {
      // Keep rendering — CheckoutForm handles COD internally
    } else {
    return (
      <>
        <Header />
        <div className="min-h-screen bg-gray-50 py-6 md:py-8 pb-24 md:pb-8">
          <div className="max-w-2xl mx-auto px-4">
            <div className="bg-red-50 border border-red-200 rounded-md p-5 md:p-6 text-center">
              <AlertCircle size={36} className="mx-auto mb-3 md:mb-4 text-red-500" />
              <h2 className="text-base md:text-lg font-bold text-red-900 mb-2">
              Payment Initialization Failed
              </h2>
              <p className="text-sm text-red-700 mb-5 md:mb-6 break-words">{initError}</p>
              <div className="flex flex-col sm:flex-row gap-2.5 sm:gap-3 justify-center">
              <button
                onClick={() => {
                  setInitError(null);
                  setLiveQuoteError(null);
                  setLoading(true);
                  setPaymentInitRetryToken((t) => t + 1);
                }}
                className="px-5 py-2.5 md:px-6 md:py-3 bg-amber-500 hover:bg-amber-600 text-white rounded-md font-semibold text-sm"
              >
                Try Again
              </button>
                <button
                  onClick={() => navigate('/checkout/review')}
                  className="px-5 py-2.5 md:px-6 md:py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-md font-semibold text-sm"
                >
                  Back to Review
                </button>
              </div>
            </div>
          </div>
        </div>
        <MobileNav />
      </>
    );
    }
  }

  if (!initError && (!clientSecret || !paymentIntentId)) {
    return (
      <>
        <Header />
        <div className="min-h-screen bg-gray-50 py-8 flex items-center justify-center pb-24 md:pb-8">
          <div className="text-center">
            <Loader2 size={36} className="animate-spin mx-auto mb-4 text-blue-600" />
            <p className="text-gray-600">Preparing payment...</p>
          </div>
        </div>
        <MobileNav />
      </>
    );
  }

  // --- Main checkout UI ---
  const stripePromise = getStripe();

  return (
    <div className="min-h-screen bg-[#eaeded] flex flex-col">
      <Header />
        <div className="flex-1 py-5 pb-24 md:pb-5">
      <div className="max-w-[1100px] mx-auto px-4">

        {initError ? (
          <>
          <div className="max-w-2xl mx-auto bg-red-50 border border-red-200 rounded-md p-6 text-center mb-4">
            <AlertCircle size={36} className="mx-auto mb-3 text-red-500" />
            <h3 className="text-lg font-bold text-red-900 mb-2">Online Payment Unavailable</h3>
            <p className="text-red-700 text-sm">
              {codEligible && !isInternational && !minimumOrderNotMet
                ? 'Online payment failed to initialize. You can still place your order using Cash on Delivery below.'
                : 'Please return to review and try again.'}
            </p>
          </div>

          {/* SL6: COD fallback form when Stripe fails but COD is eligible (India-to-India only) */}
          {codEligible && !isInternational && !minimumOrderNotMet && (
            <div className="max-w-2xl mx-auto bg-white border border-[#ddd] rounded-lg p-6 text-center">
              <h3 className="text-lg font-bold text-[#0f1111] mb-3">💵 Pay with Cash on Delivery</h3>
              <p className="text-sm text-[#555] mb-4">
                You'll pay <strong>{checkoutData ? `₹${(liveQuote?.totalAmount ?? checkoutData.totalAmount).toFixed(2)}` : ''}</strong> in cash when your order is delivered.
              </p>
              {codFallbackError && (
                <div className="bg-red-50 border border-red-200 rounded-md p-3 mb-4 text-sm text-red-700">{codFallbackError}</div>
              )}
              <button
                onClick={handleCodFallbackOrder}
                disabled={codFallbackLoading}
                className="w-full py-3.5 bg-[#ffd814] hover:bg-[#f7ca00] border border-[#fcd200] text-[#0f1111] rounded-lg text-[15px] font-bold cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {codFallbackLoading ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 size={16} className="animate-spin" />
                    Placing COD Order...
                  </span>
                ) : (
                  'Place COD Order'
                )}
              </button>
              <p className="text-xs text-[#555] mt-3">Pay when your order arrives. No advance payment required.</p>
            </div>
          )}

          {/* Back button for non-COD eligible */}
          {(!codEligible || isInternational || minimumOrderNotMet) && (
            <div className="max-w-2xl mx-auto text-center mt-4">
              <button
                onClick={() => navigate('/checkout/review')}
                className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-md font-semibold text-sm"
              >
                Back to Review
              </button>
            </div>
          )}
          </>
        ) : (
          <Elements
            stripe={stripePromise}
            options={{
              clientSecret: clientSecret || '',
              appearance: {
                theme: 'stripe',
                variables: {
                  colorPrimary: '#2563eb',
                  borderRadius: '8px',
                },
              },
            }}
          >
            <CheckoutForm
              {...checkoutData}
              totalAmount={liveQuote?.totalAmount ?? checkoutData.totalAmount}
              shippingAmount={liveQuote?.shippingAmount ?? checkoutData.shippingAmount}
              actualShippingCost={liveQuote?.actualShippingCost ?? checkoutData.actualShippingCost}
              platformShippingMargin={liveQuote?.platformShippingMargin ?? checkoutData.platformShippingMargin}
              paymentIntentId={paymentIntentId || ''}
              productMeta={productMeta}
              codEligible={codEligible}
              isInternational={isInternational}
              codSurcharge={liveQuote?.codSurcharge ?? 0}
              codPricingLoading={liveQuoteLoading}
            />
          </Elements>
        )}
      </div>
      </div>

      {/* Outer leave-page confirmation dialog */}
      {outerLeaveDialog && (
        <div className="fixed inset-0 z-[9999] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6 space-y-4">
            <h3 className="text-lg font-bold text-gray-900">Leave Checkout?</h3>
            <p className="text-sm text-gray-600">
              Are you sure you want to leave? Your payment will be cancelled and the order will not be placed.
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setOuterLeaveDialog(null)}
                className="flex-1 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold text-sm rounded-lg transition-colors"
              >
                Stay
              </button>
              <button
                type="button"
                onClick={() => { setOuterLeaveDialog(null); navigate(outerLeaveDialog.destination); }}
                className="flex-1 py-2.5 bg-red-600 hover:bg-red-700 text-white font-semibold text-sm rounded-lg transition-colors"
              >
                Leave
              </button>
            </div>
          </div>
        </div>
      )}

      <Footer />
      <MobileNav />
    </div>
  );
};

export default Checkout;

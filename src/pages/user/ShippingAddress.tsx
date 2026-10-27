import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { MapPin, Plus, Check, Loader2 } from 'lucide-react';
import { useCart } from '../../contexts/CartContext';
import { useAuth } from '../../contexts/AuthContext';
import { Skeleton, ListSkeleton } from '../../components/common/Skeleton';
import { Header } from '../../components/layout/Header';
import { Footer } from '../../components/layout/Footer';
import { MobileNav } from '../../components/layout/MobileNav';
import { useCurrency } from '../../contexts/CurrencyContext';
import { createUserAddress, getUserAddresses } from '../../lib/adminService';
import type { UserAddress } from '../../types';
import {
  calculateDestinationCheckoutPricing,
  type DestinationCheckoutPricing,
} from '../../lib/checkoutPricingService';
import { fetchPublicProductPrices } from '../../lib/pricingService';
import { hasCurrencyRate, isExchangeRateUnavailable } from '../../utils/currency';
import { detectLocationWithCaching } from '../../lib/locationService';
import { fetchCountries, type Country } from '../../lib/shippingDataService';
import {
  INDIA_COUNTRY_CODE,
  INDIA_COUNTRY_NAME,
  IS_FIXED_COUNTRY_STOREFRONT,
  IS_INDIA_STOREFRONT,
  IS_MALDIVES_STOREFRONT,
  isIndiaCountry,
  isMaldivesCountry,
  MALDIVES_COUNTRY_CODE,
  MALDIVES_COUNTRY_NAME,
  MALDIVES_CURRENCY_CODE,
  STOREFRONT_CACHE_KEY,
} from '../../config/market';

interface ShippingFormData {
  full_name: string;
  phone_number: string;
  email: string;
  country: string;
  street_address_1: string;
  street_address_2?: string;
  city: string;
  state: string;
  postal_code: string;
  delivery_notes?: string;
}

const createEmptyShippingFormData = (): ShippingFormData => ({
  full_name: '',
  phone_number: '',
  email: '',
  country: IS_MALDIVES_STOREFRONT ? MALDIVES_COUNTRY_NAME : IS_INDIA_STOREFRONT ? INDIA_COUNTRY_NAME : '',
  street_address_1: '',
  street_address_2: '',
  city: '',
  state: '',
  postal_code: '',
  delivery_notes: '',
});

const getShippingDraftKey = (userId: string): string =>
  `beauzead_checkout_shipping_draft:${STOREFRONT_CACHE_KEY}:${userId}`;

const removeShippingDraft = (userId: string): void => {
  try {
    localStorage.removeItem(getShippingDraftKey(userId));
  } catch (err) {
    console.error('Unable to remove checkout address draft:', err);
  }
};

const ShippingAddressPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { items } = useCart();
  const { user, currentAuthUser } = useAuth();
  const { rates } = useCurrency();
  const [useExistingAddress, setUseExistingAddress] = useState(false);
  const [savedAddresses, setSavedAddresses] = useState<UserAddress[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [pageReady, setPageReady] = useState(false);
  const [locationLoading, setLocationLoading] = useState(false);
  const [error, setError] = useState('');
  const [locationError, setLocationError] = useState('');
  const [pricing, setPricing] = useState<DestinationCheckoutPricing | null>(null);
  const [pricingLoading, setPricingLoading] = useState(false);
  const [publicPriceMap, setPublicPriceMap] = useState<Record<string, number>>({});
  const [publicPriceLoading, setPublicPriceLoading] = useState(false);
  const [addressSelectionLoading, setAddressSelectionLoading] = useState(false);
  const [countryOptions, setCountryOptions] = useState<Country[]>([]);
  const [selectedCartItemIds, setSelectedCartItemIds] = useState<string[]>([]);
  const [draftOwnerId, setDraftOwnerId] = useState<string | null>(null);
  const [draftSaveError, setDraftSaveError] = useState(false);
  const pricingRequestRef = useRef(0);
  const hydratedDraftUserRef = useRef<string | null>(null);
  const restoredDraftUserRef = useRef<string | null>(null);

  const [formData, setFormData] = useState<ShippingFormData>(createEmptyShippingFormData);

  useEffect(() => {
    if (!draftOwnerId || useExistingAddress) return;

    try {
      localStorage.setItem(
        getShippingDraftKey(draftOwnerId),
        JSON.stringify({ formData, updatedAt: Date.now() }),
      );
      setDraftSaveError(false);
    } catch (err) {
      console.error('Unable to save checkout address draft:', err);
      setDraftSaveError(true);
    }
  }, [draftOwnerId, formData, useExistingAddress]);

  // Load saved addresses from Supabase or fallback to localStorage
  useEffect(() => {
    const routeSelected = (location.state as any)?.selectedCartItemIds as string[] | undefined;
    const persisted = localStorage.getItem('beauzead_checkout_selected_cart_ids');
    let parsedPersisted: string[] = [];
    try { parsedPersisted = persisted ? (JSON.parse(persisted) as string[]) : []; } catch { /* corrupted */ }
    const source = Array.isArray(routeSelected) && routeSelected.length > 0 ? routeSelected : parsedPersisted;

    if (source.length > 0) {
      setSelectedCartItemIds(source);
      localStorage.setItem('beauzead_checkout_selected_cart_ids', JSON.stringify(source));
      return;
    }

    const allIds = items.map((item) => item.cartItemId);
    setSelectedCartItemIds(allIds);
    localStorage.setItem('beauzead_checkout_selected_cart_ids', JSON.stringify(allIds));
  }, [items, location.state]);

  const activeCartItems = useMemo(
    () => items.filter((item) => selectedCartItemIds.includes(item.cartItemId)),
    [items, selectedCartItemIds],
  );

  const destinationCountryForPricing = IS_FIXED_COUNTRY_STOREFRONT
    ? (IS_INDIA_STOREFRONT ? INDIA_COUNTRY_NAME : MALDIVES_COUNTRY_NAME)
    : formData.country || user?.country || '';

  useEffect(() => {
    const loadPublicPrices = async () => {
      if (!destinationCountryForPricing) {
        setPublicPriceMap({});
        setPublicPriceLoading(true);
        return;
      }

      if (activeCartItems.length === 0) {
        setPublicPriceMap({});
        setPublicPriceLoading(false);
        return;
      }

      setPublicPriceLoading(true);
      const { data } = await fetchPublicProductPrices(
        activeCartItems.map((item) => item.product.id),
        destinationCountryForPricing,
      );
      const map: Record<string, number> = {};
      (data || []).forEach((item) => {
        map[item.productId] = item.publicUnitPrice;
      });
      setPublicPriceMap(map);
      setPublicPriceLoading(false);
    };

    void loadPublicPrices();
  }, [activeCartItems, destinationCountryForPricing]);

  const hasUnresolvedPublicPrices = activeCartItems.some(
    (item) => typeof publicPriceMap[item.product.id] !== 'number'
      && typeof item.variantPrice !== 'number'
      && typeof item.product.price !== 'number'
  );

  const pricingItems = useMemo(
    () => activeCartItems.map((item) => ({
      cartItemId: item.cartItemId,
      productId: item.product.id,
      productName: item.product.name,
      quantity: item.quantity,
      unitPrice: item.variantPrice ?? publicPriceMap[item.product.id] ?? item.product.price ?? 0,
      currency: item.product.currency || 'INR',
      selectedVariantId: item.selectedVariantId,
      selectedVariantSku: item.selectedVariantSku,
      selectedSize: item.selectedSize,
      selectedColor: item.selectedColor,
    })),
    [activeCartItems, publicPriceMap],
  );

  useEffect(() => {
    const loadCountries = async () => {
      const { data } = await fetchCountries();
      const countries = data || [];
      setCountryOptions(
        IS_FIXED_COUNTRY_STOREFRONT
          ? countries.filter((country) => IS_INDIA_STOREFRONT
            ? isIndiaCountry(country.country_name) || isIndiaCountry(country.country_code) || isIndiaCountry(country.short_code)
            : isMaldivesCountry(country.country_name) || isMaldivesCountry(country.country_code) || isMaldivesCountry(country.short_code))
          : countries,
      );
    };

    void loadCountries();
  }, []);

  useEffect(() => {
    const loadSavedAddresses = async () => {
      try {
        const userId = user?.id || currentAuthUser?.userId;
        if (!userId) {
          navigate('/login', { state: { from: '/checkout/shipping' } });
          return;
        }

        let restoredDraft: ShippingFormData | null = null;
        if (hydratedDraftUserRef.current !== userId) {
          const emptyForm = createEmptyShippingFormData();
          try {
            const savedDraft = localStorage.getItem(getShippingDraftKey(userId));
            if (savedDraft) {
              const parsed = JSON.parse(savedDraft) as { formData?: Partial<ShippingFormData> };
              if (parsed.formData && typeof parsed.formData === 'object') {
                restoredDraft = Object.fromEntries(
                  Object.entries(emptyForm).map(([key, fallback]) => [
                    key,
                    typeof parsed.formData?.[key as keyof ShippingFormData] === 'string'
                      ? parsed.formData[key as keyof ShippingFormData]
                      : fallback,
                  ]),
                ) as ShippingFormData;
                if (IS_FIXED_COUNTRY_STOREFRONT) {
                  restoredDraft.country = IS_INDIA_STOREFRONT ? INDIA_COUNTRY_NAME : MALDIVES_COUNTRY_NAME;
                }
              }
            }
          } catch (err) {
            console.error('Unable to restore checkout address draft:', err);
            removeShippingDraft(userId);
          }

          hydratedDraftUserRef.current = userId;
          restoredDraftUserRef.current = restoredDraft ? userId : null;
          setDraftOwnerId(userId);
          setFormData(restoredDraft || emptyForm);
          setSelectedAddressId(null);
          setUseExistingAddress(false);
        }
        const hasRestoredDraft = restoredDraftUserRef.current === userId;

        // Fetch from DB
        const result = await getUserAddresses(userId);
        if (result.data && result.data.length > 0) {
          const addresses = result.data.map((a: any) => ({
            id: a.id,
            full_name: a.full_name || '',
            phone_number: a.phone_number || '',
            email: a.email || '',
            country: a.country || '',
            street_address_1: a.street_address_1 || '',
            street_address_2: a.street_address_2 || '',
            city: a.city || '',
            state: a.state || '',
            postal_code: a.postal_code || '',
            delivery_notes: a.delivery_notes || '',
            is_default: a.is_default || false,
          })) as UserAddress[];
          const supportedAddresses = IS_FIXED_COUNTRY_STOREFRONT
            ? addresses.filter((address) => IS_INDIA_STOREFRONT
              ? isIndiaCountry(address.country)
              : isMaldivesCountry(address.country))
            : addresses;
          setSavedAddresses(supportedAddresses);

          // Auto-select default address if exists
          const defaultAddress = hasRestoredDraft
            ? undefined
            : supportedAddresses.find(addr => addr.is_default);
          if (defaultAddress) {
            setSelectedAddressId(defaultAddress.id);
            setUseExistingAddress(true);
            // Populate formData so pricing runs with postal code immediately
            setFormData(prev => ({
              ...prev,
              full_name: defaultAddress.full_name || prev.full_name,
              phone_number: defaultAddress.phone_number || prev.phone_number,
              email: defaultAddress.email || prev.email,
              country: IS_FIXED_COUNTRY_STOREFRONT
                ? (IS_INDIA_STOREFRONT ? INDIA_COUNTRY_NAME : MALDIVES_COUNTRY_NAME)
                : defaultAddress.country || prev.country,
              street_address_1: defaultAddress.street_address_1 || '',
              street_address_2: defaultAddress.street_address_2 || '',
              city: defaultAddress.city || '',
              state: defaultAddress.state || '',
              postal_code: defaultAddress.postal_code || '',
              delivery_notes: defaultAddress.delivery_notes || '',
            }));
          }
        }

        // Pre-fill from auth context
        const name = user?.full_name || '';
        const email = user?.email || currentAuthUser?.email || '';
        const phone = user?.phone || '';
        if (name || email || phone) {
          setFormData(prev => ({
            ...prev,
            full_name: prev.full_name || name,
            email: prev.email || email,
            phone_number: prev.phone_number || phone,
          }));
        }
      } catch (err) {
        console.error('Failed to load addresses:', err);
      } finally {
        setPageReady(true);
      }
    };

    loadSavedAddresses();
  }, [user, currentAuthUser, navigate]);

  // Redirect if cart is empty
  useEffect(() => {
    if (items.length === 0) {
      navigate('/cart');
      return;
    }

    if (selectedCartItemIds.length > 0 && activeCartItems.length === 0) {
      navigate('/cart');
    }
  }, [items.length, selectedCartItemIds.length, activeCartItems.length, navigate]);

  useEffect(() => {
    const destinationCountry = destinationCountryForPricing;
    if (pricingItems.length === 0) {
      setPricing(null);
      setPricingLoading(false);
      return;
    }

    if (hasUnresolvedPublicPrices) {
      setPricingLoading(false);
      return;
    }

    const requestId = pricingRequestRef.current + 1;
    pricingRequestRef.current = requestId;
    setPricingLoading(true);

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const data = await calculateDestinationCheckoutPricing({
            items: pricingItems,
            destinationCountry,
            destinationPostalCode: formData.postal_code,
            rates,
          });
          if (pricingRequestRef.current === requestId) {
            setPricing(data);
          }
        } catch (err) {
          console.error('Failed to refresh checkout pricing:', err);
          if (pricingRequestRef.current === requestId) {
            setError(err instanceof Error
              ? err.message
              : 'Unable to load checkout pricing. Please refresh and try again.');
            setPricing(null);
          }
        } finally {
          if (pricingRequestRef.current === requestId) {
            setPricingLoading(false);
          }
        }
      })();
    }, 250);

    return () => {
      window.clearTimeout(timer);
    };
  }, [destinationCountryForPricing, formData.postal_code, pricingItems, rates, hasUnresolvedPublicPrices]);

  useEffect(() => {
    if (!pricingLoading) {
      setAddressSelectionLoading(false);
    }
  }, [pricingLoading]);

  const targetCurrency = (
    pricing?.currency || (IS_MALDIVES_STOREFRONT ? MALDIVES_CURRENCY_CODE : 'INR')
  ).toUpperCase();
  const requiresFxConversion = Boolean(
    pricing?.items?.some((line) => String(line.sourceCurrency || '').toUpperCase() !== targetCurrency)
  );
  const fxUnavailableForCheckout = IS_MALDIVES_STOREFRONT
    ? !hasCurrencyRate(MALDIVES_CURRENCY_CODE, rates)
      || Boolean(pricing?.items?.some((line) =>
        String(line.sourceCurrency || '').toUpperCase() !== MALDIVES_CURRENCY_CODE
        && !hasCurrencyRate(line.sourceCurrency, rates)))
    : IS_INDIA_STOREFRONT
      ? requiresFxConversion && (
        !hasCurrencyRate('INR', rates)
        || Boolean(pricing?.items?.some((line) =>
          String(line.sourceCurrency || '').toUpperCase() !== 'INR'
          && !hasCurrencyRate(line.sourceCurrency, rates)))
      )
      : requiresFxConversion && isExchangeRateUnavailable();

  const hasSelectedCountryOption = countryOptions.some((country) => country.country_name === formData.country);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    const next = { ...formData, [name]: value };
    if (draftOwnerId) {
      try {
        localStorage.setItem(
          getShippingDraftKey(draftOwnerId),
          JSON.stringify({ formData: next, updatedAt: Date.now() }),
        );
        setDraftSaveError(false);
      } catch (err) {
        console.error('Unable to save checkout address draft:', err);
        setDraftSaveError(true);
      }
    }
    setFormData(next);
  };

  const handleSelectAddress = (address: UserAddress) => {
    if (draftOwnerId) removeShippingDraft(draftOwnerId);
    setDraftSaveError(false);
    setUseExistingAddress(true);
    setSelectedAddressId(address.id);
    setAddressSelectionLoading(true);

    // Some saved-address rows may not include email/phone. Preserve the prefilled
    // values from auth/context so the user doesn't get stuck without an error.
    const fallbackEmail = user?.email || currentAuthUser?.email || formData.email;
    const fallbackPhone = (user as any)?.phone || formData.phone_number;

    setFormData({
      full_name: address.full_name || formData.full_name,
      phone_number: address.phone_number || fallbackPhone || '',
      email: address.email || fallbackEmail || '',
      country: IS_FIXED_COUNTRY_STOREFRONT
        ? (IS_INDIA_STOREFRONT ? INDIA_COUNTRY_NAME : MALDIVES_COUNTRY_NAME)
        : address.country || formData.country,
      street_address_1: address.street_address_1 || '',
      street_address_2: address.street_address_2 || '',
      city: address.city || '',
      state: address.state || '',
      postal_code: address.postal_code || '',
      delivery_notes: address.delivery_notes || '',
    });
  };

  const validateForm = (): boolean => {
    if (IS_FIXED_COUNTRY_STOREFRONT && !(IS_INDIA_STOREFRONT
      ? isIndiaCountry(formData.country)
      : isMaldivesCountry(formData.country))) {
      setError(IS_INDIA_STOREFRONT
        ? 'BZEAD.IN shipping addresses must be in India.'
        : 'BZEAD.MV shipping addresses must be in Maldives.');
      return false;
    }

    if (!formData.full_name.trim()) {
      setError('Full name is required');
      return false;
    }
    if (!formData.phone_number.trim()) {
      setError('Phone number is required');
      return false;
    }
    if (formData.phone_number.replace(/\D/g, '').length < 6) {
      setError('Phone number must have at least 6 digits');
      return false;
    }
    if (!formData.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email.trim())) {
      setError('Valid email is required');
      return false;
    }
    if (!formData.street_address_1.trim()) {
      setError('Street address is required');
      return false;
    }
    if (!formData.city.trim()) {
      setError('City is required');
      return false;
    }
    if (!formData.state.trim()) {
      setError('State/Province is required');
      return false;
    }
    if (!formData.postal_code.trim()) {
      setError('Postal code is required');
      return false;
    }
    // M10: Basic postal code format validation
    const countryUpper = (formData.country || '').trim().toUpperCase();
    if (['INDIA', 'IN', 'IND'].includes(countryUpper) && !/^\d{6}$/.test(formData.postal_code.trim())) {
      setError('Indian postal code must be exactly 6 digits');
      return false;
    }
    if (!formData.country.trim()) {
      setError('Country is required');
      return false;
    }
    return true;
  };

  const handleSubmit = async (e?: React.SyntheticEvent) => {
    e?.preventDefault?.();
    setError('');

    if (!validateForm()) {
      return;
    }

    if (pricingLoading) {
      setError('Refreshing shipping charges. Please wait a moment and try again.');
      return;
    }

    if (publicPriceLoading || hasUnresolvedPublicPrices) {
      setError('Final prices are still loading. Please wait a moment and try again.');
      return;
    }

    if (!pricing) {
      setError('Unable to calculate checkout prices and shipping. Please refresh and try again.');
      return;
    }

    if (fxUnavailableForCheckout) {
      setError('Live currency conversion is temporarily unavailable. Please try again in a moment.');
      return;
    }
    if (pricing.intlShippingError || pricing.domesticShippingError) {
      setError(pricing.intlShippingError || pricing.domesticShippingError || 'Shipping is not available for this address.');
      return;
    }

    setIsLoading(true);

    try {
      const userId = user?.id || currentAuthUser?.userId;
      let activeAddressId = selectedAddressId;

      if (userId && (!useExistingAddress || !selectedAddressId)) {
        const payload = {
          user_id: userId,
          full_name: formData.full_name,
          phone_number: formData.phone_number,
          email: formData.email,
          country: formData.country,
          street_address_1: formData.street_address_1,
          street_address_2: formData.street_address_2 || null,
          city: formData.city,
          state: formData.state,
          postal_code: formData.postal_code,
          delivery_notes: formData.delivery_notes || null,
          address_type: 'home',
          is_default: savedAddresses.length === 0,
        };

        const created = await createUserAddress(payload);
        if (created.error || !created.data) {
          throw new Error(created.error || 'Failed to save address to account.');
        }

        const newAddress = created.data as UserAddress;
        activeAddressId = newAddress.id;
        setSelectedAddressId(newAddress.id);
        setSavedAddresses((prev) => [newAddress, ...prev]);
      }

      // Store shipping address in localStorage for order summary page
      const selectedCountry = countryOptions.find((country) => country.country_name === formData.country);
      const selectedCountryCode = IS_FIXED_COUNTRY_STOREFRONT
        ? (IS_INDIA_STOREFRONT ? INDIA_COUNTRY_CODE : MALDIVES_COUNTRY_CODE)
        : String(selectedCountry?.country_code || '').trim().toUpperCase();

      const shippingData = {
        street: formData.street_address_1,
        street2: formData.street_address_2,
        city: formData.city,
        state: formData.state,
        postalCode: formData.postal_code,
        country: formData.country,
        countryCode: selectedCountryCode || undefined,
        fullName: formData.full_name,
        phone: formData.phone_number,
        email: formData.email,
        notes: formData.delivery_notes,
        selectedAddressId: activeAddressId,
        selectedCartItemIds,
      };

      localStorage.setItem('beauzead_checkout_shipping', JSON.stringify(shippingData));
      if (userId) removeShippingDraft(userId);

      // Navigate to order summary
      navigate('/checkout/review');
    } catch (err) {
      console.error(err);
      setError('Unable to save shipping details right now. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleUseCurrentLocation = async () => {
    if (locationLoading) return;

    setLocationLoading(true);
    setLocationError('');

    try {
      const userId = user?.id || currentAuthUser?.userId || null;
      const { data, error: detectError } = await detectLocationWithCaching({
        userId,
        forceRefresh: true,
      });

      if (detectError || !data) {
        setLocationError(detectError || 'Unable to fetch your location.');
        return;
      }

      setFormData((prev) => ({
        ...prev,
        // L3: Populate street_address_1 from place if empty (approximate from geolocation)
        street_address_1: prev.street_address_1 || data.place || prev.street_address_1,
        street_address_2: prev.street_address_2 || '',
        city: data.city || prev.city,
        state: data.state || prev.state,
        postal_code: data.postalCode || prev.postal_code,
        country: IS_FIXED_COUNTRY_STOREFRONT
          ? (IS_INDIA_STOREFRONT ? INDIA_COUNTRY_NAME : MALDIVES_COUNTRY_NAME)
          : data.country || prev.country,
      }));
    } finally {
      setLocationLoading(false);
    }
  };

  if (!pageReady) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="w-full max-w-3xl mx-auto px-4 py-6 space-y-4">
          <div className="h-6 w-52 rounded bg-gray-200 animate-pulse mb-2" />
          <ListSkeleton rows={3} withAvatar={false} />
          <Skeleton rounded="2xl" className="h-40 w-full" />
        </div>
      </div>
    );
  }

  return (
    <>
    <Header />
    <div className="min-h-screen bg-[#eaeded] py-4">
      <div className="max-w-[1100px] mx-auto px-4 pb-24 md:pb-5">
        <div className="grid grid-cols-1 gap-5">
        {/* LEFT COLUMN */}
        <div>
        <div className="bg-white border border-[#ddd] rounded-lg p-3 sm:p-6 mb-4">
          <h2 className="text-[15px] sm:text-[18px] font-bold text-[#0f1111] mb-3 sm:mb-4 flex items-center gap-2 sm:gap-2.5">
            <span className="inline-flex items-center justify-center w-6 h-6 sm:w-7 sm:h-7 bg-[#ff9900] text-white rounded-full text-xs sm:text-sm font-bold">1</span>
            Shipping Address
          </h2>

          {/* Toggle between new address and saved addresses */}
          {savedAddresses.length > 0 && (
            <div className="mb-3 sm:mb-5 flex gap-2 sm:gap-3">
              <button
                onClick={() => setUseExistingAddress(false)}
                className={`flex-1 py-1.5 sm:py-2.5 px-2 sm:px-4 rounded-md sm:rounded-lg border sm:border-2 text-[12px] sm:text-sm font-semibold transition-all ${
                  !useExistingAddress
                    ? 'border-[#ff9900] bg-[#fffbf0] text-[#0f1111]'
                    : 'border-gray-300 text-gray-600 hover:border-gray-400'
                }`}
              >
                <Plus size={14} className="inline mr-1 sm:mr-1.5" />
                New Address
              </button>
              <button
                onClick={() => {
                  if (draftOwnerId) removeShippingDraft(draftOwnerId);
                  setDraftSaveError(false);
                  setUseExistingAddress(true);
                }}
                className={`flex-1 py-1.5 sm:py-2.5 px-2 sm:px-4 rounded-md sm:rounded-lg border sm:border-2 text-[12px] sm:text-sm font-semibold transition-all ${
                  useExistingAddress
                    ? 'border-[#ff9900] bg-[#fffbf0] text-[#0f1111]'
                    : 'border-gray-300 text-gray-600 hover:border-gray-400'
                }`}
              >
                <MapPin size={14} className="inline mr-1 sm:mr-1.5" />
                Saved ({savedAddresses.length})
              </button>
            </div>
          )}

          {/* Saved Addresses Grid */}
          {useExistingAddress && savedAddresses.length > 0 && (
            <div className="mb-3 sm:mb-5 grid grid-cols-1 md:grid-cols-2 gap-2 sm:gap-3">
              {savedAddresses.map((address) => (
                <div
                  key={address.id}
                  onClick={() => handleSelectAddress(address)}
                  className={`relative px-2.5 py-2 sm:p-4 rounded-md sm:rounded-lg border sm:border-2 cursor-pointer transition-all ${
                    selectedAddressId === address.id
                      ? 'border-[#ff9900] bg-[#fffbf0]'
                      : 'border-gray-300 hover:border-[#ff9900]'
                  }`}
                >
                  {address.is_default && (
                    <span className="absolute top-1.5 right-2 sm:top-2.5 sm:right-3 bg-[#007185] text-white text-[9px] sm:text-[11px] px-1.5 sm:px-2 py-0 sm:py-0.5 rounded">
                      Default
                    </span>
                  )}
                  <div className="flex items-center gap-1.5 mb-0.5 sm:mb-1 pr-14 sm:pr-16">
                    <span className="font-bold text-[12px] sm:text-sm text-[#0f1111] truncate">{address.full_name}</span>
                    {selectedAddressId === address.id && (
                      addressSelectionLoading ? <Loader2 size={14} className="text-[#ff9900] animate-spin shrink-0" /> : <Check size={14} className="text-[#ff9900] shrink-0" />
                    )}
                  </div>
                  <div className="text-[11px] sm:text-[13px] text-[#555] leading-snug sm:leading-relaxed">
                    <p className="truncate">{address.phone_number}</p>
                    <p className="line-clamp-2 sm:line-clamp-none">
                      {address.street_address_1}
                      {address.street_address_2 && `, ${address.street_address_2}`}
                      , {address.city}, {address.state} {address.postal_code}, {address.country}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* New Address Form */}
          {(!useExistingAddress || savedAddresses.length === 0) && (
            <form onSubmit={handleSubmit} className="space-y-6">
              {/* Contact Information */}
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Contact Information</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">
                      Full Name <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      name="full_name"
                      value={formData.full_name}
                      onChange={handleInputChange}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500"
                      placeholder="John Doe"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">
                      Phone Number <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="tel"
                      name="phone_number"
                      value={formData.phone_number}
                      onChange={handleInputChange}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500"
                      placeholder="+1 (555) 123-4567"
                      required
                    />
                  </div>
                </div>
                <div className="mt-4">
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Email <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="email"
                    name="email"
                    value={formData.email}
                    onChange={handleInputChange}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500"
                    placeholder="john@example.com"
                    required
                  />
                </div>
              </div>

              {/* Address Details */}
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold text-gray-900">Address Details</h3>
                  {!IS_FIXED_COUNTRY_STOREFRONT && (
                    <button
                      type="button"
                      onClick={() => void handleUseCurrentLocation()}
                      disabled={locationLoading}
                      className="inline-flex items-center gap-2 px-3 py-2 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 disabled:opacity-50"
                    >
                      {locationLoading ? <Loader2 size={14} className="animate-spin" /> : <MapPin size={14} />}
                      Use Current Location
                    </button>
                  )}
                </div>

                {locationError && (
                  <div className="mb-3 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700">
                    {locationError}
                  </div>
                )}

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">
                      Street Address <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      name="street_address_1"
                      value={formData.street_address_1}
                      onChange={handleInputChange}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500"
                      placeholder="123 Main Street"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">
                      Apartment, Suite, etc. (Optional)
                    </label>
                    <input
                      type="text"
                      name="street_address_2"
                      value={formData.street_address_2}
                      onChange={handleInputChange}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500"
                      placeholder="Apt 4B"
                    />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-2">
                        City <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        name="city"
                        value={formData.city}
                        onChange={handleInputChange}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500"
                        placeholder={IS_INDIA_STOREFRONT ? 'Mumbai' : 'New York'}
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-2">
                        {IS_MALDIVES_STOREFRONT ? 'Atoll' : 'State/Province'} <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        name="state"
                        value={formData.state}
                        onChange={handleInputChange}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500"
                        placeholder={IS_INDIA_STOREFRONT ? 'Maharashtra' : 'NY'}
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-2">
                        {IS_INDIA_STOREFRONT ? 'PIN Code' : 'Postal Code'} <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        name="postal_code"
                        value={formData.postal_code}
                        onChange={handleInputChange}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500"
                        placeholder={IS_INDIA_STOREFRONT ? '560001' : '10001'}
                        required
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">
                      Country <span className="text-red-500">*</span>
                    </label>
                    <select
                      name="country"
                      value={formData.country}
                      onChange={handleInputChange}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500"
                      disabled={IS_FIXED_COUNTRY_STOREFRONT}
                      required
                    >
                      {IS_FIXED_COUNTRY_STOREFRONT ? (
                        <option value={IS_INDIA_STOREFRONT ? INDIA_COUNTRY_NAME : MALDIVES_COUNTRY_NAME}>
                          {IS_INDIA_STOREFRONT ? INDIA_COUNTRY_NAME : MALDIVES_COUNTRY_NAME}
                        </option>
                      ) : (
                        <>
                          <option value="">Select Country</option>
                          {!hasSelectedCountryOption && formData.country && (
                            <option value={formData.country}>{formData.country}</option>
                          )}
                          {countryOptions.map((country) => (
                            <option key={country.id} value={country.country_name}>
                              {country.country_name}
                            </option>
                          ))}
                        </>
                      )}
                    </select>
                  </div>
                </div>
              </div>

              {/* Delivery Notes */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  Delivery Notes (Optional)
                </label>
                <textarea
                  name="delivery_notes"
                  value={formData.delivery_notes}
                  onChange={handleInputChange}
                  rows={3}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 resize-none"
                  placeholder="Any special instructions for delivery..."
                />
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-red-700">
                  {error}
                </div>
              )}

              {draftSaveError && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-amber-800" role="status">
                  Your address draft could not be saved on this device. Keep this page open until you continue checkout.
                </div>
              )}

              {fxUnavailableForCheckout && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-amber-700 text-sm">
                  Live currency conversion is temporarily unavailable. Checkout is paused until rates are available.
                </div>
              )}

              {pricingLoading && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-blue-700 text-sm">
                  Checking configured shipping table, then live carrier fallback...
                </div>
              )}

              {(publicPriceLoading || hasUnresolvedPublicPrices) && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-blue-700 text-sm">
                  Loading final item prices...
                </div>
              )}

              <button
                type="submit"
                disabled={isLoading || pricingLoading || publicPriceLoading || hasUnresolvedPublicPrices || fxUnavailableForCheckout}
                className="w-full py-3.5 bg-[#ffd814] hover:bg-[#f7ca00] border border-[#fcd200] disabled:bg-gray-200 disabled:border-gray-300 text-[#0f1111] rounded-lg text-[15px] font-bold cursor-pointer transition-colors"
              >
                {isLoading ? 'Saving...' : (pricingLoading || publicPriceLoading || hasUnresolvedPublicPrices) ? 'Refreshing Shipping...' : 'Continue to Review Order'}
              </button>
            </form>
          )}

          {/* Guidance when no address selected */}
          {useExistingAddress && !selectedAddressId && (
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-center">
              Please select an address above to continue
            </p>
          )}

          {/* Continue with Selected Address */}
          {useExistingAddress && selectedAddressId && (
            <>
              {error && (
                <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-red-700">
                  {error}
                </div>
              )}
              {fxUnavailableForCheckout && (
                <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-amber-700 text-sm">
                  Live currency conversion is temporarily unavailable. Checkout is paused until rates are available.
                </div>
              )}
              {pricingLoading && (
                <div className="mb-4 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-blue-700 text-sm">
                  Checking configured shipping table, carrier fallback, and delivery estimate...
                </div>
              )}
              {(publicPriceLoading || hasUnresolvedPublicPrices) && (
                <div className="mb-4 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-blue-700 text-sm">
                  Loading final item prices...
                </div>
              )}
              <button
                onClick={handleSubmit}
                disabled={isLoading || pricingLoading || publicPriceLoading || hasUnresolvedPublicPrices || fxUnavailableForCheckout}
                className="w-full py-3.5 bg-[#ffd814] hover:bg-[#f7ca00] border border-[#fcd200] disabled:bg-gray-200 disabled:border-gray-300 text-[#0f1111] rounded-lg text-[15px] font-bold cursor-pointer transition-colors"
              >
                {isLoading ? 'Saving...' : (pricingLoading || publicPriceLoading || hasUnresolvedPublicPrices) ? 'Refreshing Shipping...' : 'Continue to Review Order'}
              </button>
            </>
          )}
        </div>
        </div>{/* END LEFT COLUMN */}

        </div>{/* END GRID */}
      </div>
    </div>
    <MobileNav />
    <Footer />
    </>
  );
};

export default ShippingAddressPage;

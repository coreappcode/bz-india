export const MALDIVES_COUNTRY_NAME = 'Maldives';
export const MALDIVES_COUNTRY_CODE = 'MV';
export const MALDIVES_CURRENCY_CODE = 'MVR';
export const INDIA_COUNTRY_NAME = 'India';
export const INDIA_COUNTRY_CODE = 'IN';
export const INDIA_CURRENCY_CODE = 'INR';

export const IS_MALDIVES_STOREFRONT = import.meta.env.VITE_MARKET === MALDIVES_COUNTRY_CODE;
export const IS_INDIA_STOREFRONT = import.meta.env.VITE_MARKET === INDIA_COUNTRY_CODE;
export const IS_FIXED_COUNTRY_STOREFRONT = IS_MALDIVES_STOREFRONT || IS_INDIA_STOREFRONT;

export const STOREFRONT_CACHE_KEY = IS_MALDIVES_STOREFRONT
  ? MALDIVES_COUNTRY_CODE
  : IS_INDIA_STOREFRONT
    ? INDIA_COUNTRY_CODE
    : 'GLOBAL';

export const isMaldivesCountry = (country: string): boolean => {
  const token = String(country || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return token === 'MALDIVES' || token === 'MV' || token === 'MDV';
};

export const isIndiaCountry = (country: string): boolean => {
  const token = String(country || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return token === 'INDIA' || token === 'IN' || token === 'IND';
};

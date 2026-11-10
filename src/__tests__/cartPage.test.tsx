import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CartPage } from '../pages/user/Cart';

const mocks = vi.hoisted(() => ({
  addToWishlist: vi.fn(),
  removeFromCart: vi.fn(),
  updateQuantity: vi.fn(),
  navigate: vi.fn(),
  variantPrices: vi.fn(),
  authUser: { id: 'user-1', country: 'India' },
  item: {
    cartItemId: 'item-1',
    product: {
      id: 'product-1', name: 'Test product', slug: 'test-product',
      brand: 'Test seller', image_url: '/test.png', price: 100,
      currency: 'INR', stock: 5,
    },
    quantity: 2,
    selectedSize: 'M',
    selectedColor: 'Blue',
    selectedVariantId: 'variant-1',
  },
}));

const items = [mocks.item];

vi.mock('../components/layout/Header', () => ({ Header: () => null }));
vi.mock('../components/layout/Footer', () => ({ Footer: () => null }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: mocks.authUser, currentAuthUser: null }),
}));
vi.mock('../contexts/CartContext', () => ({
  useCart: () => ({
    items, removeFromCart: mocks.removeFromCart, updateQuantity: mocks.updateQuantity,
  }),
}));
vi.mock('../contexts/CurrencyContext', () => ({
  useCurrency: () => ({
    formatPrice: (price: number) => `INR ${price}`, convertPrice: (price: number) => price, currency: 'INR',
  }),
}));
vi.mock('../contexts/WishlistContext', () => ({
  useWishlist: () => ({ addToWishlist: mocks.addToWishlist }),
}));
vi.mock('../hooks/useDestinationCountry', () => ({ useDestinationCountry: () => 'India' }));
vi.mock('../lib/pricingService', () => ({
  fetchVerifiedVariantPrices: mocks.variantPrices,
  fetchPublicProductPrices: vi.fn().mockResolvedValue({ data: [] }),
  calculateCheckoutPricing: vi.fn().mockResolvedValue({ data: { items: [] }, error: null }),
}));
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => mocks.navigate,
}));

describe('cart item cards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.variantPrices.mockResolvedValue({
      data: { 'item-1': { sellingPrice: 125 } }, error: null, errorsByKey: {},
    });
  });

  it('shows verified pricing and variant details, adds to wishlist without removing, and confirms removal', async () => {
    render(<MemoryRouter><CartPage /></MemoryRouter>);
    expect(await screen.findByText('INR 125')).toBeInTheDocument();
    expect(screen.getByText('Size: M · Color: Blue')).toBeInTheDocument();
    expect(screen.getByText('In Stock')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Test product' })).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Add Test product to wishlist' }));
    expect(mocks.addToWishlist).toHaveBeenCalledWith(mocks.item.product);
    expect(mocks.removeFromCart).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Test product from cart' }));
    expect(screen.getByText('Remove Item')).toBeInTheDocument();
    expect(mocks.removeFromCart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Remove$/ }));
    expect(mocks.removeFromCart).toHaveBeenCalledWith('item-1');
  });

  it('updates quantity and checks out only selected cart items', async () => {
    render(<MemoryRouter><CartPage /></MemoryRouter>);
    await screen.findByText('INR 125');
    fireEvent.click(screen.getByRole('button', { name: 'Increase quantity of Test product' }));
    expect(mocks.updateQuantity).toHaveBeenCalledWith('item-1', 3);
    await waitFor(() => expect(screen.getByRole('button', { name: /Proceed to Checkout/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Proceed to Checkout/ }));
    expect(mocks.navigate).toHaveBeenCalledWith('/checkout/shipping', {
      state: { selectedCartItemIds: ['item-1'] },
    });
    expect(JSON.parse(localStorage.getItem('beauzead_checkout_selected_cart_ids') || '[]')).toEqual(['item-1']);
  });

  it('shows unavailable variants and prevents checkout', async () => {
    mocks.variantPrices.mockResolvedValue({
      data: {}, error: null, errorsByKey: { 'item-1': 'Variant unavailable' },
    });
    render(<MemoryRouter><CartPage /></MemoryRouter>);
    expect(await screen.findByText(/This option is no longer available/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Proceed to Checkout/ })).toBeDisabled();
  });
});

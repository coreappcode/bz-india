import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CategoryProducts } from '../pages/CategoryProducts';

const mocks = vi.hoisted(() => ({
  fetchCategoryContext: vi.fn(),
  fetchProducts: vi.fn(),
  fetchPublicProductPrices: vi.fn(),
}));

vi.mock('../components/layout/StorefrontHeader', () => ({ StorefrontHeader: () => null }));
vi.mock('../components/layout/Footer', () => ({ Footer: () => null }));
vi.mock('../components/products/ProductCard', () => ({
  ProductCard: ({ product }: { product: { name: string } }) => <div>{product.name}</div>,
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null, currentAuthUser: null }) }));
vi.mock('../contexts/CurrencyContext', () => ({ useCurrency: () => ({ formatPrice: (price: number) => String(price) }) }));
vi.mock('../hooks/useDestinationCountry', () => ({ useDestinationCountry: () => 'India' }));
vi.mock('../lib/productService', () => ({
  fetchCategoryContext: mocks.fetchCategoryContext,
  fetchProducts: mocks.fetchProducts,
}));
vi.mock('../lib/pricingService', () => ({ fetchPublicProductPrices: mocks.fetchPublicProductPrices }));

let intersectionCallback: IntersectionObserverCallback;

class MockIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) { intersectionCallback = callback; }
  observe() {}
  disconnect() {}
}

const context = (id: string) => ({
  category: { id, name: id, slug: id, parent_id: null, level: 1 },
  parent: null, children: [], allCategoryIds: [id], parentById: {}, categoryNames: {},
});

const page = (start: number, length: number, prefix = 'Product') =>
  Array.from({ length }, (_, index) => ({
    id: `${prefix}-${start + index}`, name: `${prefix} ${start + index}`, price: 100,
    category: prefix, stock: 1, created_at: '2026-01-01',
  }));

function Navigation() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/category/second')}>Change category</button>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/category/first']}>
      <Navigation />
      <Routes><Route path="/category/:categoryId" element={<CategoryProducts />} /></Routes>
    </MemoryRouter>,
  );
}

describe('category product pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    mocks.fetchCategoryContext.mockImplementation(async (id: string) => context(id));
    mocks.fetchPublicProductPrices.mockResolvedValue({ data: [], error: null });
  });

  it('fetches 20 initially and loads subsequent pages when the sentinel is visible', async () => {
    mocks.fetchProducts
      .mockResolvedValueOnce({ data: page(1, 20), count: 25, error: null })
      .mockResolvedValueOnce({ data: page(21, 5), count: 25, error: null });
    renderPage();
    expect(await screen.findByText('Product 1')).toBeInTheDocument();
    expect(mocks.fetchProducts).toHaveBeenCalledTimes(1);
    expect(mocks.fetchProducts).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 20, offset: 0 }));
    expect(screen.getByText(/Filters, sorting, counts and brands apply to loaded products only/)).toBeInTheDocument();

    await act(async () => {
      intersectionCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    expect(await screen.findByText('Product 25')).toBeInTheDocument();
    expect(mocks.fetchProducts).toHaveBeenNthCalledWith(2, expect.objectContaining({ limit: 20, offset: 20 }));
    expect(screen.getByText('25 loaded results')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more products' })).not.toBeInTheDocument();
  });

  it('reports a page error and allows retry without losing loaded products', async () => {
    mocks.fetchProducts
      .mockResolvedValueOnce({ data: page(1, 20), count: 21, error: null })
      .mockResolvedValueOnce({ data: [], count: 0, error: 'Network error' })
      .mockResolvedValueOnce({ data: page(21, 1), count: 21, error: null });
    renderPage();
    await screen.findByText('Product 1');
    fireEvent.click(screen.getByRole('button', { name: 'Load more products' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load more products');
    expect(screen.getByText('Product 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Product 21')).toBeInTheDocument();
    expect(mocks.fetchProducts).toHaveBeenNthCalledWith(3, expect.objectContaining({ offset: 20 }));
  });

  it('shows an error when the initial product request fails', async () => {
    mocks.fetchProducts.mockResolvedValueOnce({ data: [], count: 0, error: 'Network error' });
    renderPage();
    expect(await screen.findByText('Failed to load products. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText('No products found')).not.toBeInTheDocument();
  });

  it('keeps a selected price range when more products change the price ceiling', async () => {
    const laterProducts = page(21, 1).map(product => ({ ...product, price: 2500 }));
    mocks.fetchProducts
      .mockResolvedValueOnce({ data: page(1, 20).map(product => ({ ...product, price: 1000 })), count: 21, error: null })
      .mockResolvedValueOnce({ data: laterProducts, count: 21, error: null });
    renderPage();
    await screen.findByText('Product 1');
    const maxSlider = screen.getAllByRole('slider')[1];
    fireEvent.change(maxSlider, { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load more products' }));
    await waitFor(() => expect(maxSlider).toHaveAttribute('max', '2500'));
    expect(maxSlider).toHaveValue('500');
  });

  it('ignores a previous category page that finishes after navigation', async () => {
    let finishOldPage!: (value: { data: ReturnType<typeof page>; count: number; error: null }) => void;
    mocks.fetchProducts
      .mockResolvedValueOnce({ data: page(1, 20), count: 21, error: null })
      .mockReturnValueOnce(new Promise(resolve => { finishOldPage = resolve; }))
      .mockResolvedValueOnce({ data: page(1, 1, 'Second'), count: 1, error: null });
    renderPage();
    await screen.findByText('Product 1');
    fireEvent.click(screen.getByRole('button', { name: 'Load more products' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change category' }));
    expect(await screen.findByText('Second 1')).toBeInTheDocument();
    await act(async () => finishOldPage({ data: page(21, 1), count: 21, error: null }));
    expect(screen.queryByText('Product 21')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Second 1')).toBeInTheDocument());
  });
});

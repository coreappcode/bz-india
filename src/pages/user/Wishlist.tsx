import React, { useState, useEffect } from 'react';
import { Header } from '../../components/layout/Header';
import { Footer } from '../../components/layout/Footer';
import { MobileNav } from '../../components/layout/MobileNav';
import { ProductGridSkeleton } from '../../components/common/Skeleton';
import { useAuth } from '../../contexts/AuthContext';
import { useWishlist } from '../../contexts/WishlistContext';
import { useCurrency } from '../../contexts/CurrencyContext';
import { useDestinationCountry } from '../../hooks/useDestinationCountry';
import { fetchPublicProductPrices } from '../../lib/pricingService';
import { useNavigate } from 'react-router-dom';
import { Heart, Trash2, ShoppingCart } from 'lucide-react';
import { Link } from 'react-router-dom';

export const WishlistPage: React.FC = () => {
  const { user, currentAuthUser, loading: authLoading } = useAuth();
  const { items: wishlistItems, removeFromWishlist, loadFromBackend } = useWishlist();
  const { formatPrice, convertPrice, currency } = useCurrency();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [priceLoading, setPriceLoading] = useState(false);
  const [publicPriceMap, setPublicPriceMap] = useState<Record<string, number>>({});
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const selectedCountry = useDestinationCountry({
    userId: user?.id || currentAuthUser?.userId || null,
    userCountry: user?.country || '',
  });

  useEffect(() => {
    // Wait for auth to initialize
    if (authLoading) return;
    // Check if user is logged in
    if (!user && !currentAuthUser) {
      navigate('/login');
      return;
    }

    // Load wishlist from backend
    const loadWishlist = async () => {
      try {
        const userId = user?.id || currentAuthUser?.userId;
        if (userId) {
          await loadFromBackend(userId);
        }
      } catch (error) {
        console.error('Failed to load wishlist from backend:', error);
      } finally {
        setLoading(false);
      }
    };

    loadWishlist();
  }, [user, currentAuthUser, navigate, loadFromBackend, authLoading]);

  useEffect(() => {
    const loadPublicPrices = async () => {
      if (!selectedCountry) {
        setPublicPriceMap({});
        setPriceLoading(true);
        return;
      }

      if (wishlistItems.length === 0) {
        setPublicPriceMap({});
        setPriceLoading(false);
        return;
      }

      setPriceLoading(true);
      const { data } = await fetchPublicProductPrices(
        wishlistItems.map((item) => item.id),
        selectedCountry,
      );

      const map: Record<string, number> = {};
      (data || []).forEach((item) => {
        map[item.productId] = item.publicUnitPrice;
      });

      setPublicPriceMap(map);
      setPriceLoading(false);
    };

    void loadPublicPrices();
  }, [wishlistItems, selectedCountry]);

  const handleRemoveItem = (id: string) => {
    setRemovingId(id);
    removeFromWishlist(id);
    // Small delay so opacity-50 feedback is visible before item is removed from list
    setTimeout(() => {
      setRemovingId(null);
      setConfirmRemoveId(null);
    }, 300);
  };

  const handleAddToCart = (product: any) => {
    // Navigate to product page so user can select variant (size/color) before adding
    navigate(`/products/${product.id}`);
  };

  const resolvePublicPriceSourceCurrency = (product: { currency?: string }) =>
    (product.currency || 'INR').toUpperCase();

  const hasResolvedAllPrices = wishlistItems.every((item) => {
    return typeof publicPriceMap[item.id] === 'number' || typeof item.price === 'number';
  });
  const totalValue = hasResolvedAllPrices
    ? wishlistItems.reduce(
      (sum, item) => {
        const unitPrice = typeof publicPriceMap[item.id] === 'number' ? publicPriceMap[item.id] : item.price;
        return sum + convertPrice(unitPrice, resolvePublicPriceSourceCurrency(item));
      },
      0
    )
    : 0;
  const totalSavings = hasResolvedAllPrices
    ? wishlistItems.reduce(
      (sum, item) => {
        const unitPrice = typeof publicPriceMap[item.id] === 'number' ? publicPriceMap[item.id] : item.price;
        return sum + (convertPrice(unitPrice, resolvePublicPriceSourceCurrency(item)) * (item.discount || 0)) / 100;
      },
      0
    )
    : 0;

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <Header />

      <main className="flex-grow max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 sm:py-6 w-full pb-24 md:pb-8">
        {/* Page Header */}
        <div className="mb-3 sm:mb-6">
          <h1 className="text-base sm:text-2xl md:text-3xl font-bold text-amber-600 mb-0.5 sm:mb-1 leading-tight">My Wishlist</h1>
          <p className="text-[11px] sm:text-sm text-gray-500">{wishlistItems.length} items saved</p>
        </div>

        {/* Loading State */}
        {loading ? (
          <ProductGridSkeleton count={8} className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4" />
        ) : wishlistItems.length === 0 ? (
          <div className="bg-gray-50 border-2 border-dashed border-gray-200 rounded-lg p-12 text-center">
            <Heart className="h-16 w-16 text-gray-500 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Wishlist Empty</h2>
            <p className="text-gray-500 mb-6">
              Start adding items to your wishlist to save them for later.
            </p>
            <button
              onClick={() => navigate('/')}
              className="bg-amber-500 text-black px-6 py-2 rounded-lg font-semibold hover:bg-yellow-500 transition-all duration-300"
            >
              Continue Shopping
            </button>
          </div>
        ) : (
          <div>
            {/* Summary */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                <p className="text-gray-500 text-sm mb-1">Total Value</p>
                <p className="text-2xl font-bold text-amber-600">
                  {hasResolvedAllPrices ? formatPrice(totalValue, currency) : 'Loading prices...'}
                </p>
              </div>
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                <p className="text-gray-500 text-sm mb-1">Total Savings</p>
                <p className="text-2xl font-bold text-green-400">
                  {hasResolvedAllPrices ? formatPrice(Math.round(totalSavings), currency) : 'Loading prices...'}
                </p>
              </div>
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                <p className="text-gray-500 text-sm mb-1">Items</p>
                <p className="text-2xl font-bold text-gray-900">{wishlistItems.length}</p>
              </div>
            </div>

            {/* Wishlist Items */}
            <div className="space-y-4">
              {wishlistItems.map((product) => (
                <div
                  key={product.id}
                  className={`bg-gray-50 border border-gray-200 rounded-lg overflow-hidden hover:border-amber-500 transition-all duration-300 flex flex-col sm:flex-row gap-3 p-3.5 group ${
                    removingId === product.id ? 'opacity-50' : ''
                  }`}
                >
                  {/* Image */}
                  <Link to={`/products/${product.id}`} className="flex-shrink-0 w-full sm:w-36 h-36 bg-gray-100 rounded-lg overflow-hidden">
                    <img
                      src={product.image_url}
                      alt={product.name}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    />
                  </Link>

                  {/* Details */}
                  <div className="flex-grow">
                    <Link to={`/products/${product.id}`} className="hover:text-amber-600 transition-colors">
                      <h3 className="text-lg font-bold text-gray-900 mb-1 line-clamp-2">{product.name}</h3>
                    </Link>
                    <p className="text-sm text-gray-500 mb-3">{product.brand || 'Brand'}</p>

                    {/* Price */}
                    <div className="mb-3 flex items-center gap-3">
                      {(typeof publicPriceMap[product.id] === 'number' || typeof product.price === 'number') ? (
                        <span className="text-2xl font-bold text-amber-600">
                          {formatPrice(
                            typeof publicPriceMap[product.id] === 'number' ? publicPriceMap[product.id] : product.price,
                            resolvePublicPriceSourceCurrency(product)
                          )}
                        </span>
                      ) : (
                        <span className="text-sm font-medium text-gray-500">
                          {priceLoading ? 'Loading price...' : 'Loading price...'}
                        </span>
                      )}
                      {(typeof publicPriceMap[product.id] === 'number' || typeof product.price === 'number') && product.discount && (
                        <>
                          <span className="text-sm text-gray-500 line-through">
                            {formatPrice(
                              Math.round((typeof publicPriceMap[product.id] === 'number' ? publicPriceMap[product.id] : product.price) / (1 - product.discount / 100)),
                              resolvePublicPriceSourceCurrency(product),
                            )}
                          </span>
                          <span className="bg-red-900 text-red-200 px-2 py-1 rounded text-xs font-bold">
                            -{product.discount}%
                          </span>
                        </>
                      )}
                    </div>

                    {/* Stock Status */}
                    <p className={`text-sm font-medium mb-4 ${product.stock == null ? 'text-gray-500' : product.stock > 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {product.stock == null ? 'Check availability' : product.stock > 0 ? '✓ In Stock' : '✗ Out of Stock'}
                    </p>
                  </div>

                  {/* Actions */}
                  <div className="flex flex-col gap-3 justify-end sm:w-40">
                    <button
                      onClick={() => handleAddToCart(product)}
                      disabled={removingId === product.id}
                      className="bg-amber-500 text-black px-4 py-2 rounded-lg font-semibold hover:bg-yellow-500 transition-all duration-300 disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      <ShoppingCart className="h-4 w-4" />
                      View & Add to Cart
                    </button>
                    <button
                      onClick={() => setConfirmRemoveId(product.id)}
                      disabled={removingId === product.id}
                      className="bg-gray-100 hover:bg-red-900 text-gray-900 px-4 py-2 rounded-lg font-medium transition-all duration-300 disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      <Trash2 className="h-4 w-4" />
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Confirm Remove Dialog */}
      {confirmRemoveId && (
        <div className="fixed inset-0 z-[10001] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-xl">
            <h3 className="text-lg font-bold text-gray-900 mb-2">Remove from Wishlist</h3>
            <p className="text-sm text-gray-600 mb-6">Are you sure you want to remove this item from your wishlist?</p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmRemoveId(null)}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 font-semibold hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleRemoveItem(confirmRemoveId)}
                className="flex-1 px-4 py-2 bg-red-500 text-white rounded-lg font-semibold hover:bg-red-600 transition-colors"
              >
                Remove
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

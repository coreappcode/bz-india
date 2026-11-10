import { beforeEach, describe, expect, it, vi } from 'vitest';

const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { from } }));
vi.mock('../lib/notificationService', () => ({
  notifyAccountEvent: vi.fn(),
  notifyAdminsOfEvent: vi.fn(),
}));

import { fetchProducts } from '../lib/productService';

describe('category product query', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requests the correct range with a stable ordering', async () => {
    const query = {
      select: vi.fn(), or: vi.fn(), eq: vi.fn(), order: vi.fn(), range: vi.fn(),
      then: (resolve: (value: { data: never[]; error: null; count: number }) => unknown) =>
        Promise.resolve({ data: [], error: null, count: 40 }).then(resolve),
    };
    query.select.mockReturnValue(query);
    query.or.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.order.mockReturnValue(query);
    query.range.mockReturnValue(query);
    from.mockReturnValue(query);

    await fetchProducts({
      categoryIds: ['category-1'], approvalStatus: 'approved', isActive: true, limit: 20, offset: 20,
    });

    expect(query.range).toHaveBeenCalledWith(20, 39);
    expect(query.order).toHaveBeenNthCalledWith(1, 'created_at', { ascending: false });
    expect(query.order).toHaveBeenNthCalledWith(2, 'id', { ascending: false });
    expect(query.or).toHaveBeenCalledWith(
      'category.in.(category-1),sub_category.in.(category-1),product_type.in.(category-1)',
    );
  });
});

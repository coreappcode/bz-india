-- Buyer-facing platform handling charge is 0 (matches the checkout quote).
-- Seller commission (platform_fee / seller_earning) is unchanged.
DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'create_order_secure' AND n.nspname = 'public';

  v_new := replace(
    v_def,
    E'v_platform_handling_charge := round(\n    (v_product_subtotal + coalesce(p_shipping_charge, 0)) * v_commission_percent / 100, 2\n  );',
    E'v_platform_handling_charge := 0;'
  );

  IF v_new = v_def THEN
    RAISE EXCEPTION 'handling charge expression not found';
  END IF;

  EXECUTE v_new;
END
$$;

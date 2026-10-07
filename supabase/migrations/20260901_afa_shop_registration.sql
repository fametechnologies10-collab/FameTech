-- ═══════════════════════════════════════════════════════════
-- AFA Registration on Shop Storefronts
-- ═══════════════════════════════════════════════════════════

-- 1. Shop-order columns on afa_orders (all nullable — existing rows unaffected)
ALTER TABLE public.afa_orders
  ADD COLUMN IF NOT EXISTS shop_id          uuid REFERENCES public.shop_profiles(id),
  ADD COLUMN IF NOT EXISTS guest_phone      text,
  ADD COLUMN IF NOT EXISTS cost_price       numeric,
  ADD COLUMN IF NOT EXISTS selling_price    numeric,
  ADD COLUMN IF NOT EXISTS profit           numeric,
  ADD COLUMN IF NOT EXISTS parent_shop_id   uuid REFERENCES public.shop_profiles(id),
  ADD COLUMN IF NOT EXISTS parent_profit    numeric,
  ADD COLUMN IF NOT EXISTS refund_method    text,
  ADD COLUMN IF NOT EXISTS refund_reason    text,
  ADD COLUMN IF NOT EXISTS refunded_at      timestamptz,
  ADD COLUMN IF NOT EXISTS refunded_by      uuid,
  ADD COLUMN IF NOT EXISTS paystack_reference text;

CREATE UNIQUE INDEX IF NOT EXISTS afa_orders_paystack_reference_unique
  ON public.afa_orders (paystack_reference)
  WHERE paystack_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS afa_orders_shop_id_idx ON public.afa_orders (shop_id) WHERE shop_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS afa_orders_guest_phone_idx ON public.afa_orders (guest_phone) WHERE guest_phone IS NOT NULL;

-- 2. Widen source to allow shop-origin orders. 'api' MUST be included — the v2
-- developer API (app/api/v2/afa/register) stamps source='api' on every
-- registration, and omitting it would break that live endpoint. No source
-- constraint exists today; all existing rows are 'web'.
ALTER TABLE public.afa_orders DROP CONSTRAINT IF EXISTS afa_orders_source_check;
ALTER TABLE public.afa_orders
  ADD CONSTRAINT afa_orders_source_check CHECK (source IN ('web', 'ussd', 'api', 'shop'));

-- 3. Shop-level AFA markup. No separate enable boolean — a shop is "AFA-enabled"
-- purely by having a non-null afa_fee_percent (same convention as RC/airtime:
-- saving a markup turns the service on; clearing it back to null turns it off).
ALTER TABLE public.shop_profiles
  ADD COLUMN IF NOT EXISTS afa_fee_percent numeric;

-- 4. Global kill switch. admin_settings.value is jsonb — every sibling
-- storefront toggle is stored as a JSON STRING ('true'/'false'), and every
-- reader compares against the string. Must be explicitly quoted here or the
-- plain literal 'false' parses as a JSON boolean instead, which the '!== ''true'''
-- string check can never match — the feature could never be enabled.
INSERT INTO public.admin_settings (key, value) VALUES
  ('storefront_afa_enabled', '"false"')
ON CONFLICT (key) DO NOTHING;

-- 5. Per-role markup caps (0 = no limit, matches mashup convention)
INSERT INTO public.shop_global_settings (key, value) VALUES
  ('afa_shop_fee_max_customer', '0'),
  ('afa_shop_fee_max_agent', '0'),
  ('afa_shop_fee_max_dealer', '0')
ON CONFLICT (key) DO NOTHING;

-- 6. Commission ledger linkage (idempotency anchor for the credit RPC).
-- shop_wallet_transactions.shop_order_id carries a FK to shop_orders(id), so an
-- afa_orders id can NOT go there. Dedicated nullable column + unique partial
-- index, mirroring utility_order_id / uq_shop_wallet_tx_utility_commission
-- in 20260709_utility_bills.sql.
ALTER TABLE public.shop_wallet_transactions
  ADD COLUMN IF NOT EXISTS afa_order_id uuid REFERENCES public.afa_orders(id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_shop_wallet_tx_afa_profit
  ON public.shop_wallet_transactions(afa_order_id) WHERE afa_order_id IS NOT NULL;

-- 7. Profit-credit RPC — modeled on credit_shop_profit (lock-before-check idempotency).
-- type stays 'profit' (already allowed by shop_wallet_transactions_type_check) so
-- AFA markup shows up in existing shop-owner earnings views unchanged.
CREATE OR REPLACE FUNCTION public.credit_shop_afa_profit(p_afa_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_profit DECIMAL;
  v_owner_id UUID;
  v_wallet_id UUID;
  v_guest_phone TEXT;
  v_existing_tx_id UUID;
BEGIN
  SELECT
    ao.profit,
    sp.owner_id,
    ao.guest_phone
  INTO
    v_profit,
    v_owner_id,
    v_guest_phone
  FROM public.afa_orders ao
  JOIN public.shop_profiles sp ON ao.shop_id = sp.id
  WHERE ao.id = p_afa_order_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Order not found');
  END IF;

  IF v_profit <= 0 OR v_profit IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'No profit to credit');
  END IF;

  INSERT INTO public.shop_wallets (owner_id, balance, total_earned)
  VALUES (v_owner_id, 0, 0)
  ON CONFLICT (owner_id) DO NOTHING;

  -- Lock BEFORE checking idempotency — same rule as credit_shop_profit, prevents
  -- two concurrent callers (e.g. a retried admin click) from both passing the check.
  SELECT id INTO v_wallet_id
  FROM public.shop_wallets
  WHERE owner_id = v_owner_id
  FOR UPDATE;

  SELECT id INTO v_existing_tx_id
  FROM public.shop_wallet_transactions
  WHERE afa_order_id = p_afa_order_id AND type = 'profit';

  IF v_existing_tx_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'message', 'Already credited');
  END IF;

  UPDATE public.shop_wallets
  SET
    balance = balance + v_profit,
    total_earned = total_earned + v_profit,
    updated_at = NOW()
  WHERE id = v_wallet_id;

  INSERT INTO public.shop_wallet_transactions
    (shop_wallet_id, afa_order_id, type, amount, description, status)
  VALUES
    (v_wallet_id, p_afa_order_id, 'profit', v_profit, 'AFA Registration: ' || COALESCE(v_guest_phone, 'guest'), 'completed');

  RETURN jsonb_build_object('success', true, 'message', 'Credited ' || v_profit);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.credit_shop_afa_profit(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.credit_shop_afa_profit(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.credit_shop_afa_profit(uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.credit_shop_afa_profit(uuid) TO service_role;

-- 8. Extend the guest order-tracking RPC to include AFA shop orders
CREATE OR REPLACE FUNCTION public.get_shop_orders_by_phone(
    phone_number text,
    limit_count  int  DEFAULT 20,
    p_shop_id    uuid DEFAULT NULL
)
RETURNS TABLE (
    id            uuid,
    network       text,
    package_size  text,
    selling_price numeric,
    status        text,
    created_at    timestamptz,
    guest_phone   text,
    shop_name     text,
    shop_slug     text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RETURN QUERY
    SELECT
        so.id,
        so.network,
        so.package_size,
        so.selling_price,
        COALESCE(retry_o.status, orig_o.status, so.status) AS status,
        so.created_at,
        so.guest_phone,
        sp.shop_name,
        sp.shop_slug
    FROM public.shop_orders   so
    JOIN public.shop_profiles sp ON so.shop_id = sp.id
    LEFT JOIN public.orders orig_o ON orig_o.shop_order_id = so.id
    LEFT JOIN LATERAL (
        SELECT o2.status
        FROM public.orders o2
        WHERE o2.retry_of_order_id = orig_o.id
        ORDER BY o2.created_at DESC
        LIMIT 1
    ) retry_o ON true
    WHERE so.guest_phone = phone_number
      AND (p_shop_id IS NULL OR so.shop_id = p_shop_id)

    UNION ALL

    SELECT
        ao.id,
        'AFA'::text              AS network,
        'AFA Registration'::text AS package_size,
        ao.selling_price,
        ao.status,
        ao.created_at,
        ao.guest_phone,
        sp2.shop_name,
        sp2.shop_slug
    FROM public.afa_orders ao
    JOIN public.shop_profiles sp2 ON ao.shop_id = sp2.id
    WHERE ao.shop_id IS NOT NULL
      AND ao.guest_phone = phone_number
      AND (p_shop_id IS NULL OR ao.shop_id = p_shop_id)

    ORDER BY created_at DESC
    LIMIT limit_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_shop_orders_by_phone(text, int, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_shop_orders_by_phone(text, int, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_shop_orders_by_phone(text, int, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.get_shop_orders_by_phone(text, int, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- MIGRATION: get_shop_orders_by_phone — resolve status through retry descendants
-- Date:      2026-07-28
--
-- Same root cause as the shop owner's order-history page (fixed client-side
-- for that page): a retry on a refunded order creates a NEW `orders` row
-- (orders.retry_of_order_id -> original) instead of mutating the original in
-- place, and that new row is never linked back into shop_orders. This RPC
-- read shop_orders.status directly, which only stays in sync with the
-- ORIGINAL order (permanently 'refunded' after the first refund) — so a
-- guest looking up their order on the storefront tracker kept seeing
-- "Refunded" forever, even after a successful retry delivered their bundle.
--
-- Fix: resolve status as the latest retry descendant's status if one exists,
-- else the mirrored original order's status, else shop_orders.status as a
-- last-resort fallback. Return shape is unchanged — the guest tracker has no
-- business seeing retry_count/retried_by_role/etc (they can't retry their own
-- order), so nothing beyond the resolved `status` value changes here.
-- ============================================================================

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
    ORDER BY so.created_at DESC
    LIMIT limit_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_shop_orders_by_phone(text, int, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_shop_orders_by_phone(text, int, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_shop_orders_by_phone(text, int, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.get_shop_orders_by_phone(text, int, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

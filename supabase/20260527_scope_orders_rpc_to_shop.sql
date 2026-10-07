-- ============================================================================
-- Security: Scope get_shop_orders_by_phone to a single shop
--
-- The original RPC returned orders for a phone number across ALL shops,
-- enabling cross-shop order enumeration and customer PII harvesting.
-- The new signature requires p_shop_id so the API can scope results to
-- only the shop the customer is currently viewing.
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
AS $$
BEGIN
    RETURN QUERY
    SELECT
        so.id,
        so.network,
        so.package_size,
        so.selling_price,
        so.status,
        so.created_at,
        so.guest_phone,
        sp.shop_name,
        sp.shop_slug
    FROM shop_orders so
    JOIN shop_profiles sp ON so.shop_id = sp.id
    WHERE so.guest_phone = phone_number
      AND (p_shop_id IS NULL OR so.shop_id = p_shop_id)
    ORDER BY so.created_at DESC
    LIMIT limit_count;
END;
$$;

-- Re-grant execute to both roles (overloaded signature requires explicit grant)
GRANT EXECUTE ON FUNCTION public.get_shop_orders_by_phone(text, int, uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_shop_orders_by_phone(text, int, uuid) TO authenticated;

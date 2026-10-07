-- ============================================================================
-- MIGRATION: get_shop_orders_by_phone — fix ambiguous "phone_number" reference
-- Date:      2026-09-24
--
-- Root cause: the 3-arg overload (phone_number, limit_count, p_shop_id) LEFT
-- JOINs public.orders (aliased orig_o) to resolve retry status. public.orders
-- has its own "phone_number" column, so the unqualified parameter reference
-- in "WHERE so.guest_phone = phone_number" became ambiguous the moment that
-- join was added — Postgres can't tell if it means the plpgsql parameter or
-- orig_o.phone_number. Every call (guest storefront order tracker, for both
-- the main domain and subagent/shop-domain storefronts, since this function
-- is shared and only scoped by p_shop_id) has been throwing
-- "42702: column reference \"phone_number\" is ambiguous" and failing.
--
-- Fix: drop and recreate with the p_-prefixed convention already used for
-- p_shop_id in this function, so parameters can never collide with a real
-- column name again. Body logic (retry-status resolution + AFA orders
-- union) is unchanged — only the parameter names change.
-- ============================================================================

DROP FUNCTION IF EXISTS public.get_shop_orders_by_phone(text, int, uuid);

CREATE FUNCTION public.get_shop_orders_by_phone(
    p_phone_number text,
    p_limit_count   int  DEFAULT 20,
    p_shop_id       uuid DEFAULT NULL
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
    WHERE so.guest_phone = p_phone_number
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
      AND ao.guest_phone = p_phone_number
      AND (p_shop_id IS NULL OR ao.shop_id = p_shop_id)

    ORDER BY created_at DESC
    LIMIT p_limit_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_shop_orders_by_phone(text, int, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_shop_orders_by_phone(text, int, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_shop_orders_by_phone(text, int, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.get_shop_orders_by_phone(text, int, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

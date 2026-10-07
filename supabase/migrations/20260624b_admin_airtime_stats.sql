-- ============================================================
-- admin_airtime_stats — server-side aggregate for the admin airtime panel.
-- The panel previously summed money client-side over a 500-row fetch, so every
-- figure understated past 500 lifetime orders. This aggregates the FULL set under
-- the network/type/date filters. Money figures are COMPLETED-scoped (earned only);
-- pending_value is at-risk money; counts break down the matched set.
-- SECURITY INVOKER + REVOKE from anon/authenticated → only the service-role route
-- can call it (which already bypasses RLS), so no SECURITY DEFINER advisor.
-- ============================================================

CREATE OR REPLACE FUNCTION public.admin_airtime_stats(
    p_network text DEFAULT NULL,
    p_type    text DEFAULT NULL,
    p_start   timestamptz DEFAULT NULL,
    p_end     timestamptz DEFAULT NULL
)
RETURNS TABLE (
    gross_sales       numeric,
    admin_markup      numeric,
    hubtel_commission numeric,
    shop_profit       numeric,
    total_volume      numeric,
    pending_value     numeric,
    total_count       bigint,
    airtime_count     bigint,
    mashup_count      bigint,
    pending_count     bigint,
    completed_count   bigint,
    hubtel_count      bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    SELECT
        COALESCE(SUM(total_paid)     FILTER (WHERE status = 'completed'), 0) AS gross_sales,
        -- Admin markup, 0-tolerant: admin_fee_amount when set, else derive admin = fee - shop
        -- for a shop order, else the whole fee for a direct order (fixes the DEFAULT-0 trap).
        COALESCE(SUM(
            CASE WHEN admin_fee_amount > 0 THEN admin_fee_amount
                 WHEN shop_id IS NOT NULL  THEN GREATEST(0, fee_amount - shop_fee_amount)
                 ELSE fee_amount END
        ) FILTER (WHERE status = 'completed'), 0) AS admin_markup,
        COALESCE(SUM(NULLIF(fulfillment_metadata->>'commission', '')::numeric)
                 FILTER (WHERE status = 'completed'), 0) AS hubtel_commission,
        COALESCE(SUM(shop_fee_amount) FILTER (WHERE status = 'completed' AND shop_id IS NOT NULL), 0) AS shop_profit,
        COALESCE(SUM(airtime_amount)  FILTER (WHERE status = 'completed'), 0) AS total_volume,
        COALESCE(SUM(total_paid)      FILTER (WHERE status = 'pending'), 0) AS pending_value,
        COUNT(*)                                                          AS total_count,
        COUNT(*) FILTER (WHERE type <> 'mashup')                          AS airtime_count,
        COUNT(*) FILTER (WHERE type = 'mashup')                           AS mashup_count,
        COUNT(*) FILTER (WHERE status = 'pending')                        AS pending_count,
        COUNT(*) FILTER (WHERE status = 'completed')                      AS completed_count,
        COUNT(*) FILTER (WHERE status = 'completed' AND fulfillment_service = 'hubtel-commission') AS hubtel_count
    FROM public.airtime_orders
    WHERE (p_network IS NULL OR network    = p_network)
      AND (p_type    IS NULL OR type       = p_type)
      AND (p_start   IS NULL OR created_at >= p_start)
      AND (p_end     IS NULL OR created_at <= p_end);
$$;

-- REVOKE from PUBLIC too — Postgres grants EXECUTE to PUBLIC by default, which anon/authenticated
-- inherit; revoking only the named roles leaves the PUBLIC grant in place. Only service_role calls it.
REVOKE ALL ON FUNCTION public.admin_airtime_stats(text, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_airtime_stats(text, text, timestamptz, timestamptz) TO service_role;

-- supabase/migrations/20260619_shop_credit_rollups.sql
-- Aggregate RPC for the admin shop-credits accountability route.
-- Returns the green/amber/red split for the entire table or a single shop owner.
-- Called by app/api/admin/shop-credits/route.ts — never by client code.
CREATE OR REPLACE FUNCTION public.get_shop_credit_rollups(p_owner_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
    SELECT jsonb_build_object(
        'green_total', COALESCE(SUM(amount) FILTER (WHERE risk_status = 'green'), 0),
        'amber_total', COALESCE(SUM(amount) FILTER (WHERE risk_status = 'amber'), 0),
        'red_total',   COALESCE(SUM(amount) FILTER (WHERE risk_status = 'red'), 0),
        'red_count',   COUNT(*)            FILTER (WHERE risk_status = 'red')
    )
    FROM public.v_shop_profit_credit_reconciliation
    WHERE p_owner_id IS NULL OR owner_id = p_owner_id;
$$;

REVOKE ALL ON FUNCTION public.get_shop_credit_rollups(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_shop_credit_rollups(UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_shop_credit_rollups(UUID) TO service_role;

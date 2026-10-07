-- supabase/migrations/20260628_reconciliation_ussd_airtime_proof.sql
-- =============================================================================
-- FIX: USSD airtime shop credits were flagged RED ('ussd_no_paid_order').
--
-- The reconciliation view proves a USSD sale was paid by requiring a paid
-- public.orders row linked to the shop_order. But ONLY USSD *data* writes that
-- row (lib/ussd/fulfillment/data.ts inserts orders with payment_status='paid'
-- + shop_order_id). USSD *airtime* (lib/ussd/fulfillment/airtime.ts) records the
-- sale in airtime_orders + a shop_orders row (package_id=NULL) and NEVER writes a
-- public.orders row — so every legitimate airtime credit failed the check and went
-- RED. That false-positive made RED meaningless for airtime (alert fatigue), which
-- is itself a security regression: a genuinely forged airtime credit hid in the noise.
--
-- FIX: scope the strict "must have a paid orders row" rule to DATA only
-- (so.package_id IS NOT NULL). Airtime (package_id IS NULL, writes no orders row)
-- is no longer auto-RED; it is still RED on the OTHER integrity rules that DO apply
-- to it — amount mismatch vs shop_orders.profit, duplicate credit, or a
-- failed/refunded order — and the real payment gate upstream is the Fixie static-IP
-- allowlist on the Hubtel callback (a forged callback can't reach /api/ussd/fulfill).
--
-- Unchanged: USSD data (strict orders-row proof), website orders (paystack_reference),
-- and RC USSD credits (shop_order_id IS NULL → 'amber' source_uncross_checked, a
-- milder pre-existing signal, not a false RED — intentionally left as-is).
-- =============================================================================

CREATE OR REPLACE VIEW public.v_shop_profit_credit_reconciliation AS
WITH credits AS (
    SELECT t.*,
           COUNT(*) FILTER (WHERE t.shop_order_id IS NOT NULL)
             OVER (PARTITION BY t.shop_order_id) AS order_dupe_count
    FROM public.shop_wallet_transactions t
    WHERE t.type = 'profit'
)
SELECT
    c.id,
    c.shop_wallet_id,
    w.owner_id,
    sp.id              AS shop_id,
    COALESCE(sp.shop_name, 'Unknown Shop') AS shop_name,
    TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS owner_name,
    u.email            AS owner_email,
    sp.owner_phone     AS owner_phone,
    c.amount,
    so.profit          AS expected_amount,
    c.created_at,
    c.shop_order_id,
    COALESCE(so.paystack_reference, c.ussd_ref) AS order_ref,
    so.status          AS order_status,
    so.network,
    so.package_size,
    so.guest_phone,
    COALESCE(c.credit_source,
        CASE WHEN c.shop_order_id IS NOT NULL THEN COALESCE(so.source,'order')
             WHEN c.ussd_ref IS NOT NULL THEN 'ussd'
             ELSE 'unknown' END) AS credit_source,
    -- A USSD DATA credit is GREEN only if a PAID linked order exists (orders.payment_status='paid',
    -- written post-payment by lib/ussd/fulfillment/data.ts). USSD AIRTIME (so.package_id IS NULL)
    -- writes no orders row, so that proof does not apply — it relies on the amount/dup/status
    -- checks below + the Fixie callback allowlist instead.
    CASE
        WHEN c.shop_order_id IS NULL AND c.ussd_ref IS NULL THEN 'red'                       -- orphan, no link
        WHEN c.shop_order_id IS NOT NULL AND so.id IS NULL THEN 'red'                        -- dangling FK
        WHEN c.shop_order_id IS NOT NULL AND so.status IN ('failed','refunded') THEN 'red'   -- credit on dead order
        WHEN c.shop_order_id IS NOT NULL AND so.profit IS NOT NULL
             AND ABS(c.amount - so.profit) > 0.01 THEN 'red'                                 -- amount mismatch
        WHEN c.order_dupe_count > 1 THEN 'red'                                               -- duplicate credit
        WHEN c.shop_order_id IS NOT NULL AND COALESCE(so.source,'website') <> 'ussd'
             AND so.paystack_reference IS NULL THEN 'red'                                    -- website order, no payment ref
        WHEN c.shop_order_id IS NOT NULL AND COALESCE(so.source,'') = 'ussd'
             AND so.package_id IS NOT NULL                                                   -- DATA only (airtime nulls package_id, writes no orders row)
             AND NOT EXISTS (SELECT 1 FROM public.orders o
                             WHERE o.shop_order_id = c.shop_order_id AND o.payment_status = 'paid')
             THEN 'red'                                                                      -- USSD DATA credit, NO paid order
        WHEN c.shop_order_id IS NULL AND c.ussd_ref IS NOT NULL THEN 'amber'                 -- credit w/ only ussd_ref, no order
        ELSE 'green'                                                                         -- paid + backed (website ref, USSD data paid, or USSD airtime)
    END AS risk_status,
    ARRAY_REMOVE(ARRAY[
        CASE WHEN c.shop_order_id IS NULL AND c.ussd_ref IS NULL THEN 'orphan_no_order' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND so.id IS NULL THEN 'dangling_order_fk' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND so.status IN ('failed','refunded') THEN 'order_status_invalid' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND so.profit IS NOT NULL AND ABS(c.amount - so.profit) > 0.01 THEN 'amount_mismatch' END,
        CASE WHEN c.order_dupe_count > 1 THEN 'duplicate_for_order' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND COALESCE(so.source,'website') <> 'ussd' AND so.paystack_reference IS NULL THEN 'order_unpaid' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND COALESCE(so.source,'') = 'ussd'
                  AND so.package_id IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.shop_order_id = c.shop_order_id AND o.payment_status = 'paid')
             THEN 'ussd_no_paid_order' END,
        CASE WHEN c.shop_order_id IS NULL AND c.ussd_ref IS NOT NULL THEN 'source_uncross_checked' END
    ], NULL) AS risk_reasons
FROM credits c
JOIN public.shop_wallets   w  ON w.id = c.shop_wallet_id
LEFT JOIN public.shop_profiles sp ON sp.owner_id = w.owner_id
LEFT JOIN public.users      u  ON u.id = w.owner_id
LEFT JOIN public.shop_orders so ON so.id = c.shop_order_id;

REVOKE ALL ON public.v_shop_profit_credit_reconciliation FROM PUBLIC;
REVOKE ALL ON public.v_shop_profit_credit_reconciliation FROM anon, authenticated;
GRANT SELECT ON public.v_shop_profit_credit_reconciliation TO service_role;

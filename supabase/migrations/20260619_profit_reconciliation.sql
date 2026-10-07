-- supabase/migrations/20260619_profit_reconciliation.sql
-- Server-computed red/green/amber classification of every profit credit.
-- GREEN  = backed by a paid, verified shop_orders row with matching profit & owner.
-- AMBER  = known but un-cross-checkable source (USSD/RC) OR soft anomaly.
-- RED    = orphan (no order link at all), amount mismatch, or unpaid/invalid order.
--
-- NOTE: This VIEW references c.ussd_ref (column 'ussd_ref' on shop_wallet_transactions).
-- Before applying, confirm the column exists:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name='shop_wallet_transactions' AND column_name='ussd_ref';
-- Also confirm shop_orders has: profit, paystack_reference, status, network,
-- package_size, guest_phone, shop_id:
--   SELECT column_name FROM information_schema.columns WHERE table_name='shop_orders'
--   AND column_name IN ('profit','paystack_reference','status','network','package_size','guest_phone','shop_id');
-- If ussd_ref does not exist, replace every c.ussd_ref reference with the real column
-- name, or drop those branches and treat shop_order_id IS NULL uniformly as red/orphan.
-- Do NOT invent a column name.
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
    so.paystack_reference AS order_ref,
    so.status          AS order_status,
    so.network,
    so.package_size,
    so.guest_phone,
    COALESCE(c.credit_source,
        CASE WHEN c.shop_order_id IS NOT NULL THEN 'order'
             WHEN c.ussd_ref IS NOT NULL THEN 'ussd'
             ELSE 'unknown' END) AS credit_source,
    -- risk_status
    CASE
        WHEN c.shop_order_id IS NULL AND c.ussd_ref IS NULL THEN 'red'      -- true orphan
        WHEN c.shop_order_id IS NOT NULL AND so.id IS NULL THEN 'red'       -- dangling FK
        WHEN c.shop_order_id IS NOT NULL AND so.status IN ('failed','refunded') THEN 'red'
        WHEN c.shop_order_id IS NOT NULL AND so.paystack_reference IS NULL THEN 'red'
        WHEN c.shop_order_id IS NOT NULL AND so.profit IS NOT NULL
             AND ABS(c.amount - so.profit) > 0.01 THEN 'red'                -- amount mismatch
        WHEN c.order_dupe_count > 1 THEN 'red'                              -- duplicate credit
        WHEN c.shop_order_id IS NULL AND c.ussd_ref IS NOT NULL THEN 'amber'-- known but uncross-checked
        WHEN c.shop_order_id IS NOT NULL AND so.status = 'pending' THEN 'amber'
        ELSE 'green'
    END AS risk_status,
    -- risk_reasons (array, only the failing rules)
    ARRAY_REMOVE(ARRAY[
        CASE WHEN c.shop_order_id IS NULL AND c.ussd_ref IS NULL THEN 'orphan_no_order' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND so.id IS NULL THEN 'dangling_order_fk' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND so.status IN ('failed','refunded') THEN 'order_status_invalid' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND so.paystack_reference IS NULL THEN 'order_unpaid' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND so.profit IS NOT NULL AND ABS(c.amount - so.profit) > 0.01 THEN 'amount_mismatch' END,
        CASE WHEN c.order_dupe_count > 1 THEN 'duplicate_for_order' END,
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

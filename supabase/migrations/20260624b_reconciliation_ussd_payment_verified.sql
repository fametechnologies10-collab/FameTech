-- supabase/migrations/20260624b_reconciliation_ussd_payment_verified.sql
-- =============================================================================
-- Make USSD reconciliation actually VERIFY payment instead of guessing from the
-- fulfillment status. USSD data orders are created post-payment in
-- lib/ussd/fulfillment/data.ts, which writes a linked public.orders row with
-- payment_status='paid'. So:
--   * USSD credit WITH a paid linked order  -> GREEN (real, paid sale; delivery
--     status is irrelevant to fraud).
--   * USSD credit WITHOUT a paid linked order -> RED 'ussd_no_paid_order'
--     (this is what a forged Hubtel callback / credit-without-payment would look
--     like — the exact attack we want to catch).
-- Also: a website order that is paid (has paystack_reference) but still 'pending'
-- is GREEN (paid; awaiting completion is not a fraud signal). The only remaining
-- amber is a credit whose sole link is a ussd_ref with no shop_order at all.
-- Removes the misleading 'ussd_payment_unconfirmed' / 'order_pending' amber flags.
-- =============================================================================

-- Keep the EXISTS(orders) check fast.
CREATE INDEX IF NOT EXISTS idx_orders_shop_order_id
    ON public.orders (shop_order_id) WHERE shop_order_id IS NOT NULL;

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
    -- A USSD credit is GREEN only if a PAID linked order exists (orders.payment_status='paid',
    -- written post-payment by lib/ussd/fulfillment/data.ts); otherwise RED (forged callback / bug).
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
             AND NOT EXISTS (SELECT 1 FROM public.orders o
                             WHERE o.shop_order_id = c.shop_order_id AND o.payment_status = 'paid')
             THEN 'red'                                                                      -- USSD credit, NO paid order
        WHEN c.shop_order_id IS NULL AND c.ussd_ref IS NOT NULL THEN 'amber'                 -- credit w/ only ussd_ref, no order
        ELSE 'green'                                                                         -- paid + backed (website ref, or USSD paid)
    END AS risk_status,
    ARRAY_REMOVE(ARRAY[
        CASE WHEN c.shop_order_id IS NULL AND c.ussd_ref IS NULL THEN 'orphan_no_order' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND so.id IS NULL THEN 'dangling_order_fk' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND so.status IN ('failed','refunded') THEN 'order_status_invalid' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND so.profit IS NOT NULL AND ABS(c.amount - so.profit) > 0.01 THEN 'amount_mismatch' END,
        CASE WHEN c.order_dupe_count > 1 THEN 'duplicate_for_order' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND COALESCE(so.source,'website') <> 'ussd' AND so.paystack_reference IS NULL THEN 'order_unpaid' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND COALESCE(so.source,'') = 'ussd'
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

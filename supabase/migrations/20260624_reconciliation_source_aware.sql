-- supabase/migrations/20260624_reconciliation_source_aware.sql
-- =============================================================================
-- FIX: source-aware red/green classification.
-- The previous VIEW flagged EVERY order with paystack_reference IS NULL as red
-- ('order_unpaid'). But USSD orders (source='ussd') are paid via the USSD/wallet
-- rail and NEVER carry a paystack_reference — so all 205 USSD credits were RED
-- false positives (verified 2026-06-24: all real orders, profit=sell-cost,
-- credit=order.profit). Only 'website'/Paystack orders are expected to have a ref.
--
-- New rules:
--   * order_unpaid (RED) applies ONLY to non-ussd (website/Paystack) orders.
--   * USSD order pending          -> amber (ussd_payment_unconfirmed)
--   * USSD order completed/proc.  -> green (real sale, profit reconciled)
--   * website order pending       -> amber (order_pending)
-- All other RED rules (orphan, dangling FK, failed/refunded order, amount
-- mismatch, duplicate) are unchanged. risk_reasons now also carries amber reasons.
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
    so.paystack_reference AS order_ref,
    so.status          AS order_status,
    so.network,
    so.package_size,
    so.guest_phone,
    COALESCE(c.credit_source,
        CASE WHEN c.shop_order_id IS NOT NULL THEN COALESCE(so.source,'order')
             WHEN c.ussd_ref IS NOT NULL THEN 'ussd'
             ELSE 'unknown' END) AS credit_source,
    CASE
        WHEN c.shop_order_id IS NULL AND c.ussd_ref IS NULL THEN 'red'                          -- true orphan
        WHEN c.shop_order_id IS NOT NULL AND so.id IS NULL THEN 'red'                           -- dangling FK
        WHEN c.shop_order_id IS NOT NULL AND so.status IN ('failed','refunded') THEN 'red'      -- profit on a dead order
        WHEN c.shop_order_id IS NOT NULL AND so.profit IS NOT NULL
             AND ABS(c.amount - so.profit) > 0.01 THEN 'red'                                    -- amount mismatch
        WHEN c.order_dupe_count > 1 THEN 'red'                                                  -- duplicate credit
        WHEN c.shop_order_id IS NOT NULL AND so.paystack_reference IS NULL
             AND COALESCE(so.source,'website') <> 'ussd' THEN 'red'                             -- website order w/o payment ref
        WHEN c.shop_order_id IS NOT NULL AND COALESCE(so.source,'') = 'ussd'
             AND so.status = 'pending' THEN 'amber'                                             -- ussd payment unconfirmed
        WHEN c.shop_order_id IS NOT NULL AND so.status = 'pending' THEN 'amber'                 -- website order pending
        WHEN c.shop_order_id IS NULL AND c.ussd_ref IS NOT NULL THEN 'amber'                    -- credit w/ only ussd_ref
        ELSE 'green'
    END AS risk_status,
    ARRAY_REMOVE(ARRAY[
        CASE WHEN c.shop_order_id IS NULL AND c.ussd_ref IS NULL THEN 'orphan_no_order' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND so.id IS NULL THEN 'dangling_order_fk' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND so.status IN ('failed','refunded') THEN 'order_status_invalid' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND so.profit IS NOT NULL AND ABS(c.amount - so.profit) > 0.01 THEN 'amount_mismatch' END,
        CASE WHEN c.order_dupe_count > 1 THEN 'duplicate_for_order' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND so.paystack_reference IS NULL AND COALESCE(so.source,'website') <> 'ussd' THEN 'order_unpaid' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND COALESCE(so.source,'') = 'ussd' AND so.status = 'pending' THEN 'ussd_payment_unconfirmed' END,
        CASE WHEN c.shop_order_id IS NOT NULL AND COALESCE(so.source,'') <> 'ussd' AND so.status = 'pending' THEN 'order_pending' END,
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

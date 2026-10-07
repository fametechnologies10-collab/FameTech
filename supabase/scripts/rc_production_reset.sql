-- ═══════════════════════════════════════════════════════════
-- RC PRODUCTION RESET — run ONCE before go-live
-- ═══════════════════════════════════════════════════════════
-- PURPOSE: Wipe ALL Results Checker TEST data (orders, vouchers/PINs,
--          complaints, test profit logs) and REVERSE test shop-owner
--          credits, leaving a clean slate for production. Superset of
--          rc_reset_test_data.sql (adds profit-log clear + credit reversal).
--
-- USAGE:   Run ONCE manually in the Supabase SQL Editor. Permanent delete.
--          Wrapped in a transaction — review the pre/post counts; if the
--          post-counts look wrong, ROLLBACK instead of COMMIT.
--
-- PRESERVED (NOT touched):
--   ✓ results_checker_types          (your exam types)
--   ✓ shop_rc_markups                (shop owners' configured pricing)
--   ✓ admin_settings                 (enable flags, pricing, markup caps, backorder)
--   ✓ user wallets / accounts        (only the RC test SHOP credit is reversed)
-- ═══════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Pre-check: what will be removed ────────────────────
SELECT 'orders'            AS item, COUNT(*)::text AS n FROM results_checker_orders
UNION ALL SELECT 'inventory(PINs)', COUNT(*)::text FROM results_checker_inventory
UNION ALL SELECT 'complaints',      COUNT(*)::text FROM results_checker_complaints
UNION ALL SELECT 'rc_profit_logs',  COUNT(*)::text FROM admin_profit_logs WHERE transaction_type = 'results_checker'
UNION ALL SELECT 'rc_shop_credits', COUNT(*)::text FROM shop_wallet_transactions WHERE ussd_ref LIKE 'RC-SHOP-CREDIT-%'
UNION ALL SELECT 'rc_shop_credit_sum', COALESCE(SUM(amount),0)::text FROM shop_wallet_transactions WHERE ussd_ref LIKE 'RC-SHOP-CREDIT-%';

-- ── 2. Reverse test shop-owner RC credits ─────────────────
-- The new storefront credit flow (credit_shop_ussd_profit) added markup to shop
-- wallets during testing. Subtract it back so no phantom test money remains.
UPDATE shop_wallets sw
SET balance      = sw.balance - t.amt,
    total_earned = GREATEST(0, sw.total_earned - t.amt),
    updated_at   = NOW()
FROM (
    SELECT shop_wallet_id, SUM(amount) AS amt
    FROM shop_wallet_transactions
    WHERE ussd_ref LIKE 'RC-SHOP-CREDIT-%'
    GROUP BY shop_wallet_id
) t
WHERE sw.id = t.shop_wallet_id;

DELETE FROM shop_wallet_transactions WHERE ussd_ref LIKE 'RC-SHOP-CREDIT-%';

-- ── 3. Wipe test orders, vouchers (PINs/credentials), complaints ──
DELETE FROM results_checker_complaints;
DELETE FROM results_checker_orders;
DELETE FROM results_checker_inventory;

-- ── 4. Clear RC test profit-log entries (clean admin profit dashboard) ──
DELETE FROM admin_profit_logs WHERE transaction_type = 'results_checker';

-- ── 5. Post-check: orders/inventory/complaints/profit/credits = 0; types + markups preserved ──
SELECT 'orders'            AS item, COUNT(*)::text AS remaining FROM results_checker_orders
UNION ALL SELECT 'inventory(PINs)', COUNT(*)::text FROM results_checker_inventory
UNION ALL SELECT 'complaints',      COUNT(*)::text FROM results_checker_complaints
UNION ALL SELECT 'rc_profit_logs',  COUNT(*)::text FROM admin_profit_logs WHERE transaction_type = 'results_checker'
UNION ALL SELECT 'rc_shop_credits', COUNT(*)::text FROM shop_wallet_transactions WHERE ussd_ref LIKE 'RC-SHOP-CREDIT-%'
UNION ALL SELECT 'types_PRESERVED', COUNT(*)::text FROM results_checker_types
UNION ALL SELECT 'shop_markups_PRESERVED', COUNT(*)::text FROM shop_rc_markups;

-- Review the post-check above. If correct:
COMMIT;
-- If anything looks wrong instead run:  ROLLBACK;

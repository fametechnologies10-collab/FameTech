-- ============================================================
-- SCRIPT 3: Index Optimization
-- Part A: Drop duplicate index
-- Part B: Add missing foreign key indexes  
-- Part C: Drop confirmed unused indexes (NOT new tables)
-- ============================================================
-- ── Part A: Drop Duplicate Constraint Index ──────────────────
-- shop_pricing has two identical unique constraints — drop the redundant one
-- unique_shop_package is a CONSTRAINT (not a bare index), so we must DROP CONSTRAINT
ALTER TABLE public.shop_pricing DROP CONSTRAINT IF EXISTS unique_shop_package;
-- Keeping: shop_pricing_shop_id_package_id_key (the auto-named constraint index)
-- ── Part B: Add Missing Foreign Key Indexes ──────────────────
-- These speed up JOINs and lookups on these columns
CREATE INDEX IF NOT EXISTS idx_admin_custom_lists_created_by ON public.admin_custom_lists(created_by);
CREATE INDEX IF NOT EXISTS idx_afa_orders_user_id ON public.afa_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_afa_orders_transaction_id ON public.afa_orders(transaction_id);
CREATE INDEX IF NOT EXISTS idx_airtime_orders_fulfilled_by ON public.airtime_orders(fulfilled_by);
CREATE INDEX IF NOT EXISTS idx_airtime_orders_shop_id ON public.airtime_orders(shop_id);
CREATE INDEX IF NOT EXISTS idx_complaints_order_id ON public.complaints(order_id);
CREATE INDEX IF NOT EXISTS idx_fulfillment_logs_order_id ON public.fulfillment_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_mtn_fulfillment_tracking_order_id ON public.mtn_fulfillment_tracking(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_download_batch_id ON public.orders(download_batch_id);
CREATE INDEX IF NOT EXISTS idx_pending_settlements_wallet_transaction_id ON public.pending_settlements(wallet_transaction_id);
CREATE INDEX IF NOT EXISTS idx_rc_complaints_order_id ON public.results_checker_complaints(order_id);
CREATE INDEX IF NOT EXISTS idx_rc_complaints_user_id ON public.results_checker_complaints(user_id);
CREATE INDEX IF NOT EXISTS idx_rc_complaints_shop_id ON public.results_checker_complaints(shop_id);
CREATE INDEX IF NOT EXISTS idx_rc_inventory_sold_to_user_id ON public.results_checker_inventory(sold_to_user_id);
CREATE INDEX IF NOT EXISTS idx_rc_orders_type_id ON public.results_checker_orders(type_id);
CREATE INDEX IF NOT EXISTS idx_shop_announcements_shop_id ON public.shop_announcements(shop_id);
CREATE INDEX IF NOT EXISTS idx_shop_orders_package_id ON public.shop_orders(package_id);
CREATE INDEX IF NOT EXISTS idx_shop_payment_details_shop_owner_id ON public.shop_payment_details(shop_owner_id);
CREATE INDEX IF NOT EXISTS idx_shop_pricing_logs_package_id ON public.shop_pricing_logs(package_id);
CREATE INDEX IF NOT EXISTS idx_shop_pricing_logs_shop_id ON public.shop_pricing_logs(shop_id);
CREATE INDEX IF NOT EXISTS idx_shop_pricing_pending_package_id ON public.shop_pricing_pending(package_id);
CREATE INDEX IF NOT EXISTS idx_shop_profiles_approved_by ON public.shop_profiles(approved_by);
CREATE INDEX IF NOT EXISTS idx_shop_profiles_pricing_approved_by ON public.shop_profiles(pricing_approved_by);
CREATE INDEX IF NOT EXISTS idx_shop_wallet_txns_shop_order_id ON public.shop_wallet_transactions(shop_order_id);
CREATE INDEX IF NOT EXISTS idx_wallet_payments_user_id ON public.wallet_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_payments_wallet_id ON public.wallet_payments(wallet_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet_id ON public.wallet_transactions(wallet_id);
-- ── Part C: Drop Confirmed Unused Indexes ────────────────────
-- ⚠️ DO NOT drop idx_momo_transactions_status or idx_rc_orders_ref
-- Those are new tables from recent work — they will be used soon
DROP INDEX IF EXISTS public.idx_airtime_orders_status;
DROP INDEX IF EXISTS public.idx_airtime_orders_type;
DROP INDEX IF EXISTS public.idx_orders_shop_name;
DROP INDEX IF EXISTS public.idx_complaints_status;
DROP INDEX IF EXISTS public.idx_profit_logs_loss;
DROP INDEX IF EXISTS public.idx_profit_logs_created;
DROP INDEX IF EXISTS public.idx_aclu_list_id;
-- ── Verification Query ────────────────────────────────────────
-- Run this after Script 3 to confirm indexes were created
SELECT indexname,
    tablename
FROM pg_indexes
WHERE schemaname = 'public'
    AND indexname LIKE 'idx_%'
ORDER BY tablename,
    indexname;
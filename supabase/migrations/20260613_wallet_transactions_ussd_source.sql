-- ============================================================
-- USSD wallet payment support migrations
--
-- 1. Add 'ussd' to wallet_transactions source CHECK constraint
--    (source was 'payment' | 'refund' | 'admin' | 'purchase')
-- 2. Add payment_method column to results_checker_orders
-- 3. Add payment_method column to afa_orders
--    (orders table already has payment_method)
-- ============================================================

-- 1. wallet_transactions source constraint
ALTER TABLE public.wallet_transactions
    DROP CONSTRAINT IF EXISTS wallet_transactions_source_check;

ALTER TABLE public.wallet_transactions
    ADD CONSTRAINT wallet_transactions_source_check
    CHECK (source IN ('payment', 'refund', 'admin', 'purchase', 'ussd'));

-- 2. results_checker_orders: track how the order was paid
ALTER TABLE public.results_checker_orders
    ADD COLUMN IF NOT EXISTS payment_method text DEFAULT 'momo';

-- 3. afa_orders: track how the order was paid
ALTER TABLE public.afa_orders
    ADD COLUMN IF NOT EXISTS payment_method text DEFAULT 'momo';

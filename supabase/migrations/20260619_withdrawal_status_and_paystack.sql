-- supabase/migrations/20260619_withdrawal_status_and_paystack.sql
-- =============================================================================
-- Withdrawal state machine + Paystack MoMo payout rail + audit columns.
-- Adds failed/reversed/paystack_pending statuses (fixing CF-03 constraint drift),
-- Paystack transfer columns, processed_by actor attribution, and failure tracking.
-- =============================================================================

-- 1. New columns (idempotent)
ALTER TABLE public.shop_wallet_transactions
    ADD COLUMN IF NOT EXISTS payout_provider TEXT,
    ADD COLUMN IF NOT EXISTS paystack_recipient_code TEXT,
    ADD COLUMN IF NOT EXISTS paystack_transfer_code TEXT,
    ADD COLUMN IF NOT EXISTS paystack_transfer_reference TEXT,
    ADD COLUMN IF NOT EXISTS paystack_transfer_status TEXT,
    ADD COLUMN IF NOT EXISTS paystack_fee NUMERIC(12,2),
    ADD COLUMN IF NOT EXISTS processed_by UUID REFERENCES public.users(id),
    ADD COLUMN IF NOT EXISTS failure_reason TEXT,
    ADD COLUMN IF NOT EXISTS last_polled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS poll_attempts INTEGER NOT NULL DEFAULT 0;

-- 2. payout_provider domain (nullable until a payout is attempted)
ALTER TABLE public.shop_wallet_transactions
    DROP CONSTRAINT IF EXISTS shop_wallet_transactions_payout_provider_check;
ALTER TABLE public.shop_wallet_transactions
    ADD CONSTRAINT shop_wallet_transactions_payout_provider_check
    CHECK (payout_provider IS NULL OR payout_provider IN ('moolre','paystack','manual'));

-- 3. Rebuild the status CHECK to the full machine
DO $$
DECLARE v_constraint TEXT;
BEGIN
    SELECT conname INTO v_constraint
    FROM pg_constraint
    WHERE conrelid = 'public.shop_wallet_transactions'::regclass
      AND contype = 'c' AND conname LIKE '%status%' ORDER BY conname LIMIT 1;
    IF v_constraint IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.shop_wallet_transactions DROP CONSTRAINT %I', v_constraint);
    END IF;
END; $$;

ALTER TABLE public.shop_wallet_transactions
    ADD CONSTRAINT shop_wallet_transactions_status_check
    CHECK (status IN ('pending','moolre_pending','paystack_pending','completed','failed','reversed'));

-- 4. Idempotency + resolver-cron performance indexes
CREATE UNIQUE INDEX IF NOT EXISTS uq_shop_wallet_tx_paystack_ref
    ON public.shop_wallet_transactions (paystack_transfer_reference)
    WHERE paystack_transfer_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shop_wallet_tx_paystack_pending
    ON public.shop_wallet_transactions (status)
    WHERE status = 'paystack_pending';

-- 5. Backfill payout_provider for historical rows (display correctness)
UPDATE public.shop_wallet_transactions
SET payout_provider = CASE
    WHEN moolre_transaction_id IS NOT NULL OR status = 'moolre_pending' THEN 'moolre'
    WHEN type = 'withdrawal' AND status = 'completed' THEN 'manual'
    ELSE payout_provider
END
WHERE type = 'withdrawal' AND payout_provider IS NULL;

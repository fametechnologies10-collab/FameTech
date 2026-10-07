-- supabase/migrations/20260619_profit_credit_attribution.sql
-- Adds attribution columns for the red/green accountability model and locks down
-- the profit-credit RPC so credits can only originate from trusted server code.
ALTER TABLE public.shop_wallet_transactions
    ADD COLUMN IF NOT EXISTS created_by UUID,
    ADD COLUMN IF NOT EXISTS credit_source TEXT;

-- Backfill a best-effort source for existing profit credits (display only):
-- NOTE: The WHEN ussd_ref IS NOT NULL branch assumes a column named 'ussd_ref'
-- exists on shop_wallet_transactions. Before applying, verify with:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name='shop_wallet_transactions' AND column_name='ussd_ref';
-- If the column does not exist, replace 'ussd_ref' with the actual USSD reference
-- column name found in that table, or drop the branch and leave those rows as 'unknown'.
-- Do NOT invent a column name.
UPDATE public.shop_wallet_transactions
SET credit_source = CASE
    WHEN shop_order_id IS NOT NULL THEN 'order'
    WHEN ussd_ref IS NOT NULL THEN 'ussd'
    ELSE 'unknown'
END
WHERE type = 'profit' AND credit_source IS NULL;

-- Lock EXECUTE on the profit-credit RPC to service_role only.
REVOKE ALL ON FUNCTION public.credit_shop_profit(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.credit_shop_profit(UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_shop_profit(UUID) TO service_role;

CREATE INDEX IF NOT EXISTS idx_shop_wallet_tx_profit_type
    ON public.shop_wallet_transactions (type) WHERE type = 'profit';

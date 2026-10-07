-- supabase/migrations/20260907d_commission_wallet_sub_agent_extension.sql
-- =============================================================================
-- Extends the existing commission wallet (built for Hubtel utility payouts) to
-- accept sub-agent margin as a second credit source (spec §5.3, C5).
--
-- utility_order_id is UNTOUCHED — it stays the utility path's own FK + partial
-- unique index. order_reference is new and generic, mirroring that same
-- idempotency pattern for the sub-agent path.
--
-- amount stays STRICTLY POSITIVE on every row (existing CHECK, unchanged) —
-- matching the established shop_wallet_transactions convention where
-- 'profit'/'profit_reversal' both store positive amounts. The +/- a recruiter
-- sees in the UI is rendered from `type`, never stored as a signed number.
--
-- Pre-flight verified live on project ubvjtacdmwynqcxuposj (2026-09-07):
--   - commission_wallet_transactions_type_check exists exactly as assumed,
--     currently CHECK (type = ANY (ARRAY['commission', 'transfer_out_main',
--     'transfer_out_shop', 'withdrawal', 'withdrawal_reversal'])).
--   - order_reference does not already exist on this table under any name.
-- =============================================================================

ALTER TABLE public.commission_wallet_transactions
  ADD COLUMN IF NOT EXISTS order_reference TEXT;

-- order_table is nullable, matching order_reference's own nullability: existing
-- utility-path rows will never populate either column.
ALTER TABLE public.commission_wallet_transactions
  ADD COLUMN IF NOT EXISTS order_table TEXT;

-- Composite on (order_table, order_reference), not order_reference alone —
-- mirrors sub_agent_order_earnings' UNIQUE(order_table, order_reference)
-- (20260907c), because order_reference values are only guaranteed unique
-- within a single order table, not across orders/afa_orders/
-- results_checker_orders/shop_orders.
CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_wallet_tx_sub_agent_credit
  ON public.commission_wallet_transactions(order_table, order_reference)
  WHERE type = 'sub_agent_margin';

CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_wallet_tx_sub_agent_reversal
  ON public.commission_wallet_transactions(order_table, order_reference)
  WHERE type = 'sub_agent_margin_reversal';

-- Constraint name confirmed live at Step 1 (2026-09-07): commission_wallet_transactions_type_check.
ALTER TABLE public.commission_wallet_transactions
  DROP CONSTRAINT IF EXISTS commission_wallet_transactions_type_check;
ALTER TABLE public.commission_wallet_transactions
  ADD CONSTRAINT commission_wallet_transactions_type_check
  CHECK (type = ANY (ARRAY[
    'commission', 'transfer_out_main', 'transfer_out_shop',
    'withdrawal', 'withdrawal_reversal',
    'sub_agent_margin', 'sub_agent_margin_reversal'
  ]));

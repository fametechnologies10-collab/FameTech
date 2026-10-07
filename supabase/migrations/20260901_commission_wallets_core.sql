-- ============================================================================
-- 20260901_commission_wallets_core.sql
-- Commission Wallet — Task A1: schema only. No RPCs yet (Task 2), no data
-- migration (verified zero historical rows exist for source='api' utility
-- commission as of 2026-09-01). RLS is read-only-by-owner; every write goes
-- through SECURITY DEFINER RPCs added in the next migration.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.commission_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  balance numeric NOT NULL DEFAULT 0,
  total_earned numeric NOT NULL DEFAULT 0,
  total_withdrawn numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.commission_wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_wallet_id uuid NOT NULL REFERENCES public.commission_wallets(id) ON DELETE CASCADE,
  utility_order_id uuid REFERENCES public.utility_orders(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('commission', 'transfer_out_main', 'transfer_out_shop', 'withdrawal', 'withdrawal_reversal')),
  amount numeric NOT NULL CHECK (amount > 0),
  description text,
  status text NOT NULL DEFAULT 'completed',
  momo_number text,
  network text,
  account_name text,
  name_verified boolean,
  payout_provider text,
  paystack_transfer_reference text,
  paystack_transfer_code text,
  paystack_transfer_status text,
  paystack_recipient_code text,
  paystack_fee numeric,
  poll_attempts integer NOT NULL DEFAULT 0,
  last_polled_at timestamptz,
  failure_reason text,
  admin_note text,
  processed_by uuid REFERENCES public.users(id),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_commission_wallet_tx_wallet_id ON public.commission_wallet_transactions(commission_wallet_id);
CREATE INDEX IF NOT EXISTS idx_commission_wallet_tx_status ON public.commission_wallet_transactions(status) WHERE status IN ('pending', 'paystack_pending');
CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_wallet_tx_order_credit
  ON public.commission_wallet_transactions(utility_order_id) WHERE type = 'commission';

ALTER TABLE public.commission_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commission_wallet_transactions ENABLE ROW LEVEL SECURITY;

-- DROP IF EXISTS before each CREATE POLICY so this file is re-runnable against
-- a fresh database (the policies already exist live — this file is NOT re-applied
-- to the live project, purely so a fresh DB can replay migration history).
DROP POLICY IF EXISTS commission_wallets_owner_select ON public.commission_wallets;
CREATE POLICY commission_wallets_owner_select ON public.commission_wallets
  FOR SELECT USING (auth.uid() = owner_id);

DROP POLICY IF EXISTS commission_wallet_tx_owner_select ON public.commission_wallet_transactions;
CREATE POLICY commission_wallet_tx_owner_select ON public.commission_wallet_transactions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.commission_wallets w
      WHERE w.id = commission_wallet_transactions.commission_wallet_id
        AND w.owner_id = auth.uid()
    )
  );

-- Admins/sub-admins can read everything (needed for the admin tab).
DROP POLICY IF EXISTS commission_wallets_admin_select ON public.commission_wallets;
CREATE POLICY commission_wallets_admin_select ON public.commission_wallets
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('admin', 'sub-admin'))
  );

DROP POLICY IF EXISTS commission_wallet_tx_admin_select ON public.commission_wallet_transactions;
CREATE POLICY commission_wallet_tx_admin_select ON public.commission_wallet_transactions
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('admin', 'sub-admin'))
  );

-- New allowed shop_wallet_transactions type for money moved IN from a
-- commission-wallet transfer (Task 3's transfer_commission_wallet RPC writes
-- this). Additive only — every existing allowed value stays.
ALTER TABLE public.shop_wallet_transactions DROP CONSTRAINT IF EXISTS shop_wallet_transactions_type_check;
ALTER TABLE public.shop_wallet_transactions ADD CONSTRAINT shop_wallet_transactions_type_check
  CHECK (type IN ('profit', 'withdrawal', 'profit_reversal', 'utility_commission', 'commission_transfer_in'));

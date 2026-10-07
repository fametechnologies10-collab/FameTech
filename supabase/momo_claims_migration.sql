-- ============================================================
-- MoMo Transaction ID Claim System — Database Migration
-- Run this in Supabase SQL Editor BEFORE deploying the code
-- ============================================================

-- ── 1. momo_transactions table ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.momo_transactions (
    id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    transaction_id  TEXT NOT NULL UNIQUE,
    amount          NUMERIC(12, 2) NOT NULL,
    sender_name     TEXT NOT NULL,
    sender_network  TEXT NOT NULL CHECK (sender_network IN ('MTN', 'Telecel', 'AirtelTigo', 'Unknown')),
    raw_sms         TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'claimed', 'voided', 'flagged')),
    claimed_by      UUID REFERENCES public.users(id) ON DELETE SET NULL,
    claimed_at      TIMESTAMP WITH TIME ZONE,
    claim_fee_percent NUMERIC(5, 2) DEFAULT 0,
    claim_fee_amount  NUMERIC(12, 2) DEFAULT 0,
    net_amount        NUMERIC(12, 2),
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_momo_transactions_transaction_id ON public.momo_transactions(transaction_id);
CREATE INDEX IF NOT EXISTS idx_momo_transactions_status ON public.momo_transactions(status);
CREATE INDEX IF NOT EXISTS idx_momo_transactions_claimed_by ON public.momo_transactions(claimed_by);
CREATE INDEX IF NOT EXISTS idx_momo_transactions_created_at ON public.momo_transactions(created_at DESC);

-- ── 2. momo_claim_attempts table (rate limiting + audit) ─────
CREATE TABLE IF NOT EXISTS public.momo_claim_attempts (
    id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id             UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
    transaction_id_input TEXT NOT NULL,
    result              TEXT NOT NULL CHECK (result IN ('found', 'not_found', 'already_claimed', 'rate_limited', 'below_minimum', 'flagged', 'invalid_format')),
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_momo_claim_attempts_user_id ON public.momo_claim_attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_momo_claim_attempts_created_at ON public.momo_claim_attempts(created_at DESC);

-- ── 3. Row Level Security ─────────────────────────────────────
ALTER TABLE public.momo_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.momo_claim_attempts ENABLE ROW LEVEL SECURITY;

-- Admins can see everything; users can only see their own claims
DROP POLICY IF EXISTS "Admin full access to momo_transactions" ON public.momo_transactions;
CREATE POLICY "Admin full access to momo_transactions"
    ON public.momo_transactions FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE users.id = auth.uid()
            AND users.role IN ('admin', 'sub-admin')
        )
    );

DROP POLICY IF EXISTS "Users can view their own claimed transactions" ON public.momo_transactions;
CREATE POLICY "Users can view their own claimed transactions"
    ON public.momo_transactions FOR SELECT
    USING (claimed_by = auth.uid());

DROP POLICY IF EXISTS "Admin full access to momo_claim_attempts" ON public.momo_claim_attempts;
CREATE POLICY "Admin full access to momo_claim_attempts"
    ON public.momo_claim_attempts FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE users.id = auth.uid()
            AND users.role IN ('admin', 'sub-admin')
        )
    );

DROP POLICY IF EXISTS "Users can view their own claim attempts" ON public.momo_claim_attempts;
CREATE POLICY "Users can view their own claim attempts"
    ON public.momo_claim_attempts FOR SELECT
    USING (user_id = auth.uid());

-- ── 4. Atomic Claim RPC ───────────────────────────────────────
-- This function is called server-side (SECURITY DEFINER bypasses RLS).
-- It receives ONLY the transaction_id and user_id — never an amount.
-- All monetary logic happens inside this function.
CREATE OR REPLACE FUNCTION public.claim_momo_transaction(
    p_transaction_id TEXT,
    p_user_id        UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_txn              RECORD;
    v_wallet           RECORD;
    v_fee_key          TEXT;
    v_fee_setting      RECORD;
    v_min_claimable    NUMERIC;
    v_fee_percent      NUMERIC;
    v_fee_amount       NUMERIC;
    v_net_amount       NUMERIC;
    v_new_balance      NUMERIC;
    v_user_role        TEXT;
BEGIN
    -- 1. Get user role
    SELECT role INTO v_user_role
    FROM public.users
    WHERE id = p_user_id;

    -- 2. Lock the transaction row (prevents concurrent claims)
    SELECT * INTO v_txn
    FROM public.momo_transactions
    WHERE transaction_id = p_transaction_id
    FOR UPDATE;

    -- 3. Validate it exists and is pending
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Transaction not found');
    END IF;

    IF v_txn.status = 'claimed' THEN
        RETURN jsonb_build_object('success', false, 'error', 'already_claimed',
            'claimed_at', v_txn.claimed_at,
            'is_own_claim', (v_txn.claimed_by = p_user_id));
    END IF;

    IF v_txn.status = 'voided' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Transaction has been voided by admin');
    END IF;

    IF v_txn.status = 'flagged' THEN
        RETURN jsonb_build_object('success', false, 'error', 'This transaction requires admin review. Please contact support.');
    END IF;

    -- 4. Get minimum claimable amount from settings
    SELECT NULLIF(value#>>'{}', '')::NUMERIC INTO v_min_claimable
    FROM public.admin_settings
    WHERE key = 'momo_min_claimable';
    v_min_claimable := COALESCE(v_min_claimable, 1);

    -- 5. Determine which fee key to use based on user role
    IF v_user_role = 'agent' THEN
        v_fee_key := 'momo_claim_fee_agent';
    ELSE
        v_fee_key := 'momo_claim_fee_customer';
    END IF;

    -- 6. Get fee percent from admin settings
    SELECT NULLIF(value#>>'{}', '')::NUMERIC INTO v_fee_percent
    FROM public.admin_settings
    WHERE key = v_fee_key;
    v_fee_percent := COALESCE(v_fee_percent, 0);

    -- 7. Compute fee and net amount entirely server-side
    v_fee_amount := ROUND((v_txn.amount * v_fee_percent / 100), 2);
    v_net_amount := v_txn.amount - v_fee_amount;

    -- 8. Enforce minimum claimable (belt-and-suspenders server check)
    IF v_net_amount < v_min_claimable THEN
        RETURN jsonb_build_object('success', false, 'error', 'below_minimum',
            'min_claimable', v_min_claimable,
            'net_amount', v_net_amount);
    END IF;

    -- 9. Get user's wallet (lock it too)
    SELECT * INTO v_wallet
    FROM public.wallets
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Wallet not found');
    END IF;

    -- 10. Update momo_transactions to claimed
    UPDATE public.momo_transactions
    SET status           = 'claimed',
        claimed_by       = p_user_id,
        claimed_at       = NOW(),
        claim_fee_percent = v_fee_percent,
        claim_fee_amount  = v_fee_amount,
        net_amount        = v_net_amount
    WHERE id = v_txn.id;

    -- 11. Credit the user's wallet
    v_new_balance := v_wallet.balance + v_net_amount;

    UPDATE public.wallets
    SET balance        = v_new_balance,
        total_credited = total_credited + v_net_amount,
        updated_at     = NOW()
    WHERE id = v_wallet.id;

    -- 12. Log a wallet transaction for history
    INSERT INTO public.wallet_transactions (
        wallet_id, user_id, type, amount,
        description, reference, source, status
    ) VALUES (
        v_wallet.id,
        p_user_id,
        'credit',
        v_net_amount,
        'MoMo Claim — ' || v_txn.sender_network || ' — TXN: ' || p_transaction_id,
        'MOMO-' || p_transaction_id,
        'payment',
        'completed'
    );

    -- 13. Return full breakdown for notification dispatch
    RETURN jsonb_build_object(
        'success',        true,
        'amount',         v_txn.amount,
        'sender_name',    v_txn.sender_name,
        'sender_network', v_txn.sender_network,
        'fee_percent',    v_fee_percent,
        'fee_amount',     v_fee_amount,
        'net_amount',     v_net_amount,
        'new_balance',    v_new_balance,
        'transaction_id', p_transaction_id
    );
END;
$$;

-- VULN-11 fix: Immediately restrict after creation — service_role only
REVOKE EXECUTE ON FUNCTION public.claim_momo_transaction(TEXT, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_momo_transaction(TEXT, UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.claim_momo_transaction(TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_momo_transaction(TEXT, UUID) TO service_role;

-- ── 5. Default Admin Settings ─────────────────────────────────
INSERT INTO public.admin_settings (key, value) VALUES
    ('momo_claim_enabled',       'true'),
    ('momo_account_name',        '"Felix Boahen"'),
    ('momo_payment_accounts',    '[{"network":"MTN","number":"0551617309"},{"network":"Telecel","number":"0507193592"}]'),
    ('momo_claim_fee_customer',  '0'),
    ('momo_claim_fee_agent',     '0'),
    ('momo_min_claimable',       '1'),
    ('momo_max_claimable',       '50000')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- MoMo Reference Auto-Claim System — Database Migration
-- Run this in Supabase SQL Editor AFTER the existing
-- momo_claims_migration.sql has already been applied.
-- ============================================================

-- ── 1. user_payment_references table ─────────────────────────
-- Stores each user's unique 5-character reference code.
-- One code per user (UNIQUE on user_id), uniqueness on the
-- code itself enforced by the UNIQUE constraint on reference_code.
CREATE TABLE IF NOT EXISTS public.user_payment_references (
    id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id         UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
    reference_code  TEXT NOT NULL UNIQUE,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Validate the reference_code is exactly 5 uppercase alphanumeric chars
ALTER TABLE public.user_payment_references
    ADD CONSTRAINT chk_reference_code_format
    CHECK (reference_code ~ '^[A-Z0-9]{5}$');

CREATE INDEX IF NOT EXISTS idx_upr_user_id        ON public.user_payment_references(user_id);
CREATE INDEX IF NOT EXISTS idx_upr_reference_code ON public.user_payment_references(reference_code);
CREATE INDEX IF NOT EXISTS idx_upr_is_active      ON public.user_payment_references(is_active);

-- ── 2. Extend momo_transactions table ────────────────────────
-- Track whether a claim was made automatically via reference
-- and which reference code triggered it.
ALTER TABLE public.momo_transactions
    ADD COLUMN IF NOT EXISTS is_auto_claimed  BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS claimed_via_ref  TEXT;

-- ── 3. Row Level Security for user_payment_references ────────
ALTER TABLE public.user_payment_references ENABLE ROW LEVEL SECURITY;

-- Admin full access
DROP POLICY IF EXISTS "Admin full access to user_payment_references" ON public.user_payment_references;
CREATE POLICY "Admin full access to user_payment_references"
    ON public.user_payment_references FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE users.id = auth.uid()
            AND users.role IN ('admin', 'sub-admin')
        )
    );

-- Users can view and insert their own reference only
DROP POLICY IF EXISTS "Users can view own payment reference" ON public.user_payment_references;
CREATE POLICY "Users can view own payment reference"
    ON public.user_payment_references FOR SELECT
    USING (user_id = auth.uid());

-- Users can insert their own reference (checked server-side for uniqueness)
DROP POLICY IF EXISTS "Users can insert own payment reference" ON public.user_payment_references;
CREATE POLICY "Users can insert own payment reference"
    ON public.user_payment_references FOR INSERT
    WITH CHECK (user_id = auth.uid());

-- ── 4. Updated atomic claim RPC ──────────────────────────────
-- Drop the old 2-parameter version first so the new one can take over.
-- The new version adds two optional parameters:
--   p_is_auto   : true when called by the SMS webhook auto-claim path
--   p_ref_code  : the 5-char reference that triggered the auto-claim
DROP FUNCTION IF EXISTS public.claim_momo_transaction(TEXT, UUID);

CREATE OR REPLACE FUNCTION public.claim_momo_transaction(
    p_transaction_id TEXT,
    p_user_id        UUID,
    p_is_auto        BOOLEAN  DEFAULT false,
    p_ref_code       TEXT     DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_txn              RECORD;
    v_wallet           RECORD;
    v_fee_key          TEXT;
    v_min_claimable    NUMERIC;
    v_fee_percent      NUMERIC;
    v_fee_amount       NUMERIC;
    v_net_amount       NUMERIC;
    v_new_balance      NUMERIC;
    v_user_role        TEXT;
    v_description      TEXT;
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
            'is_own_claim', (v_txn.claimed_by = p_user_id),
            'is_auto_claimed', v_txn.is_auto_claimed,
            'claimed_via_ref', v_txn.claimed_via_ref);
    END IF;

    IF v_txn.status = 'voided' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Transaction has been voided by admin');
    END IF;

    IF v_txn.status = 'flagged' THEN
        RETURN jsonb_build_object('success', false, 'error', 'This transaction requires admin review. Please contact support.');
    END IF;

    -- 4. Get minimum claimable amount from settings (handle JSONB safely)
    SELECT NULLIF(value#>>ARRAY[]::TEXT[], '')::NUMERIC INTO v_min_claimable
    FROM public.admin_settings
    WHERE key = 'momo_min_claimable';
    v_min_claimable := COALESCE(v_min_claimable, 1);

    -- 5. Determine which fee key to use based on user role
    IF v_user_role = 'agent' THEN
        v_fee_key := 'momo_claim_fee_agent';
    ELSE
        v_fee_key := 'momo_claim_fee_customer';
    END IF;

    -- 6. Get fee percent from admin settings (handle JSONB safely)
    SELECT NULLIF(value#>>ARRAY[]::TEXT[], '')::NUMERIC INTO v_fee_percent
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

    -- 10. Build the description based on how it was claimed
    IF p_is_auto AND p_ref_code IS NOT NULL THEN
        v_description := 'Auto-Claim via Ref ' || p_ref_code || ' — ' || v_txn.sender_network || ' — TXN: ' || p_transaction_id;
    ELSE
        v_description := 'MoMo Claim — ' || v_txn.sender_network || ' — TXN: ' || p_transaction_id;
    END IF;

    -- 11. Update momo_transactions to claimed (with auto-claim metadata)
    UPDATE public.momo_transactions
    SET status            = 'claimed',
        claimed_by        = p_user_id,
        claimed_at        = NOW(),
        claim_fee_percent = v_fee_percent,
        claim_fee_amount  = v_fee_amount,
        net_amount        = v_net_amount,
        is_auto_claimed   = p_is_auto,
        claimed_via_ref   = p_ref_code
    WHERE id = v_txn.id;

    -- 12. Credit the user's wallet
    v_new_balance := v_wallet.balance + v_net_amount;

    UPDATE public.wallets
    SET balance        = v_new_balance,
        total_credited = total_credited + v_net_amount,
        updated_at     = NOW()
    WHERE id = v_wallet.id;

    -- 13. Log a wallet transaction for history
    INSERT INTO public.wallet_transactions (
        wallet_id, user_id, type, amount,
        description, reference, source, status
    ) VALUES (
        v_wallet.id,
        p_user_id,
        'credit',
        v_net_amount,
        v_description,
        'MOMO-' || p_transaction_id,
        'payment',
        'completed'
    );

    -- 14. Return full breakdown for notification dispatch
    RETURN jsonb_build_object(
        'success',        true,
        'amount',         v_txn.amount,
        'sender_name',    v_txn.sender_name,
        'sender_network', v_txn.sender_network,
        'fee_percent',    v_fee_percent,
        'fee_amount',     v_fee_amount,
        'net_amount',     v_net_amount,
        'new_balance',    v_new_balance,
        'transaction_id', p_transaction_id,
        'is_auto_claimed', p_is_auto,
        'claimed_via_ref', p_ref_code
    );
END;
$$;

-- Immediately restrict after creation — service_role only
REVOKE EXECUTE ON FUNCTION public.claim_momo_transaction(TEXT, UUID, BOOLEAN, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_momo_transaction(TEXT, UUID, BOOLEAN, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.claim_momo_transaction(TEXT, UUID, BOOLEAN, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_momo_transaction(TEXT, UUID, BOOLEAN, TEXT) TO service_role;

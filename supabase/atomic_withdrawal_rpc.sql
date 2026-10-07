-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: atomic_withdrawal_rpc.sql
-- Purpose:   Solves the TOCTOU (Time-of-Check to Time-of-Use) race condition
--            by moving the balance verification, deduction, and transaction
--            insertion into a single atomic PostgreSQL transaction.
--
-- Security hardening (audit v2):
--   - Ownership check via auth.uid() prevents horizontal privilege escalation
--   - Fixed search_path prevents schema injection on SECURITY DEFINER functions
--   - GRANT EXECUTE to authenticated role is required for RPC to work at all
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION process_shop_withdrawal(
    p_wallet_id UUID,
    p_amount NUMERIC,
    p_fee NUMERIC,
    p_net_amount NUMERIC,
    p_account_name TEXT,
    p_momo_number TEXT,
    p_account_number TEXT,
    p_network TEXT,
    p_payment_type TEXT,
    p_bank_id TEXT,
    p_bank_name TEXT,
    p_branch TEXT,
    p_description TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
-- SECURITY DEFINER lets the function bypass RLS to do the locked SELECT and UPDATE
-- atomically. The caller ownership is verified explicitly inside the function body.
SECURITY DEFINER
-- FIX (CRITICAL-2): Lock search_path to prevent schema injection attacks.
-- Without this, a malicious schema could shadow public.shop_wallets.
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_wallet_owner_id UUID;
    v_current_balance NUMERIC;
    v_new_balance NUMERIC;
    v_tx_id UUID;
BEGIN
    -- 0. CRITICAL SECURITY FIX: Prevent negative amounts from adding funds
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Withdrawal amount must be greater than zero';
    END IF;

    -- 1. Read the wallet AND its owner atomically while locking
    -- the row. This prevents both race conditions and ownership bypass.
    SELECT owner_id, balance INTO v_wallet_owner_id, v_current_balance
    FROM shop_wallets
    WHERE id = p_wallet_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Wallet not found';
    END IF;

    -- Verify that the authenticated caller actually owns this wallet.
    -- auth.uid() is available inside SECURITY DEFINER functions in Supabase.
    -- This prevents any authenticated user from draining another user's wallet
    -- by calling the RPC directly with an arbitrary p_wallet_id.
    IF auth.uid() IS NULL OR auth.uid() != v_wallet_owner_id THEN
        RAISE EXCEPTION 'Unauthorized: caller does not own this wallet';
    END IF;

    -- Verify sufficient funds AT THE EXACT MOMENT OF EXECUTION (after row lock)
    IF v_current_balance < p_amount THEN
        RAISE EXCEPTION 'Insufficient shop wallet balance';
    END IF;

    -- Calculate new balance
    v_new_balance := v_current_balance - p_amount;

    -- Deduct balance atomically
    UPDATE shop_wallets
    SET
        balance = v_new_balance,
        total_withdrawn = COALESCE(total_withdrawn, 0) + p_amount,
        updated_at = NOW()
    WHERE id = p_wallet_id;

    -- Insert transaction record in the same transaction
    INSERT INTO shop_wallet_transactions (
        shop_wallet_id,
        type,
        amount,
        fee,
        net_amount,
        account_name,
        momo_number,
        account_number,
        network,
        payment_type,
        bank_id,
        bank_name,
        branch,
        description,
        status,
        balance_snapshot
    ) VALUES (
        p_wallet_id,
        'withdrawal',
        p_amount,
        p_fee,
        p_net_amount,
        p_account_name,
        p_momo_number,
        p_account_number,
        p_network,
        p_payment_type,
        p_bank_id,
        p_bank_name,
        p_branch,
        p_description,
        'pending',
        v_new_balance
    ) RETURNING id INTO v_tx_id;

    -- Return success payload
    RETURN jsonb_build_object(
        'success', true,
        'newBalance', v_new_balance,
        'transactionId', v_tx_id
    );
END;
$$;

-- FIX (CRITICAL-3): Grant EXECUTE to authenticated role.
-- Without this, Supabase PostgREST will return 42501 permission denied for
-- every RPC call from logged-in users, breaking all withdrawals in production.
GRANT EXECUTE ON FUNCTION process_shop_withdrawal TO authenticated;

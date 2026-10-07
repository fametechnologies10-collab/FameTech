-- supabase/migrations/20260616_sec005_withdrawal_fee_server_side.sql
-- =============================================================================
-- SEC-005: server-authoritative withdrawal fee inside process_shop_withdrawal
-- =============================================================================
-- The RPC previously trusted caller-supplied p_fee / p_net_amount. A user
-- calling the RPC directly via PostgREST could pass p_fee=0, p_net_amount=p_amount
-- to evade the platform withdrawal fee (the balance is still debited p_amount, but
-- the RECORDED net_amount — what gets paid out — was attacker-controlled).
--
-- Fix: recompute the fee inside the function from the SAME authoritative source
-- the route uses (per-shop override → role-specific global → legacy global →
-- hardcoded default), mirroring resolveWithdrawalFee() in
-- app/api/shop/withdraw/route.ts. We take GREATEST(caller_fee, computed_fee):
--   * legitimate calls already pass the correct fee → unchanged (prod-safe).
--   * evasion calls (fee too low / 0) → the computed fee is enforced.
-- Behaviour for the deployed app is therefore preserved; only under-fee tampering
-- is corrected. Ownership / row-lock / amount>0 checks are unchanged.
-- =============================================================================

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
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_wallet_owner_id UUID;
    v_current_balance NUMERIC;
    v_new_balance NUMERIC;
    v_tx_id UUID;
    v_owner_role TEXT;
    v_pct NUMERIC;
    v_flat NUMERIC;
    v_computed_fee NUMERIC;
    v_fee NUMERIC;
    v_net NUMERIC;
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Withdrawal amount must be greater than zero';
    END IF;

    -- Lock wallet row + read owner atomically
    SELECT owner_id, balance INTO v_wallet_owner_id, v_current_balance
    FROM shop_wallets
    WHERE id = p_wallet_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Wallet not found';
    END IF;

    -- Ownership (defense-in-depth; route also verifies)
    IF auth.uid() IS NULL OR auth.uid() != v_wallet_owner_id THEN
        RAISE EXCEPTION 'Unauthorized: caller does not own this wallet';
    END IF;

    IF v_current_balance < p_amount THEN
        RAISE EXCEPTION 'Insufficient shop wallet balance';
    END IF;

    -- ── SEC-005: recompute the authoritative fee ────────────────────────────
    SELECT role INTO v_owner_role FROM users WHERE id = v_wallet_owner_id;
    v_owner_role := COALESCE(v_owner_role, 'customer');

    -- per-shop override
    SELECT withdrawal_fee_percent, withdrawal_fee_flat INTO v_pct, v_flat
    FROM shop_profiles WHERE owner_id = v_wallet_owner_id;

    -- percent: per-shop → role global → legacy global → 2
    IF v_pct IS NULL THEN
        SELECT NULLIF(trim(both '"' from value::text), '')::numeric INTO v_pct
        FROM shop_global_settings WHERE key = 'withdrawal_fee_percent_' || v_owner_role;
    END IF;
    IF v_pct IS NULL THEN
        SELECT NULLIF(trim(both '"' from value::text), '')::numeric INTO v_pct
        FROM shop_global_settings WHERE key = 'withdrawal_fee_percent';
    END IF;
    IF v_pct IS NULL THEN v_pct := 2; END IF;

    -- flat: per-shop → role global → legacy global → 0
    IF v_flat IS NULL THEN
        SELECT NULLIF(trim(both '"' from value::text), '')::numeric INTO v_flat
        FROM shop_global_settings WHERE key = 'withdrawal_fee_flat_' || v_owner_role;
    END IF;
    IF v_flat IS NULL THEN
        SELECT NULLIF(trim(both '"' from value::text), '')::numeric INTO v_flat
        FROM shop_global_settings WHERE key = 'withdrawal_fee_flat';
    END IF;
    IF v_flat IS NULL THEN v_flat := 0; END IF;

    v_computed_fee := (p_amount * v_pct / 100.0) + v_flat;

    -- Never accept a fee below the authoritative computed fee (anti-evasion).
    -- A legitimate call passes the exact route-computed fee, so GREATEST keeps it.
    v_fee := GREATEST(COALESCE(p_fee, 0), v_computed_fee);
    v_net := p_amount - v_fee;

    IF v_net <= 0 THEN
        RAISE EXCEPTION 'Withdrawal amount too low to cover the processing fee';
    END IF;

    v_new_balance := v_current_balance - p_amount;

    UPDATE shop_wallets
    SET balance = v_new_balance,
        total_withdrawn = COALESCE(total_withdrawn, 0) + p_amount,
        updated_at = NOW()
    WHERE id = p_wallet_id;

    INSERT INTO shop_wallet_transactions (
        shop_wallet_id, type, amount, fee, net_amount, account_name, momo_number,
        account_number, network, payment_type, bank_id, bank_name, branch,
        description, status, balance_snapshot
    ) VALUES (
        p_wallet_id, 'withdrawal', p_amount, v_fee, v_net, p_account_name, p_momo_number,
        p_account_number, p_network, p_payment_type, p_bank_id, p_bank_name, p_branch,
        p_description, 'pending', v_new_balance
    ) RETURNING id INTO v_tx_id;

    RETURN jsonb_build_object(
        'success', true,
        'newBalance', v_new_balance,
        'fee', v_fee,
        'netAmount', v_net,
        'transactionId', v_tx_id
    );
END;
$$;

GRANT EXECUTE ON FUNCTION process_shop_withdrawal TO authenticated;

-- =============================================================================
-- C1 (part 1 of 2) — process_shop_withdrawal entry lock + real name_verified.
-- ADDITIVE / BACKWARD-COMPATIBLE. Safe to apply to prod BEFORE the new route
-- code ships (the currently-deployed route keeps working). The companion
-- migration 20260624h_revoke_withdrawal_execute.sql performs the breaking
-- REVOKE and must be applied ONLY once the new service-role route is live.
--
-- Why: the RPC is EXECUTE-granted to `authenticated`, so a shop owner can call
-- it directly via PostgREST and forge the payout destination name (the only
-- "verified" signal is a [UNVERIFIED-NAME] tag in p_description that the
-- attacker simply omits). It is their own funds, but it defeats Moolre
-- name-match/KYC and shows admins a fabricated "verified" name.
--
-- Two-part fix:
--   1. Accept a trusted p_owner_id so the route can call the RPC with a
--      SERVICE-ROLE client (auth.uid() = NULL). Ownership = COALESCE(auth.uid(),
--      p_owner_id): an authenticated caller is still pinned to their own
--      auth.uid() (cannot spoof via p_owner_id); the hardened service-role route
--      supplies p_owner_id. This lets us REVOKE EXECUTE from `authenticated`
--      (migration h) and close direct PostgREST access entirely.
--   2. Record a real boolean name_verified column instead of relying on a
--      forgeable description substring. The admin UI reads the column (falling
--      back to the legacy tag for pre-existing rows).
--
-- New params are appended with DEFAULT NULL, so the existing route's 13-named-
-- argument .rpc() call resolves to this same function (the two new args default).
-- =============================================================================

-- 1. Real verification flag on the ledger (additive; existing rows = NULL/unknown).
ALTER TABLE public.shop_wallet_transactions
    ADD COLUMN IF NOT EXISTS name_verified BOOLEAN;

-- 2. Replace the 13-arg function with a 15-arg version (2 new defaulted params).
--    DROP+CREATE because adding parameters changes the signature; both run in the
--    migration's transaction so there is no window where the function is missing.
DROP FUNCTION IF EXISTS public.process_shop_withdrawal(
    UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
);

CREATE OR REPLACE FUNCTION public.process_shop_withdrawal(
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
    p_description TEXT,
    p_owner_id UUID DEFAULT NULL,
    p_name_verified BOOLEAN DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_wallet_owner_id UUID;
    v_caller UUID;
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

    -- Caller identity. An authenticated direct call carries auth.uid(); the
    -- hardened service-role route carries auth.uid() = NULL and passes p_owner_id.
    -- COALESCE prefers auth.uid(), so an authenticated caller can NEVER act as
    -- another owner by passing someone else's p_owner_id.
    v_caller := COALESCE(auth.uid(), p_owner_id);
    IF v_caller IS NULL OR v_caller <> v_wallet_owner_id THEN
        RAISE EXCEPTION 'Unauthorized: caller does not own this wallet';
    END IF;

    IF v_current_balance < p_amount THEN
        RAISE EXCEPTION 'Insufficient shop wallet balance';
    END IF;

    -- ── SEC-005: recompute the authoritative fee ────────────────────────────
    SELECT role INTO v_owner_role FROM users WHERE id = v_wallet_owner_id;
    v_owner_role := COALESCE(v_owner_role, 'customer');

    SELECT withdrawal_fee_percent, withdrawal_fee_flat INTO v_pct, v_flat
    FROM shop_profiles WHERE owner_id = v_wallet_owner_id;

    IF v_pct IS NULL THEN
        SELECT NULLIF(trim(both '"' from value::text), '')::numeric INTO v_pct
        FROM shop_global_settings WHERE key = 'withdrawal_fee_percent_' || v_owner_role;
    END IF;
    IF v_pct IS NULL THEN
        SELECT NULLIF(trim(both '"' from value::text), '')::numeric INTO v_pct
        FROM shop_global_settings WHERE key = 'withdrawal_fee_percent';
    END IF;
    IF v_pct IS NULL THEN v_pct := 2; END IF;

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
        description, status, balance_snapshot, name_verified
    ) VALUES (
        p_wallet_id, 'withdrawal', p_amount, v_fee, v_net, p_account_name, p_momo_number,
        p_account_number, p_network, p_payment_type, p_bank_id, p_bank_name, p_branch,
        p_description, 'pending', v_new_balance, p_name_verified
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

-- Grants: keep `authenticated` for now so the currently-deployed route keeps
-- working; add `service_role` for the new hardened route. Migration h removes
-- the `authenticated` grant once the new route is live.
REVOKE ALL ON FUNCTION public.process_shop_withdrawal(
    UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, BOOLEAN
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_shop_withdrawal(
    UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, BOOLEAN
) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

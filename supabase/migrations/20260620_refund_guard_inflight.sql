-- supabase/migrations/20260620_refund_guard_inflight.sql
-- =============================================================================
-- Tighten refund_shop_withdrawal: reject in-flight (moolre_pending / paystack_pending)
-- and terminal (completed) rows — only pending and failed are refundable.
-- Rationale: refunding an in-flight payout double-pays the owner (the provider
-- may still pay out). The previous guard only blocked 'completed'; this replaces
-- that with a whitelist-based check (NOT IN pending/failed).
-- AUTHORED ONLY — do not apply to live DB until reviewed by the team.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.refund_shop_withdrawal(
    p_tx_id UUID,
    p_admin_id UUID,
    p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_wallet_id UUID;
    v_amount NUMERIC;
    v_status TEXT;
    v_type TEXT;
    v_new_balance NUMERIC;
BEGIN
    -- Lock the transaction row first
    SELECT shop_wallet_id, amount, status, type
      INTO v_wallet_id, v_amount, v_status, v_type
    FROM shop_wallet_transactions
    WHERE id = p_tx_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Withdrawal transaction not found';
    END IF;
    IF v_type <> 'withdrawal' THEN
        RAISE EXCEPTION 'Not a withdrawal transaction';
    END IF;

    -- Idempotency: already refunded → success no-op (do NOT double-credit)
    IF v_status = 'reversed' THEN
        RETURN jsonb_build_object('success', true, 'alreadyRefunded', true);
    END IF;
    -- Whitelist guard: only pending and failed withdrawals are refundable.
    -- In-flight (moolre_pending, paystack_pending) and completed rows are blocked —
    -- the provider may still pay out, and completing then refunding would double-pay.
    IF v_status NOT IN ('pending', 'failed') THEN
        RAISE EXCEPTION 'Cannot refund a payout in status % — only pending or failed withdrawals are refundable', v_status;
    END IF;

    -- Lock + credit the wallet back by the GROSS amount that was debited at request time
    UPDATE shop_wallets
    SET balance = balance + v_amount,
        total_withdrawn = GREATEST(COALESCE(total_withdrawn, 0) - v_amount, 0),
        updated_at = NOW()
    WHERE id = v_wallet_id
    RETURNING balance INTO v_new_balance;

    -- Mark the withdrawal reversed + record who/why
    UPDATE shop_wallet_transactions
    SET status = 'reversed',
        failure_reason = LEFT(COALESCE(p_reason, 'Refunded by admin'), 500),
        processed_by = p_admin_id,
        processed_at = NOW(),
        updated_at = NOW()
    WHERE id = p_tx_id;

    RETURN jsonb_build_object('success', true, 'newBalance', v_new_balance, 'refunded', v_amount);
END;
$$;

-- Service-role only (admin route calls it with the service client). Never grant to anon/authenticated.
REVOKE ALL ON FUNCTION public.refund_shop_withdrawal(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refund_shop_withdrawal(UUID, UUID, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_shop_withdrawal(UUID, UUID, TEXT) TO service_role;

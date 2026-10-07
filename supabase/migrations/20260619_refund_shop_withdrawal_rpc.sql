-- supabase/migrations/20260619_refund_shop_withdrawal_rpc.sql
-- =============================================================================
-- Admin-triggered, idempotent refund of a failed/pending withdrawal.
-- Returns the previously-debited GROSS amount to the shop wallet and marks the
-- withdrawal row 'reversed'. NEVER called automatically — only from the admin
-- "Reject & Refund" action. Money is mutated only through this RPC (no raw UPDATE).
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
    -- A completed payout means money was actually sent — never auto-refundable here
    IF v_status = 'completed' THEN
        RAISE EXCEPTION 'Cannot refund a completed payout';
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

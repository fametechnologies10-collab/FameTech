-- ============================================================
-- refund_ussd_wallet — atomic, idempotent wallet refund for the USSD refund queue.
--
-- Fixes the CRITICAL double-credit / silent-loss gap: the admin route previously
-- did SELECT-then-INSERT ledger + separate balance credit with a revert path. A
-- credit failure after the ledger insert left an orphan ledger row that made a
-- retry short-circuit as "already credited" WITHOUT crediting. This function does
-- the idempotency check + ledger insert + balance credit in ONE transaction under
-- a wallet row lock, so it is safe against double-click, concurrency, and retry.
-- ============================================================

CREATE OR REPLACE FUNCTION public.refund_ussd_wallet(
    p_user_id   UUID,
    p_amount    NUMERIC,
    p_reference TEXT,
    p_description TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_wallet_id   UUID;
    v_new_balance NUMERIC;
BEGIN
    -- Lock the wallet so concurrent refunds for this user serialize.
    SELECT id INTO v_wallet_id FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
    IF v_wallet_id IS NULL THEN
        RAISE EXCEPTION 'WALLET_NOT_FOUND';
    END IF;

    -- Idempotency under the lock: if this refund reference was already applied, no-op.
    IF EXISTS (
        SELECT 1 FROM public.wallet_transactions
        WHERE reference = p_reference AND source = 'refund'
    ) THEN
        RETURN jsonb_build_object('already_processed', true);
    END IF;

    INSERT INTO public.wallet_transactions
        (wallet_id, user_id, type, amount, description, reference, source, status)
    VALUES
        (v_wallet_id, p_user_id, 'credit', p_amount, p_description, p_reference, 'refund', 'completed');

    UPDATE public.wallets
        SET balance        = balance + p_amount,
            total_credited = COALESCE(total_credited, 0) + p_amount,
            updated_at     = NOW()
        WHERE id = v_wallet_id
        RETURNING balance INTO v_new_balance;

    RETURN jsonb_build_object('already_processed', false, 'new_balance', v_new_balance);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.refund_ussd_wallet(UUID, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.refund_ussd_wallet(UUID, NUMERIC, TEXT, TEXT) TO service_role;

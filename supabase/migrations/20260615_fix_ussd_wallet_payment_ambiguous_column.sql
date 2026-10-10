-- ============================================================
-- Fix: USSD "Pay with FameTech Wallet" always failed for registered users
--
-- process_ussd_wallet_payment() declares RETURNS TABLE(wallet_id, ...),
-- which makes `wallet_id` an OUT-parameter VARIABLE in scope for the
-- whole function body. The final statement:
--
--     UPDATE public.wallet_transactions SET status = 'completed'
--     WHERE wallet_id = v_wallet_id ...
--
-- references `wallet_id` unqualified — matching BOTH the table column
-- and the OUT-param variable. Under the default
-- plpgsql.variable_conflict = error, Postgres raises
-- "column reference wallet_id is ambiguous", which aborts the function
-- and rolls back the whole transaction (so the debit is undone, but the
-- payment fails). The USSD handler then shows "Payment failed."
--
-- Fix: qualify the column with its table name in the final UPDATE so it
-- can never collide with the OUT-param variable. Return contract and all
-- other logic are unchanged.
-- ============================================================

CREATE OR REPLACE FUNCTION public.process_ussd_wallet_payment(
    p_user_id uuid,
    p_amount numeric,
    p_description text,
    p_reference text
)
RETURNS TABLE(wallet_id uuid, new_balance numeric, already_processed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_wallet_id uuid;
    v_new_balance numeric;
BEGIN
    -- Reserve the reference first. If it already exists for source='ussd',
    -- the unique index causes ON CONFLICT to short-circuit below — this
    -- makes retries of the same USSD request idempotent.
    INSERT INTO public.wallet_transactions
        (wallet_id, user_id, type, amount, description, reference, source, status)
    SELECT w.id, p_user_id, 'debit', p_amount, p_description, p_reference, 'ussd', 'pending'
    FROM public.wallets w
    WHERE w.user_id = p_user_id
    ON CONFLICT (reference) WHERE source = 'ussd' DO NOTHING
    RETURNING public.wallet_transactions.wallet_id INTO v_wallet_id;

    IF v_wallet_id IS NULL THEN
        -- Either no wallet for this user, or this reference was already processed.
        SELECT wt.wallet_id, w.balance INTO v_wallet_id, v_new_balance
        FROM public.wallet_transactions wt
        JOIN public.wallets w ON w.id = wt.wallet_id
        WHERE wt.reference = p_reference AND wt.source = 'ussd';

        IF v_wallet_id IS NULL THEN
            RAISE EXCEPTION 'WALLET_NOT_FOUND';
        END IF;

        RETURN QUERY SELECT v_wallet_id, v_new_balance, true;
        RETURN;
    END IF;

    -- Atomic deduction: only succeeds if balance is sufficient.
    UPDATE public.wallets
    SET balance     = balance - p_amount,
        total_spent = COALESCE(total_spent, 0) + p_amount,
        updated_at  = NOW()
    WHERE id = v_wallet_id
      AND balance >= p_amount
    RETURNING balance INTO v_new_balance;

    IF v_new_balance IS NULL THEN
        -- Insufficient balance — abort. The pending wallet_transactions row
        -- inserted above is rolled back with this exception.
        RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
    END IF;

    -- Qualify wallet_transactions.wallet_id so it cannot be read as the
    -- ambiguous OUT-param variable of the same name.
    UPDATE public.wallet_transactions
    SET status = 'completed'
    WHERE public.wallet_transactions.wallet_id = v_wallet_id
      AND public.wallet_transactions.reference = p_reference
      AND public.wallet_transactions.source = 'ussd';

    RETURN QUERY SELECT v_wallet_id, v_new_balance, false;
END;
$$;

REVOKE ALL ON FUNCTION public.process_ussd_wallet_payment(uuid, numeric, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_ussd_wallet_payment(uuid, numeric, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_ussd_wallet_payment(uuid, numeric, text, text) TO service_role;

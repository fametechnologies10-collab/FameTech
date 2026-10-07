-- Fix process_afa_order RPC:
--  1. Sets payment_method = 'wallet' on INSERT (web registrations are wallet-paid; was inheriting 'momo' default)
--  2. Sets id_type = 'Ghana Card' explicitly (forward-locked to Ghana Card only)
--  3. Adds SET search_path = '' for security hardening
--
-- EXECUTE remains: anon=false, authenticated=false, service_role=true (unchanged)
-- After applying, verify grants:
--   SELECT p.proname, r.rolname, has_function_privilege(r.oid, p.oid, 'EXECUTE')
--   FROM pg_proc p CROSS JOIN pg_roles r
--   WHERE p.proname = 'process_afa_order'
--     AND r.rolname IN ('anon','authenticated','service_role');
CREATE OR REPLACE FUNCTION public.process_afa_order(
    p_user_id        UUID,
    p_amount         NUMERIC,
    p_form_data      JSONB,
    p_reference_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_wallet_id      UUID;
    v_wallet_balance NUMERIC;
    v_new_balance    NUMERIC;
    v_transaction_id UUID;
    v_order_id       UUID;
BEGIN
    SELECT id, balance
        INTO v_wallet_id, v_wallet_balance
        FROM public.wallets
        WHERE user_id = p_user_id
        FOR UPDATE;

    IF v_wallet_id IS NULL THEN
        RAISE EXCEPTION 'WALLET_NOT_FOUND';
    END IF;

    IF v_wallet_balance < p_amount THEN
        RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
    END IF;

    UPDATE public.wallets
        SET
            balance     = balance - p_amount,
            total_spent = COALESCE(total_spent, 0) + p_amount,
            updated_at  = NOW()
        WHERE id = v_wallet_id
        RETURNING balance INTO v_new_balance;

    INSERT INTO public.wallet_transactions (
        wallet_id, user_id, type, amount, description,
        reference, source, status, metadata
    ) VALUES (
        v_wallet_id, p_user_id, 'debit', p_amount,
        'MTN AFA Registration Fee',
        p_reference_code, 'purchase', 'completed',
        jsonb_build_object('category', 'afa_order', 'source', 'afa_registration')
    )
    RETURNING id INTO v_transaction_id;

    INSERT INTO public.afa_orders (
        user_id, full_name, phone, ghana_card, id_type, id_number,
        location, region, occupation, date_of_birth, notes, status,
        payment_amount, payment_method, reference_code, transaction_id
    ) VALUES (
        p_user_id,
        p_form_data->>'full_name',
        p_form_data->>'phone',
        p_form_data->>'id_number',
        'Ghana Card',
        p_form_data->>'id_number',
        p_form_data->>'location',
        p_form_data->>'region',
        'Farmer',
        (p_form_data->>'date_of_birth')::DATE,
        p_form_data->>'notes',
        'pending',
        p_amount,
        'wallet',
        p_reference_code,
        v_transaction_id
    )
    RETURNING id INTO v_order_id;

    RETURN json_build_object(
        'order_id',       v_order_id,
        'transaction_id', v_transaction_id,
        'new_balance',    v_new_balance
    );
END;
$$;

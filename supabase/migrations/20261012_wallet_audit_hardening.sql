-- Wallet audit hardening (2026-10-12)
-- Additive: new RPCs + one partial unique index + one widened CHECK constraint, and a
-- status check added to claim_momo_transaction. Old code keeps working until the new code deploys.
-- Spec: docs/superpowers/specs/2026-10-12-wallet-audit-hardening-design.md (section A, items 1-4)

-- ---------------------------------------------------------------------------
-- 0. momo_claim_attempts.result CHECK
--    The old allow-list (found / not_found / already_claimed / rate_limited /
--    below_minimum / flagged / invalid_format) rejects the values the new limiter
--    writes ('attempt', and later 'claimed_successfully' + free-form failure codes).
--    The table is server-write-only (RLS: admin_write policy only) and has 0 rows,
--    so replace the allow-list with a length bound.
-- ---------------------------------------------------------------------------
ALTER TABLE public.momo_claim_attempts
    DROP CONSTRAINT IF EXISTS momo_claim_attempts_result_check;
ALTER TABLE public.momo_claim_attempts
    ADD CONSTRAINT momo_claim_attempts_result_check
    CHECK (char_length(result) BETWEEN 1 AND 64);

-- ---------------------------------------------------------------------------
-- 1. Partial unique index: one wallet_payments row per (user, client_request_id)
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_payments_client_request
    ON public.wallet_payments (user_id, ((metadata ->> 'client_request_id')))
    WHERE metadata ? 'client_request_id';

-- ---------------------------------------------------------------------------
-- 2. credit_wallet_topup: lock -> verify -> credit -> ledger -> complete, ONE transaction.
--    Lock order is always: wallet_payments row first, then wallets row.
--    Never touches wallets.total_spent.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.credit_wallet_topup(
    p_reference            text,
    p_provider_amount_kobo bigint,
    p_currency             text,
    p_provider_metadata    jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_payment       public.wallet_payments%ROWTYPE;
    v_wallet        public.wallets%ROWTYPE;
    v_expected_kobo bigint;
    v_currency      text;
    v_new_balance   numeric;
    v_carry         jsonb;
    v_base          jsonb;
    v_ledger_rows   integer;
BEGIN
    -- 1. Lock the payment row first.
    SELECT * INTO v_payment
    FROM public.wallet_payments
    WHERE reference = p_reference
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_found');
    END IF;

    -- 2. Idempotency: completed -> already processed; any other non-pending -> refuse.
    IF v_payment.status = 'completed' THEN
        RETURN jsonb_build_object(
            'success', true,
            'already_processed', true,
            'user_id', v_payment.user_id,
            'amount', v_payment.amount,
            'reference', v_payment.reference
        );
    END IF;

    IF v_payment.status <> 'pending' THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_pending');
    END IF;

    -- 3. Fail closed on a missing provider amount (row stays pending for webhook/reconcile retry).
    IF p_provider_amount_kobo IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'amount_unverified');
    END IF;

    -- 4. Currency (when supplied) must be GHS and amount must equal total_amount in pesewas.
    v_currency := nullif(upper(btrim(p_currency)), '');
    v_expected_kobo := round(v_payment.total_amount * 100)::bigint;

    IF (v_currency IS NOT NULL AND v_currency <> 'GHS')
       OR p_provider_amount_kobo <> v_expected_kobo THEN
        UPDATE public.wallet_payments
        SET status = 'failed',
            metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
                'mismatch_reason',
                    'Amount/currency mismatch: expected ' || v_expected_kobo::text || ' GHS pesewas, received '
                    || p_provider_amount_kobo::text || ' ' || coalesce(v_currency, '(no currency)'),
                'mismatch_detected_at', now()
            ),
            updated_at = now()
        WHERE id = v_payment.id;
        RETURN jsonb_build_object('success', false, 'error', 'amount_mismatch');
    END IF;

    -- 5. Lock the wallet (payment row is already locked). Missing -> stays pending.
    SELECT * INTO v_wallet
    FROM public.wallets
    WHERE user_id = v_payment.user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'wallet_not_found');
    END IF;

    -- 7. Ledger row first (guard): the partial unique index on (reference) WHERE source='payment'
    --    makes a pre-existing ledger row mean "this reference was already credited".
    INSERT INTO public.wallet_transactions (
        wallet_id, user_id, type, amount, description, reference, source, status
    ) VALUES (
        v_wallet.id, v_payment.user_id, 'credit', v_payment.amount,
        'Wallet top-up via Paystack', p_reference, 'payment', 'completed'
    )
    ON CONFLICT (reference) WHERE source = 'payment' DO NOTHING;
    GET DIAGNOSTICS v_ledger_rows = ROW_COUNT;

    -- 8. Completion metadata: provider payload, plus client_request_id carried over.
    IF v_payment.metadata ? 'client_request_id' THEN
        v_carry := jsonb_build_object('client_request_id', v_payment.metadata -> 'client_request_id');
    ELSE
        v_carry := '{}'::jsonb;
    END IF;
    v_base := CASE WHEN jsonb_typeof(p_provider_metadata) = 'object'
                   THEN p_provider_metadata ELSE '{}'::jsonb END;

    IF v_ledger_rows = 0 THEN
        -- A payment ledger row already exists for this reference: the credit happened earlier
        -- (legacy non-atomic path). Do NOT credit again; just finalise the payment.
        UPDATE public.wallet_payments
        SET status = 'completed',
            metadata = v_base || v_carry,
            updated_at = now()
        WHERE id = v_payment.id;
        RETURN jsonb_build_object(
            'success', true,
            'already_processed', true,
            'user_id', v_payment.user_id,
            'amount', v_payment.amount,
            'reference', v_payment.reference
        );
    END IF;

    -- 6. Credit. total_spent is deliberately NOT touched.
    UPDATE public.wallets
    SET balance        = coalesce(balance, 0) + v_payment.amount,
        total_credited = coalesce(total_credited, 0) + v_payment.amount,
        updated_at     = now()
    WHERE id = v_wallet.id
    RETURNING balance INTO v_new_balance;

    UPDATE public.wallet_payments
    SET status = 'completed',
        metadata = v_base || v_carry,
        updated_at = now()
    WHERE id = v_payment.id;

    -- 9.
    RETURN jsonb_build_object(
        'success', true,
        'user_id', v_payment.user_id,
        'amount', v_payment.amount,
        'new_balance', v_new_balance,
        'reference', v_payment.reference
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.credit_wallet_topup(text, bigint, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_wallet_topup(text, bigint, text, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. create_pending_wallet_payment: per-user advisory lock; client_request_id replay; cap 5/15 min
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_pending_wallet_payment(
    p_user_id           uuid,
    p_wallet_id         uuid,
    p_amount            numeric,
    p_fee               numeric,
    p_total             numeric,
    p_reference         text,
    p_client_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_cid      text := nullif(btrim(p_client_request_id), '');
    v_existing public.wallet_payments%ROWTYPE;
    v_pending  integer;
    v_meta     jsonb;
    v_id       uuid;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('wp:' || p_user_id::text));

    -- Replay of the same client request (any status): return the stored state, no new row.
    IF v_cid IS NOT NULL THEN
        SELECT * INTO v_existing
        FROM public.wallet_payments
        WHERE user_id = p_user_id
          AND metadata ->> 'client_request_id' = v_cid
        LIMIT 1;

        IF FOUND THEN
            RETURN jsonb_build_object(
                'existing', true,
                'reference', v_existing.reference,
                'status', v_existing.status,
                'charge_status', v_existing.metadata ->> 'charge_status',
                'display_text', v_existing.metadata ->> 'display_text',
                'fee', v_existing.fee,
                'total_amount', v_existing.total_amount
            );
        END IF;
    END IF;

    -- Pending cap: at most 5 pending rows in the last 15 minutes.
    SELECT count(*) INTO v_pending
    FROM public.wallet_payments
    WHERE user_id = p_user_id
      AND status = 'pending'
      AND created_at > now() - interval '15 minutes';

    IF v_pending >= 5 THEN
        RETURN jsonb_build_object('error', 'too_many_pending');
    END IF;

    IF v_cid IS NULL THEN
        v_meta := '{}'::jsonb;
    ELSE
        v_meta := jsonb_build_object('client_request_id', v_cid);
    END IF;

    INSERT INTO public.wallet_payments (
        user_id, wallet_id, amount, fee, total_amount, reference, provider, status, metadata
    ) VALUES (
        p_user_id, p_wallet_id, p_amount, p_fee, p_total, p_reference, 'paystack', 'pending', v_meta
    )
    RETURNING id INTO v_id;

    RETURN jsonb_build_object(
        'existing', false,
        'id', v_id,
        'reference', p_reference,
        'metadata', v_meta
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.create_pending_wallet_payment(uuid, uuid, numeric, numeric, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_pending_wallet_payment(uuid, uuid, numeric, numeric, numeric, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. claim_rate_limit_check: insert-before-claim limiter, serialised per user
--    Blocked when >=3 rows in 30 s (excluding 'rate_limited'), or >=10 failure rows in 1 h.
--    'rate_limited' rows never count, so a blocked user's lockout does not self-extend.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_rate_limit_check(
    p_user_id uuid,
    p_txn     text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_burst     integer;
    v_hourly    integer;
    v_reason    text;
    v_attempt   uuid;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('claim:' || p_user_id::text));

    SELECT count(*) INTO v_burst
    FROM public.momo_claim_attempts
    WHERE user_id = p_user_id
      AND created_at > now() - interval '30 seconds'
      AND result <> 'rate_limited';

    IF v_burst >= 3 THEN
        v_reason := 'burst';
    ELSE
        SELECT count(*) INTO v_hourly
        FROM public.momo_claim_attempts
        WHERE user_id = p_user_id
          AND created_at > now() - interval '1 hour'
          AND result NOT IN ('attempt', 'claimed_successfully', 'rate_limited');

        IF v_hourly >= 10 THEN
            v_reason := 'hourly';
        END IF;
    END IF;

    IF v_reason IS NOT NULL THEN
        INSERT INTO public.momo_claim_attempts (user_id, transaction_id_input, result)
        VALUES (p_user_id, coalesce(p_txn, ''), 'rate_limited');
        RETURN jsonb_build_object('allowed', false, 'reason', v_reason);
    END IF;

    INSERT INTO public.momo_claim_attempts (user_id, transaction_id_input, result)
    VALUES (p_user_id, coalesce(p_txn, ''), 'attempt')
    RETURNING id INTO v_attempt;

    RETURN jsonb_build_object('allowed', true, 'attempt_id', v_attempt);
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_rate_limit_check(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_rate_limit_check(uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. claim_momo_transaction: same body as before; ONLY change is that the user lookup now
--    also reads status and a missing / non-active user is refused before any row lock.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_momo_transaction(p_transaction_id text, p_user_id uuid, p_is_auto boolean DEFAULT false, p_ref_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    v_user_status      TEXT;
    v_description      TEXT;
BEGIN
    -- 1. Get user role and status
    SELECT role, status INTO v_user_role, v_user_status
    FROM public.users
    WHERE id = p_user_id;

    -- 1b. Only active accounts may claim (missing user is refused too)
    IF NOT FOUND OR v_user_status IS DISTINCT FROM 'active' THEN
        RETURN jsonb_build_object('success', false, 'error', 'account_not_active');
    END IF;

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
$function$;

REVOKE ALL ON FUNCTION public.claim_momo_transaction(text, uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_momo_transaction(text, uuid, boolean, text) TO service_role;

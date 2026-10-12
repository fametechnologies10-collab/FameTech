-- Rollback-only SQL test for the wallet audit hardening migration
-- (supabase/migrations/20261012_wallet_audit_hardening.sql).
--
-- HOW TO RUN: send this whole file as ONE statement (Supabase `execute_sql`). The block always
-- ends in RAISE EXCEPTION, which aborts the implicit transaction, so NOTHING it touches persists.
-- Expected outcome after the migration is applied: ERROR ... 'RESULT: ALL PASSED'
-- Any other RESULT line lists the failing cases.
--
-- It borrows one existing ACTIVE user (+ that user's wallet) and a throwaway auth user.
-- Assumptions (a red 'N raised: ...' line usually means one of these does not hold):
--   * case 5: a minimal INSERT INTO auth.users (id, email) succeeds for the executing role, and
--     deleting the auto-created wallet of the throwaway public.users row is allowed;
--   * case 9: public.users accepts status 'suspended' / 'inactive' updates (no blocking trigger);
--   * case 9: a minimal INSERT INTO public.momo_transactions (transaction_id, amount, sender_name,
--     sender_network, status) succeeds, and transaction_id '99999999999' does not already exist;
--   * case 8: momo_claim_attempts_result_check was relaxed by the migration (rows with result
--     'txn_not_found' / 'claimed_successfully' / 'attempt' must be insertable);
--   * at least one active user with a wallet exists.
-- To exercise the migration BEFORE applying it, prepend the migration SQL in the same call.

DO $test$
DECLARE
    failures   text[] := '{}';
    v_user     uuid;
    v_wallet   uuid;
    v_thr      uuid := gen_random_uuid();   -- throwaway user (no wallet)
    v_tag      text := substr(md5(random()::text), 1, 8);
    r          jsonb;
    r2         jsonb;
    ref1       text;
    ref2       text;
    ref3       text;
    b0         numeric;  tc0 numeric;  ts0 numeric;
    b1         numeric;  tc1 numeric;  ts1 numeric;
    n          integer;
    s          text;
    v_cid      text;
    i          integer;
BEGIN
    -- Borrow an active user that has a wallet and no recent pending payments.
    SELECT u.id, w.id INTO v_user, v_wallet
    FROM public.users u
    JOIN public.wallets w ON w.user_id = u.id
    WHERE u.status = 'active'
      AND NOT EXISTS (
          SELECT 1 FROM public.wallet_payments p
          WHERE p.user_id = u.id AND p.status = 'pending' AND p.created_at > now() - interval '15 minutes')
    ORDER BY (SELECT count(*) FROM public.wallet_payments p WHERE p.user_id = u.id) ASC
    LIMIT 1;

    IF v_user IS NULL THEN
        RAISE EXCEPTION 'RESULT: SETUP FAILED - no active user with a wallet found';
    END IF;

    ref1 := 'WAHT-' || v_tag || '-1';
    ref2 := 'WAHT-' || v_tag || '-2';
    ref3 := 'WAHT-' || v_tag || '-3';

    -- ===================================================================
    -- Case 1: credit_wallet_topup happy path
    -- ===================================================================
    BEGIN
        INSERT INTO public.wallet_payments (user_id, wallet_id, amount, fee, total_amount, reference, status, metadata)
        VALUES (v_user, v_wallet, 10.00, 0.50, 10.50, ref1, 'pending', '{"client_request_id":"cr-direct-1"}');

        SELECT balance, coalesce(total_credited,0), coalesce(total_spent,0) INTO b0, tc0, ts0 FROM public.wallets WHERE id = v_wallet;

        r := public.credit_wallet_topup(ref1, 1050, 'GHS', '{"amount":1050,"currency":"GHS","id":123}');

        SELECT balance, coalesce(total_credited,0), coalesce(total_spent,0) INTO b1, tc1, ts1 FROM public.wallets WHERE id = v_wallet;

        IF coalesce(r->>'success', '') <> 'true' OR r ? 'error' THEN failures := failures || ('1: not success: ' || r::text); END IF;
        IF (r->>'new_balance')::numeric IS DISTINCT FROM b1 THEN failures := failures || '1: new_balance mismatch'; END IF;
        IF b1 IS DISTINCT FROM b0 + 10 THEN failures := failures || ('1: balance ' || b0 || ' -> ' || b1); END IF;
        IF tc1 IS DISTINCT FROM tc0 + 10 THEN failures := failures || ('1: total_credited ' || tc0 || ' -> ' || tc1); END IF;
        IF ts1 IS DISTINCT FROM ts0 THEN failures := failures || ('1: total_spent CHANGED ' || ts0 || ' -> ' || ts1); END IF;
        SELECT count(*) INTO n FROM public.wallet_transactions WHERE reference = ref1 AND source = 'payment';
        IF n IS DISTINCT FROM 1 THEN failures := failures || ('1: ledger rows = ' || n); END IF;
        SELECT status, metadata->>'client_request_id' INTO s, v_cid FROM public.wallet_payments WHERE reference = ref1;
        IF s IS DISTINCT FROM 'completed' THEN failures := failures || ('1: payment status ' || s); END IF;
        IF v_cid IS DISTINCT FROM 'cr-direct-1' THEN failures := failures || '1: client_request_id lost'; END IF;

        -- Case 2: replay
        r2 := public.credit_wallet_topup(ref1, 1050, 'GHS', '{"amount":1050}');
        IF NOT coalesce(r2->>'already_processed' = 'true' AND r2->>'success' = 'true', false) THEN failures := failures || ('2: replay result ' || r2::text); END IF;
        SELECT balance INTO b0 FROM public.wallets WHERE id = v_wallet;
        IF b0 IS DISTINCT FROM b1 THEN failures := failures || '2: balance changed on replay'; END IF;
        SELECT count(*) INTO n FROM public.wallet_transactions WHERE reference = ref1 AND source = 'payment';
        IF n IS DISTINCT FROM 1 THEN failures := failures || ('2: ledger rows after replay = ' || n); END IF;
    EXCEPTION WHEN OTHERS THEN
        failures := failures || ('1/2 raised: ' || SQLERRM);
    END;

    -- ===================================================================
    -- Case 2b: pending payment whose ledger row already exists (legacy partial credit) -> no double credit
    -- ===================================================================
    BEGIN
        INSERT INTO public.wallet_payments (user_id, wallet_id, amount, fee, total_amount, reference, status)
        VALUES (v_user, v_wallet, 5.00, 0, 5.00, ref2, 'pending');
        INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
        VALUES (v_wallet, v_user, 'credit', 5.00, 'legacy', ref2, 'payment', 'completed');
        SELECT balance INTO b0 FROM public.wallets WHERE id = v_wallet;

        r := public.credit_wallet_topup(ref2, 500, 'GHS', '{}');
        SELECT balance INTO b1 FROM public.wallets WHERE id = v_wallet;
        SELECT status INTO s FROM public.wallet_payments WHERE reference = ref2;
        IF NOT coalesce(r->>'already_processed' = 'true', false) THEN failures := failures || ('2b: expected already_processed ' || r::text); END IF;
        IF b1 IS DISTINCT FROM b0 THEN failures := failures || '2b: double credit'; END IF;
        IF s IS DISTINCT FROM 'completed' THEN failures := failures || ('2b: status ' || s); END IF;
    EXCEPTION WHEN OTHERS THEN
        failures := failures || ('2b raised: ' || SQLERRM);
    END;

    -- ===================================================================
    -- Case 3: NULL provider amount -> amount_unverified, stays pending
    -- ===================================================================
    BEGIN
        INSERT INTO public.wallet_payments (user_id, wallet_id, amount, fee, total_amount, reference, status)
        VALUES (v_user, v_wallet, 20.00, 0, 20.00, ref3 || 'a', 'pending');
        SELECT balance INTO b0 FROM public.wallets WHERE id = v_wallet;

        r := public.credit_wallet_topup(ref3 || 'a', NULL, 'GHS', '{}');
        SELECT balance INTO b1 FROM public.wallets WHERE id = v_wallet;
        SELECT status INTO s FROM public.wallet_payments WHERE reference = ref3 || 'a';
        IF r->>'error' IS DISTINCT FROM 'amount_unverified' THEN failures := failures || ('3: ' || r::text); END IF;
        IF s IS DISTINCT FROM 'pending' THEN failures := failures || ('3: status ' || s); END IF;
        IF b1 IS DISTINCT FROM b0 THEN failures := failures || '3: balance changed'; END IF;
        -- Retire the intentionally-left-pending row so it cannot count toward case 7's pending cap.
        UPDATE public.wallet_payments SET status = 'failed' WHERE reference = ref3 || 'a';
    EXCEPTION WHEN OTHERS THEN
        failures := failures || ('3 raised: ' || SQLERRM);
    END;

    -- ===================================================================
    -- Case 4: wrong amount / wrong currency -> amount_mismatch, failed; also case 6b (not_pending)
    -- ===================================================================
    BEGIN
        INSERT INTO public.wallet_payments (user_id, wallet_id, amount, fee, total_amount, reference, status)
        VALUES (v_user, v_wallet, 20.00, 0, 20.00, ref3 || 'b', 'pending'),
               (v_user, v_wallet, 20.00, 0, 20.00, ref3 || 'c', 'pending');
        SELECT balance INTO b0 FROM public.wallets WHERE id = v_wallet;

        r := public.credit_wallet_topup(ref3 || 'b', 1999, 'GHS', '{}');
        SELECT status INTO s FROM public.wallet_payments WHERE reference = ref3 || 'b';
        IF r->>'error' IS DISTINCT FROM 'amount_mismatch' THEN failures := failures || ('4a: ' || r::text); END IF;
        IF s IS DISTINCT FROM 'failed' THEN failures := failures || ('4a: status ' || s); END IF;

        r := public.credit_wallet_topup(ref3 || 'c', 2000, 'USD', '{}');
        SELECT status INTO s FROM public.wallet_payments WHERE reference = ref3 || 'c';
        IF r->>'error' IS DISTINCT FROM 'amount_mismatch' THEN failures := failures || ('4b: ' || r::text); END IF;
        IF s IS DISTINCT FROM 'failed' THEN failures := failures || ('4b: status ' || s); END IF;

        SELECT balance INTO b1 FROM public.wallets WHERE id = v_wallet;
        IF b1 IS DISTINCT FROM b0 THEN failures := failures || '4: balance changed'; END IF;

        -- Case 6b: an already-failed row -> not_pending (even with a now-correct amount)
        r := public.credit_wallet_topup(ref3 || 'b', 2000, 'GHS', '{}');
        IF r->>'error' IS DISTINCT FROM 'not_pending' THEN failures := failures || ('6b: ' || r::text); END IF;
    EXCEPTION WHEN OTHERS THEN
        failures := failures || ('4/6b raised: ' || SQLERRM);
    END;

    -- ===================================================================
    -- Case 5: wallet absent for the payment's user -> wallet_not_found, stays pending
    -- (throwaway auth+public user with its auto-created wallet deleted; payment keeps the
    --  borrowed wallet_id so the wallet_payments.wallet_id FK is satisfied)
    -- ===================================================================
    BEGIN
        INSERT INTO auth.users (id, email) VALUES (v_thr, 'wah-test-' || v_tag || '@example.invalid');
        INSERT INTO public.users (id, email, first_name, last_name)
        VALUES (v_thr, 'wah-test-' || v_tag || '@example.invalid', 'Wah', 'Test')
        ON CONFLICT (id) DO NOTHING;
        DELETE FROM public.wallets WHERE user_id = v_thr;

        INSERT INTO public.wallet_payments (user_id, wallet_id, amount, fee, total_amount, reference, status)
        VALUES (v_thr, v_wallet, 7.00, 0, 7.00, 'WAHT-' || v_tag || '-nw', 'pending');

        r := public.credit_wallet_topup('WAHT-' || v_tag || '-nw', 700, 'GHS', '{}');
        SELECT status INTO s FROM public.wallet_payments WHERE reference = 'WAHT-' || v_tag || '-nw';
        IF r->>'error' IS DISTINCT FROM 'wallet_not_found' THEN failures := failures || ('5: ' || r::text); END IF;
        IF s IS DISTINCT FROM 'pending' THEN failures := failures || ('5: status ' || s); END IF;
    EXCEPTION WHEN OTHERS THEN
        failures := failures || ('5 raised: ' || SQLERRM);
    END;

    -- ===================================================================
    -- Case 6a: unknown reference -> not_found
    -- ===================================================================
    BEGIN
        r := public.credit_wallet_topup('WAHT-' || v_tag || '-does-not-exist', 100, 'GHS', '{}');
        IF r->>'error' IS DISTINCT FROM 'not_found' THEN failures := failures || ('6a: ' || r::text); END IF;
    EXCEPTION WHEN OTHERS THEN
        failures := failures || ('6a raised: ' || SQLERRM);
    END;

    -- ===================================================================
    -- Case 7: create_pending_wallet_payment
    -- ===================================================================
    BEGIN
        -- Cap arithmetic (pending rows for v_user in the last 15 min): first defensively retire any pending
        -- row this test created earlier (case 3 already does; cases 1/2/2b/4 end completed/failed; case 5
        -- uses another user), so the count starts at 0. 7a creates cp1 (pending=1), which 7d completes
        -- (pending=0). The loop then adds 4 pending (=4); the 'cap5' call is the 5th (allowed, =5);
        -- the 'cap6' call is the 6th -> too_many_pending.
        UPDATE public.wallet_payments SET status = 'failed'
        WHERE user_id = v_user AND status = 'pending' AND reference LIKE 'WAHT-' || v_tag || '-%';

        r := public.create_pending_wallet_payment(v_user, v_wallet, 10, 0.5, 10.5, 'WAHT-' || v_tag || '-cp1', 'cr-' || v_tag);
        IF NOT coalesce(r->>'existing' = 'false' AND r->>'reference' = 'WAHT-' || v_tag || '-cp1' AND r ? 'id', false) THEN
            failures := failures || ('7a: first call ' || r::text);
        END IF;
        IF r->'metadata'->>'client_request_id' IS DISTINCT FROM 'cr-' || v_tag THEN failures := failures || '7a: metadata missing client_request_id'; END IF;

        -- Replay with same client_request_id (different candidate reference) -> existing, same reference
        r2 := public.create_pending_wallet_payment(v_user, v_wallet, 10, 0.5, 10.5, 'WAHT-' || v_tag || '-cp2', 'cr-' || v_tag);
        IF NOT coalesce(r2->>'existing' = 'true' AND r2->>'reference' = 'WAHT-' || v_tag || '-cp1' AND r2->>'status' = 'pending'
                AND (r2->>'fee')::numeric = 0.5 AND (r2->>'total_amount')::numeric = 10.5, false) THEN
            failures := failures || ('7b: replay ' || r2::text);
        END IF;
        SELECT count(*) INTO n FROM public.wallet_payments WHERE user_id = v_user AND reference IN ('WAHT-' || v_tag || '-cp1', 'WAHT-' || v_tag || '-cp2');
        IF n IS DISTINCT FROM 1 THEN failures := failures || ('7b: rows after replay = ' || n); END IF;

        -- charge_status / display_text surface from metadata on replay
        UPDATE public.wallet_payments
        SET metadata = metadata || '{"charge_status":"send_otp","display_text":"Enter OTP"}'
        WHERE reference = 'WAHT-' || v_tag || '-cp1';
        r2 := public.create_pending_wallet_payment(v_user, v_wallet, 10, 0.5, 10.5, 'WAHT-' || v_tag || '-cp3', 'cr-' || v_tag);
        IF NOT coalesce(r2->>'charge_status' = 'send_otp' AND r2->>'display_text' = 'Enter OTP', false) THEN failures := failures || ('7c: ' || r2::text); END IF;

        -- Same id after the payment is completed -> still existing:true
        r := public.credit_wallet_topup('WAHT-' || v_tag || '-cp1', 1050, 'GHS', '{"amount":1050}');
        IF r->>'success' IS DISTINCT FROM 'true' THEN failures := failures || ('7d: credit ' || r::text); END IF;
        r2 := public.create_pending_wallet_payment(v_user, v_wallet, 10, 0.5, 10.5, 'WAHT-' || v_tag || '-cp4', 'cr-' || v_tag);
        IF NOT coalesce(r2->>'existing' = 'true' AND r2->>'reference' = 'WAHT-' || v_tag || '-cp1' AND r2->>'status' = 'completed', false) THEN
            failures := failures || ('7d: replay after completion ' || r2::text);
        END IF;

        -- Cap: pending rows in last 15 min. The completed one does not count. Make 4 pending, 5th allowed, 6th capped.
        FOR i IN 1..4 LOOP
            INSERT INTO public.wallet_payments (user_id, wallet_id, amount, fee, total_amount, reference, status)
            VALUES (v_user, v_wallet, 1, 0, 1, 'WAHT-' || v_tag || '-cap' || i, 'pending');
        END LOOP;
        r := public.create_pending_wallet_payment(v_user, v_wallet, 1, 0, 1, 'WAHT-' || v_tag || '-cap5', 'cr-' || v_tag || '-5');
        IF r->>'existing' IS DISTINCT FROM 'false' THEN failures := failures || ('7e: 5th pending should be allowed ' || r::text); END IF;
        r := public.create_pending_wallet_payment(v_user, v_wallet, 1, 0, 1, 'WAHT-' || v_tag || '-cap6', 'cr-' || v_tag || '-6');
        IF r->>'error' IS DISTINCT FROM 'too_many_pending' THEN failures := failures || ('7f: 6th should be capped ' || r::text); END IF;
        SELECT count(*) INTO n FROM public.wallet_payments WHERE reference = 'WAHT-' || v_tag || '-cap6';
        IF n IS DISTINCT FROM 0 THEN failures := failures || '7f: capped call inserted a row'; END IF;
        -- Replay of an existing request is still served while capped
        r := public.create_pending_wallet_payment(v_user, v_wallet, 1, 0, 1, 'WAHT-' || v_tag || '-cap7', 'cr-' || v_tag || '-5');
        IF r->>'existing' IS DISTINCT FROM 'true' THEN failures := failures || ('7g: replay while capped ' || r::text); END IF;
        -- Null / empty client_request_id: no key stored
        DELETE FROM public.wallet_payments WHERE reference LIKE 'WAHT-' || v_tag || '-cap%';
        r := public.create_pending_wallet_payment(v_user, v_wallet, 1, 0, 1, 'WAHT-' || v_tag || '-nul', '');
        IF r->>'existing' IS DISTINCT FROM 'false' OR r->'metadata' ? 'client_request_id' THEN failures := failures || ('7h: empty cid ' || r::text); END IF;
        -- Unique index backstop exists
        IF to_regclass('public.uq_wallet_payments_client_request') IS NULL THEN failures := failures || '7i: unique index missing'; END IF;
    EXCEPTION WHEN OTHERS THEN
        failures := failures || ('7 raised: ' || SQLERRM);
    END;

    -- ===================================================================
    -- Case 8: claim_rate_limit_check
    -- ===================================================================
    BEGIN
        DELETE FROM public.momo_claim_attempts WHERE user_id = v_user;

        FOR i IN 1..3 LOOP
            r := public.claim_rate_limit_check(v_user, '1111111111' || i);
            IF NOT coalesce(r->>'allowed' = 'true' AND r ? 'attempt_id', false) THEN failures := failures || ('8a: call ' || i || ' ' || r::text); END IF;
        END LOOP;
        SELECT count(*) INTO n FROM public.momo_claim_attempts WHERE user_id = v_user AND result = 'attempt';
        IF n IS DISTINCT FROM 3 THEN failures := failures || ('8a: attempt rows = ' || n); END IF;
        r := public.claim_rate_limit_check(v_user, '11111111114');
        IF NOT coalesce(r->>'allowed' = 'false' AND r->>'reason' = 'burst', false) THEN failures := failures || ('8b: 4th ' || r::text); END IF;
        SELECT count(*) INTO n FROM public.momo_claim_attempts WHERE user_id = v_user AND result = 'rate_limited';
        IF n IS DISTINCT FROM 1 THEN failures := failures || ('8b: rate_limited rows = ' || n); END IF;

        -- 3 attempts older than 30 s do not trigger burst
        DELETE FROM public.momo_claim_attempts WHERE user_id = v_user;
        INSERT INTO public.momo_claim_attempts (user_id, transaction_id_input, result, created_at)
        SELECT v_user, 'x', 'attempt', now() - interval '60 seconds' FROM generate_series(1,3);
        r := public.claim_rate_limit_check(v_user, 'x');
        IF r->>'allowed' IS DISTINCT FROM 'true' THEN failures := failures || ('8c: old attempts blocked ' || r::text); END IF;

        -- rate_limited rows do not count toward burst
        DELETE FROM public.momo_claim_attempts WHERE user_id = v_user;
        INSERT INTO public.momo_claim_attempts (user_id, transaction_id_input, result)
        SELECT v_user, 'x', 'rate_limited' FROM generate_series(1,5);
        r := public.claim_rate_limit_check(v_user, 'x');
        IF r->>'allowed' IS DISTINCT FROM 'true' THEN failures := failures || ('8d: rate_limited rows counted ' || r::text); END IF;

        -- hourly: 9 failures (10 min ago) allowed, 10th failure -> hourly
        DELETE FROM public.momo_claim_attempts WHERE user_id = v_user;
        INSERT INTO public.momo_claim_attempts (user_id, transaction_id_input, result, created_at)
        SELECT v_user, 'x', 'txn_not_found', now() - interval '10 minutes' FROM generate_series(1,9);
        r := public.claim_rate_limit_check(v_user, 'x');
        IF r->>'allowed' IS DISTINCT FROM 'true' THEN failures := failures || ('8e: 9 failures blocked ' || r::text); END IF;
        INSERT INTO public.momo_claim_attempts (user_id, transaction_id_input, result, created_at)
        VALUES (v_user, 'x', 'txn_not_found', now() - interval '10 minutes');
        r := public.claim_rate_limit_check(v_user, 'x');
        IF NOT coalesce(r->>'allowed' = 'false' AND r->>'reason' = 'hourly', false) THEN failures := failures || ('8f: 10 failures ' || r::text); END IF;

        -- successes / attempts / failures older than an hour do not count toward hourly
        DELETE FROM public.momo_claim_attempts WHERE user_id = v_user;
        INSERT INTO public.momo_claim_attempts (user_id, transaction_id_input, result, created_at)
        SELECT v_user, 'x', 'claimed_successfully', now() - interval '10 minutes' FROM generate_series(1,12);
        INSERT INTO public.momo_claim_attempts (user_id, transaction_id_input, result, created_at)
        SELECT v_user, 'x', 'txn_not_found', now() - interval '2 hours' FROM generate_series(1,12);
        r := public.claim_rate_limit_check(v_user, 'x');
        IF r->>'allowed' IS DISTINCT FROM 'true' THEN failures := failures || ('8g: successes/old counted ' || r::text); END IF;

        DELETE FROM public.momo_claim_attempts WHERE user_id = v_user;
    EXCEPTION WHEN OTHERS THEN
        failures := failures || ('8 raised: ' || SQLERRM);
    END;

    -- ===================================================================
    -- Case 9: claim_momo_transaction user-status gate
    -- ===================================================================
    BEGIN
        INSERT INTO public.momo_transactions (transaction_id, amount, sender_name, sender_network, status)
        VALUES ('99999999999', 1000, 'Test Sender', 'MTN', 'pending');
        SELECT balance INTO b0 FROM public.wallets WHERE id = v_wallet;

        UPDATE public.users SET status = 'suspended' WHERE id = v_user;
        r := public.claim_momo_transaction('99999999999', v_user, false, NULL);
        SELECT status INTO s FROM public.momo_transactions WHERE transaction_id = '99999999999';
        SELECT balance INTO b1 FROM public.wallets WHERE id = v_wallet;
        IF r->>'error' IS DISTINCT FROM 'account_not_active' THEN failures := failures || ('9a: suspended ' || r::text); END IF;
        IF s IS DISTINCT FROM 'pending' THEN failures := failures || ('9a: txn status ' || s); END IF;
        IF b1 IS DISTINCT FROM b0 THEN failures := failures || '9a: balance changed'; END IF;

        UPDATE public.users SET status = 'inactive' WHERE id = v_user;
        r := public.claim_momo_transaction('99999999999', v_user, false, NULL);
        IF r->>'error' IS DISTINCT FROM 'account_not_active' THEN failures := failures || ('9b: inactive ' || r::text); END IF;

        r := public.claim_momo_transaction('99999999999', gen_random_uuid(), false, NULL);
        IF r->>'error' IS DISTINCT FROM 'account_not_active' THEN failures := failures || ('9c: missing user ' || r::text); END IF;

        UPDATE public.users SET status = 'active' WHERE id = v_user;
        r := public.claim_momo_transaction('99999999999', v_user, false, NULL);
        SELECT status INTO s FROM public.momo_transactions WHERE transaction_id = '99999999999';
        SELECT balance INTO b1 FROM public.wallets WHERE id = v_wallet;
        IF r->>'success' IS DISTINCT FROM 'true' THEN failures := failures || ('9d: active claim ' || r::text); END IF;
        IF s IS DISTINCT FROM 'claimed' THEN failures := failures || ('9d: txn status ' || s); END IF;
        IF b1 IS DISTINCT FROM b0 + (r->>'net_amount')::numeric THEN failures := failures || '9d: balance delta <> net_amount'; END IF;

        r := public.claim_momo_transaction('99999999999', v_user, false, NULL);
        IF r->>'error' IS DISTINCT FROM 'already_claimed' THEN failures := failures || ('9e: replay ' || r::text); END IF;
    EXCEPTION WHEN OTHERS THEN
        failures := failures || ('9 raised: ' || SQLERRM);
    END;

    -- ===================================================================
    -- Case 10: privileges (service_role only; no PUBLIC grant)
    -- ===================================================================
    BEGIN
        FOREACH s IN ARRAY ARRAY[
            'public.credit_wallet_topup(text,bigint,text,jsonb)',
            'public.create_pending_wallet_payment(uuid,uuid,numeric,numeric,numeric,text,text)',
            'public.claim_rate_limit_check(uuid,text)',
            'public.claim_momo_transaction(text,uuid,boolean,text)'
        ] LOOP
            IF has_function_privilege('anon', s, 'EXECUTE') THEN failures := failures || ('10: anon can execute ' || s); END IF;
            IF has_function_privilege('authenticated', s, 'EXECUTE') THEN failures := failures || ('10: authenticated can execute ' || s); END IF;
            IF NOT has_function_privilege('service_role', s, 'EXECUTE') THEN failures := failures || ('10: service_role cannot execute ' || s); END IF;
            IF EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(p.proacl) a WHERE p.oid = s::regprocedure AND a.grantee = 0) THEN
                failures := failures || ('10: PUBLIC grant on ' || s);
            END IF;
        END LOOP;
    EXCEPTION WHEN OTHERS THEN
        failures := failures || ('10 raised: ' || SQLERRM);
    END;

    RAISE EXCEPTION '%', 'RESULT: ' || coalesce(nullif(array_to_string(failures, '; ', '<NULL failure message>'), ''), 'ALL PASSED');
END
$test$;

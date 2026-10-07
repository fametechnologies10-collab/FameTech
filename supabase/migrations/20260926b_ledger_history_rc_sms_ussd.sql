-- Wallet history (wallet_transactions) was missing rows for real, correctly-charged
-- wallet debits (balances were always right; only the history/statement was short):
--   1. Results checker (dashboard + v2 API) wrote source 'results_checker', which the
--      source CHECK constraint rejected -> every insert failed silently (fire-and-forget).
--   2. activate_shop_sms / purchase_sms_bundle / purchase_user_sms_credits /
--      activate_shop_ussd debit the wallet in SQL and never wrote a history row.
-- This migration (A) allows 'results_checker', (B) makes the four functions write the
-- history row in the same transaction as the debit, and (C) backfills past rows.
-- Dry run 2026-09-26: 1,045 of 1,048 wallets reconcile exactly afterwards (from 977),
-- 0 over-explained; wallets.balance / total_spent are NOT touched.
-- See docs/security-audits/2026-09-24-client-order-forgery.md (F11).

-- ── A. Allow results_checker as a ledger source ─────────────────────────────
ALTER TABLE public.wallet_transactions DROP CONSTRAINT wallet_transactions_source_check;
ALTER TABLE public.wallet_transactions ADD CONSTRAINT wallet_transactions_source_check
  CHECK (source = ANY (ARRAY['payment','refund','admin','purchase','ussd','airtime','utility',
                             'retry','commission','results_checker']));

-- ── B. Write the history row alongside the debit ────────────────────────────
CREATE OR REPLACE FUNCTION public.activate_shop_sms(p_owner_id uuid, p_paid_from text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_shop_id UUID;
    v_fee     NUMERIC;
    v_rows    INTEGER;
BEGIN
    IF p_paid_from NOT IN ('wallet', 'profit') THEN
        RAISE EXCEPTION 'INVALID_SOURCE';
    END IF;

    SELECT id INTO v_shop_id FROM shop_profiles WHERE owner_id = p_owner_id;
    IF v_shop_id IS NULL THEN
        RAISE EXCEPTION 'SHOP_NOT_FOUND';
    END IF;

    IF EXISTS (SELECT 1 FROM shop_sms_activations WHERE shop_id = v_shop_id) THEN
        RAISE EXCEPTION 'ALREADY_ACTIVATED';
    END IF;

    SELECT COALESCE(NULLIF(TRIM(BOTH '"' FROM value::text), '')::numeric, 0) INTO v_fee
    FROM shop_global_settings WHERE key = 'sms_activation_fee';
    IF v_fee IS NULL THEN v_fee := 0; END IF;

    IF v_fee > 0 THEN
        IF p_paid_from = 'wallet' THEN
            UPDATE wallets
            SET balance     = balance - v_fee,
                total_spent = COALESCE(total_spent, 0) + v_fee,
                updated_at  = now()
            WHERE user_id = p_owner_id AND balance >= v_fee;
        ELSE
            UPDATE shop_wallets
            SET balance    = balance - v_fee,
                updated_at = now()
            WHERE owner_id = p_owner_id AND balance >= v_fee;
        END IF;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows = 0 THEN
            RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
        END IF;

        IF p_paid_from = 'wallet' THEN
            INSERT INTO wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
            SELECT id, p_owner_id, 'debit', v_fee, 'Shop SMS activation fee',
                   'SMSACT-' || v_shop_id::text, 'purchase', 'completed'
            FROM wallets WHERE user_id = p_owner_id;
        END IF;
    END IF;

    INSERT INTO shop_sms_activations (shop_id, owner_id, amount_paid, paid_from)
    VALUES (v_shop_id, p_owner_id, v_fee, p_paid_from);

    INSERT INTO shop_sms_wallets (shop_id, credits)
    VALUES (v_shop_id, 0)
    ON CONFLICT (shop_id) DO NOTHING;

    RETURN jsonb_build_object('success', true, 'amount_paid', v_fee);
END;
$function$;

CREATE OR REPLACE FUNCTION public.activate_shop_ussd(p_owner_id uuid, p_paid_from text, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_shop       shop_profiles%ROWTYPE;
    v_fee        NUMERIC;
    v_rows       INTEGER;
    v_constraint TEXT;
BEGIN
    IF p_paid_from NOT IN ('wallet', 'profit') THEN
        RAISE EXCEPTION 'INVALID_SOURCE';
    END IF;

    SELECT * INTO v_shop FROM shop_profiles WHERE owner_id = p_owner_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'SHOP_NOT_FOUND';
    END IF;

    IF v_shop.approval_status <> 'approved' OR COALESCE(v_shop.is_active, false) = false THEN
        RAISE EXCEPTION 'SHOP_NOT_APPROVED';
    END IF;

    -- Idempotent: if a code was EVER assigned, treat the shop as already
    -- activated and charge nothing — even if ussd_active was later toggled off.
    IF v_shop.ussd_code IS NOT NULL THEN
        RETURN jsonb_build_object(
            'success',        true,
            'code',           v_shop.ussd_code,
            'already_active', true,
            'amount_paid',    0
        );
    END IF;

    -- Fee from admin config only. admin_settings.value is JSONB stored as a
    -- quoted string e.g. "50.00" — strip the surrounding quotes before casting.
    SELECT COALESCE(NULLIF(trim(both '"' from value::text), '')::numeric, 50)
      INTO v_fee
      FROM admin_settings
     WHERE key = 'ussd_shop_activation_fee';
    IF v_fee IS NULL THEN
        v_fee := 50;
    END IF;
    IF v_fee < 0 THEN
        RAISE EXCEPTION 'INVALID_FEE';
    END IF;

    -- Atomic debit from the chosen balance (skipped when the fee is 0).
    IF v_fee > 0 THEN
        IF p_paid_from = 'wallet' THEN
            UPDATE wallets
               SET balance     = balance - v_fee,
                   total_spent = COALESCE(total_spent, 0) + v_fee,
                   updated_at  = now()
             WHERE user_id = p_owner_id AND balance >= v_fee;
        ELSE
            UPDATE shop_wallets
               SET balance    = balance - v_fee,
                   updated_at = now()
             WHERE owner_id = p_owner_id AND balance >= v_fee;
        END IF;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows = 0 THEN
            RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
        END IF;

        -- History row in the same transaction (rolled back with the debit if the
        -- activation below fails, e.g. CODE_TAKEN).
        IF p_paid_from = 'wallet' THEN
            INSERT INTO wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
            SELECT id, p_owner_id, 'debit', v_fee, 'Shop USSD activation fee',
                   'USSDACT-' || v_shop.id::text, 'purchase', 'completed'
            FROM wallets WHERE user_id = p_owner_id;
        END IF;
    END IF;

    -- Activate. Scope the unique handler to the ussd_code constraint — any OTHER
    -- future unique violation must surface (not be retried, re-running the debit).
    BEGIN
        UPDATE shop_profiles
           SET ussd_code         = p_code,
               ussd_active       = true,
               ussd_activated_at = now(),
               updated_at        = now()
         WHERE id = v_shop.id;
    EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF v_constraint ILIKE '%ussd_code%' THEN
            RAISE EXCEPTION 'CODE_TAKEN';
        ELSE
            RAISE;
        END IF;
    END;

    RETURN jsonb_build_object(
        'success',        true,
        'code',           p_code,
        'already_active', false,
        'amount_paid',    v_fee
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.purchase_sms_bundle(p_owner_id uuid, p_bundle_id uuid, p_paid_from text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_shop_id     UUID;
    v_credits     INTEGER;
    v_price       NUMERIC;
    v_rows        INTEGER;
    v_purchase_id UUID;
BEGIN
    IF p_paid_from NOT IN ('wallet', 'profit') THEN
        RAISE EXCEPTION 'INVALID_SOURCE';
    END IF;

    SELECT id INTO v_shop_id FROM shop_profiles WHERE owner_id = p_owner_id;
    IF v_shop_id IS NULL THEN
        RAISE EXCEPTION 'SHOP_NOT_FOUND';
    END IF;

    -- Must be activated first — server-side enforcement, not just UI
    IF NOT EXISTS (SELECT 1 FROM shop_sms_activations WHERE shop_id = v_shop_id) THEN
        RAISE EXCEPTION 'NOT_ACTIVATED';
    END IF;

    -- Price/credits come from the admin-configured bundle row only
    SELECT credits, price INTO v_credits, v_price
    FROM shop_sms_bundles
    WHERE id = p_bundle_id AND is_active = true;
    IF v_credits IS NULL THEN
        RAISE EXCEPTION 'BUNDLE_NOT_FOUND';
    END IF;

    -- Atomic debit
    IF p_paid_from = 'wallet' THEN
        UPDATE wallets
        SET balance = balance - v_price,
            total_spent = COALESCE(total_spent, 0) + v_price,
            updated_at = now()
        WHERE user_id = p_owner_id AND balance >= v_price;
    ELSE
        UPDATE shop_wallets
        SET balance = balance - v_price,
            updated_at = now()
        WHERE owner_id = p_owner_id AND balance >= v_price;
    END IF;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
        RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
    END IF;

    -- Credit the SMS wallet
    INSERT INTO shop_sms_wallets (shop_id, credits, total_purchased)
    VALUES (v_shop_id, v_credits, v_credits)
    ON CONFLICT (shop_id) DO UPDATE SET
        credits         = shop_sms_wallets.credits + v_credits,
        total_purchased = shop_sms_wallets.total_purchased + v_credits,
        updated_at      = now();

    INSERT INTO shop_sms_purchases (shop_id, owner_id, bundle_id, credits, price, paid_from)
    VALUES (v_shop_id, p_owner_id, p_bundle_id, v_credits, v_price, p_paid_from)
    RETURNING id INTO v_purchase_id;

    IF p_paid_from = 'wallet' THEN
        INSERT INTO wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
        SELECT id, p_owner_id, 'debit', v_price, 'SMS bundle: ' || v_credits || ' credits',
               'SHOPSMS-' || v_purchase_id::text, 'purchase', 'completed'
        FROM wallets WHERE user_id = p_owner_id;
    END IF;

    RETURN jsonb_build_object('success', true, 'credits_added', v_credits, 'price', v_price);
END;
$function$;

CREATE OR REPLACE FUNCTION public.purchase_user_sms_credits(p_user_id uuid, p_bundle_id uuid, p_paid_from text, p_payment_reference text DEFAULT NULL::text, p_verified_amount numeric DEFAULT NULL::numeric, p_client_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_acct        RECORD;
    v_bundle      RECORD;
    v_price       NUMERIC(10,2);
    v_key         TEXT;
    v_ledger_id   UUID;
    v_balance     INTEGER;
    v_purchase_id UUID;
BEGIN
    IF p_paid_from NOT IN ('wallet', 'momo') THEN
        RAISE EXCEPTION 'INVALID_SOURCE';
    END IF;

    SELECT a.*, w.credits AS wallet_credits
    INTO v_acct
    FROM sms_accounts a
    JOIN sms_wallets w ON w.account_id = a.id
    WHERE a.user_id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ACCOUNT_NOT_FOUND';
    END IF;
    IF v_acct.status <> 'active' THEN
        RAISE EXCEPTION 'ACCOUNT_SUSPENDED';
    END IF;

    SELECT * INTO v_bundle FROM sms_bundles
    WHERE id = p_bundle_id AND is_active = true;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'BUNDLE_NOT_FOUND';
    END IF;

    -- v2 GUARD: a bundle can only be bought by an account in its own mode
    -- (or a 'both'-mode bundle, purchasable from either mode).
    IF v_bundle.mode <> 'both' AND v_bundle.mode <> v_acct.mode THEN
        RAISE EXCEPTION 'BUNDLE_MODE_MISMATCH';
    END IF;

    v_price := v_bundle.price;   -- v2: business_price no longer consulted

    IF p_paid_from = 'momo' THEN
        IF p_payment_reference IS NULL OR length(trim(p_payment_reference)) < 6 THEN
            RAISE EXCEPTION 'MISSING_PAYMENT_REFERENCE';
        END IF;
        IF p_verified_amount IS NULL OR p_verified_amount <> v_price THEN
            RAISE EXCEPTION 'AMOUNT_MISMATCH';
        END IF;
        v_key := 'purchase:' || p_payment_reference;
    ELSE
        IF p_client_key IS NULL OR length(trim(p_client_key)) < 8 THEN
            RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY';
        END IF;
        v_key := 'purchase:' || p_client_key;
    END IF;

    -- Reserve the ledger key BEFORE moving any money.
    INSERT INTO sms_credit_ledger (account_id, delta, kind, idempotency_key, reference)
    VALUES (v_acct.id, v_bundle.credits, 'purchase', v_key, p_payment_reference)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_ledger_id;

    IF v_ledger_id IS NULL THEN
        RETURN jsonb_build_object('already_processed', true);
    END IF;

    IF p_paid_from = 'wallet' THEN
        PERFORM deduct_wallet_balance(p_user_id, v_price);
    END IF;

    UPDATE sms_wallets
    SET credits         = credits + v_bundle.credits,
        total_purchased = total_purchased + v_bundle.credits,
        updated_at      = now()
    WHERE account_id = v_acct.id
    RETURNING credits INTO v_balance;

    UPDATE sms_credit_ledger SET balance_after = v_balance WHERE id = v_ledger_id;

    INSERT INTO sms_purchases (account_id, user_id, bundle_id, credits, price, paid_from, payment_reference)
    VALUES (v_acct.id, p_user_id, p_bundle_id, v_bundle.credits, v_price, p_paid_from, p_payment_reference)
    RETURNING id INTO v_purchase_id;

    IF p_paid_from = 'wallet' THEN
        INSERT INTO wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
        SELECT id, p_user_id, 'debit', v_price, 'SMS credits: ' || v_bundle.credits,
               'SMSCRED-' || v_purchase_id::text, 'purchase', 'completed'
        FROM wallets WHERE user_id = p_user_id;
    END IF;

    RETURN jsonb_build_object(
        'already_processed', false,
        'credits_added', v_bundle.credits,
        'price', v_price,
        'balance', v_balance
    );
END;
$function$;

-- ── C. Backfill history for past charges (history only; balances untouched) ─
-- Same reference scheme as B, and NOT EXISTS keeps every step idempotent.
INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status, created_at)
SELECT w.id, a.owner_id, 'debit', a.amount_paid, 'Shop SMS activation fee',
       'SMSACT-' || a.shop_id::text, 'purchase', 'completed', a.created_at
FROM public.shop_sms_activations a JOIN public.wallets w ON w.user_id = a.owner_id
WHERE a.paid_from = 'wallet' AND a.amount_paid > 0
  AND NOT EXISTS (SELECT 1 FROM public.wallet_transactions t WHERE t.reference = 'SMSACT-' || a.shop_id::text);

INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status, created_at)
SELECT w.id, p.owner_id, 'debit', p.price, 'SMS bundle: ' || p.credits || ' credits',
       'SHOPSMS-' || p.id::text, 'purchase', 'completed', p.created_at
FROM public.shop_sms_purchases p JOIN public.wallets w ON w.user_id = p.owner_id
WHERE p.paid_from = 'wallet'
  AND NOT EXISTS (SELECT 1 FROM public.wallet_transactions t WHERE t.reference = 'SHOPSMS-' || p.id::text);

INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status, created_at)
SELECT w.id, s.user_id, 'debit', s.price, 'SMS credits: ' || s.credits,
       'SMSCRED-' || s.id::text, 'purchase', 'completed', s.created_at
FROM public.sms_purchases s JOIN public.wallets w ON w.user_id = s.user_id
WHERE s.paid_from = 'wallet'
  AND NOT EXISTS (SELECT 1 FROM public.wallet_transactions t WHERE t.reference = 'SMSCRED-' || s.id::text);

-- Results checker bought with the wallet (dashboard + v2 API): user set, no shop,
-- source website/api. Failed orders are excluded (their debit was refunded).
INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status, created_at)
SELECT w.id, r.user_id, 'debit', r.total_paid, 'Results Checker: ' || r.quantity || 'x ' || r.type_name,
       r.reference_code, 'results_checker', 'completed', r.created_at
FROM public.results_checker_orders r JOIN public.wallets w ON w.user_id = r.user_id
WHERE r.user_id IS NOT NULL AND r.shop_id IS NULL AND r.source IN ('website', 'api') AND r.status <> 'failed'
  AND NOT EXISTS (SELECT 1 FROM public.wallet_transactions t WHERE t.type = 'debit' AND t.reference = r.reference_code);

-- Those orders were labelled with the column default 'momo'; they were wallet-paid.
UPDATE public.results_checker_orders
   SET payment_method = 'wallet'
 WHERE user_id IS NOT NULL AND shop_id IS NULL AND source IN ('website', 'api') AND payment_method = 'momo';

-- USSD activation fee: the amount charged (and whether it came from the wallet or shop
-- profit) was never recorded, so only backfill where the owner's remaining ledger-vs-balance
-- gap is EXACTLY one plausible fee (30 or 50) — gaps cluster sharply on those two values.
-- Labelled "(reconstructed)" so the statement is honest that it was inferred.
WITH ledger AS (
    SELECT user_id, SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END) AS net
    FROM public.wallet_transactions WHERE status = 'completed' GROUP BY user_id
)
INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status, created_at)
SELECT w.id, sp.owner_id, 'debit', ROUND(l.net - w.balance, 2), 'Shop USSD activation fee (reconstructed)',
       'USSDACT-' || sp.id::text, 'purchase', 'completed', sp.ussd_activated_at
FROM public.shop_profiles sp
JOIN public.wallets w ON w.user_id = sp.owner_id
JOIN ledger l ON l.user_id = sp.owner_id
WHERE sp.ussd_activated_at IS NOT NULL
  AND ROUND(l.net - w.balance, 2) IN (30, 50)
  AND NOT EXISTS (SELECT 1 FROM public.wallet_transactions t WHERE t.reference = 'USSDACT-' || sp.id::text);

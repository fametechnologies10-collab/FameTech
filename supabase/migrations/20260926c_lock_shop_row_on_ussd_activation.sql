-- activate_shop_ussd read the shop row without a lock and treated "ussd_code IS NULL" as
-- "not yet activated". Two concurrent calls (double-submit / retry) could both pass that
-- check, both debit the fee, and the second UPDATE would overwrite the first code — a
-- double charge. Lock the shop row first (FOR UPDATE): the second call waits, then sees
-- the code the first one set and returns already_active without charging.
-- Body otherwise identical to 20260926b_ledger_history_rc_sms_ussd.sql. (F15)
-- (activate_shop_sms is already protected by UNIQUE(shop_sms_activations.shop_id).)

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

    -- Lock the shop row so concurrent activations serialise on it (F15).
    SELECT * INTO v_shop FROM shop_profiles WHERE owner_id = p_owner_id FOR UPDATE;
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

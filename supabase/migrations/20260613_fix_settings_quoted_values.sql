-- ── Fix quoted numeric values in shop_global_settings ────────────────────────
-- Root cause: admin UI stored values as JSON strings (e.g. "50" instead of 50),
-- leaving embedded double-quotes that break ::numeric casts inside RPCs.
-- value column is jsonb, so all comparisons/trims require ::text cast first.

-- 1. Strip embedded double-quotes from all numeric settings
UPDATE shop_global_settings
SET value = to_jsonb(TRIM(BOTH '"' FROM value::text))
WHERE key IN (
    'sms_activation_fee',
    'sms_max_recipients_per_send',
    'sms_sends_per_hour',
    'sms_recipients_per_day',
    'sms_welcome_bonus_credits'
)
  AND value::text LIKE '"%"';

-- 2. Harden activate_shop_sms — strip quotes before casting to numeric.
--    value is jsonb; cast to text then trim before ::numeric.
CREATE OR REPLACE FUNCTION public.activate_shop_sms(
    p_owner_id  UUID,
    p_paid_from TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

    -- Cast jsonb→text, strip any embedded quotes, then cast to numeric
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
    END IF;

    INSERT INTO shop_sms_activations (shop_id, owner_id, amount_paid, paid_from)
    VALUES (v_shop_id, p_owner_id, v_fee, p_paid_from);

    INSERT INTO shop_sms_wallets (shop_id, credits)
    VALUES (v_shop_id, 0)
    ON CONFLICT (shop_id) DO NOTHING;

    RETURN jsonb_build_object('success', true, 'amount_paid', v_fee);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.activate_shop_sms(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.activate_shop_sms(UUID, TEXT) TO service_role;

-- ── Security Fixes (HIGH-1, HIGH-2, MEDIUM-2) ───────────────────────────────
-- 1. claim_sms_welcome_bonus — atomic RPC (replaces two-step credit + mark)
-- 2. sms_templates SELECT policy for authenticated users (fixes blank template panel)

-- 1. Atomic bonus claim -------------------------------------------------------
--    Reads bonus credit count from admin settings, marks bonus_claimed = true,
--    and credits the SMS wallet — all in a single transaction.
--    Raises ALREADY_CLAIMED if the bonus was already used.
CREATE OR REPLACE FUNCTION public.claim_sms_welcome_bonus(p_shop_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_credits_text  TEXT;
    v_credits       INTEGER;
BEGIN
    -- Read admin-configured credit count; default 10, cap at 500
    SELECT value INTO v_credits_text
    FROM shop_global_settings
    WHERE key = 'sms_welcome_bonus_credits';

    BEGIN
        v_credits := v_credits_text::INTEGER;
    EXCEPTION WHEN OTHERS THEN
        v_credits := 10;
    END;

    IF v_credits IS NULL OR v_credits <= 0 OR v_credits > 500 THEN
        v_credits := 10;
    END IF;

    -- Mark bonus claimed (UPDATE returns 0 rows if already claimed → raise)
    UPDATE shop_sms_activations
    SET bonus_claimed    = true,
        bonus_claimed_at = now()
    WHERE shop_id = p_shop_id
      AND bonus_claimed = false;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ALREADY_CLAIMED';
    END IF;

    -- Credit the SMS wallet atomically
    INSERT INTO shop_sms_wallets (shop_id, credits, total_purchased, total_used)
    VALUES (p_shop_id, v_credits, v_credits, 0)
    ON CONFLICT (shop_id) DO UPDATE
    SET credits         = shop_sms_wallets.credits         + v_credits,
        total_purchased = shop_sms_wallets.total_purchased + v_credits,
        updated_at      = now();

    RETURN jsonb_build_object('success', true, 'credits_added', v_credits);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_sms_welcome_bonus(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_sms_welcome_bonus(UUID) TO service_role;

-- 2. Allow authenticated users to read global SMS templates -------------------
--    Without this policy the sms_templates table returns 0 rows to shop owners,
--    making the "Platform Templates" tab permanently empty.
CREATE POLICY sms_templates_authenticated_read ON public.sms_templates
    FOR SELECT TO authenticated
    USING (true);

-- ============================================================
-- Migration: Shop SMS Anti-Fraud Controls
-- Created: 2026-06-16
-- Adds:
--   1. Per-shop SMS suspend flag (admin abuse switch)
--   2. Admin-configurable EXTRA allowed link domains setting
-- Both are additive / safe (new column defaults false, new setting row).
-- ============================================================

-- 1. Per-shop SMS suspend flag.
--    Admin-controlled abuse switch. Owners have SELECT-only RLS on
--    shop_sms_activations (see 20260612_shop_phase_c.sql), so they cannot
--    self-unsuspend. The send route (app/api/shop/sms/send/route.ts) checks
--    this server-side and rejects sends before any credit debit.
ALTER TABLE public.shop_sms_activations
    ADD COLUMN IF NOT EXISTS sms_suspended BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.shop_sms_activations.sms_suspended IS
    'Admin abuse switch — when true the shop cannot send SMS. Admin-write only.';

-- 2. Extra allowed link domains (comma-separated host list).
--    ADDITIVE to the built-in KiNG FLEXY + social allowlist baked into
--    lib/sms-content-filter.ts (WhatsApp / Facebook / Instagram / X / Telegram).
--    Lets admins permit e.g. tiktok.com or youtube.com without a deploy.
--    Empty string = built-in defaults only. Read by the send route and editable
--    from /admin/shop-sms. shop_global_settings is publicly READABLE but
--    admin-WRITE only (see 20260406_fix_rls_vulnerabilities.sql) — a non-secret
--    allowlist is safe to expose.
-- NOTE: shop_global_settings.value is JSONB, so the empty default must be a
-- valid JSON string ("") — a bare '' is invalid JSON. The admin PATCH stores
-- the domain list as a JSON string too, so this round-trips via String(value).
INSERT INTO public.shop_global_settings (key, value)
VALUES ('sms_allowed_link_domains', '""')
ON CONFLICT (key) DO NOTHING;

-- 3. Make the suspend gate ATOMIC with the credit debit.
--    The send route pre-checks sms_suspended, but that check and the debit are
--    two round-trips — an admin suspending a shop in that window could let one
--    more send through (TOCTOU). Moving the guard inside debit_sms_credits
--    closes the race: a suspended shop can never complete a debit, so the
--    route never reaches the provider send. Mirrors the existing NOT_ACTIVATED
--    guard already inside this function (20260612_shop_phase_c.sql).
CREATE OR REPLACE FUNCTION public.debit_sms_credits(
    p_shop_id UUID,
    p_credits INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_new_credits INTEGER;
BEGIN
    IF p_credits IS NULL OR p_credits <= 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT';
    END IF;

    -- Activation gate is INSIDE the atomic debit — a revoked activation can
    -- never slip through between a separate check and the debit (TOCTOU).
    IF NOT EXISTS (SELECT 1 FROM shop_sms_activations WHERE shop_id = p_shop_id) THEN
        RAISE EXCEPTION 'NOT_ACTIVATED';
    END IF;

    -- Suspend gate (admin abuse switch) — also atomic with the debit.
    IF EXISTS (SELECT 1 FROM shop_sms_activations WHERE shop_id = p_shop_id AND sms_suspended = true) THEN
        RAISE EXCEPTION 'SUSPENDED';
    END IF;

    UPDATE shop_sms_wallets
    SET credits    = credits - p_credits,
        total_used = total_used + p_credits,
        updated_at = now()
    WHERE shop_id = p_shop_id AND credits >= p_credits
    RETURNING credits INTO v_new_credits;

    IF v_new_credits IS NULL THEN
        RAISE EXCEPTION 'INSUFFICIENT_CREDITS';
    END IF;

    RETURN jsonb_build_object('success', true, 'remaining', v_new_credits);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.debit_sms_credits(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_sms_credits(UUID, INTEGER) TO service_role;

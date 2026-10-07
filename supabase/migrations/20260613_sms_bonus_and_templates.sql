-- ── SMS Bonus + Shop Templates ─────────────────────────────────────────────
-- 1. Track first-activation welcome bonus on shop_sms_activations
-- 2. Shop-owned SMS message templates with RLS

-- 1. Welcome bonus tracking
ALTER TABLE shop_sms_activations
    ADD COLUMN IF NOT EXISTS bonus_claimed      boolean   NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS bonus_claimed_at   timestamptz;

-- 2. Per-shop SMS templates (separate from admin global sms_templates)
CREATE TABLE IF NOT EXISTS shop_sms_templates (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id     uuid        NOT NULL REFERENCES shop_profiles(id) ON DELETE CASCADE,
    name        text        NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 60),
    body        text        NOT NULL CHECK (char_length(trim(body)) BETWEEN 3 AND 1000),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shop_sms_templates_shop_id_idx ON shop_sms_templates(shop_id);

ALTER TABLE shop_sms_templates ENABLE ROW LEVEL SECURITY;

-- Owners can manage their own shop's templates
CREATE POLICY shop_sms_templates_select ON shop_sms_templates
    FOR SELECT USING (shop_id IN (
        SELECT id FROM shop_profiles WHERE owner_id = (SELECT auth.uid())
    ));

CREATE POLICY shop_sms_templates_insert ON shop_sms_templates
    FOR INSERT WITH CHECK (shop_id IN (
        SELECT id FROM shop_profiles WHERE owner_id = (SELECT auth.uid())
    ));

CREATE POLICY shop_sms_templates_update ON shop_sms_templates
    FOR UPDATE
    USING      (shop_id IN (SELECT id FROM shop_profiles WHERE owner_id = (SELECT auth.uid())))
    WITH CHECK (shop_id IN (SELECT id FROM shop_profiles WHERE owner_id = (SELECT auth.uid())));

CREATE POLICY shop_sms_templates_delete ON shop_sms_templates
    FOR DELETE USING (shop_id IN (
        SELECT id FROM shop_profiles WHERE owner_id = (SELECT auth.uid())
    ));

-- Admins can manage all templates
CREATE POLICY shop_sms_templates_admin ON shop_sms_templates
    FOR ALL USING (is_admin());

-- 3. credit_sms_credits RPC — add purchased/bonus credits to an SMS wallet.
--    Increments both `credits` (spendable) and `total_purchased`.
--    service_role only; never called by authenticated users directly.
CREATE OR REPLACE FUNCTION public.credit_sms_credits(
    p_shop_id UUID,
    p_credits INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_credits IS NULL OR p_credits <= 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT';
    END IF;

    INSERT INTO shop_sms_wallets (shop_id, credits, total_purchased, total_used)
    VALUES (p_shop_id, p_credits, p_credits, 0)
    ON CONFLICT (shop_id) DO UPDATE
    SET credits          = shop_sms_wallets.credits          + p_credits,
        total_purchased  = shop_sms_wallets.total_purchased  + p_credits,
        updated_at       = now();

    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.credit_sms_credits(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.credit_sms_credits(UUID, INTEGER) TO service_role;

-- 4. Admin setting for welcome bonus credit count (default 10)
INSERT INTO shop_global_settings (key, value)
VALUES ('sms_welcome_bonus_credits', '10')
ON CONFLICT (key) DO NOTHING;

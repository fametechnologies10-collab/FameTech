-- supabase/migrations/20260612_ussd_storefront.sql
-- =============================================================================
-- USSD Storefront Mode
-- =============================================================================

-- 1. shop_profiles: USSD activation columns
ALTER TABLE public.shop_profiles
    ADD COLUMN IF NOT EXISTS ussd_code         TEXT UNIQUE,
    ADD COLUMN IF NOT EXISTS ussd_active       BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS ussd_activated_at TIMESTAMPTZ;

-- 2. shop_orders: source tag for USSD vs web
ALTER TABLE public.shop_orders
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'website';

-- 3. ussd_pending_orders: link to shop context (NULL = admin USSD, set = shop USSD)
ALTER TABLE public.ussd_pending_orders
    ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES public.shop_profiles(id);

-- 4. shop_wallet_transactions: idempotency key for non-shop-order credits (RC)
ALTER TABLE public.shop_wallet_transactions
    ADD COLUMN IF NOT EXISTS ussd_ref TEXT UNIQUE;

-- 5. Admin setting keys for storefront mode
INSERT INTO public.admin_settings (key, value) VALUES
    ('ussd_storefront_mode',     '"false"'),
    ('ussd_shop_activation_fee', '"50.00"'),
    ('ussd_shortcode',           '"*711*9939#"')
ON CONFLICT (key) DO NOTHING;

-- 6. Fast lookup for shop code validation
CREATE INDEX IF NOT EXISTS idx_shop_profiles_ussd_code
    ON public.shop_profiles(ussd_code)
    WHERE ussd_active = true;

-- 7. RPC: credit shop wallet for RC orders (idempotent, atomic)
--    Used instead of credit_shop_profit when there is no shop_orders row.
CREATE OR REPLACE FUNCTION public.credit_shop_ussd_profit(
    p_shop_id     UUID,
    p_profit      DECIMAL,
    p_ussd_ref    TEXT,
    p_description TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_owner_id   UUID;
    v_wallet_id  UUID;
BEGIN
    IF p_profit <= 0 THEN
        RETURN jsonb_build_object('success', false, 'message', 'No profit to credit');
    END IF;

    -- Idempotency: skip if already credited with this ref
    IF EXISTS (
        SELECT 1 FROM public.shop_wallet_transactions WHERE ussd_ref = p_ussd_ref
    ) THEN
        RETURN jsonb_build_object('success', true, 'message', 'Already credited');
    END IF;

    -- Get shop owner
    SELECT owner_id INTO v_owner_id FROM public.shop_profiles WHERE id = p_shop_id;
    IF v_owner_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Shop not found');
    END IF;

    -- Upsert wallet
    INSERT INTO public.shop_wallets (owner_id, balance, total_earned)
    VALUES (v_owner_id, 0, 0)
    ON CONFLICT (owner_id) DO NOTHING;

    SELECT id INTO v_wallet_id FROM public.shop_wallets WHERE owner_id = v_owner_id;

    -- Atomic credit
    UPDATE public.shop_wallets
    SET balance       = balance + p_profit,
        total_earned  = total_earned + p_profit,
        updated_at    = NOW()
    WHERE id = v_wallet_id;

    -- Log with idempotency ref
    INSERT INTO public.shop_wallet_transactions
        (shop_wallet_id, type, amount, description, status, ussd_ref)
    VALUES
        (v_wallet_id, 'profit', p_profit, p_description, 'completed', p_ussd_ref);

    RETURN jsonb_build_object('success', true, 'message', 'Credited ' || p_profit);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$;

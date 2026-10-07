-- ============================================================
-- Shop Mega-Update Phase C
-- 1. shop_customers — per-shop customer book (auto-built from orders)
-- 2. Shop SMS system — activation, bundles, credits, logs
-- 3. Atomic RPCs for activation / purchase / credit debit
-- ============================================================

-- ════════════════════════════════════════════════════════════
-- 1. SHOP CUSTOMERS
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.shop_customers (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id        UUID NOT NULL REFERENCES public.shop_profiles(id) ON DELETE CASCADE,
    phone          TEXT NOT NULL,
    name           TEXT,
    tags           TEXT[] NOT NULL DEFAULT '{}',
    notes          TEXT,
    total_orders   INTEGER NOT NULL DEFAULT 0,
    total_spent    NUMERIC(12,2) NOT NULL DEFAULT 0,
    first_order_at TIMESTAMPTZ,
    last_order_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (shop_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_shop_customers_shop ON public.shop_customers(shop_id);
CREATE INDEX IF NOT EXISTS idx_shop_customers_last_order ON public.shop_customers(shop_id, last_order_at DESC);

ALTER TABLE public.shop_customers ENABLE ROW LEVEL SECURITY;

-- Owners can read their own customers (no cross-shop access — enforced at row level)
DROP POLICY IF EXISTS "shop_customers_owner_select" ON public.shop_customers;
CREATE POLICY "shop_customers_owner_select" ON public.shop_customers
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.shop_profiles sp
            WHERE sp.id = shop_customers.shop_id
              AND sp.owner_id = (SELECT auth.uid())
        )
    );

-- Owners may update tags/notes only — column-level enforcement happens in the
-- API route; row-level ownership is enforced here.
DROP POLICY IF EXISTS "shop_customers_owner_update" ON public.shop_customers;
CREATE POLICY "shop_customers_owner_update" ON public.shop_customers
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM public.shop_profiles sp
            WHERE sp.id = shop_customers.shop_id
              AND sp.owner_id = (SELECT auth.uid())
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.shop_profiles sp
            WHERE sp.id = shop_customers.shop_id
              AND sp.owner_id = (SELECT auth.uid())
        )
    );

-- INSERT/DELETE intentionally have no policies — rows are written only by the
-- trigger below (SECURITY DEFINER) and the service role.

-- Column-level write protection: owners may only edit tags/notes via
-- PostgREST; system-managed columns (totals, timestamps, phone) are
-- writable only by the service role and triggers.
REVOKE UPDATE ON public.shop_customers FROM authenticated;
GRANT UPDATE (tags, notes, updated_at) ON public.shop_customers TO authenticated;

-- ─── Upsert trigger: data/airtime orders ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_shop_customer_from_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.shop_id IS NULL OR NEW.guest_phone IS NULL OR NEW.guest_phone = '' THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.shop_customers (shop_id, phone, total_orders, total_spent, first_order_at, last_order_at)
    VALUES (NEW.shop_id, NEW.guest_phone, 1, COALESCE(NEW.selling_price, 0), NEW.created_at, NEW.created_at)
    ON CONFLICT (shop_id, phone) DO UPDATE SET
        total_orders  = shop_customers.total_orders + 1,
        total_spent   = shop_customers.total_spent + COALESCE(NEW.selling_price, 0),
        last_order_at = GREATEST(shop_customers.last_order_at, NEW.created_at),
        updated_at    = now();

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shop_customers_from_orders ON public.shop_orders;
CREATE TRIGGER trg_shop_customers_from_orders
    AFTER INSERT ON public.shop_orders
    FOR EACH ROW EXECUTE FUNCTION public.upsert_shop_customer_from_order();

-- ─── Upsert trigger: results checker orders ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_shop_customer_from_rc_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.shop_id IS NULL OR NEW.customer_phone IS NULL OR NEW.customer_phone = '' THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.shop_customers (shop_id, phone, total_orders, total_spent, first_order_at, last_order_at)
    VALUES (
        NEW.shop_id, NEW.customer_phone, 1,
        COALESCE(NEW.unit_price, 0) * COALESCE(NEW.quantity, 1),
        NEW.created_at, NEW.created_at
    )
    ON CONFLICT (shop_id, phone) DO UPDATE SET
        total_orders  = shop_customers.total_orders + 1,
        total_spent   = shop_customers.total_spent + (COALESCE(NEW.unit_price, 0) * COALESCE(NEW.quantity, 1)),
        last_order_at = GREATEST(shop_customers.last_order_at, NEW.created_at),
        updated_at    = now();

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shop_customers_from_rc_orders ON public.results_checker_orders;
CREATE TRIGGER trg_shop_customers_from_rc_orders
    AFTER INSERT ON public.results_checker_orders
    FOR EACH ROW EXECUTE FUNCTION public.upsert_shop_customer_from_rc_order();

-- ─── Backfill from existing orders ───────────────────────────────────────────
INSERT INTO public.shop_customers (shop_id, phone, total_orders, total_spent, first_order_at, last_order_at)
SELECT shop_id, guest_phone, COUNT(*), COALESCE(SUM(selling_price), 0), MIN(created_at), MAX(created_at)
FROM public.shop_orders
WHERE shop_id IS NOT NULL AND guest_phone IS NOT NULL AND guest_phone <> ''
GROUP BY shop_id, guest_phone
ON CONFLICT (shop_id, phone) DO NOTHING;

INSERT INTO public.shop_customers (shop_id, phone, total_orders, total_spent, first_order_at, last_order_at)
SELECT shop_id, customer_phone, COUNT(*),
       COALESCE(SUM(COALESCE(unit_price, 0) * COALESCE(quantity, 1)), 0),
       MIN(created_at), MAX(created_at)
FROM public.results_checker_orders
WHERE shop_id IS NOT NULL AND customer_phone IS NOT NULL AND customer_phone <> ''
  AND payment_status <> 'pending_payment'
GROUP BY shop_id, customer_phone
ON CONFLICT (shop_id, phone) DO UPDATE SET
    total_orders  = shop_customers.total_orders + EXCLUDED.total_orders,
    total_spent   = shop_customers.total_spent + EXCLUDED.total_spent,
    last_order_at = GREATEST(shop_customers.last_order_at, EXCLUDED.last_order_at),
    updated_at    = now();

-- ════════════════════════════════════════════════════════════
-- 2. SHOP SMS SYSTEM
-- ════════════════════════════════════════════════════════════

-- One-time paid activation per shop
CREATE TABLE IF NOT EXISTS public.shop_sms_activations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id     UUID NOT NULL UNIQUE REFERENCES public.shop_profiles(id) ON DELETE CASCADE,
    owner_id    UUID NOT NULL REFERENCES public.users(id),
    amount_paid NUMERIC(10,2) NOT NULL CHECK (amount_paid >= 0),
    paid_from   TEXT NOT NULL CHECK (paid_from IN ('wallet', 'profit')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Admin-configured bundle tiers
CREATE TABLE IF NOT EXISTS public.shop_sms_bundles (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    credits    INTEGER NOT NULL CHECK (credits > 0),
    price      NUMERIC(10,2) NOT NULL CHECK (price > 0),
    is_active  BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Credit balance per shop
CREATE TABLE IF NOT EXISTS public.shop_sms_wallets (
    shop_id         UUID PRIMARY KEY REFERENCES public.shop_profiles(id) ON DELETE CASCADE,
    credits         INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
    total_purchased INTEGER NOT NULL DEFAULT 0,
    total_used      INTEGER NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bundle purchase records (admin revenue reporting)
CREATE TABLE IF NOT EXISTS public.shop_sms_purchases (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id    UUID NOT NULL REFERENCES public.shop_profiles(id) ON DELETE CASCADE,
    owner_id   UUID NOT NULL REFERENCES public.users(id),
    bundle_id  UUID REFERENCES public.shop_sms_bundles(id),
    credits    INTEGER NOT NULL CHECK (credits > 0),
    price      NUMERIC(10,2) NOT NULL CHECK (price > 0),
    paid_from  TEXT NOT NULL CHECK (paid_from IN ('wallet', 'profit')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shop_sms_purchases_shop ON public.shop_sms_purchases(shop_id);

-- Send logs (transparency + admin flag review)
CREATE TABLE IF NOT EXISTS public.shop_sms_logs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id          UUID NOT NULL REFERENCES public.shop_profiles(id) ON DELETE CASCADE,
    message          TEXT NOT NULL,
    recipients_count INTEGER NOT NULL CHECK (recipients_count > 0),
    segments         INTEGER NOT NULL CHECK (segments > 0),
    credits_used     INTEGER NOT NULL CHECK (credits_used >= 0),
    status           TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'partial', 'failed', 'blocked')),
    flagged          BOOLEAN NOT NULL DEFAULT false,
    flag_reason      TEXT,
    provider         TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shop_sms_logs_shop ON public.shop_sms_logs(shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shop_sms_logs_flagged ON public.shop_sms_logs(flagged) WHERE flagged = true;

-- Failed credit refunds (provider partially failed AND the refund RPC also
-- failed) — replayable by admin/cron so credits are never silently lost.
CREATE TABLE IF NOT EXISTS public.shop_sms_refund_failures (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id    UUID NOT NULL REFERENCES public.shop_profiles(id) ON DELETE CASCADE,
    credits    INTEGER NOT NULL CHECK (credits > 0),
    reason     TEXT,
    resolved   BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.shop_sms_refund_failures ENABLE ROW LEVEL SECURITY;
-- service-role only (no client policies)

-- ─── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.shop_sms_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_sms_bundles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_sms_wallets     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_sms_purchases   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_sms_logs        ENABLE ROW LEVEL SECURITY;

-- Owners read their own activation / wallet / purchases / logs
DROP POLICY IF EXISTS "sms_activations_owner_select" ON public.shop_sms_activations;
CREATE POLICY "sms_activations_owner_select" ON public.shop_sms_activations
    FOR SELECT USING (owner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "sms_wallets_owner_select" ON public.shop_sms_wallets;
CREATE POLICY "sms_wallets_owner_select" ON public.shop_sms_wallets
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.shop_profiles sp
            WHERE sp.id = shop_sms_wallets.shop_id
              AND sp.owner_id = (SELECT auth.uid())
        )
    );

DROP POLICY IF EXISTS "sms_purchases_owner_select" ON public.shop_sms_purchases;
CREATE POLICY "sms_purchases_owner_select" ON public.shop_sms_purchases
    FOR SELECT USING (owner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "sms_logs_owner_select" ON public.shop_sms_logs;
CREATE POLICY "sms_logs_owner_select" ON public.shop_sms_logs
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.shop_profiles sp
            WHERE sp.id = shop_sms_logs.shop_id
              AND sp.owner_id = (SELECT auth.uid())
        )
    );

-- Bundle tiers are public-readable (displayed on the purchase page)
DROP POLICY IF EXISTS "sms_bundles_public_read" ON public.shop_sms_bundles;
CREATE POLICY "sms_bundles_public_read" ON public.shop_sms_bundles
    FOR SELECT USING (is_active = true);

-- All writes go through SECURITY DEFINER RPCs / service role — no client
-- INSERT/UPDATE/DELETE policies on any SMS table.

-- ════════════════════════════════════════════════════════════
-- 3. ATOMIC RPCs
--    Execution restricted to service_role — client roles cannot
--    call these directly (prevents spoofed owner IDs).
-- ════════════════════════════════════════════════════════════

-- ─── Activate SMS feature (one-time paid) ────────────────────────────────────
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

    -- Already activated? (unique constraint is the backstop)
    IF EXISTS (SELECT 1 FROM shop_sms_activations WHERE shop_id = v_shop_id) THEN
        RAISE EXCEPTION 'ALREADY_ACTIVATED';
    END IF;

    -- Fee comes from admin config only — never from the caller
    SELECT COALESCE(NULLIF(value::text, '')::numeric, 0) INTO v_fee
    FROM shop_global_settings WHERE key = 'sms_activation_fee';
    IF v_fee IS NULL THEN v_fee := 0; END IF;

    -- Atomic debit from the chosen wallet
    IF v_fee > 0 THEN
        IF p_paid_from = 'wallet' THEN
            UPDATE wallets
            SET balance = balance - v_fee,
                total_spent = COALESCE(total_spent, 0) + v_fee,
                updated_at = now()
            WHERE user_id = p_owner_id AND balance >= v_fee;
        ELSE
            UPDATE shop_wallets
            SET balance = balance - v_fee,
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
GRANT EXECUTE ON FUNCTION public.activate_shop_sms(UUID, TEXT) TO service_role;

-- ─── Purchase an SMS bundle ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.purchase_sms_bundle(
    p_owner_id  UUID,
    p_bundle_id UUID,
    p_paid_from TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_shop_id UUID;
    v_credits INTEGER;
    v_price   NUMERIC;
    v_rows    INTEGER;
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
    VALUES (v_shop_id, p_owner_id, p_bundle_id, v_credits, v_price, p_paid_from);

    RETURN jsonb_build_object('success', true, 'credits_added', v_credits, 'price', v_price);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.purchase_sms_bundle(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_sms_bundle(UUID, UUID, TEXT) TO service_role;

-- ─── Atomic SMS credit debit ─────────────────────────────────────────────────
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

-- ─── Refund SMS credits (partial provider failure) ───────────────────────────
CREATE OR REPLACE FUNCTION public.refund_sms_credits(
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

    UPDATE shop_sms_wallets
    SET credits    = credits + p_credits,
        total_used = GREATEST(0, total_used - p_credits),
        updated_at = now()
    WHERE shop_id = p_shop_id;

    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.refund_sms_credits(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_sms_credits(UUID, INTEGER) TO service_role;

-- ─── Default admin settings (only inserted if missing) ───────────────────────
INSERT INTO public.shop_global_settings (key, value)
VALUES
    ('sms_feature_enabled', 'true'),
    ('sms_activation_fee', '50'),
    ('sms_max_recipients_per_send', '100'),
    ('sms_sends_per_hour', '10'),
    ('sms_recipients_per_day', '500')
ON CONFLICT (key) DO NOTHING;

-- ─── Default bundle tiers (only if table is empty) ───────────────────────────
INSERT INTO public.shop_sms_bundles (name, credits, price, sort_order)
SELECT * FROM (VALUES
    ('Starter',  100,  10.00::numeric, 1),
    ('Growth',   500,  45.00::numeric, 2),
    ('Business', 1000, 80.00::numeric, 3)
) AS v(name, credits, price, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.shop_sms_bundles);

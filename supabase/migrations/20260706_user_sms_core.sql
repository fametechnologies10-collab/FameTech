-- ============================================================================
-- USER SMS PLATFORM — CORE (accounts, wallets, credit ledger, bundles, purchases)
-- Part 1 of 3. Campaigns/messages: 20260706b. Sender IDs/KYC: 20260706c.
--
-- Design (docs/superpowers/plans/2026-07-06-user-sms-provider-platform.md):
--  * Standalone product, user-keyed (NOT shop-keyed like shop_sms_*).
--  * Every credit mutation writes sms_credit_ledger with a UNIQUE
--    idempotency_key — the ledger row is inserted FIRST (key reservation);
--    any later failure rolls the whole transaction back. Retries with the
--    same key return already_processed instead of double-moving credits.
--  * All money/credit RPCs are SECURITY DEFINER, EXECUTE revoked from
--    PUBLIC/anon/authenticated, granted to service_role only. Routes
--    authenticate the user first, then call via the admin client with the
--    server-derived user id.
--  * Feature ships OFF: admin_settings.user_sms_enabled = false (JSONB).
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sms_accounts (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    -- 'business' requires an APPROVED sms_business_profiles row (20260706c).
    mode             TEXT NOT NULL DEFAULT 'platform' CHECK (mode IN ('platform', 'business')),
    status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    suspended_reason TEXT,
    -- Chosen sender from the admin default pool (business mode, pre-own-sender).
    default_sender   TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE sms_accounts IS
    'User SMS platform account. mode=business unlocks telco-only filter + sender choice; admin-write only.';

CREATE TABLE IF NOT EXISTS sms_wallets (
    account_id      UUID PRIMARY KEY REFERENCES sms_accounts(id) ON DELETE CASCADE,
    credits         INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
    total_purchased INTEGER NOT NULL DEFAULT 0,
    total_used      INTEGER NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sms_credit_ledger (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      UUID NOT NULL REFERENCES sms_accounts(id) ON DELETE CASCADE,
    delta           INTEGER NOT NULL,
    balance_after   INTEGER,
    kind            TEXT NOT NULL CHECK (kind IN ('purchase', 'debit', 'refund', 'bonus', 'admin_adjust')),
    idempotency_key TEXT NOT NULL UNIQUE,
    reference       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_credit_ledger_account
    ON sms_credit_ledger(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sms_bundles (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name           TEXT NOT NULL,
    credits        INTEGER NOT NULL CHECK (credits > 0),
    price          NUMERIC(10,2) NOT NULL CHECK (price > 0),
    -- Optional business-mode price; NULL = same as price.
    business_price NUMERIC(10,2) CHECK (business_price IS NULL OR business_price > 0),
    is_active      BOOLEAN NOT NULL DEFAULT true,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sms_purchases (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id        UUID NOT NULL REFERENCES sms_accounts(id) ON DELETE CASCADE,
    user_id           UUID NOT NULL REFERENCES users(id),
    bundle_id         UUID REFERENCES sms_bundles(id),
    credits           INTEGER NOT NULL CHECK (credits > 0),
    price             NUMERIC(10,2) NOT NULL CHECK (price > 0),
    paid_from         TEXT NOT NULL CHECK (paid_from IN ('wallet', 'momo')),
    -- PSP reference for MoMo purchases; NULL for wallet. UNIQUE kills
    -- webhook-retry / status-poll double-crediting at the schema level.
    payment_reference TEXT UNIQUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_purchases_account
    ON sms_purchases(account_id, created_at DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- 2. RLS — owners read their own rows; ALL writes via service-role RPCs
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE sms_accounts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_wallets       ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_bundles       ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_purchases     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sms_accounts_owner_select ON sms_accounts;
CREATE POLICY sms_accounts_owner_select ON sms_accounts
    FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS sms_wallets_owner_select ON sms_wallets;
CREATE POLICY sms_wallets_owner_select ON sms_wallets
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM sms_accounts a WHERE a.id = account_id AND a.user_id = auth.uid()
    ));

DROP POLICY IF EXISTS sms_credit_ledger_owner_select ON sms_credit_ledger;
CREATE POLICY sms_credit_ledger_owner_select ON sms_credit_ledger
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM sms_accounts a WHERE a.id = account_id AND a.user_id = auth.uid()
    ));

DROP POLICY IF EXISTS sms_bundles_public_read ON sms_bundles;
CREATE POLICY sms_bundles_public_read ON sms_bundles
    FOR SELECT USING (is_active = true);

DROP POLICY IF EXISTS sms_purchases_owner_select ON sms_purchases;
CREATE POLICY sms_purchases_owner_select ON sms_purchases
    FOR SELECT USING (user_id = auth.uid());

-- Red-team lesson (2026-06): never leave broad write grants + RLS to chance.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON sms_accounts,
    sms_wallets, sms_credit_ledger, sms_bundles, sms_purchases
    FROM anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. RPCs
-- ────────────────────────────────────────────────────────────────────────────

-- ensure_sms_account: idempotent account+wallet provisioning on first visit.
CREATE OR REPLACE FUNCTION ensure_sms_account(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user   RECORD;
    v_acct   RECORD;
BEGIN
    SELECT id, status INTO v_user FROM users WHERE id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'USER_NOT_FOUND';
    END IF;
    IF v_user.status <> 'active' THEN
        RAISE EXCEPTION 'USER_NOT_ACTIVE';
    END IF;

    INSERT INTO sms_accounts (user_id)
    VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;

    SELECT * INTO v_acct FROM sms_accounts WHERE user_id = p_user_id;

    INSERT INTO sms_wallets (account_id)
    VALUES (v_acct.id)
    ON CONFLICT (account_id) DO NOTHING;

    RETURN jsonb_build_object(
        'account_id', v_acct.id,
        'mode', v_acct.mode,
        'status', v_acct.status,
        'default_sender', v_acct.default_sender
    );
END;
$$;

-- credit_user_sms_credits: idempotent credit (refund/bonus/admin_adjust/purchase-side).
-- Ledger-key reservation FIRST; duplicate key => already_processed, no mutation.
CREATE OR REPLACE FUNCTION credit_user_sms_credits(
    p_account_id UUID,
    p_credits    INTEGER,
    p_key        TEXT,
    p_kind       TEXT DEFAULT 'refund',
    p_reference  TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_ledger_id UUID;
    v_balance   INTEGER;
BEGIN
    IF p_credits IS NULL OR p_credits <= 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT';
    END IF;
    IF p_key IS NULL OR length(trim(p_key)) < 8 THEN
        RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY';
    END IF;
    IF p_kind NOT IN ('purchase', 'refund', 'bonus', 'admin_adjust') THEN
        RAISE EXCEPTION 'INVALID_KIND';
    END IF;

    -- Reserve the key. Conflict = this credit already happened.
    INSERT INTO sms_credit_ledger (account_id, delta, kind, idempotency_key, reference)
    VALUES (p_account_id, p_credits, p_kind, p_key, p_reference)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_ledger_id;

    IF v_ledger_id IS NULL THEN
        RETURN jsonb_build_object('already_processed', true);
    END IF;

    UPDATE sms_wallets
    SET credits    = credits + p_credits,
        total_used = CASE WHEN p_kind = 'refund'
                          THEN GREATEST(0, total_used - p_credits)
                          ELSE total_used END,
        total_purchased = CASE WHEN p_kind IN ('purchase', 'bonus')
                               THEN total_purchased + p_credits
                               ELSE total_purchased END,
        updated_at = now()
    WHERE account_id = p_account_id
    RETURNING credits INTO v_balance;

    IF v_balance IS NULL THEN
        RAISE EXCEPTION 'WALLET_NOT_FOUND';
    END IF;

    UPDATE sms_credit_ledger SET balance_after = v_balance WHERE id = v_ledger_id;

    RETURN jsonb_build_object('already_processed', false, 'balance', v_balance);
END;
$$;

-- purchase_user_sms_credits: buy an admin-priced bundle.
--  paid_from='wallet': atomic conditional debit of the user's main wallet.
--  paid_from='momo'  : money already collected by the PSP; the CALLER (single
--    payment processor shared by webhook + status poll) must pass the
--    PSP-confirmed amount, which is verified against the bundle price here
--    (AMOUNT_MISMATCH). sms_purchases.payment_reference UNIQUE +
--    ledger key 'purchase:{reference}' make replays no-ops.
CREATE OR REPLACE FUNCTION purchase_user_sms_credits(
    p_user_id           UUID,
    p_bundle_id         UUID,
    p_paid_from         TEXT,
    p_payment_reference TEXT DEFAULT NULL,
    p_verified_amount   NUMERIC DEFAULT NULL,
    p_client_key        TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_acct      RECORD;
    v_bundle    RECORD;
    v_price     NUMERIC(10,2);
    v_key       TEXT;
    v_ledger_id UUID;
    v_balance   INTEGER;
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

    v_price := CASE WHEN v_acct.mode = 'business' AND v_bundle.business_price IS NOT NULL
                    THEN v_bundle.business_price ELSE v_bundle.price END;

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

    -- Reserve the ledger key BEFORE moving any money — retries become no-ops
    -- and any failure below rolls the reservation back.
    INSERT INTO sms_credit_ledger (account_id, delta, kind, idempotency_key, reference)
    VALUES (v_acct.id, v_bundle.credits, 'purchase', v_key, p_payment_reference)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_ledger_id;

    IF v_ledger_id IS NULL THEN
        RETURN jsonb_build_object('already_processed', true);
    END IF;

    IF p_paid_from = 'wallet' THEN
        -- Route main-wallet debits through the project's hardened RPC (audit
        -- M-3) so there is one canonical deduction path. It performs the same
        -- atomic conditional decrement and RAISEs INSUFFICIENT_BALANCE itself.
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
    VALUES (v_acct.id, p_user_id, p_bundle_id, v_bundle.credits, v_price, p_paid_from, p_payment_reference);

    RETURN jsonb_build_object(
        'already_processed', false,
        'credits_added', v_bundle.credits,
        'price', v_price,
        'balance', v_balance
    );
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Grants — service_role only (Supabase grants new funcs to anon/authenticated
--    by default; revoke BY NAME — project gotcha from the fintech-console work)
-- ────────────────────────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION ensure_sms_account(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION ensure_sms_account(UUID) TO service_role;

REVOKE EXECUTE ON FUNCTION credit_user_sms_credits(UUID, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION credit_user_sms_credits(UUID, INTEGER, TEXT, TEXT, TEXT) TO service_role;

REVOKE EXECUTE ON FUNCTION purchase_user_sms_credits(UUID, UUID, TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION purchase_user_sms_credits(UUID, UUID, TEXT, TEXT, NUMERIC, TEXT) TO service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Settings seeds (admin_settings.value is JSONB — seed real JSON values)
--    Feature ships OFF; flip user_sms_enabled from the admin console.
-- ────────────────────────────────────────────────────────────────────────────

INSERT INTO admin_settings (key, value) VALUES
    ('user_sms_enabled',              'false'),
    -- Stored roles per lib/roles.ts — 'customer' is the base role, never 'user'.
    ('user_sms_allowed_roles',        '["customer","agent","dealer","admin"]'),
    ('user_sms_caps',                 '{"platform":{"max_recipients_per_send":500,"sends_per_hour":10,"recipients_per_day":2000},"business":{"max_recipients_per_send":10000,"sends_per_hour":60,"recipients_per_day":100000}}'),
    ('user_sms_blocked_keywords',     '""'),
    ('user_sms_default_senders',      '[]'),
    ('user_sms_autosuspend_threshold','5'),
    ('user_sms_flag_review_threshold','10'),
    ('user_sms_message_retention_months', '12')
ON CONFLICT (key) DO NOTHING;

-- Default bundle tiers (admin-editable; effective retail ≈ GHS 0.08–0.10/credit).
INSERT INTO sms_bundles (name, credits, price, sort_order)
SELECT * FROM (VALUES
    ('Starter',  100,   10.00::numeric, 1),
    ('Growth',   500,   45.00::numeric, 2),
    ('Business', 1000,  80.00::numeric, 3),
    ('Scale',    5000, 350.00::numeric, 4)
) AS seed(name, credits, price, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM sms_bundles);

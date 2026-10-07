-- ============================================================================
-- KFT SMS PLATFORM — CONSOLIDATED MIGRATION (apply once)
-- Paste this whole file into the Supabase Dashboard → SQL Editor → Run.
-- Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT.
-- Prereq already in prod: deduct_wallet_balance() (migration 20260219).
-- Feature ships OFF (admin_settings.user_sms_enabled='false').
-- Order: core → campaigns → sender/KYC.
-- ============================================================================

-- ═══════════════════ PART 1/3: core (20260706_user_sms_core.sql) ═══════════════════

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

-- ═══════════════ PART 2/3: campaigns (20260706b_user_sms_campaigns.sql) ═══════════════

-- ============================================================================
-- USER SMS PLATFORM — CAMPAIGNS & DELIVERY RECORDS (part 2 of 3)
-- Requires 20260706_user_sms_core.sql.
--
--  * sms_campaigns: one row per send/broadcast. Claim discipline: inline
--    dispatch inserts campaigns ALREADY CLAIMED (status='processing',
--    claimed_at set); the cron claims only due 'queued' rows or stale claims —
--    inline and cron can never double-send (USSD claimed_at recovery pattern).
--  * sms_messages: one row PER RECIPIENT — the landing zone for Hubtel
--    delivery reports (provider_message_id) and the source of truth for
--    refunds. Delivery stats are AGGREGATED ON READ (no rollup counters to
--    corrupt on webhook replays).
--  * Refund contract: ONE terminal settlement per campaign
--    (ledger key 'refund:{campaignId}'), amount computed HERE from persisted
--    failure rows — never from a caller-supplied count.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sms_campaigns (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id       UUID NOT NULL REFERENCES sms_accounts(id) ON DELETE CASCADE,
    sender_used      TEXT,                 -- resolved sender ID at send time (NULL on blocked)
    mode_at_send     TEXT NOT NULL CHECK (mode_at_send IN ('platform', 'business')),
    message          TEXT NOT NULL,
    recipients_count INTEGER NOT NULL CHECK (recipients_count >= 0),
    segments         INTEGER NOT NULL CHECK (segments >= 0),
    credits_charged  INTEGER NOT NULL DEFAULT 0 CHECK (credits_charged >= 0),
    status           TEXT NOT NULL CHECK (status IN
                     ('queued', 'processing', 'completed', 'partial', 'failed', 'blocked', 'cancelled')),
    flagged          BOOLEAN NOT NULL DEFAULT false,
    flag_reason      TEXT,
    flag_severity    TEXT CHECK (flag_severity IN ('fraud', 'info')),
    scheduled_at     TIMESTAMPTZ,
    claimed_at       TIMESTAMPTZ,
    settled_at       TIMESTAMPTZ,
    source           TEXT NOT NULL DEFAULT 'dashboard' CHECK (source IN ('dashboard', 'api')),
    provider         TEXT NOT NULL DEFAULT 'hubtel',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_campaigns_account
    ON sms_campaigns(account_id, created_at DESC);
-- Dispatcher work queue.
CREATE INDEX IF NOT EXISTS idx_sms_campaigns_dispatch
    ON sms_campaigns(status, scheduled_at) WHERE status IN ('queued', 'processing');
-- Admin flagged-review queue.
CREATE INDEX IF NOT EXISTS idx_sms_campaigns_flagged
    ON sms_campaigns(created_at DESC) WHERE flagged = true;

CREATE TABLE IF NOT EXISTS sms_messages (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id         UUID NOT NULL REFERENCES sms_campaigns(id) ON DELETE CASCADE,
    account_id          UUID NOT NULL REFERENCES sms_accounts(id) ON DELETE CASCADE,
    recipient           TEXT NOT NULL,     -- 233XXXXXXXXX
    chunk_no            INTEGER NOT NULL DEFAULT 0,
    provider            TEXT NOT NULL DEFAULT 'hubtel',
    provider_message_id TEXT,
    -- queued: awaiting dispatch | sent: provider accepted | failed: provider
    -- rejected at send time (REFUNDABLE) | delivered/undelivered/expired/
    -- rejected: DLR verdicts (NOT refundable — carrier-side outcomes).
    status              TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
                        ('queued', 'sent', 'delivered', 'undelivered', 'failed', 'expired', 'rejected')),
    status_detail       TEXT,
    network_id          TEXT,
    rate                NUMERIC(10,4),
    status_updated_at   TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_messages_provider_mid
    ON sms_messages(provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sms_messages_campaign
    ON sms_messages(campaign_id, chunk_no);
CREATE INDEX IF NOT EXISTS idx_sms_messages_account
    ON sms_messages(account_id, created_at DESC);
-- Reconcile-cron scan: stuck non-terminal rows.
CREATE INDEX IF NOT EXISTS idx_sms_messages_pending
    ON sms_messages(status_updated_at) WHERE status IN ('queued', 'sent');

-- User-owned contact books (owner CRUD RLS — the shop_sms_templates pattern,
-- NOT the admin deny-all sms_contacts/sms_groups tables).
CREATE TABLE IF NOT EXISTS sms_contact_groups (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  UUID NOT NULL REFERENCES sms_accounts(id) ON DELETE CASCADE,
    name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sms_group_contacts (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id     UUID NOT NULL REFERENCES sms_contact_groups(id) ON DELETE CASCADE,
    phone_number TEXT NOT NULL,
    first_name   TEXT,
    last_name    TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (group_id, phone_number)
);

CREATE INDEX IF NOT EXISTS idx_sms_group_contacts_group ON sms_group_contacts(group_id);

CREATE TABLE IF NOT EXISTS sms_user_templates (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES sms_accounts(id) ON DELETE CASCADE,
    name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    body       TEXT NOT NULL CHECK (length(body) BETWEEN 3 AND 1000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- 2. RLS
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE sms_campaigns      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_messages       ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_contact_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_group_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_user_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sms_campaigns_owner_select ON sms_campaigns;
CREATE POLICY sms_campaigns_owner_select ON sms_campaigns
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM sms_accounts a WHERE a.id = account_id AND a.user_id = auth.uid()
    ));

DROP POLICY IF EXISTS sms_messages_owner_select ON sms_messages;
CREATE POLICY sms_messages_owner_select ON sms_messages
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM sms_accounts a WHERE a.id = account_id AND a.user_id = auth.uid()
    ));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON sms_campaigns, sms_messages
    FROM anon, authenticated;

-- Owner CRUD on contact books + templates (writes stay RLS-scoped).
DROP POLICY IF EXISTS sms_contact_groups_owner_all ON sms_contact_groups;
CREATE POLICY sms_contact_groups_owner_all ON sms_contact_groups
    FOR ALL
    USING (EXISTS (SELECT 1 FROM sms_accounts a WHERE a.id = account_id AND a.user_id = auth.uid()))
    WITH CHECK (EXISTS (SELECT 1 FROM sms_accounts a WHERE a.id = account_id AND a.user_id = auth.uid()));

DROP POLICY IF EXISTS sms_group_contacts_owner_all ON sms_group_contacts;
CREATE POLICY sms_group_contacts_owner_all ON sms_group_contacts
    FOR ALL
    USING (EXISTS (
        SELECT 1 FROM sms_contact_groups g
        JOIN sms_accounts a ON a.id = g.account_id
        WHERE g.id = group_id AND a.user_id = auth.uid()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM sms_contact_groups g
        JOIN sms_accounts a ON a.id = g.account_id
        WHERE g.id = group_id AND a.user_id = auth.uid()
    ));

DROP POLICY IF EXISTS sms_user_templates_owner_all ON sms_user_templates;
CREATE POLICY sms_user_templates_owner_all ON sms_user_templates
    FOR ALL
    USING (EXISTS (SELECT 1 FROM sms_accounts a WHERE a.id = account_id AND a.user_id = auth.uid()))
    WITH CHECK (EXISTS (SELECT 1 FROM sms_accounts a WHERE a.id = account_id AND a.user_id = auth.uid()));

-- ────────────────────────────────────────────────────────────────────────────
-- 3. RPCs
-- ────────────────────────────────────────────────────────────────────────────

-- create_sms_campaign: THE atomic entry point for every send.
--  * Suspension + role-allowlist gates run INSIDE the same transaction as the
--    debit (TOCTOU-safe, per the shop debit_sms_credits v2 lesson).
--  * Ledger key 'debit:{campaignId}' — a client retry with the same campaign
--    UUID is a no-op (returns already_processed).
--  * p_blocked=true records a filter-refused attempt: campaign row with
--    status='blocked', zero credits, NO debit (feeds auto-suspend counters).
--  * p_claim_now=true births the campaign already claimed (inline dispatch);
--    false → 'queued' for the cron (large or scheduled sends).
CREATE OR REPLACE FUNCTION create_sms_campaign(
    p_campaign_id      UUID,
    p_user_id          UUID,
    p_message          TEXT,
    p_recipients_count INTEGER,
    p_segments         INTEGER,
    p_credits          INTEGER,
    p_mode             TEXT,
    p_sender           TEXT,
    p_source           TEXT DEFAULT 'dashboard',
    p_scheduled_at     TIMESTAMPTZ DEFAULT NULL,
    p_claim_now        BOOLEAN DEFAULT false,
    p_blocked          BOOLEAN DEFAULT false,
    p_flagged          BOOLEAN DEFAULT false,
    p_flag_reason      TEXT DEFAULT NULL,
    p_flag_severity    TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_acct      RECORD;
    v_role      TEXT;
    v_allowed   JSONB;
    v_ledger_id UUID;
    v_balance   INTEGER;
    v_status    TEXT;
BEGIN
    SELECT a.* INTO v_acct FROM sms_accounts a WHERE a.user_id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ACCOUNT_NOT_FOUND';
    END IF;
    IF v_acct.status <> 'active' THEN
        RAISE EXCEPTION 'ACCOUNT_SUSPENDED';
    END IF;
    IF p_mode NOT IN ('platform', 'business') OR p_mode <> v_acct.mode THEN
        RAISE EXCEPTION 'MODE_MISMATCH';
    END IF;

    -- Role allowlist re-checked atomically (admin may narrow roles at any time).
    SELECT u.role INTO v_role FROM users u WHERE u.id = p_user_id AND u.status = 'active';
    IF v_role IS NULL THEN
        RAISE EXCEPTION 'USER_NOT_ACTIVE';
    END IF;
    SELECT value INTO v_allowed FROM admin_settings WHERE key = 'user_sms_allowed_roles';
    IF v_allowed IS NULL OR jsonb_typeof(v_allowed) <> 'array'
       OR NOT (v_allowed ? v_role) THEN
        RAISE EXCEPTION 'ROLE_NOT_ALLOWED';
    END IF;

    -- Blocked attempt: audit row only, no money movement.
    IF p_blocked THEN
        INSERT INTO sms_campaigns (id, account_id, sender_used, mode_at_send, message,
            recipients_count, segments, credits_charged, status, flagged, flag_reason,
            flag_severity, source)
        VALUES (p_campaign_id, v_acct.id, NULL, p_mode, p_message,
            p_recipients_count, p_segments, 0, 'blocked', true, p_flag_reason,
            COALESCE(p_flag_severity, 'fraud'), p_source);
        RETURN jsonb_build_object('blocked', true, 'campaign_id', p_campaign_id);
    END IF;

    IF p_credits IS NULL OR p_credits <= 0 OR p_recipients_count <= 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT';
    END IF;
    IF p_sender IS NULL OR length(trim(p_sender)) = 0 THEN
        -- Never fall through to an implicit provider default sender.
        RAISE EXCEPTION 'SENDER_REQUIRED';
    END IF;

    -- Reserve the debit ledger key (client retry with same UUID = no-op).
    INSERT INTO sms_credit_ledger (account_id, delta, kind, idempotency_key, reference)
    VALUES (v_acct.id, -p_credits, 'debit', 'debit:' || p_campaign_id::text, p_campaign_id::text)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_ledger_id;

    IF v_ledger_id IS NULL THEN
        RETURN jsonb_build_object('already_processed', true, 'campaign_id', p_campaign_id);
    END IF;

    -- Atomic compare-and-decrement (CHECK credits >= 0 backstops).
    UPDATE sms_wallets
    SET credits = credits - p_credits,
        total_used = total_used + p_credits,
        updated_at = now()
    WHERE account_id = v_acct.id AND credits >= p_credits
    RETURNING credits INTO v_balance;
    IF v_balance IS NULL THEN
        RAISE EXCEPTION 'INSUFFICIENT_CREDITS';
    END IF;

    UPDATE sms_credit_ledger SET balance_after = v_balance WHERE id = v_ledger_id;

    v_status := CASE WHEN p_claim_now THEN 'processing' ELSE 'queued' END;

    INSERT INTO sms_campaigns (id, account_id, sender_used, mode_at_send, message,
        recipients_count, segments, credits_charged, status, flagged, flag_reason,
        flag_severity, scheduled_at, claimed_at, source)
    VALUES (p_campaign_id, v_acct.id, trim(p_sender), p_mode, p_message,
        p_recipients_count, p_segments, p_credits, v_status, p_flagged, p_flag_reason,
        p_flag_severity, p_scheduled_at,
        CASE WHEN p_claim_now THEN now() ELSE NULL END, p_source);

    RETURN jsonb_build_object(
        'already_processed', false,
        'campaign_id', p_campaign_id,
        'account_id', v_acct.id,
        'status', v_status,
        'balance', v_balance
    );
END;
$$;

-- claim_sms_campaigns: cron dispatcher claim. Due queued campaigns OR stale
-- claims (crashed dispatcher). SKIP LOCKED = safe under concurrent crons.
CREATE OR REPLACE FUNCTION claim_sms_campaigns(
    p_limit         INTEGER DEFAULT 3,
    p_stale_minutes INTEGER DEFAULT 10
)
RETURNS SETOF sms_campaigns
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    UPDATE sms_campaigns c
    SET status = 'processing', claimed_at = now()
    WHERE c.id IN (
        SELECT id FROM sms_campaigns
        WHERE (status = 'queued' AND (scheduled_at IS NULL OR scheduled_at <= now()))
           OR (status = 'processing' AND claimed_at < now() - make_interval(mins => p_stale_minutes))
        ORDER BY created_at
        LIMIT GREATEST(1, LEAST(p_limit, 10))
        FOR UPDATE SKIP LOCKED
    )
    RETURNING c.*;
END;
$$;

-- bulk_update_sms_message_status: dispatcher writes provider results in ONE
-- round trip. Transition-gated: only 'queued' rows move (replays idempotent).
-- p_updates: [{"id": "...", "status": "sent|failed", "provider_message_id": "...",
--              "network_id": "...", "rate": 0.03, "detail": "..."}]
CREATE OR REPLACE FUNCTION bulk_update_sms_message_status(p_updates JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'array' THEN
        RAISE EXCEPTION 'INVALID_PAYLOAD';
    END IF;

    UPDATE sms_messages m
    SET status              = u.status,
        provider_message_id = COALESCE(u.provider_message_id, m.provider_message_id),
        network_id          = COALESCE(u.network_id, m.network_id),
        rate                = COALESCE(u.rate, m.rate),
        status_detail       = COALESCE(u.detail, m.status_detail),
        status_updated_at   = now()
    FROM jsonb_to_recordset(p_updates) AS u(
        id UUID, status TEXT, provider_message_id TEXT,
        network_id TEXT, rate NUMERIC, detail TEXT
    )
    WHERE m.id = u.id
      AND u.status IN ('sent', 'failed')
      AND m.status = 'queued';

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- apply_sms_delivery_report: DLR/reconcile terminal transition. Only
-- queued/sent rows move; terminal states are immutable (webhook replays and
-- forged repeats are no-ops). MOVES NO MONEY by design.
CREATE OR REPLACE FUNCTION apply_sms_delivery_report(
    p_provider_message_id TEXT,
    p_status              TEXT,
    p_detail              TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row RECORD;
BEGIN
    -- SECURITY (audit H-1): 'failed' is a SEND-TIME provider rejection written
    -- only by bulk_update_sms_message_status, and settle_sms_campaign refunds
    -- exactly the 'failed' rows. A DLR callback must NEVER be able to mint a
    -- 'failed' row (that would refund an already-sent message), so it is
    -- excluded here regardless of what the caller maps — the DB contract holds
    -- even if an app-layer mapping regresses.
    IF p_status NOT IN ('delivered', 'undelivered', 'expired', 'rejected') THEN
        RAISE EXCEPTION 'INVALID_STATUS';
    END IF;

    UPDATE sms_messages
    SET status = p_status,
        status_detail = COALESCE(p_detail, status_detail),
        status_updated_at = now()
    WHERE provider_message_id = p_provider_message_id
      AND status IN ('queued', 'sent')
    RETURNING id, campaign_id, account_id INTO v_row;

    IF v_row.id IS NULL THEN
        RETURN jsonb_build_object('updated', false);
    END IF;

    RETURN jsonb_build_object('updated', true,
        'message_id', v_row.id, 'campaign_id', v_row.campaign_id,
        'account_id', v_row.account_id);
END;
$$;

-- settle_sms_campaign: single terminal settlement. Refund computed FROM
-- PERSISTED send-time failures (status='failed' only — DLR outcomes such as
-- 'undelivered' are carrier results and are NOT refunded). Ledger key
-- 'refund:{campaignId}' makes double-settlement impossible.
CREATE OR REPLACE FUNCTION settle_sms_campaign(p_campaign_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_camp        RECORD;
    v_failed      INTEGER;
    v_undispatched INTEGER;
    v_refund      INTEGER;
    v_final       TEXT;
    v_credit      JSONB;
BEGIN
    SELECT * INTO v_camp FROM sms_campaigns
    WHERE id = p_campaign_id AND status = 'processing'
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('settled', false, 'reason', 'NOT_PROCESSING');
    END IF;

    SELECT COUNT(*) FILTER (WHERE status = 'failed'),
           COUNT(*) FILTER (WHERE status = 'queued')
    INTO v_failed, v_undispatched
    FROM sms_messages WHERE campaign_id = p_campaign_id;

    -- Undispatched rows at settle time (dispatcher aborted): mark failed so
    -- they are refunded and never silently lost.
    IF v_undispatched > 0 THEN
        UPDATE sms_messages
        SET status = 'failed', status_detail = 'not dispatched', status_updated_at = now()
        WHERE campaign_id = p_campaign_id AND status = 'queued';
        v_failed := v_failed + v_undispatched;
    END IF;

    v_refund := v_failed * v_camp.segments;
    v_final  := CASE
        WHEN v_failed = 0 THEN 'completed'
        WHEN v_failed >= v_camp.recipients_count THEN 'failed'
        ELSE 'partial'
    END;

    IF v_refund > 0 THEN
        v_credit := credit_user_sms_credits(
            v_camp.account_id, v_refund,
            'refund:' || p_campaign_id::text, 'refund', p_campaign_id::text);
    END IF;

    UPDATE sms_campaigns
    SET status = v_final, settled_at = now()
    WHERE id = p_campaign_id;

    RETURN jsonb_build_object('settled', true, 'final_status', v_final,
        'failed_count', v_failed, 'refunded_credits', COALESCE(v_refund, 0));
END;
$$;

-- cancel_sms_campaign: user/admin cancel of a NOT-YET-DISPATCHED campaign
-- (queued only — processing campaigns are in flight). Full refund, same
-- 'refund:{campaignId}' key family so cancel/settle can never both refund.
CREATE OR REPLACE FUNCTION cancel_sms_campaign(p_campaign_id UUID, p_account_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_camp   RECORD;
    v_credit JSONB;
BEGIN
    UPDATE sms_campaigns
    SET status = 'cancelled', settled_at = now()
    WHERE id = p_campaign_id AND account_id = p_account_id AND status = 'queued'
    RETURNING * INTO v_camp;

    IF v_camp.id IS NULL THEN
        RETURN jsonb_build_object('cancelled', false, 'reason', 'NOT_CANCELLABLE');
    END IF;

    UPDATE sms_messages
    SET status = 'failed', status_detail = 'campaign cancelled', status_updated_at = now()
    WHERE campaign_id = p_campaign_id AND status = 'queued';

    IF v_camp.credits_charged > 0 THEN
        v_credit := credit_user_sms_credits(
            p_account_id, v_camp.credits_charged,
            'refund:' || p_campaign_id::text, 'refund', p_campaign_id::text);
    END IF;

    RETURN jsonb_build_object('cancelled', true,
        'refunded_credits', COALESCE(v_camp.credits_charged, 0));
END;
$$;

-- purge_old_sms_messages: retention cron helper (bounded batch).
CREATE OR REPLACE FUNCTION purge_old_sms_messages(p_months INTEGER DEFAULT 12, p_limit INTEGER DEFAULT 5000)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    DELETE FROM sms_messages
    WHERE id IN (
        SELECT id FROM sms_messages
        WHERE created_at < now() - make_interval(months => GREATEST(1, p_months))
        LIMIT GREATEST(1, LEAST(p_limit, 20000))
    );
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Grants — service_role only, revoked BY NAME
-- ────────────────────────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION create_sms_campaign(UUID, UUID, TEXT, INTEGER, INTEGER, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN, BOOLEAN, BOOLEAN, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION create_sms_campaign(UUID, UUID, TEXT, INTEGER, INTEGER, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN, BOOLEAN, BOOLEAN, TEXT, TEXT) TO service_role;

REVOKE EXECUTE ON FUNCTION claim_sms_campaigns(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION claim_sms_campaigns(INTEGER, INTEGER) TO service_role;

REVOKE EXECUTE ON FUNCTION bulk_update_sms_message_status(JSONB) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION bulk_update_sms_message_status(JSONB) TO service_role;

REVOKE EXECUTE ON FUNCTION apply_sms_delivery_report(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION apply_sms_delivery_report(TEXT, TEXT, TEXT) TO service_role;

REVOKE EXECUTE ON FUNCTION settle_sms_campaign(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION settle_sms_campaign(UUID) TO service_role;

REVOKE EXECUTE ON FUNCTION cancel_sms_campaign(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION cancel_sms_campaign(UUID, UUID) TO service_role;

REVOKE EXECUTE ON FUNCTION purge_old_sms_messages(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION purge_old_sms_messages(INTEGER, INTEGER) TO service_role;

-- ═══════════════ PART 3/3: sender/KYC (20260706c_sms_sender_kyc.sql) ═══════════════

-- ============================================================================
-- USER SMS PLATFORM — BUSINESS PROFILES, SENDER IDs, KYC STORAGE (part 3 of 3)
-- Requires 20260706_user_sms_core.sql.
--
--  * sms_business_profiles: domain + description (+ optional Ghana Card /
--    business cert / Form A docs). Admin approval of the profile flips the
--    account to mode='business' (route-side, audit-logged). Docs hold storage
--    PATHS only — never URLs; admin views via service-role signed URLs
--    (TTL <= 5 min), generated on demand.
--  * sms_sender_ids: own-sender lifecycle
--    under_review -> submitted_to_hubtel -> approved | rejected | revoked.
--    Reserved-name checks (normalized brand-collision matching) run in the
--    request route using the content-filter fold pipeline; the DB enforces
--    charset/length + approved-name uniqueness. Admin + Hubtel review are the
--    human backstops.
--  * Storage bucket sms-kyc-docs is PRIVATE (Ghana Card scans). Object prefix
--    is {user_id}/... so the standard (storage.foldername(name))[1] =
--    auth.uid()::text check works verbatim. NO authenticated SELECT policy —
--    reads happen exclusively through service-role signed URLs.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sms_business_profiles (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id               UUID NOT NULL UNIQUE REFERENCES sms_accounts(id) ON DELETE CASCADE,
    business_name            TEXT NOT NULL CHECK (length(business_name) BETWEEN 2 AND 120),
    description              TEXT NOT NULL CHECK (length(description) BETWEEN 10 AND 2000),
    domain_link              TEXT,          -- bare host or URL of the business site
    ghana_card_number_masked TEXT,          -- e.g. GHA-*****1234 — full number never stored
    -- [{"type":"ghana_card"|"business_cert"|"form_a"|"other","path":"<uid>/...","uploaded_at":"..."}]
    docs                     JSONB NOT NULL DEFAULT '[]',
    status                   TEXT NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'under_review', 'approved', 'rejected')),
    review_notes             TEXT,
    reviewed_by              UUID REFERENCES users(id),
    reviewed_at              TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE sms_business_profiles IS
    'SMS business registration (domain + description; cert optional). Approval unlocks mode=business account-wide. Writes are service-role only via authenticated routes.';

CREATE TABLE IF NOT EXISTS sms_sender_ids (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id       UUID NOT NULL REFERENCES sms_accounts(id) ON DELETE CASCADE,
    sender_text      TEXT NOT NULL CHECK (
                         length(trim(sender_text)) BETWEEN 3 AND 11
                         AND sender_text ~ '^[A-Za-z0-9 ]+$'
                     ),
    status           TEXT NOT NULL DEFAULT 'under_review' CHECK (status IN
                     ('under_review', 'submitted_to_hubtel', 'approved', 'rejected', 'revoked')),
    is_default       BOOLEAN NOT NULL DEFAULT false,
    hubtel_reference TEXT,
    rejection_reason TEXT,
    requested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at      TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One default sender per account; no two tenants may hold the same approved name.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_sender_ids_default
    ON sms_sender_ids(account_id) WHERE is_default = true;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_sender_ids_approved_name
    ON sms_sender_ids(lower(trim(sender_text))) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS idx_sms_sender_ids_account ON sms_sender_ids(account_id);
-- Admin review queue.
CREATE INDEX IF NOT EXISTS idx_sms_sender_ids_review
    ON sms_sender_ids(requested_at) WHERE status IN ('under_review', 'submitted_to_hubtel');

-- ────────────────────────────────────────────────────────────────────────────
-- 2. RLS — owner SELECT; ALL writes via service-role routes
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE sms_business_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_sender_ids        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sms_business_profiles_owner_select ON sms_business_profiles;
CREATE POLICY sms_business_profiles_owner_select ON sms_business_profiles
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM sms_accounts a WHERE a.id = account_id AND a.user_id = auth.uid()
    ));

DROP POLICY IF EXISTS sms_sender_ids_owner_select ON sms_sender_ids;
CREATE POLICY sms_sender_ids_owner_select ON sms_sender_ids
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM sms_accounts a WHERE a.id = account_id AND a.user_id = auth.uid()
    ));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON sms_business_profiles, sms_sender_ids
    FROM anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. KYC storage bucket — PRIVATE, size/MIME-limited
-- ────────────────────────────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'sms-kyc-docs', 'sms-kyc-docs', false,
    5242880, -- 5 MB
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Upload: owners may only write inside their own {user_id}/ folder.
DROP POLICY IF EXISTS sms_kyc_docs_owner_insert ON storage.objects;
CREATE POLICY sms_kyc_docs_owner_insert ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'sms-kyc-docs'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

-- Deliberately NO SELECT / UPDATE / DELETE policies for authenticated:
-- national-ID scans are readable only via short-lived service-role signed
-- URLs (admin review UI), and uploaded evidence is immutable from the client.

-- ═══════════════════ PART 4: KFT SMS v2 (20260708_sms_v2.sql) ═══════════════════

-- ============================================================================
-- KFT SMS v2 — bundle mode segregation, per-mode business fraud lists,
-- cert-skip -> grace -> admin-hold lifecycle, own-sender confirmations
-- (user + shop), shop sender-ID request/review columns.
--
-- Requires: 20260706_user_sms_core.sql, 20260706b_user_sms_campaigns.sql,
-- 20260706c_sms_sender_kyc.sql (already applied to prod).
--
-- ADDITIVE ONLY — every ALTER uses ADD COLUMN IF NOT EXISTS, every seed
-- INSERT is guarded (WHERE NOT EXISTS / ON CONFLICT DO NOTHING). No column
-- drops, no CHECK edits on pre-existing columns. sms_bundles.business_price
-- is left in place (dead column) and simply stops being read.
--
-- Feature ships OFF (admin_settings.user_sms_enabled = 'false'); this
-- migration is written now and applied later (Stage 5). Do not run yet.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Bundle mode segregation — platform vs business bundle catalogs.
--    Existing 4 rows (20260706 seed) keep their DEFAULT 'platform'.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE sms_bundles
    ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'platform'
        CHECK (mode IN ('platform', 'business', 'both'));

-- Seed a business bundle set once (idempotent: only seeds if no 'business' rows exist).
INSERT INTO sms_bundles (name, credits, price, is_active, sort_order, mode)
SELECT * FROM (VALUES
    ('Business Starter', 200,   18.00::numeric,   true, 10, 'business'),
    ('Business Growth',  1000,  85.00::numeric,   true, 11, 'business'),
    ('Business Scale',   5000,  400.00::numeric,  true, 12, 'business'),
    ('Business Bulk',    20000, 1500.00::numeric, true, 13, 'business')
) AS v(name, credits, price, is_active, sort_order, mode)
WHERE NOT EXISTS (SELECT 1 FROM sms_bundles WHERE mode = 'business');

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Account lifecycle flags — business fraud hold + own-sender-for-confirmations opt-in.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE sms_accounts
    ADD COLUMN IF NOT EXISTS business_on_hold BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS use_own_sender_for_confirmations BOOLEAN NOT NULL DEFAULT false;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Business profile cert-skip -> grace lifecycle.
--    docs is a JSONB ARRAY of {"type","path","uploaded_at"} objects
--    (see 20260706c_sms_sender_kyc.sql) — NOT an object keyed by doc-type.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE sms_business_profiles
    ADD COLUMN IF NOT EXISTS cert_skipped     BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS grace_ends_at    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS grace_flagged_at TIMESTAMPTZ;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Shop sender IDs — paid own-sender order-confirmation service.
--    sms_sender_status: under_review | approved | rejected | revoked.
-- ────────────────────────────────────────────────────────────────────────────

-- Fix 5 (Stage-4): CHECK constraint on sms_sender_status. `ADD COLUMN IF NOT
-- EXISTS ... CHECK (...)` is valid Postgres — the CHECK only takes effect
-- when the column is actually created by this statement (a no-op ADD COLUMN
-- IF NOT EXISTS on an already-existing column does not retroactively add the
-- constraint), which is acceptable here since the column doesn't exist in
-- prod yet.
ALTER TABLE shop_profiles
    ADD COLUMN IF NOT EXISTS sms_sender_id           TEXT,
    ADD COLUMN IF NOT EXISTS sms_sender_status        TEXT
        CHECK (sms_sender_status IN ('under_review', 'approved', 'rejected', 'revoked')),
    ADD COLUMN IF NOT EXISTS sms_sender_requested_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS sms_sender_reviewed_at   TIMESTAMPTZ;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. purchase_user_sms_credits — REPLACE with v2 mode guard.
--    Exact prior body (20260706_user_sms_core.sql) reproduced verbatim.
--    ONLY two lines are new vs the prior definition:
--      (a) the bundle/account mode guard (BUNDLE_MODE_MISMATCH), and
--      (b) v_price sourced from v_bundle.price only (business_price CASE
--          removed — that column is dead as of v2; mode-specific pricing is
--          now expressed via separate bundle rows, not a second price column).
--    Everything else — signature, MoMo amount-verification, payment_reference
--    UNIQUE dedup via the ledger-key reservation, deduct_wallet_balance()
--    wallet debit, sms_purchases insert, return shape — is unchanged.
-- ────────────────────────────────────────────────────────────────────────────

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

    -- v2 GUARD: a bundle can only be bought by an account in its own mode
    -- (or a 'both'-mode bundle, which is visible/purchasable from either mode).
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

-- Explicit re-revoke (belt-and-suspenders on REPLACE; grants persist across
-- CREATE OR REPLACE in Postgres, but this keeps the contract self-evident).
-- REVOKE FROM PUBLIC as well as anon/authenticated: PUBLIC's default EXECUTE
-- grant is a separate privilege from any named-role grant, so omitting PUBLIC
-- here would leave anon/authenticated executing via the implicit PUBLIC grant
-- (the project's established pattern in 20260706_user_sms_core.sql always
-- revokes FROM PUBLIC, anon, authenticated together).
REVOKE ALL ON FUNCTION purchase_user_sms_credits(UUID, UUID, TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
-- Fix 4 (Stage-4): the belt-and-suspenders REVOKE above only touches
-- PUBLIC/anon/authenticated — it does not itself remove service_role's
-- EXECUTE grant from the original 20260706_user_sms_core.sql definition
-- (grants persist across CREATE OR REPLACE). But this file is meant to be
-- readable/appliable standalone (see apply_sms_platform.sql, which
-- concatenates all parts) and every other REVOKE-from-PUBLIC pair in this
-- migration set is paired with an explicit service_role GRANT — pairing
-- this one the same way keeps the contract self-evident and safe even if
-- this section is ever replayed without Part 1 having run first.
GRANT EXECUTE ON FUNCTION purchase_user_sms_credits(UUID, UUID, TEXT, TEXT, NUMERIC, TEXT) TO service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 6. sms_flag_expired_grace — cron RPC. Stamps grace_flagged_at on
--    cert-skipped, grace-expired profiles that still have no uploaded
--    business_cert doc. Flags only; admin applies business_on_hold manually
--    from the review queue. Returns the flagged rows for the notify step.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sms_flag_expired_grace()
RETURNS SETOF sms_business_profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    UPDATE sms_business_profiles p
       SET grace_flagged_at = now()
     WHERE p.cert_skipped = true
       AND p.grace_ends_at IS NOT NULL
       AND p.grace_ends_at < now()
       AND p.grace_flagged_at IS NULL
       -- docs is a JSONB ARRAY of {"type",...} objects (not an object keyed by
       -- doc-type) — "cert not uploaded" means no array element has
       -- type='business_cert'. `docs ? 'business_cert'` would silently always
       -- be false against this shape (jsonb `?` matches array elements that
       -- are themselves the bare string, not a key inside an element object).
       AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(p.docs) AS doc
           WHERE doc->>'type' = 'business_cert'
       )
    RETURNING p.*;
END;
$$;

REVOKE ALL ON FUNCTION sms_flag_expired_grace() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION sms_flag_expired_grace() TO service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. Per-mode business fraud-list settings (rows, no schema change).
--    admin_settings.value is JSONB — seed with the same empty-string
--    convention as user_sms_blocked_keywords (20260706_user_sms_core.sql).
-- ────────────────────────────────────────────────────────────────────────────

INSERT INTO admin_settings (key, value) VALUES
    ('user_sms_business_blocked_keywords', '""'),
    ('user_sms_business_flagged_keywords', '""'),
    ('user_sms_business_allowed_domains',  '""')
ON CONFLICT (key) DO NOTHING;

-- ═══════════════════ PART 5: Shop multi-sender IDs (20260709_shop_sender_ids.sql) ═══════════════════

-- ============================================================================
-- SHOP MULTI-SENDER IDs (Feature Wave 6, Task 2)
-- Additive only — does not touch any existing table/column/RPC.
--
-- Shops currently hold at most ONE sender-ID request at a time, tracked as
-- four columns directly on shop_profiles (sms_sender_id/sms_sender_status/
-- sms_sender_requested_at/sms_sender_reviewed_at — added above in PART 4).
-- This migration lets a shop hold up to 5 concurrent sender-ID requests
-- (mirrors the KFT SMS multi-sender lifecycle in sms_sender_ids /
-- PART 3, capped lower and without the Hubtel-submission intermediate status
-- or KYC-doc gate — shop senders stay the simpler
-- under_review -> approved|rejected|revoked flow shop owners already know).
--
-- CRITICAL INVARIANT: shop_profiles.sms_sender_id/sms_sender_status/
-- sms_sender_reviewed_at become a MIRROR of whichever shop_sender_ids row is
-- the shop's current default APPROVED sender (at most one, enforced by the
-- partial unique index below). lib/sms-confirmation-sender.ts
-- (resolveShopConfirmationSender / resolveShopSenderFromRow) and every F3
-- order-confirmation enforcement call site keep reading ONLY those mirror
-- columns — nothing in that file changes. The application-layer routes
-- (app/api/shop/sms/sender-request/route.ts POST/PATCH,
-- app/api/admin/shop-sms/route.ts review_shop_sender) are responsible for
-- keeping the mirror in sync every time the default sender changes.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.shop_sender_ids (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id       UUID NOT NULL REFERENCES public.shop_profiles(id) ON DELETE CASCADE,
    sender_text   TEXT NOT NULL CHECK (
                      length(trim(sender_text)) BETWEEN 3 AND 11
                      AND sender_text ~ '^[A-Za-z0-9 ]+$'
                  ),
    status        TEXT NOT NULL DEFAULT 'under_review'
                  CHECK (status IN ('under_review', 'approved', 'rejected', 'revoked')),
    is_default    BOOLEAN NOT NULL DEFAULT false,
    requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at   TIMESTAMPTZ,
    reason        TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shop_sender_ids_shop ON public.shop_sender_ids(shop_id);

-- Admin review queue (pending requests, oldest first).
CREATE INDEX IF NOT EXISTS idx_shop_sender_ids_review
    ON public.shop_sender_ids(requested_at) WHERE status = 'under_review';

-- At most one default sender per shop. This is the row mirrored onto
-- shop_profiles — the app layer must always clear the old default before (or
-- atomically with) setting a new one, but this index is the hard backstop.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_sender_ids_one_default
    ON public.shop_sender_ids(shop_id) WHERE is_default = true;

-- ────────────────────────────────────────────────────────────────────────────
-- RLS — owner SELECT-only (mirrors the shop_sms_wallets / shop_sms_logs
-- pattern in shop_phase_c). ALL writes go through the authenticated shop
-- route (owner's own requests/default-switch) or the admin route (review) —
-- both use the service-role client, never a client INSERT/UPDATE/DELETE
-- policy.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.shop_sender_ids ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shop_sender_ids_owner_select" ON public.shop_sender_ids;
CREATE POLICY "shop_sender_ids_owner_select" ON public.shop_sender_ids
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.shop_profiles sp
            WHERE sp.id = shop_sender_ids.shop_id
              AND sp.owner_id = (SELECT auth.uid())
        )
    );

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.shop_sender_ids FROM anon, authenticated;

COMMENT ON TABLE public.shop_sender_ids IS
    'Shop SMS sender-ID requests (Feature Wave 6 Task 2) — up to 5 live per shop. Exactly one APPROVED row per shop may be is_default=true (partial unique index); that row is mirrored into shop_profiles.sms_sender_id/sms_sender_status/sms_sender_reviewed_at so resolveShopConfirmationSender (lib/sms-confirmation-sender.ts) and all F3 order-confirmation enforcement need zero changes. Writes are service-role only via app/api/shop/sms/sender-request/route.ts (owner) and app/api/admin/shop-sms/route.ts review_shop_sender (admin).';

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

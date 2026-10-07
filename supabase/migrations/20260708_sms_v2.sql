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

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

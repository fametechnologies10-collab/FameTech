-- supabase/migrations/20260926_sms_business_whatsapp_kyc.sql
-- WhatsApp-based business KYC: documents are collected over WhatsApp, not
-- uploaded to storage. Replaces the docs/cert-skip/grace-window columns with
-- a manual admin "verified via WhatsApp" record, adds the applicant's own
-- WhatsApp contact number, and adds a 'revoked' status for pulling back an
-- already-approved business. See
-- docs/superpowers/specs/2026-09-26-whatsapp-business-kyc-design.md.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Drop the cert-skip/grace cron RPC before dropping the columns it reads.
-- ─────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS sms_flag_expired_grace();

-- ─────────────────────────────────────────────────────────────────────────
-- 2. sms_business_profiles: drop upload/grace columns, extend status, add
--    WhatsApp-verification + applicant-contact columns.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE sms_business_profiles
    DROP COLUMN IF EXISTS docs,
    DROP COLUMN IF EXISTS cert_skipped,
    DROP COLUMN IF EXISTS grace_ends_at,
    DROP COLUMN IF EXISTS grace_flagged_at;

ALTER TABLE sms_business_profiles
    DROP CONSTRAINT IF EXISTS sms_business_profiles_status_check;
ALTER TABLE sms_business_profiles
    ADD CONSTRAINT sms_business_profiles_status_check
    CHECK (status IN ('draft', 'under_review', 'approved', 'rejected', 'revoked'));

ALTER TABLE sms_business_profiles
    ADD COLUMN IF NOT EXISTS whatsapp_verified boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS whatsapp_verification_note text,
    ADD COLUMN IF NOT EXISTS contact_whatsapp_number text;

COMMENT ON COLUMN sms_business_profiles.whatsapp_verified IS
    'Admin confirms Ghana Card + business documents were reviewed over WhatsApp. Required true before status can move to approved.';
COMMENT ON COLUMN sms_business_profiles.contact_whatsapp_number IS
    'Applicant''s own WhatsApp number (233XXXXXXXXX), so admin can message them directly.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Retire the KYC upload bucket's RLS policy — the client-side upload path
--    no longer exists, so the owner-insert policy on storage.objects is dead
--    weight. Real, replayable, idempotent statement (confirmed applied live
--    2026-09-27).
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS sms_kyc_docs_owner_insert ON storage.objects;

-- Bucket + object deletion for 'sms-kyc-docs' is intentionally NOT done here
-- as SQL: a `storage.protect_delete()` trigger blocks
-- `DELETE FROM storage.objects` / `DELETE FROM storage.buckets` outright, so
-- those statements would fail if this file were ever replayed. Remove the
-- bucket and its remaining objects manually via the Supabase Dashboard
-- Storage UI instead.

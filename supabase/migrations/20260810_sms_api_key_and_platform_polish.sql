-- Migration: 20260810_sms_api_key_and_platform_polish.sql
-- Adds a dedicated 'sms' api_keys.key_type (isolated to /api/v1/sms/*,
-- auto-active — business mode already required manual KYC review) and
-- sms_accounts columns for the delivery webhook + low-balance alert
-- premium additions.

-- ── api_keys.key_type: add 'sms' ────────────────────────────────────────
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'api_keys_key_type_check'
    ) THEN
        ALTER TABLE public.api_keys DROP CONSTRAINT api_keys_key_type_check;
    END IF;
    ALTER TABLE public.api_keys
        ADD CONSTRAINT api_keys_key_type_check
        CHECK (key_type IN ('standard', 'commission', 'sms'));
END $$;

-- ── sms_accounts: webhook + low-balance-alert columns ───────────────────
ALTER TABLE public.sms_accounts
    ADD COLUMN IF NOT EXISTS webhook_url TEXT,
    ADD COLUMN IF NOT EXISTS webhook_secret TEXT,
    ADD COLUMN IF NOT EXISTS low_balance_threshold INTEGER NOT NULL DEFAULT 50,
    ADD COLUMN IF NOT EXISTS low_balance_notified_at TIMESTAMPTZ;

COMMENT ON COLUMN public.sms_accounts.webhook_url IS
    'Business-mode account''s delivery-status webhook endpoint. Dispatched by the sms-status-reconcile cron when a campaign resolves to a terminal state.';
COMMENT ON COLUMN public.sms_accounts.webhook_secret IS
    'HMAC-SHA256 signing secret for webhook payloads (X-KFT-Signature header). Shown once on generation, never returned again.';
COMMENT ON COLUMN public.sms_accounts.low_balance_threshold IS
    'Credit balance below which one low-balance email notification fires. Default 50.';
COMMENT ON COLUMN public.sms_accounts.low_balance_notified_at IS
    'Set when the low-balance email fires; cleared on a top-up that brings balance back above threshold. Prevents repeat notifications.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: add_push_subscriptions.sql
-- Purpose:   Creates the push_subscriptions table to store Web Push
--            subscription objects per user and per device endpoint.
--            Each row maps a Supabase user to a browser push endpoint
--            along with its VAPID encryption keys (p256dh + auth).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Create the table
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    endpoint    TEXT        NOT NULL,
    p256dh      TEXT        NOT NULL,
    auth        TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- A user can have many devices, but each device endpoint is unique per user
    CONSTRAINT push_subscriptions_user_endpoint_unique UNIQUE (user_id, endpoint)
);

-- 2. Index for fast lookup by user_id (used by push-service.ts)
CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx
    ON push_subscriptions (user_id);

-- 3. Enable Row Level Security
--    All reads/writes are performed server-side via the service role key,
--    so no authenticated client policies are needed. RLS is enabled to
--    prevent any direct client-side access to raw push keys.
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- 4. Drop any existing policies cleanly before recreating (idempotent)
DROP POLICY IF EXISTS "Service role full access" ON push_subscriptions;
DROP POLICY IF EXISTS "Users can manage their own subscriptions" ON push_subscriptions;

-- 5. Allow users to manage their own subscriptions
CREATE POLICY "Users can manage their own subscriptions"
    ON push_subscriptions
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- 5b. Allow service role to read/write all subscriptions (for the push delivery background service)
CREATE POLICY "Service role full access"
    ON push_subscriptions
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

-- 6. Auto-update the updated_at timestamp on any row change
CREATE OR REPLACE FUNCTION update_push_subscriptions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS push_subscriptions_updated_at_trigger ON push_subscriptions;

CREATE TRIGGER push_subscriptions_updated_at_trigger
    BEFORE UPDATE ON push_subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_push_subscriptions_updated_at();

-- Done. Run this file once in the Supabase SQL editor or via the Supabase CLI:
--   supabase db push  (if using local CLI + migrations folder)

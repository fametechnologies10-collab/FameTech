-- ============================================================================
-- Developer API — Database Migration
-- Created: 2026-05-22
-- Description: Adds api_keys, api_logs tables, extends orders with source/api_key_id,
--              and seeds admin_settings for the Developer API feature.
-- Safe to run on a live Supabase database — uses IF NOT EXISTS everywhere.
-- ============================================================================

-- Ensure UUID extension is available (already exists, safe to repeat)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- TABLE 1: api_keys
-- Stores hashed API keys for developer access.
-- One key per user enforced by UNIQUE(user_id).
-- key_prefix (first 12 chars) used for fast middleware lookups.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.api_keys (
    id            UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id       UUID        REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
    key_hash      TEXT        NOT NULL,
    key_prefix    TEXT        NOT NULL,
    name          TEXT        NOT NULL DEFAULT 'My API Key',
    status        TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'active', 'revoked')),
    rate_limits   JSONB,      -- null = use global defaults from admin_settings
                              -- e.g. { "purchase": 10, "bulk": 3, "balance": 5, "status": 5 }
    last_used_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),

    -- ONE KEY PER USER (database-level enforcement)
    CONSTRAINT api_keys_user_id_unique UNIQUE (user_id),
    -- PREFIX MUST BE UNIQUE (for middleware rate-limit lookups)
    CONSTRAINT api_keys_prefix_unique  UNIQUE (key_prefix)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON public.api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_status  ON public.api_keys(status);

-- RLS
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

-- Users see their own key
CREATE POLICY "api_keys: user select own"
    ON public.api_keys FOR SELECT
    USING (user_id = (SELECT auth.uid()));

-- Users can insert (one row enforced by UNIQUE constraint)
CREATE POLICY "api_keys: user insert own"
    ON public.api_keys FOR INSERT
    WITH CHECK (user_id = (SELECT auth.uid()));

-- Users can update their own key (e.g. rename)
CREATE POLICY "api_keys: user update own"
    ON public.api_keys FOR UPDATE
    USING (user_id = (SELECT auth.uid()));

-- Users can delete own key (to create a replacement)
CREATE POLICY "api_keys: user delete own"
    ON public.api_keys FOR DELETE
    USING (user_id = (SELECT auth.uid()));

-- Admins have full access to all keys
CREATE POLICY "api_keys: admin full access"
    ON public.api_keys FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid()) AND role = 'admin'
        )
    );


-- ============================================================================
-- TABLE 2: api_logs
-- Stores every API request for auditing, debugging, and usage analytics.
-- Service role inserts; admins and key owners can read.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.api_logs (
    id               UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
    api_key_id       UUID        REFERENCES public.api_keys(id) ON DELETE SET NULL,
    user_id          UUID        REFERENCES public.users(id)   ON DELETE SET NULL,
    endpoint         TEXT        NOT NULL,
    method           TEXT        NOT NULL,
    status_code      INTEGER     NOT NULL,
    response_time_ms INTEGER,
    ip_address       TEXT,
    error_message    TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_api_logs_api_key_id ON public.api_logs(api_key_id);
CREATE INDEX IF NOT EXISTS idx_api_logs_user_id    ON public.api_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_api_logs_created_at ON public.api_logs(created_at DESC);

-- RLS
ALTER TABLE public.api_logs ENABLE ROW LEVEL SECURITY;

-- Admins see all logs
CREATE POLICY "api_logs: admin read all"
    ON public.api_logs FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = (SELECT auth.uid()) AND role = 'admin'
        )
    );

-- Users see their own logs
CREATE POLICY "api_logs: user read own"
    ON public.api_logs FOR SELECT
    USING (user_id = (SELECT auth.uid()));


-- ============================================================================
-- ALTER TABLE: orders
-- Add source column to track order origin (web, api, shop).
-- Add api_key_id to link API-placed orders back to the key.
-- ============================================================================

-- Track order origin
ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'web';

-- Link API orders to the key that placed them
ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS api_key_id UUID
        REFERENCES public.api_keys(id) ON DELETE SET NULL;

-- Indexes for filtering
CREATE INDEX IF NOT EXISTS idx_orders_source     ON public.orders(source);
CREATE INDEX IF NOT EXISTS idx_orders_api_key_id ON public.orders(api_key_id);

-- Backfill: existing shop orders should be 'shop', not 'web'
UPDATE public.orders
    SET source = 'shop'
    WHERE reference_code LIKE 'SHOP-%'
    AND source = 'web';


-- ============================================================================
-- ADMIN SETTINGS: Default configuration for the API feature
-- ============================================================================

INSERT INTO public.admin_settings (key, value) VALUES
    -- Master switch: enable/disable the entire API feature
    ('api_feature_enabled', 'true'),

    -- Roles allowed to use the API (agent only at launch, configurable by admin)
    ('api_allowed_roles', '["agent"]'),

    -- Global default rate limits per minute (overridable per key via api_keys.rate_limits)
    ('api_rate_limits', '{"packages": 10, "purchase": 10, "bulk": 3, "balance": 5, "status": 5}')

ON CONFLICT (key) DO NOTHING;

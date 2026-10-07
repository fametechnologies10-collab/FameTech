-- ============================================================================
-- API Key Types — commission key support
-- Created: 2026-07-10
-- Description: Adds api_keys.key_type ('standard' | 'commission') so developer
--   API users can hold a SECOND key scoped to the utility-bill endpoints only
--   (upcoming /api/v1/utilities/*). Commission keys pay face value from the
--   caller's main wallet and earn a commission share into their SHOP wallet —
--   credit_utility_commission (supabase/migrations/20260709b_utility_rpcs.sql)
--   already resolves source='api' utility orders' partner as the order's
--   user_id, so issuance of a commission key REQUIRES the caller to already
--   own an active shop (enforced in app/api/user/api-keys/route.ts, not here).
--
--   'standard' (the pre-existing default, kf_live_... prefix) is BYTE-PRESERVED:
--   same format, same bcrypt cost, same pending→admin-approve flow, same
--   "works on every /api/v1/* route" behavior. This migration only ADDS a
--   column + a composite uniqueness constraint; it changes no existing row's
--   observable behavior (every pre-existing row defaults to key_type='standard').
--
--   One key PER TYPE per user: the old UNIQUE(user_id) constraint
--   (api_keys_user_id_unique, see 20260521_developer_api.sql) is replaced by a
--   composite UNIQUE(user_id, key_type) — a user may hold at most one
--   'standard' AND at most one 'commission' key simultaneously.
--
-- Purely additive + idempotent — safe to run multiple times / on a live DB.
-- ============================================================================

-- ── Column: key_type ─────────────────────────────────────────────────────
-- Every existing row gets key_type='standard' via the DEFAULT — zero behavior
-- change for current API users.
ALTER TABLE public.api_keys
    ADD COLUMN IF NOT EXISTS key_type TEXT NOT NULL DEFAULT 'standard';

-- CHECK constraint added separately for idempotency: when the column already
-- exists, "ADD COLUMN IF NOT EXISTS ... CHECK (...)" is skipped entirely by
-- IF NOT EXISTS, so the CHECK must be verified/added independently on repeat
-- runs (mirrors the DO-block convention in 20260701_sub_agents.sql).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.api_keys'::regclass
          AND conname = 'api_keys_key_type_check'
    ) THEN
        ALTER TABLE public.api_keys
            ADD CONSTRAINT api_keys_key_type_check
            CHECK (key_type IN ('standard', 'commission'));
    END IF;
END $$;

-- ── Replace one-key-per-user with one-key-PER-TYPE-per-user ────────────────
-- Real constraint name confirmed from 20260521_developer_api.sql:
--   CONSTRAINT api_keys_user_id_unique UNIQUE (user_id)
-- (the brief's guess of "api_keys_user_id_key" was NOT the actual name — the
-- table was created with an explicitly-named constraint, not the Postgres
-- auto-generated one).
ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_user_id_unique;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.api_keys'::regclass
          AND conname = 'api_keys_user_type_unique'
    ) THEN
        ALTER TABLE public.api_keys
            ADD CONSTRAINT api_keys_user_type_unique UNIQUE (user_id, key_type);
    END IF;
END $$;

-- key_prefix stays globally UNIQUE (api_keys_prefix_unique, untouched) — the
-- prefix keyspace is shared across both key types; lib/api-auth.ts's prefix
-- lookup depends on global uniqueness regardless of key_type.

-- ── Index for per-type lookups (admin filters, future per-type analytics) ──
CREATE INDEX IF NOT EXISTS idx_api_keys_key_type ON public.api_keys(key_type);

COMMENT ON COLUMN public.api_keys.key_type IS
    'standard = kf_live_... prefix; valid on every /api/v1/* route except /api/v1/utilities (rejected there by that route''s own requireKeyType check). commission = kf_cs_live_... prefix; utilities-only (enforced centrally in lib/api-auth.ts validateApiKey — any /api/v1/* path NOT starting with /api/v1/utilities 403s a commission key before reaching the route). Issuance of a commission key requires the caller to own an active (approved + is_active) shop_profiles row; its commission share is credited to that shop''s wallet via credit_utility_commission.';

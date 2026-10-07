-- supabase/migrations/20260701_sub_agents.sql
-- =============================================================================
-- Sub-Agents (Storefront Network) — Phase 1 schema foundation
--
-- New tables : sub_agents (membership), shop_invites (onboarding tokens)
-- Alters     : shop_pricing (+sub_price),
--              shop_orders (+parent_shop_id, +parent_profit),
--              shop_wallet_transactions (+sub_approval_*, +escalate_after, +auto_escalated),
--              withdrawal status CHECK (+ 'shop_owner_pending')
-- RLS        : sub reads own row; Lead reads downline (sub_agents / shop_orders /
--              shop_wallet_transactions). ALL writes (redeem, approve, suspend,
--              set ceiling, credit) go through SECURITY DEFINER service-role RPCs
--              which bypass RLS — there are deliberately NO client write policies.
--
-- Ground truth: built from migrations + types/supabase.ts, NOT schema.sql (stale).
-- Idempotent. RPCs are NOT here — they land in Phases 2 (effective_owner_cost),
-- 3 (adjust_shop_pricing dealer branch), 4 (redeem_sub_invite), 6 (credit RPCs).
-- =============================================================================

-- 1. shop_invites — created first because sub_agents FKs it (joined_via_invite)
CREATE TABLE IF NOT EXISTS public.shop_invites (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  shop_id     UUID NOT NULL REFERENCES public.shop_profiles(id) ON DELETE CASCADE,  -- the LEAD shop
  code        TEXT NOT NULL UNIQUE,
  max_uses    INTEGER,                       -- NULL = unlimited
  used_count  INTEGER NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ,                   -- NULL = never expires
  revoked_at  TIMESTAMPTZ,                   -- non-NULL = revoked
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shop_invites_shop ON public.shop_invites(shop_id);
CREATE INDEX IF NOT EXISTS idx_shop_invites_code ON public.shop_invites(code);

-- 2. sub_agents — the membership edge that makes a user a sub (with or without a storefront)
CREATE TABLE IF NOT EXISTS public.sub_agents (
  id                UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id           UUID NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  upline_shop_id    UUID NOT NULL REFERENCES public.shop_profiles(id) ON DELETE RESTRICT,  -- keep sub's funds intact if Lead shop deletion is attempted
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  markup_ceiling    DECIMAL(12,2),           -- NULL = platform default (admin_settings.sub_markup_ceiling_default)
  approved_by       UUID REFERENCES public.users(id),
  approved_at       TIMESTAMPTZ,
  joined_via_invite UUID REFERENCES public.shop_invites(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sub_agents_upline ON public.sub_agents(upline_shop_id);
CREATE INDEX IF NOT EXISTS idx_sub_agents_status ON public.sub_agents(status);

-- 3. shop_pricing — the Lead's wholesale price for subs (their cost in both modes)
ALTER TABLE public.shop_pricing
  ADD COLUMN IF NOT EXISTS sub_price DECIMAL(12,2);   -- NULL = subs not yet priced for this package

-- 4. shop_orders — sub-sale attribution (the Lead credited on a sub's storefront sale)
ALTER TABLE public.shop_orders
  ADD COLUMN IF NOT EXISTS parent_shop_id UUID REFERENCES public.shop_profiles(id),
  ADD COLUMN IF NOT EXISTS parent_profit  DECIMAL(12,2);
CREATE INDEX IF NOT EXISTS idx_shop_orders_parent ON public.shop_orders(parent_shop_id);

-- 5. shop_wallet_transactions — sub withdrawal approval chain columns
ALTER TABLE public.shop_wallet_transactions
  ADD COLUMN IF NOT EXISTS sub_approval_status TEXT NOT NULL DEFAULT 'not_required'
      CHECK (sub_approval_status IN ('not_required','pending','approved','rejected')),
  ADD COLUMN IF NOT EXISTS sub_approved_by  UUID REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS sub_approval_note TEXT,
  ADD COLUMN IF NOT EXISTS escalate_after   TIMESTAMPTZ,   -- now()+48h at request; now() if Lead already ineligible
  ADD COLUMN IF NOT EXISTS auto_escalated   BOOLEAN NOT NULL DEFAULT FALSE;

-- 6. Extend the withdrawal status CHECK with 'shop_owner_pending' (a pre-'pending' state).
--    Mirrors the introspect-and-drop pattern from 20260619 so we never guess the
--    auto-generated constraint name. ('rejected' intentionally stays OUT of the main
--    status enum — sub rejection is tracked on sub_approval_status; funds go 'reversed'.)
DO $$
DECLARE v_constraint TEXT;
BEGIN
    SELECT conname INTO v_constraint
    FROM pg_constraint
    WHERE conrelid = 'public.shop_wallet_transactions'::regclass
      AND contype = 'c' AND conname LIKE '%status%' AND conname NOT LIKE '%sub_approval%'
    ORDER BY conname LIMIT 1;
    IF v_constraint IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.shop_wallet_transactions DROP CONSTRAINT %I', v_constraint);
    END IF;
END; $$;

ALTER TABLE public.shop_wallet_transactions
    ADD CONSTRAINT shop_wallet_transactions_status_check
    CHECK (status IN ('shop_owner_pending','pending','moolre_pending','paystack_pending','completed','failed','reversed'));

-- 7. Escalation-cron performance index (sweep un-approved sub withdrawals past their deadline)
CREATE INDEX IF NOT EXISTS idx_shop_wallet_tx_owner_pending
    ON public.shop_wallet_transactions (escalate_after)
    WHERE status = 'shop_owner_pending';

-- =============================================================================
-- 8. Row Level Security
-- =============================================================================
ALTER TABLE public.sub_agents  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_invites ENABLE ROW LEVEL SECURITY;

-- sub_agents: a sub reads their OWN membership row
DROP POLICY IF EXISTS "sub_agents_self_read" ON public.sub_agents;
CREATE POLICY "sub_agents_self_read" ON public.sub_agents
  FOR SELECT USING (user_id = auth.uid());

-- sub_agents: a Lead reads their DOWNLINE
DROP POLICY IF EXISTS "sub_agents_lead_read" ON public.sub_agents;
CREATE POLICY "sub_agents_lead_read" ON public.sub_agents
  FOR SELECT USING (
    upline_shop_id IN (SELECT id FROM public.shop_profiles WHERE owner_id = auth.uid())
  );
-- (No client INSERT/UPDATE/DELETE: redeem/approve/suspend/set-ceiling run via service-role RPCs.)

-- shop_invites: a Lead manages their OWN invites; no public read (prevents code enumeration —
-- redemption/validation is server-side via a service-role route/RPC)
DROP POLICY IF EXISTS "shop_invites_lead_all" ON public.shop_invites;
CREATE POLICY "shop_invites_lead_all" ON public.shop_invites
  FOR ALL USING (
    shop_id IN (SELECT id FROM public.shop_profiles WHERE owner_id = auth.uid())
  );

-- shop_orders: a Lead can read sub-sales attributed to them (read-only downline monitoring)
DROP POLICY IF EXISTS "shop_orders_parent_read" ON public.shop_orders;
CREATE POLICY "shop_orders_parent_read" ON public.shop_orders
  FOR SELECT USING (
    parent_shop_id IN (SELECT id FROM public.shop_profiles WHERE owner_id = auth.uid())
  );

-- shop_wallet_transactions: a Lead can READ their downline subs' ledger (to approve
-- withdrawals + monitor earnings). Approve/reject itself is an RPC — never a client write.
DROP POLICY IF EXISTS "shop_wallet_tx_lead_read" ON public.shop_wallet_transactions;
CREATE POLICY "shop_wallet_tx_lead_read" ON public.shop_wallet_transactions
  FOR SELECT USING (
    shop_wallet_id IN (
      SELECT sw.id
      FROM public.shop_wallets sw
      JOIN public.sub_agents sa ON sa.user_id = sw.owner_id
      WHERE sa.upline_shop_id IN (SELECT id FROM public.shop_profiles WHERE owner_id = auth.uid())
    )
  );

-- =============================================================================
-- Apply notes (Manual Action — non-interactive session cannot run Supabase OAuth):
--   1. Apply to a Supabase BRANCH first (never prod directly).
--   2. Run get_advisors — expect zero new RLS/security warnings.
--   3. Regenerate types/supabase.ts.
--   4. Config keys (admin_settings: sub_min_margin, sub_markup_ceiling_default) are
--      seeded in Phase 5 once the admin_settings read-shape is confirmed; code carries
--      hardcoded fallbacks so the resolver is safe before the seed lands.
-- =============================================================================

-- ============================================================
-- Shop Mega-Update Phase B
-- 1. Setup wizard progress tracking on shop_profiles
-- 2. Per-exam-type results checker markups (shop_rc_markups)
-- ============================================================

-- ─── 1. Setup wizard progress ─────────────────────────────────────────────────
ALTER TABLE public.shop_profiles
    ADD COLUMN IF NOT EXISTS setup_progress JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS setup_completed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.shop_profiles.setup_progress IS
    'Wizard state: { "step": int, "completed": ["details","contact","branding","pricing"] }';

-- ─── 2. Per-exam-type results checker markups ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shop_rc_markups (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id      UUID NOT NULL REFERENCES public.shop_profiles(id) ON DELETE CASCADE,
    exam_type_id UUID NOT NULL REFERENCES public.results_checker_types(id) ON DELETE CASCADE,
    markup       NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (markup >= 0),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (shop_id, exam_type_id)
);

CREATE INDEX IF NOT EXISTS idx_shop_rc_markups_shop ON public.shop_rc_markups(shop_id);

ALTER TABLE public.shop_rc_markups ENABLE ROW LEVEL SECURITY;

-- Owners manage their own markups
DROP POLICY IF EXISTS "rc_markups_owner_all" ON public.shop_rc_markups;
CREATE POLICY "rc_markups_owner_all" ON public.shop_rc_markups
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.shop_profiles sp
            WHERE sp.id = shop_rc_markups.shop_id
              AND sp.owner_id = (SELECT auth.uid())
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.shop_profiles sp
            WHERE sp.id = shop_rc_markups.shop_id
              AND sp.owner_id = (SELECT auth.uid())
        )
    );

-- Storefront visitors need read access to compute displayed prices
-- (markups are public information — they are baked into storefront prices)
DROP POLICY IF EXISTS "rc_markups_public_read" ON public.shop_rc_markups;
CREATE POLICY "rc_markups_public_read" ON public.shop_rc_markups
    FOR SELECT
    USING (true);

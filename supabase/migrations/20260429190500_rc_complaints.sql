-- ============================================================================
-- RESULTS CHECKER COMPLAINTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.results_checker_complaints (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID REFERENCES public.results_checker_orders(id) NOT NULL,
    user_id UUID REFERENCES public.users(id),
    shop_id UUID REFERENCES public.shop_profiles(id),
    description TEXT NOT NULL,
    status TEXT DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    admin_note TEXT,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS
ALTER TABLE public.results_checker_complaints ENABLE ROW LEVEL SECURITY;

-- Users can select their own complaints
DROP POLICY IF EXISTS "rc_complaints_user_select" ON public.results_checker_complaints;
CREATE POLICY "rc_complaints_user_select"
    ON public.results_checker_complaints
    FOR SELECT
    USING (auth.uid() = user_id OR auth.role() = 'service_role');

-- Shop owners can see complaints for their shop
DROP POLICY IF EXISTS "rc_complaints_shop_select" ON public.results_checker_complaints;
CREATE POLICY "rc_complaints_shop_select"
    ON public.results_checker_complaints
    FOR SELECT
    USING (auth.uid() IN (SELECT owner_id FROM public.shop_profiles WHERE id = shop_id));

-- Service role can do everything
DROP POLICY IF EXISTS "rc_complaints_service_all" ON public.results_checker_complaints;
CREATE POLICY "rc_complaints_service_all"
    ON public.results_checker_complaints
    FOR ALL
    USING (auth.role() = 'service_role');

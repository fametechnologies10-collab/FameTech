-- Shop SMS saved recipient groups — lets a shop owner save a named, reusable
-- list of numbers (pasted or uploaded) instead of re-entering them per send.
-- Lead-intake pattern (see CLAUDE.md): owner gets SELECT-only RLS; every
-- write goes through a service-role client after validation in the API route.
-- No client INSERT/UPDATE/DELETE policy exists on either table, and none
-- should ever be added — groups only ever feed the existing
-- /api/shop/sms/send recipients array, which keeps its own full
-- validation/idempotency/credit-debit pipeline untouched.

CREATE TABLE IF NOT EXISTS public.shop_sms_groups (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id    UUID NOT NULL REFERENCES public.shop_profiles(id) ON DELETE CASCADE,
    name       TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 60),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (shop_id, name)
);

CREATE TABLE IF NOT EXISTS public.shop_sms_group_members (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id   UUID NOT NULL REFERENCES public.shop_sms_groups(id) ON DELETE CASCADE,
    -- Denormalized from group_id so the RLS policy and per-shop count
    -- queries below stay simple index lookups (matches shop_customers).
    shop_id    UUID NOT NULL REFERENCES public.shop_profiles(id) ON DELETE CASCADE,
    phone      TEXT NOT NULL, -- normalized 233XXXXXXXXX — never trust client normalization
    name       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (group_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_shop_sms_groups_shop         ON public.shop_sms_groups(shop_id);
CREATE INDEX IF NOT EXISTS idx_shop_sms_group_members_group ON public.shop_sms_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_shop_sms_group_members_shop  ON public.shop_sms_group_members(shop_id);

ALTER TABLE public.shop_sms_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_sms_group_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY shop_sms_groups_select ON public.shop_sms_groups
    FOR SELECT USING (shop_id IN (SELECT id FROM shop_profiles WHERE owner_id = (SELECT auth.uid())));
CREATE POLICY shop_sms_groups_admin ON public.shop_sms_groups
    FOR ALL USING (is_admin());

CREATE POLICY shop_sms_group_members_select ON public.shop_sms_group_members
    FOR SELECT USING (shop_id IN (SELECT id FROM shop_profiles WHERE owner_id = (SELECT auth.uid())));
CREATE POLICY shop_sms_group_members_admin ON public.shop_sms_group_members
    FOR ALL USING (is_admin());

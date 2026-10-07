-- Hardening follow-up from the payments-security-reviewer pass on the shop
-- SMS groups feature (see docs/security-audits/ for the audit convention).
--
-- 1. Belt-and-suspenders only — RLS already default-denies these writes for
--    non-admins (no non-SELECT policy exists for anon/authenticated on
--    either table). This matches the project's stated convention of also
--    revoking the underlying grants, already done for ussd_pending_orders,
--    shop_orders, and shop_customers.
REVOKE INSERT, UPDATE, DELETE ON public.shop_sms_groups, public.shop_sms_group_members FROM anon, authenticated;

-- 2. Matches the Zod .max(100) cap added to the per-member name at the API
--    layer (app/api/shop/sms/groups/route.ts and .../[id]/route.ts).
ALTER TABLE public.shop_sms_group_members
    ADD CONSTRAINT shop_sms_group_members_name_len CHECK (name IS NULL OR char_length(name) <= 100);

-- supabase/migrations/20260705d_advisor_hardening.sql
-- Close the two advisor findings introduced by the sub-agent money-core functions:
--  1. function_search_path_mutable — pin search_path on all new SECURITY DEFINER /
--     shared functions (defence against search_path hijack of unqualified refs).
--  2. anon_security_definer_function_executable — find_drifted_shop_pricing was still
--     anon/authenticated-executable (REVOKE FROM PUBLIC doesn't drop Supabase's default
--     role grants); it leaks cross-shop cost/pricing. Revoke by name.
ALTER FUNCTION public.effective_owner_cost(numeric, numeric, numeric, text)   SET search_path TO 'public';
ALTER FUNCTION public.credit_shop_order_profits(uuid)                         SET search_path TO 'public';
ALTER FUNCTION public.credit_lead_margin(text, uuid, numeric, text)           SET search_path TO 'public';
ALTER FUNCTION public.find_drifted_shop_pricing()                             SET search_path TO 'public';
ALTER FUNCTION public.adjust_shop_pricing_for_role_change(uuid, text, text)   SET search_path TO 'public';

REVOKE ALL ON FUNCTION public.find_drifted_shop_pricing() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.find_drifted_shop_pricing() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_drifted_shop_pricing() TO service_role;

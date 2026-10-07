-- Fix: users_auto_upgrade_plan_check omitted '1m' and '3m', which
-- app/api/user/upgrade/toggle-auto-upgrade/route.ts's VALID_PLANS/DEALER_PLANS
-- have always allowed dealers to select. Every dealer who chose a 1-month or
-- 3-month auto-upgrade plan got a silent 500 (23514 check violation) instead
-- of having auto-upgrade enabled. Widen the constraint to match the app's
-- already-shipped intent — '6m' was the only dealer plan actually representable.
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_auto_upgrade_plan_check;
ALTER TABLE public.users ADD CONSTRAINT users_auto_upgrade_plan_check
  CHECK (auto_upgrade_plan = ANY (ARRAY['3d'::text, '14d'::text, '30d'::text, 'permanent'::text, '1m'::text, '3m'::text, '6m'::text]));

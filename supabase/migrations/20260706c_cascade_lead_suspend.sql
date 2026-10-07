-- supabase/migrations/20260706c_cascade_lead_suspend.sql
-- Cascade suspend (spec §13): when a Lead's shop is suspended (by admin), take every
-- sub-agent's storefront offline immediately. The live eligibility gate (getSubContext)
-- already blocks CHARGING when the Lead is suspended; this is the visible hard-offline so
-- sub storefronts don't keep rendering as "open". No route changes needed — fires on any
-- shop suspension (no-op for shops with no downline). Reactivation is deliberately manual.
CREATE OR REPLACE FUNCTION public.cascade_lead_suspend()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.approval_status = 'suspended' AND OLD.approval_status IS DISTINCT FROM 'suspended' THEN
    UPDATE public.shop_profiles sp
    SET is_active = false, updated_at = now()
    FROM public.sub_agents sa
    WHERE sa.upline_shop_id = NEW.id
      AND sp.owner_id = sa.user_id
      AND sp.is_active = true;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_cascade_lead_suspend ON public.shop_profiles;
CREATE TRIGGER trg_cascade_lead_suspend
  AFTER UPDATE OF approval_status ON public.shop_profiles
  FOR EACH ROW EXECUTE FUNCTION public.cascade_lead_suspend();

-- Trigger functions returning `trigger` aren't PostgREST-callable, but revoke for advisor hygiene.
REVOKE ALL ON FUNCTION public.cascade_lead_suspend() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cascade_lead_suspend() FROM anon, authenticated;

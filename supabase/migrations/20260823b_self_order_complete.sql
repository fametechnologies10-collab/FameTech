-- supabase/migrations/20260823b_self_order_complete.sql

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS self_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS self_completed_by uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS self_completed_by_role text;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_self_completed_by_role_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_self_completed_by_role_check
  CHECK (self_completed_by_role IS NULL OR self_completed_by_role IN ('customer', 'shop_owner'));

CREATE INDEX IF NOT EXISTS idx_orders_self_completed_by ON public.orders(self_completed_by)
  WHERE self_completed_by IS NOT NULL;

-- Sole authority for the processing -> completed self-service transition.
-- Deliberately stricter than claim_order_retry: ownership is resolved HERE,
-- in SQL, rather than trusted from the caller, because a false "complete"
-- has no self-limiting wallet cost (unlike a false retry) — it would hide a
-- real non-delivery and block the actual customer's refund path. The only
-- write this function can ever perform sets status to 'completed', and only
-- when the current status is exactly 'processing'.
CREATE OR REPLACE FUNCTION public.claim_self_order_complete(
  p_order_id uuid,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_o public.orders%ROWTYPE;
  v_role text;
BEGIN
  SELECT * INTO v_o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'order_not_found');
  END IF;

  IF v_o.user_id = p_actor_id THEN
    v_role := 'customer';
  ELSIF v_o.shop_order_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.shop_orders so
    JOIN public.shop_profiles sp ON sp.id = so.shop_id
    WHERE so.id = v_o.shop_order_id AND sp.owner_id = p_actor_id
  ) THEN
    v_role := 'shop_owner';
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'not_owner');
  END IF;

  IF v_o.status = 'completed' THEN
    RETURN jsonb_build_object('ok', true, 'already_completed', true);
  END IF;

  IF v_o.status <> 'processing' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_eligible', 'status', v_o.status);
  END IF;

  UPDATE public.orders SET
    status = 'completed',
    self_completed_at = now(),
    self_completed_by = p_actor_id,
    self_completed_by_role = v_role,
    updated_at = now()
  WHERE id = p_order_id;

  RETURN jsonb_build_object('ok', true, 'role', v_role);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_self_order_complete(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_self_order_complete(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

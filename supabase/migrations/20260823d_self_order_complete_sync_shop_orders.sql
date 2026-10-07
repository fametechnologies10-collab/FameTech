-- supabase/migrations/20260823d_self_order_complete_sync_shop_orders.sql
--
-- Fix (HIGH, whole-branch security review): claim_self_order_complete never
-- synced shop_orders.status, so trg_log_shop_profit (AFTER UPDATE ON
-- shop_orders, supabase/migrations/20260318_profit_dashboard_schema.sql)
-- never fired for self-completed shop orders — zero admin_profit_logs entry
-- for that channel, and shop_orders.status stayed stuck at 'processing'
-- forever (only shop_orders_effective's COALESCE-derived effective_status
-- showed 'completed'). This is an audit-trail gap only: shop profit is
-- credited at payment time (creditShopProfit in lib/shop-service.ts), not at
-- completion, so this migration only restores status-sync and lets the
-- existing trigger fire naturally — it does not credit/re-credit anything.
--
-- CREATE OR REPLACE FUNCTION (not an edit to the already-applied
-- 20260823b_self_order_complete.sql) per this branch's convention for
-- amending an already-applied RPC. Same signature, same body, same
-- SECURITY DEFINER / search_path / grants — only the new shop_orders sync
-- is added, right after the existing `orders` UPDATE, inside the same
-- 'processing' completion branch.

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

  -- Keep shop_orders in sync so the profit-audit trigger (trg_log_shop_profit,
  -- AFTER UPDATE ON shop_orders) fires for self-completed shop orders, matching
  -- every other completion path (syncShopOrderStatus / shop-order-processor.ts).
  -- Guard against clobbering a refunded shop_orders row (defensive; a refunded
  -- shop_orders row shouldn't exist for a still-'processing' orders row in
  -- practice, but avoid overwriting a terminal refunded state if it ever does).
  IF v_o.shop_order_id IS NOT NULL THEN
    UPDATE public.shop_orders SET status = 'completed', updated_at = now()
    WHERE id = v_o.shop_order_id AND status <> 'refunded';
  END IF;

  RETURN jsonb_build_object('ok', true, 'role', v_role);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_self_order_complete(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_self_order_complete(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

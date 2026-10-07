-- ============================================================================
-- 20260714c_hubtel_receive_rpcs.sql
-- Hubtel Receive Money rail — atomic claim + expiry RPCs. SECURITY DEFINER,
-- service_role only. The claim is the single convergence point every settle
-- path (callback, status-poll, cron) funnels through, so a charge is credited
-- exactly once regardless of which path wins the race.
-- ============================================================================

-- Atomically claim a Receive charge as paid exactly once (callback + poll + cron converge here).
CREATE OR REPLACE FUNCTION public.claim_hubtel_receive_paid(p_reference text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row record;
BEGIN
  UPDATE public.hubtel_receive_charges
     SET status='paid', paid_at=now()
   WHERE reference_code=p_reference AND status='pending'
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    SELECT * INTO v_row FROM public.hubtel_receive_charges WHERE reference_code=p_reference;
    IF NOT FOUND THEN RETURN jsonb_build_object('claimed',false,'error','not_found'); END IF;
    RETURN jsonb_build_object('claimed',false,'already',v_row.status);
  END IF;
  RETURN jsonb_build_object('claimed',true,'service_type',v_row.service_type,'order_id',v_row.order_id);
END $$;

-- Bulk-expire stale pendings (customer never approved the prompt). No money moved for a
-- collection, so expiry needs no refund.
CREATE OR REPLACE FUNCTION public.expire_stale_hubtel_receive(p_older_than_minutes int DEFAULT 10)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  UPDATE public.hubtel_receive_charges
     SET status='expired'
   WHERE status='pending' AND created_at < now() - make_interval(mins => p_older_than_minutes);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION public.claim_hubtel_receive_paid(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_hubtel_receive_paid(text) TO service_role;
REVOKE ALL ON FUNCTION public.expire_stale_hubtel_receive(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_hubtel_receive(int) TO service_role;

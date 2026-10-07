-- supabase/migrations/20260706_sub_invite_redeem.sql
-- =============================================================================
-- Sub-agent onboarding (spec §9, Phase 4.2): atomically redeem an invite code into
-- a PENDING sub_agents membership. Enforces the one-membership + one-role rules:
--   * a user already a sub  -> idempotent (returns existing; never switches upline)
--   * a user who owns a top-level shop -> rejected (a Lead can't be someone's sub)
--   * the Lead can't redeem their own invite (no self-recruit / cycles)
-- Invite validity (locked FOR UPDATE): not revoked, not expired, uses remaining.
-- service_role only — the /join route calls it with a server-trusted p_user_id.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.redeem_sub_invite(p_code text, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_invite   public.shop_invites%ROWTYPE;
  v_existing public.sub_agents%ROWTYPE;
  v_has_shop boolean;
BEGIN
  IF p_code IS NULL OR length(btrim(p_code)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_code');
  END IF;
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_user');
  END IF;

  -- Already a sub? Idempotent — return current membership, never re-redeem/switch upline.
  SELECT * INTO v_existing FROM public.sub_agents WHERE user_id = p_user_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'already_member', true,
      'status', v_existing.status, 'upline_shop_id', v_existing.upline_shop_id);
  END IF;

  -- One role per user: a top-level shop owner cannot also be a sub-agent.
  SELECT EXISTS (SELECT 1 FROM public.shop_profiles WHERE owner_id = p_user_id) INTO v_has_shop;
  IF v_has_shop THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_shop_owner');
  END IF;

  -- Lock + validate the invite.
  SELECT * INTO v_invite FROM public.shop_invites WHERE code = p_code FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'invite_not_found'); END IF;
  IF v_invite.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'invite_revoked'); END IF;
  IF v_invite.expires_at IS NOT NULL AND v_invite.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invite_expired'); END IF;
  IF v_invite.max_uses IS NOT NULL AND v_invite.used_count >= v_invite.max_uses THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invite_exhausted'); END IF;

  IF NOT EXISTS (SELECT 1 FROM public.shop_profiles WHERE id = v_invite.shop_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'upline_missing');
  END IF;
  IF EXISTS (SELECT 1 FROM public.shop_profiles WHERE id = v_invite.shop_id AND owner_id = p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cannot_self_recruit');
  END IF;

  INSERT INTO public.sub_agents (user_id, upline_shop_id, status, joined_via_invite)
    VALUES (p_user_id, v_invite.shop_id, 'pending', v_invite.id);
  UPDATE public.shop_invites SET used_count = used_count + 1 WHERE id = v_invite.id;

  RETURN jsonb_build_object('ok', true, 'created', true, 'status', 'pending', 'upline_shop_id', v_invite.shop_id);
EXCEPTION WHEN unique_violation THEN
  -- Race: a concurrent redeem created the membership first — treat as already a member.
  RETURN jsonb_build_object('ok', true, 'already_member', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.redeem_sub_invite(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.redeem_sub_invite(text, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_sub_invite(text, uuid) TO service_role;

-- Lead-driven membership state changes (approve / suspend / reactivate / set ceiling).
-- One RPC keeps the Lead-ownership check + status transitions in a single trusted place.
CREATE OR REPLACE FUNCTION public.set_sub_agent_state(
  p_actor_id  uuid,   -- the caller (must own the upline shop, or be admin via service path)
  p_sub_user_id uuid, -- the sub whose membership is changing
  p_action    text,   -- 'approve' | 'suspend' | 'reactivate' | 'set_ceiling'
  p_ceiling   numeric DEFAULT NULL,
  p_is_admin  boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_sa    public.sub_agents%ROWTYPE;
  v_owner uuid;
BEGIN
  SELECT * INTO v_sa FROM public.sub_agents WHERE user_id = p_sub_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'sub_not_found'); END IF;

  -- Authorization: the actor must own the sub's upline shop (unless an admin path).
  SELECT owner_id INTO v_owner FROM public.shop_profiles WHERE id = v_sa.upline_shop_id;
  IF NOT p_is_admin AND (v_owner IS NULL OR v_owner <> p_actor_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_your_sub');
  END IF;

  IF p_action = 'approve' THEN
    IF v_sa.status = 'suspended' THEN RETURN jsonb_build_object('ok', false, 'error', 'suspended'); END IF;
    UPDATE public.sub_agents SET status='active', approved_by=p_actor_id, approved_at=now(), updated_at=now()
      WHERE user_id=p_sub_user_id;
  ELSIF p_action = 'suspend' THEN
    UPDATE public.sub_agents SET status='suspended', updated_at=now() WHERE user_id=p_sub_user_id;
    -- Take the sub's storefront offline immediately.
    UPDATE public.shop_profiles SET is_active=false, updated_at=now() WHERE owner_id=p_sub_user_id;
  ELSIF p_action = 'reactivate' THEN
    UPDATE public.sub_agents SET status='active', updated_at=now() WHERE user_id=p_sub_user_id;
  ELSIF p_action = 'set_ceiling' THEN
    IF p_ceiling IS NOT NULL AND p_ceiling < 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_ceiling'); END IF;
    UPDATE public.sub_agents SET markup_ceiling=p_ceiling, updated_at=now() WHERE user_id=p_sub_user_id;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'bad_action');
  END IF;

  RETURN jsonb_build_object('ok', true, 'action', p_action);
END;
$function$;

REVOKE ALL ON FUNCTION public.set_sub_agent_state(uuid, uuid, text, numeric, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_sub_agent_state(uuid, uuid, text, numeric, boolean) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_sub_agent_state(uuid, uuid, text, numeric, boolean) TO service_role;

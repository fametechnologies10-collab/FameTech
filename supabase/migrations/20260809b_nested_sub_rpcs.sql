-- supabase/migrations/20260809b_nested_sub_rpcs.sql
-- =============================================================================
-- Nested sub-agent network (spec §5) — recruiting + depth enforcement.
--
--  redeem_sub_invite    : + depth cap (max 3 levels), loop-bounded walk
--  set_sub_agent_state  : + grant_recruit / revoke_recruit actions
--                         + auto-revoke the target's invites on suspend/revoke
--
-- Both replaced at their EXISTING signatures so current grants and callers hold.
-- =============================================================================

-- Helper: how many levels above this shop already exist? 0 == the shop's owner
-- is a true Lead (not a sub). Loop-BOUNDED (spec §5.3) — a data cycle must never
-- hang a SECURITY DEFINER function, so we count iterations rather than trusting
-- the walk to terminate on a NULL upline.
CREATE OR REPLACE FUNCTION public.sub_chain_depth_above(p_shop_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_depth   INTEGER := 0;
  v_shop    UUID := p_shop_id;
  v_owner   UUID;
  v_upline  UUID;
  i         INTEGER;
BEGIN
  -- Hard bound: at most 3 hops are ever meaningful; iterate no further.
  FOR i IN 1..3 LOOP
    SELECT owner_id INTO v_owner FROM public.shop_profiles WHERE id = v_shop;
    IF v_owner IS NULL THEN RETURN v_depth; END IF;

    SELECT upline_shop_id INTO v_upline FROM public.sub_agents WHERE user_id = v_owner;
    IF v_upline IS NULL THEN RETURN v_depth; END IF;   -- owner is a true Lead

    v_depth := v_depth + 1;
    v_shop  := v_upline;
  END LOOP;

  RETURN v_depth;
END;
$function$;

REVOKE ALL ON FUNCTION public.sub_chain_depth_above(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sub_chain_depth_above(UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sub_chain_depth_above(UUID) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- redeem_sub_invite — unchanged except for the depth cap + a may_recruit check
-- on the inviter. Full body restated (CREATE OR REPLACE needs the whole thing).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.redeem_sub_invite(p_code text, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_invite     public.shop_invites%ROWTYPE;
  v_existing   public.sub_agents%ROWTYPE;
  v_has_shop   boolean;
  v_inviter    uuid;
  v_inviter_sa public.sub_agents%ROWTYPE;
  v_depth      integer;
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

  SELECT owner_id INTO v_inviter FROM public.shop_profiles WHERE id = v_invite.shop_id;
  IF v_inviter IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'upline_missing');
  END IF;
  IF v_inviter = p_user_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cannot_self_recruit');
  END IF;

  -- NEW (spec §5.3): depth cap. The joiner lands one level below the inviter, so
  -- the inviter must currently sit at depth <= 1 (Lead=0, Sub=1) for the new
  -- member to be at most depth 2 — i.e. 3 levels total counting the Lead.
  v_depth := public.sub_chain_depth_above(v_invite.shop_id);
  IF v_depth >= 2 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'max_depth_reached');
  END IF;

  -- NEW (spec §5.2): if the inviter is themselves a sub, they must be ACTIVE and
  -- hold may_recruit. A true Lead (no sub_agents row) is governed by the route's
  -- canOwnSubNetwork check instead.
  SELECT * INTO v_inviter_sa FROM public.sub_agents WHERE user_id = v_inviter;
  IF FOUND THEN
    IF v_inviter_sa.status <> 'active' OR NOT v_inviter_sa.may_recruit THEN
      RETURN jsonb_build_object('ok', false, 'error', 'inviter_cannot_recruit');
    END IF;
  END IF;

  INSERT INTO public.sub_agents (user_id, upline_shop_id, status, joined_via_invite)
    VALUES (p_user_id, v_invite.shop_id, 'pending', v_invite.id);
  UPDATE public.shop_invites SET used_count = used_count + 1 WHERE id = v_invite.id;

  RETURN jsonb_build_object('ok', true, 'created', true, 'status', 'pending', 'upline_shop_id', v_invite.shop_id);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('ok', true, 'already_member', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.redeem_sub_invite(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.redeem_sub_invite(text, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_sub_invite(text, uuid) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- set_sub_agent_state — + grant_recruit / revoke_recruit, + invite auto-revoke.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_sub_agent_state(
  p_actor_id    uuid,
  p_sub_user_id uuid,
  p_action      text,
  p_ceiling     numeric DEFAULT NULL,
  p_is_admin    boolean DEFAULT false
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
  -- This is what confines grant_recruit to the IMMEDIATE parent (spec §5.1) — a
  -- grandparent does not own the intermediate shop and is rejected here.
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
    -- NEW (spec §5.4): a suspended node must not keep growing its downline.
    UPDATE public.shop_invites SET revoked_at = now()
      WHERE shop_id IN (SELECT id FROM public.shop_profiles WHERE owner_id = p_sub_user_id)
        AND revoked_at IS NULL;

  ELSIF p_action = 'reactivate' THEN
    UPDATE public.sub_agents SET status='active', updated_at=now() WHERE user_id=p_sub_user_id;

  ELSIF p_action = 'set_ceiling' THEN
    IF p_ceiling IS NOT NULL AND p_ceiling < 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_ceiling'); END IF;
    UPDATE public.sub_agents SET markup_ceiling=p_ceiling, updated_at=now() WHERE user_id=p_sub_user_id;

  ELSIF p_action = 'grant_recruit' THEN
    -- A sub may only recruit if granting them does not exceed the depth cap:
    -- their own children would sit one level below them.
    IF public.sub_chain_depth_above(v_sa.upline_shop_id) >= 1 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'max_depth_reached');
    END IF;
    UPDATE public.sub_agents SET may_recruit=true, updated_at=now() WHERE user_id=p_sub_user_id;

  ELSIF p_action = 'revoke_recruit' THEN
    UPDATE public.sub_agents SET may_recruit=false, updated_at=now() WHERE user_id=p_sub_user_id;
    -- Same reasoning as suspend: no new joins under a node that lost the right.
    UPDATE public.shop_invites SET revoked_at = now()
      WHERE shop_id IN (SELECT id FROM public.shop_profiles WHERE owner_id = p_sub_user_id)
        AND revoked_at IS NULL;

  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'bad_action');
  END IF;

  RETURN jsonb_build_object('ok', true, 'action', p_action);
END;
$function$;

REVOKE ALL ON FUNCTION public.set_sub_agent_state(uuid, uuid, text, numeric, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_sub_agent_state(uuid, uuid, text, numeric, boolean) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_sub_agent_state(uuid, uuid, text, numeric, boolean) TO service_role;

-- =============================================================================
-- Apply notes (Manual Action — non-interactive session cannot run Supabase OAuth):
--   1. Apply to a Supabase BRANCH first (never prod directly), after
--      20260809_nested_sub_agents.sql (this file depends on sub_agents.may_recruit).
--   2. Run get_advisors — expect zero new RLS/security warnings.
-- =============================================================================

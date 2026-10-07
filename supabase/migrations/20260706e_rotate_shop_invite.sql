-- 20260706e_rotate_shop_invite
-- One canonical, rotatable/revocable invite code per shop.
--
-- The owner's "current code" is their single ACTIVE invite: revoked_at IS NULL,
-- max_uses IS NULL (unlimited) and expires_at IS NULL (non-expiring). Rotation
-- atomically retires every active invite for the shop and mints one fresh,
-- unguessable 12-char code (72 bits from gen_random_bytes(9), base64url).
--
-- Atomic (single function/transaction): there is never a window with two active
-- codes. On the (astronomically unlikely) UNIQUE(code) collision, the failed
-- INSERT rolls the whole call back — including the revoke — and the caller
-- retries with a fresh draw, so the invariant holds.
--
-- service_role-only: invoked by app/api/shop/invites (POST action=rotate) after
-- it has verified the caller is an eligible Lead who owns the shop. The RPC
-- ALSO re-checks ownership (defence in depth) so a stolen service key still
-- cannot rotate a shop the actor does not own.

CREATE OR REPLACE FUNCTION public.rotate_shop_invite(p_actor_id uuid, p_shop_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_owner   uuid;
  v_code    text;
  v_attempt int := 0;
BEGIN
  -- Ownership re-check: the actor must own this shop.
  SELECT owner_id INTO v_owner FROM public.shop_profiles WHERE id = p_shop_id;
  IF v_owner IS NULL OR v_owner <> p_actor_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_your_shop');
  END IF;

  -- Retire every currently-active invite for this shop.
  UPDATE public.shop_invites
  SET revoked_at = now()
  WHERE shop_id = p_shop_id AND revoked_at IS NULL;

  -- Mint one fresh unlimited, non-expiring code; retry on UNIQUE(code) collision.
  LOOP
    v_attempt := v_attempt + 1;
    v_code := left(
      translate(encode(extensions.gen_random_bytes(9), 'base64'), '+/', '-_'),
      12
    );
    BEGIN
      INSERT INTO public.shop_invites (shop_id, code, max_uses, expires_at)
      VALUES (p_shop_id, v_code, NULL, NULL);
      RETURN jsonb_build_object('ok', true, 'code', v_code);
    EXCEPTION WHEN unique_violation THEN
      IF v_attempt >= 5 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'code_generation_failed');
      END IF;
      -- else: loop and draw a new code
    END;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.rotate_shop_invite(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rotate_shop_invite(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.rotate_shop_invite(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_shop_invite(uuid, uuid) TO service_role;

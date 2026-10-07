-- supabase/migrations/20260708_admin_user_management.sql
-- =============================================================================
-- Admin User Management overhaul:
--   * Time-framed suspension columns (suspended_until / reason / at / by)
--   * admin_search_users() — dynamic phone (space/233/0-insensitive) + name-token search
--   * admin_user_stats()   — segment counts for the stat/filter cards
-- Service-role only (called from admin routes after an explicit admin check).
-- =============================================================================

-- ── 1. Time-framed suspension columns ────────────────────────────────────────
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS suspended_until   timestamptz,
  ADD COLUMN IF NOT EXISTS suspension_reason text,
  ADD COLUMN IF NOT EXISTS suspended_at      timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_by      uuid;

-- ── 2. Dynamic user search ──────────────────────────────────────────────────
-- Phone: compare digits-only so "0551 161 7309" / "233551617309" / "0551617309"
--   all match (last-9 equality bridges the 233↔0 prefix; substring handles partials).
-- Name/email: every whitespace-separated token must appear in first/last/email,
--   so "john doe" matches first_name=John + last_name=Doe.
CREATE OR REPLACE FUNCTION public.admin_search_users(
  p_term   text DEFAULT NULL,
  p_role   text DEFAULT 'all',
  p_status text DEFAULT 'all',
  p_limit  int  DEFAULT 50,
  p_offset int  DEFAULT 0
) RETURNS TABLE (
  id uuid, email text, first_name text, last_name text, phone_number text,
  role text, status text, agent_expires_at timestamptz, dealer_expires_at timestamptz,
  suspended_until timestamptz, suspension_reason text, phone_verified boolean,
  created_at timestamptz, updated_at timestamptz, wallet_balance numeric, total_count bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH base AS (
    SELECT u.*, COALESCE(w.balance, 0) AS wbal
    FROM public.users u
    LEFT JOIN public.wallets w ON w.user_id = u.id
    WHERE
      -- role filter ('staff' = admin + sub-admin)
      ( p_role = 'all'
        OR (p_role = 'staff' AND u.role IN ('admin','sub-admin'))
        OR u.role = p_role )
      -- status / segment filter
      AND ( p_status = 'all'
        OR (p_status = 'active'    AND u.status = 'active')
        OR (p_status = 'suspended' AND u.status = 'suspended')
        OR (p_status = 'expired'   AND (
              (u.role = 'agent'  AND u.agent_expires_at  IS NOT NULL AND u.agent_expires_at  <= now())
           OR (u.role = 'dealer' AND u.dealer_expires_at IS NOT NULL AND u.dealer_expires_at <= now()) )) )
      -- dynamic term
      AND ( p_term IS NULL OR btrim(p_term) = ''
        OR ( length(regexp_replace(p_term,'\D','','g')) >= 3 AND (
               regexp_replace(COALESCE(u.phone_number,''),'\D','','g') ILIKE '%'||regexp_replace(p_term,'\D','','g')||'%'
               OR right(regexp_replace(COALESCE(u.phone_number,''),'\D','','g'),9)
                  = right(regexp_replace(p_term,'\D','','g'),9) ) )
        OR NOT EXISTS (
             SELECT 1 FROM unnest(string_to_array(lower(btrim(p_term)),' ')) AS tok
             WHERE tok <> ''
               AND lower(COALESCE(u.first_name,'')) NOT LIKE '%'||tok||'%'
               AND lower(COALESCE(u.last_name,''))  NOT LIKE '%'||tok||'%'
               AND lower(COALESCE(u.email,''))      NOT LIKE '%'||tok||'%' ) )
  )
  SELECT id, email, first_name, last_name, phone_number, role, status,
         agent_expires_at, dealer_expires_at, suspended_until, suspension_reason,
         phone_verified, created_at, updated_at, wbal AS wallet_balance,
         count(*) OVER() AS total_count
  FROM base
  ORDER BY created_at DESC
  LIMIT GREATEST(p_limit, 0) OFFSET GREATEST(p_offset, 0)
$$;
REVOKE ALL ON FUNCTION public.admin_search_users(text,text,text,int,int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_search_users(text,text,text,int,int) TO service_role;

-- ── 3. Segment counts for stat/filter cards ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_user_stats()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'total',           count(*),
    'customers',       count(*) FILTER (WHERE role = 'customer'),
    'agents',          count(*) FILTER (WHERE role = 'agent'),
    'active_agents',   count(*) FILTER (WHERE role = 'agent'  AND (agent_expires_at  IS NULL OR agent_expires_at  > now())),
    'expired_agents',  count(*) FILTER (WHERE role = 'agent'  AND agent_expires_at  IS NOT NULL AND agent_expires_at  <= now()),
    'dealers',         count(*) FILTER (WHERE role = 'dealer'),
    'active_dealers',  count(*) FILTER (WHERE role = 'dealer' AND (dealer_expires_at IS NULL OR dealer_expires_at > now())),
    'expired_dealers', count(*) FILTER (WHERE role = 'dealer' AND dealer_expires_at IS NOT NULL AND dealer_expires_at <= now()),
    'staff',           count(*) FILTER (WHERE role IN ('admin','sub-admin')),
    'suspended',       count(*) FILTER (WHERE status = 'suspended'),
    'expired',         count(*) FILTER (WHERE
                          (role = 'agent'  AND agent_expires_at  IS NOT NULL AND agent_expires_at  <= now())
                       OR (role = 'dealer' AND dealer_expires_at IS NOT NULL AND dealer_expires_at <= now()))
  ) FROM public.users
$$;
REVOKE ALL ON FUNCTION public.admin_user_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_user_stats() TO service_role;

-- ── 4. Atomic admin wallet adjustment (replaces the route's read-modify-write) ─
-- Row-locked delta update + ledger insert in ONE transaction; a concurrent
-- adjustment can no longer clobber the balance (Stage-4 finding H-3).
CREATE OR REPLACE FUNCTION public.admin_adjust_wallet(
  p_user_id     uuid,
  p_delta       numeric,          -- positive = credit, negative = debit
  p_description text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_wallet public.wallets%ROWTYPE;
BEGIN
  IF p_delta IS NULL OR p_delta = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;

  SELECT * INTO v_wallet FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'wallet_not_found');
  END IF;

  IF p_delta < 0 AND v_wallet.balance + p_delta < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'insufficient_balance');
  END IF;

  UPDATE public.wallets
     SET balance        = balance + p_delta,
         total_credited = CASE WHEN p_delta > 0 THEN COALESCE(total_credited, 0) + p_delta ELSE total_credited END,
         total_spent    = CASE WHEN p_delta < 0 THEN COALESCE(total_spent, 0) - p_delta ELSE total_spent END,
         updated_at     = now()
   WHERE id = v_wallet.id;

  INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, source, status)
  VALUES (v_wallet.id, p_user_id,
          CASE WHEN p_delta > 0 THEN 'credit' ELSE 'debit' END,
          abs(p_delta),
          COALESCE(p_description, 'Admin manual adjustment'), 'admin', 'completed');

  RETURN jsonb_build_object('ok', true, 'new_balance', v_wallet.balance + p_delta, 'old_balance', v_wallet.balance);
END; $$;
REVOKE ALL ON FUNCTION public.admin_adjust_wallet(uuid, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_adjust_wallet(uuid, numeric, text) TO service_role;

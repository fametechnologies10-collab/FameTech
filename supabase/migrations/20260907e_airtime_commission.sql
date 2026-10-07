-- supabase/migrations/20260907e_airtime_commission.sql
-- Airtime API → Commission-Based Model. Adds the commission-tracking columns
-- airtime_orders needs (mirroring utility_orders) and a dedicated credit RPC.
-- Only source='api' orders are ever eligible — shop/web/USSD airtime is
-- completely unaffected by this migration.

ALTER TABLE public.airtime_orders
  ADD COLUMN IF NOT EXISTS commission_amount numeric,
  ADD COLUMN IF NOT EXISTS partner_commission_amount numeric,
  ADD COLUMN IF NOT EXISTS commission_credited_at timestamptz;

ALTER TABLE public.commission_wallet_transactions
  ADD COLUMN IF NOT EXISTS airtime_order_id uuid REFERENCES public.airtime_orders(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_wallet_tx_airtime_order_credit
  ON public.commission_wallet_transactions(airtime_order_id) WHERE type = 'commission';

-- ── credit_airtime_commission — dedicated RPC, NOT folded into
--    credit_commission_wallet (which is shaped around utility_orders columns
--    like biller/account_number). Mirrors its atomic-claim + role-gate +
--    lock-then-credit shape exactly, with a stricter lifetime-only gate.
CREATE OR REPLACE FUNCTION public.credit_airtime_commission(p_airtime_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order record; v_pct numeric; v_share numeric; v_wallet_id uuid;
  v_role text; v_agent_expires_at timestamptz; v_eligible boolean;
BEGIN
  UPDATE public.airtime_orders
     SET commission_credited_at = now()
   WHERE id = p_airtime_order_id
     AND status = 'completed'
     AND commission_amount IS NOT NULL
     AND commission_credited_at IS NULL
     AND source = 'api'
  RETURNING * INTO v_order;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true, 'message', 'Nothing to credit (already credited, not completed, no commission, or not an API order)');
  END IF;

  IF v_order.user_id IS NULL THEN
    RETURN jsonb_build_object('success', true, 'message', 'No developer/buyer to credit');
  END IF;

  SELECT role, agent_expires_at
    INTO v_role, v_agent_expires_at
    FROM public.users WHERE id = v_order.user_id;

  -- Lifetime-only gate: dealer passes unconditionally (dealer_expires_at is
  -- never NULL in practice — a dealer always eventually converts to lifetime
  -- agent on expiry, see lib/effective-role.ts); agent requires a NULL
  -- agent_expires_at (lifetime agent).
  --
  -- NULL-SAFE and FAIL-CLOSED: IS NOT DISTINCT FROM never returns NULL, so an
  -- unknown/NULL role is denied, not paid (mirrors credit_commission_wallet's
  -- IS DISTINCT FROM fix in 20260903d_commission_eligibility_security_fixes.sql).
  v_eligible := (v_role IS NOT DISTINCT FROM 'dealer')
    OR (v_role IS NOT DISTINCT FROM 'agent' AND v_agent_expires_at IS NULL);
  IF NOT v_eligible THEN
    RETURN jsonb_build_object('success', true, 'message', 'Buyer not a lifetime agent/dealer — platform keeps full commission');
  END IF;

  SELECT COALESCE(NULLIF(trim(both '"' from value::text), '')::numeric, 40)
    INTO v_pct FROM public.admin_settings WHERE key = 'utility_commission_partner_percent';
  v_pct := LEAST(GREATEST(COALESCE(v_pct, 40), 0), 100);
  v_share := round(v_order.commission_amount * v_pct / 100.0, 4);
  IF v_share <= 0 THEN
    RETURN jsonb_build_object('success', true, 'message', 'Share rounds to zero');
  END IF;

  INSERT INTO public.commission_wallets (owner_id, balance, total_earned) VALUES (v_order.user_id, 0, 0)
  ON CONFLICT (owner_id) DO NOTHING;
  SELECT id INTO v_wallet_id FROM public.commission_wallets WHERE owner_id = v_order.user_id FOR UPDATE;
  UPDATE public.commission_wallets
     SET balance = balance + v_share, total_earned = total_earned + v_share, updated_at = now()
   WHERE id = v_wallet_id;
  INSERT INTO public.commission_wallet_transactions
    (commission_wallet_id, airtime_order_id, type, amount, description, status)
  VALUES (v_wallet_id, p_airtime_order_id, 'commission', v_share,
          'Airtime commission: ' || v_order.network || ' ' || v_order.beneficiary_phone, 'completed');
  UPDATE public.airtime_orders SET partner_commission_amount = v_share WHERE id = p_airtime_order_id;
  RETURN jsonb_build_object('success', true, 'amount', v_share);
EXCEPTION WHEN unique_violation THEN
  UPDATE public.airtime_orders SET commission_credited_at = now() WHERE id = p_airtime_order_id;
  RETURN jsonb_build_object('success', true, 'message', 'Already credited (ledger unique)');
END $$;

REVOKE ALL ON FUNCTION public.credit_airtime_commission(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_airtime_commission(uuid) TO service_role;

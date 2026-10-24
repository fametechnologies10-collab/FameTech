-- 20261024_standard_bundles.sql
--
-- Standard Bundles (KingFlexyGH-fulfilled data bundles): order table, client write lock,
-- atomic refund RPC and admin_settings seeds. Idempotent: safe to re-run.

-- ── 1. Table ────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.standard_bundle_orders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_code       text NOT NULL UNIQUE,
  user_id              uuid NOT NULL REFERENCES public.users(id),
  user_role            text,
  network              text NOT NULL CHECK (network IN ('MTN','Telecel','AT','TelecelBroadband')),
  kind                 text NOT NULL CHECK (kind IN ('standard','special','broadband')),
  catalog_value        text,
  pack_id              text,
  bundle_label         text,
  beneficiary_phone    text NOT NULL,
  catalog_price        numeric(12,2) NOT NULL,
  discount_pct         numeric(5,2)  NOT NULL DEFAULT 0,
  total_paid           numeric(12,2) NOT NULL,
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','processing','completed','failed','refunded')),
  kf_order_ref         text,
  commission_amount    numeric(12,2),
  fulfillment_attempts int NOT NULL DEFAULT 0,
  fulfillment_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source               text NOT NULL DEFAULT 'web',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz
);

CREATE INDEX IF NOT EXISTS idx_standard_bundle_orders_user_created
  ON public.standard_bundle_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_standard_bundle_orders_status_updated
  ON public.standard_bundle_orders (status, updated_at);

-- ── 2. RLS: owner SELECT only; every write goes through the service role ────────────────────────
ALTER TABLE public.standard_bundle_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own standard bundle orders" ON public.standard_bundle_orders;
CREATE POLICY "Users can view own standard bundle orders" ON public.standard_bundle_orders
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

REVOKE INSERT, UPDATE, DELETE ON public.standard_bundle_orders FROM anon, authenticated;
REVOKE TRUNCATE ON public.standard_bundle_orders FROM anon, authenticated;

-- Guard trigger (defence in depth if a grant/policy is ever re-added). Same shape as the other
-- money tables; block_client_money_writes() already exists (20260924b).
DROP TRIGGER IF EXISTS trg_block_client_write ON public.standard_bundle_orders;
CREATE TRIGGER trg_block_client_write BEFORE INSERT OR UPDATE ON public.standard_bundle_orders
  FOR EACH ROW EXECUTE FUNCTION public.block_client_money_writes();

-- ── 3. Atomic refund-once RPC ───────────────────────────────────────────────────────────────────
-- Order row is locked FOR UPDATE BEFORE the status check, so two concurrent calls serialize and
-- only the first credits. Status flip, wallet credit and ledger row commit or roll back together.
-- Returns { refunded, amount, new_balance }; refunded=false (amount 0) when nothing was credited.
CREATE OR REPLACE FUNCTION public.refund_standard_bundle_wallet(p_order_id uuid, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_o public.standard_bundle_orders%ROWTYPE;
  v_wallet_id uuid;
  v_new_balance numeric;
BEGIN
  SELECT * INTO v_o FROM public.standard_bundle_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('refunded', false, 'amount', 0, 'new_balance', NULL);
  END IF;

  -- Already refunded, completed, etc.: nothing to credit.
  IF v_o.status NOT IN ('pending','processing','failed') THEN
    RETURN jsonb_build_object('refunded', false, 'amount', 0, 'new_balance', NULL);
  END IF;

  INSERT INTO public.wallets (user_id, balance) VALUES (v_o.user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT id INTO v_wallet_id FROM public.wallets WHERE user_id = v_o.user_id FOR UPDATE;

  UPDATE public.wallets
     SET balance = balance + v_o.total_paid,
         total_spent = GREATEST(0, COALESCE(total_spent, 0) - v_o.total_paid),
         updated_at = now()
   WHERE id = v_wallet_id
  RETURNING balance INTO v_new_balance;

  INSERT INTO public.wallet_transactions (wallet_id, user_id, type, amount, description, reference, source, status)
    VALUES (v_wallet_id, v_o.user_id, 'credit', v_o.total_paid,
            'Refund for bundle order ' || v_o.reference_code,
            v_o.reference_code || '-REFUND', 'standard_bundles', 'completed');

  UPDATE public.standard_bundle_orders
     SET status = 'refunded',
         fulfillment_metadata = fulfillment_metadata
           || jsonb_build_object('refunded_by', p_actor_id, 'refunded_at', now()),
         updated_at = now()
   WHERE id = p_order_id;

  RETURN jsonb_build_object('refunded', true, 'amount', v_o.total_paid, 'new_balance', v_new_balance);
END $function$;

REVOKE ALL ON FUNCTION public.refund_standard_bundle_wallet(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_standard_bundle_wallet(uuid, uuid) TO service_role;

-- ── 4. admin_settings seeds (JSONB strings, matching the app's === 'true' comparisons) ──────────
INSERT INTO public.admin_settings (key, value) VALUES
  ('std_bundles_enabled',           '"true"'::jsonb),
  ('std_bundles_enabled_mtn',       '"true"'::jsonb),
  ('std_bundles_enabled_telecel',   '"true"'::jsonb),
  ('std_bundles_enabled_at',        '"true"'::jsonb),
  ('std_bundles_enabled_broadband', '"true"'::jsonb),
  ('std_bundles_discount_mtn',      '"0"'::jsonb),
  ('std_bundles_discount_telecel',  '"0"'::jsonb),
  ('std_bundles_discount_at',       '"0"'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── 5. Controller test block (commented out; run in ONE execute_sql call, it rolls back) ────────
-- Replace <USER_ID> with the id of an existing user that has a wallet. Expected result rows:
--   first = refunded:true, second = refunded:false, balance_delta = total_paid, ledger_rows = 1.
--
-- BEGIN;
-- CREATE TEMP TABLE _t ON COMMIT DROP AS
--   SELECT (SELECT balance FROM public.wallets WHERE user_id = '<USER_ID>') AS bal0;
-- INSERT INTO public.standard_bundle_orders
--   (id, reference_code, user_id, network, kind, catalog_value, beneficiary_phone,
--    catalog_price, total_paid, status)
-- VALUES ('00000000-0000-0000-0000-00000000a001', 'GHD-TESTREFUND0000000001', '<USER_ID>',
--         'MTN', 'standard', '1', '0240000000', 5.00, 5.00, 'processing');
-- SELECT public.refund_standard_bundle_wallet('00000000-0000-0000-0000-00000000a001', NULL) AS first;
-- SELECT public.refund_standard_bundle_wallet('00000000-0000-0000-0000-00000000a001', NULL) AS second;
-- SELECT (SELECT balance FROM public.wallets WHERE user_id = '<USER_ID>') - (SELECT bal0 FROM _t) AS balance_delta,
--        (SELECT count(*) FROM public.wallet_transactions
--          WHERE reference = 'GHD-TESTREFUND0000000001-REFUND') AS ledger_rows,
--        (SELECT status FROM public.standard_bundle_orders
--          WHERE id = '00000000-0000-0000-0000-00000000a001') AS final_status;
-- ROLLBACK;

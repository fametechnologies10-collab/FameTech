-- ============================================================================
-- 20260709_utility_bills.sql
-- Utility Bill Payments (ECG / Ghana Water / DSTV / GOtv / StarTimes via Hubtel
-- Commission Services) — Task A1: core ledger, saved accounts, settings seeds.
-- Ships OFF: every gate seeded 'false' / all billers disabled. Purely additive.
-- DO NOT apply automatically — reviewed and applied to prod by the controller.
-- ============================================================================

-- ── 1. Ledger ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.utility_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id),          -- NULL for guest storefront/USSD
  shop_id uuid REFERENCES public.shop_profiles(id),  -- NULL for direct/dashboard/api
  api_key_id uuid,                                   -- set for source='api' (public.api_keys.id)
  source text NOT NULL CHECK (source IN ('dashboard','storefront','api','ussd','ussd_shop')),
  biller text NOT NULL CHECK (biller IN ('ecg','ghana_water','dstv','gotv','startimes')),
  account_number text NOT NULL,        -- meter / smartcard / GW meter (trimmed)
  account_name text,                   -- from lookup snapshot
  destination_phone text,              -- ECG + GW customer phone (233 format)
  customer_email text,                 -- GW mandatory (synthetic fallback ok)
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  payment_method text NOT NULL CHECK (payment_method IN ('wallet','hubtel_checkout','ussd_momo','ussd_wallet')),
  payment_reference text,
  payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid','refunded')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed','refunded')),
  reference_code text UNIQUE NOT NULL, -- UTIL-<biller>-<10 hex>
  fulfillment_attempts integer NOT NULL DEFAULT 0,
  fulfillment_request_id text,         -- Hubtel TransactionId
  commission_amount numeric(12,4),     -- FINAL value from callback (Hubtel returns 4-dp strings e.g. "0.0171")
  partner_commission_amount numeric(12,4),
  commission_credited_at timestamptz,  -- atomic-claim flag for the credit RPC
  lookup_snapshot jsonb,               -- canonical UtilityAccountInfo at purchase time
  fulfillment_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_utility_orders_user    ON public.utility_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_utility_orders_shop    ON public.utility_orders(shop_id) WHERE shop_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_utility_orders_status  ON public.utility_orders(status) WHERE status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS idx_utility_orders_payref  ON public.utility_orders(payment_reference) WHERE payment_reference IS NOT NULL;

-- ── 2. RLS: owner read-only; ALL writes via service_role in route handlers ────
ALTER TABLE public.utility_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS utility_orders_owner_select ON public.utility_orders;
CREATE POLICY utility_orders_owner_select ON public.utility_orders
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
-- No INSERT/UPDATE/DELETE policies on purpose — 0 permissive policies for those
-- commands denies them under RLS regardless of table-level grants. Writes only
-- ever happen via service_role (route handlers), which bypasses RLS entirely.

-- Supabase auto-grants full CRUD on new tables to anon/authenticated by default.
-- Close that gap explicitly (belt-and-suspenders alongside RLS, matching the
-- 20260708_support_threads.sql convention) so the writable surface for
-- utility_orders is exactly "authenticated may SELECT their own rows".
REVOKE ALL ON public.utility_orders FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.utility_orders TO authenticated;

-- ── 3. Saved billers ("My Accounts") — logged-in users only, non-money, owner CRUD via RLS ──
CREATE TABLE IF NOT EXISTS public.utility_saved_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  biller text NOT NULL CHECK (biller IN ('ecg','ghana_water','dstv','gotv','startimes')),
  account_number text NOT NULL,
  account_name text,
  destination_phone text,       -- ECG/GW phone used with this account
  label text,                   -- optional user nickname
  last_paid_at timestamptz,
  last_amount numeric(12,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, biller, account_number)
);
ALTER TABLE public.utility_saved_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS usa_owner_all ON public.utility_saved_accounts;
CREATE POLICY usa_owner_all ON public.utility_saved_accounts
  FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- Same default-grant gap closed, but here authenticated genuinely needs full
-- CRUD (a non-money "my accounts" list the user manages directly); the policy
-- above still scopes every row to its owner.
REVOKE ALL ON public.utility_saved_accounts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.utility_saved_accounts TO authenticated;

-- ── 4. Commission ledger linkage (idempotency anchor for the credit RPC) ──────
ALTER TABLE public.shop_wallet_transactions ADD COLUMN IF NOT EXISTS utility_order_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS uq_shop_wallet_tx_utility_commission
  ON public.shop_wallet_transactions(utility_order_id) WHERE utility_order_id IS NOT NULL;

-- shop_wallet_transactions.type DOES have a CHECK constraint. It was created
-- unnamed in supabase/shop_schema.sql as CHECK (type IN ('profit','withdrawal')),
-- which Postgres names shop_wallet_transactions_type_check by default, then
-- last widened by 20260702a_refund_status_and_columns.sql to
-- CHECK (type IN ('profit','withdrawal','profit_reversal')). Extend it again
-- here so the future utility-commission credit RPC can log against this ledger.
ALTER TABLE public.shop_wallet_transactions DROP CONSTRAINT IF EXISTS shop_wallet_transactions_type_check;
ALTER TABLE public.shop_wallet_transactions ADD CONSTRAINT shop_wallet_transactions_type_check
  CHECK (type IN ('profit','withdrawal','profit_reversal','utility_commission'));

-- ── 5. updated_at trigger ──────────────────────────────────────────────────────
-- The project has no shared/generic updated_at trigger function — every table
-- gets its own dedicated function (e.g. update_support_threads_updated_at() in
-- 20260708_support_threads.sql, update_push_subscriptions_updated_at() in
-- 20260524_security_audit_fixes.sql). Reusing that exact shape here.
CREATE OR REPLACE FUNCTION public.update_utility_orders_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_utility_orders_updated_at ON public.utility_orders;
CREATE TRIGGER trg_utility_orders_updated_at
  BEFORE UPDATE ON public.utility_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_utility_orders_updated_at();

-- ── 6. Seeds — everything OFF ──────────────────────────────────────────────────
-- Scalar toggles/numbers follow 20260624_ussd_airtime.sql's exact style:
-- admin_settings.value is JSONB, but every existing toggle/number is stored as a
-- JSON *string* via to_jsonb('...'::text) (app compares with === 'true' / parses
-- numbers with parseSettingNumber, which strips surrounding quotes). The per-
-- biller map instead follows the 20260628_data_network_stock.sql precedent for
-- object-shaped settings: a real JSONB object (not string-wrapped), since the
-- app reads individual keys off it (e.g. settings['hubtel_utility_billers'].ecg).
INSERT INTO public.admin_settings (key, value) VALUES ('utility_bills_enabled', to_jsonb('false'::text))
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.admin_settings (key, value) VALUES ('utility_auto_fulfillment_enabled', to_jsonb('false'::text))
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.admin_settings (key, value) VALUES ('hubtel_utility_billers',
  '{"ecg":false,"ghana_water":false,"dstv":false,"gotv":false,"startimes":false}'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.admin_settings (key, value) VALUES ('storefront_utilities_enabled', to_jsonb('false'::text))
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.admin_settings (key, value) VALUES ('ussd_utility_enabled', to_jsonb('false'::text))
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.admin_settings (key, value) VALUES ('utility_commission_partner_percent', to_jsonb('40'::text))
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.admin_settings (key, value) VALUES ('utility_min_amount', to_jsonb('1'::text))
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.admin_settings (key, value) VALUES ('utility_max_amount', to_jsonb('1000'::text))
ON CONFLICT (key) DO NOTHING;

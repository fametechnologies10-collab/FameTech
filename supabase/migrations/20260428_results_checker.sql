-- ============================================================================
-- RESULTS CHECKER VOUCHER SYSTEM
-- Migration: 20260428_results_checker.sql
-- ============================================================================

-- ============================================================================
-- SECTION 1: results_checker_types table
-- Fully dynamic — no hardcoded exam types
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.results_checker_types (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name           TEXT UNIQUE NOT NULL,          -- e.g. 'WAEC 2024', 'BECE 2025'
  customer_price DECIMAL(12,2) NOT NULL,
  agent_price    DECIMAL(12,2) NOT NULL,
  cost_price     DECIMAL(12,2) NOT NULL,        -- admin true supplier cost for profit logs
  is_active      BOOLEAN DEFAULT true,          -- archive instead of delete
  display_order  INTEGER DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rc_types_active
  ON public.results_checker_types(display_order)
  WHERE is_active = true;

-- ============================================================================
-- SECTION 2: results_checker_inventory table
-- Voucher PIN/serial store — atomic reservation via FOR UPDATE SKIP LOCKED
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.results_checker_inventory (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type_id                 UUID NOT NULL REFERENCES public.results_checker_types(id),
  pin                     TEXT NOT NULL,
  serial_number           TEXT NOT NULL,
  status                  TEXT DEFAULT 'available'
                            CHECK (status IN ('available', 'reserved', 'sold')),
  reserved_by_order       UUID,
  reservation_expires_at  TIMESTAMPTZ,
  sold_to_user_id         UUID REFERENCES public.users(id),
  sold_at                 TIMESTAMPTZ,
  batch_id                TEXT,
  expiry_date             DATE,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(type_id, pin)
);

CREATE INDEX IF NOT EXISTS idx_rc_inv_available
  ON public.results_checker_inventory(type_id, created_at ASC)
  WHERE status = 'available';

CREATE INDEX IF NOT EXISTS idx_rc_inv_reserved_expiry
  ON public.results_checker_inventory(reservation_expires_at)
  WHERE status = 'reserved';

CREATE INDEX IF NOT EXISTS idx_rc_inv_type_status
  ON public.results_checker_inventory(type_id, status);

-- ============================================================================
-- SECTION 3: results_checker_orders table
-- Mirrors airtime_orders pattern exactly
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.results_checker_orders (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id               UUID REFERENCES public.users(id),          -- nullable for guests
  user_role             TEXT DEFAULT 'customer',
  shop_id               UUID REFERENCES public.shop_profiles(id),  -- nullable
  shop_name             TEXT,
  shop_markup           DECIMAL(12,2) DEFAULT 0,
  customer_name         TEXT,
  customer_email        TEXT,
  customer_phone        TEXT,
  type_id               UUID REFERENCES public.results_checker_types(id),
  type_name             TEXT,                                       -- snapshot at purchase time
  quantity              INTEGER NOT NULL CHECK (quantity > 0),
  unit_price            DECIMAL(12,2),                             -- role-based price paid per voucher
  cost_price_at_time    DECIMAL(12,2),                             -- snapshot of cost_price for profit logs
  fee_amount            DECIMAL(12,2) DEFAULT 0,                   -- Paystack fee for storefront orders
  total_paid            DECIMAL(12,2) NOT NULL,
  merchant_commission   DECIMAL(12,2) DEFAULT 0,
  inventory_ids         UUID[],                                    -- assigned voucher IDs
  status                TEXT DEFAULT 'pending'
                          CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  payment_status        TEXT DEFAULT 'pending'
                          CHECK (payment_status IN ('pending', 'pending_payment', 'completed', 'failed')),
  reference_code        TEXT UNIQUE,
  delivered_via         TEXT[],
  fulfilled_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rc_orders_user
  ON public.results_checker_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_rc_orders_status
  ON public.results_checker_orders(status, payment_status);
CREATE INDEX IF NOT EXISTS idx_rc_orders_ref
  ON public.results_checker_orders(reference_code);
CREATE INDEX IF NOT EXISTS idx_rc_orders_shop
  ON public.results_checker_orders(shop_id);
CREATE INDEX IF NOT EXISTS idx_rc_orders_created
  ON public.results_checker_orders(created_at DESC);

-- ============================================================================
-- SECTION 4: Modify shop_profiles — add single markup column
-- One flat markup (GHS) applied equally to all voucher types per shop
-- ============================================================================

ALTER TABLE public.shop_profiles
  ADD COLUMN IF NOT EXISTS results_checker_markup DECIMAL(12,2) DEFAULT 0;

-- ============================================================================
-- SECTION 5: Seed admin_settings keys
-- ============================================================================

INSERT INTO public.admin_settings (key, value) VALUES
  ('results_checker_enabled',              'false'),
  ('results_checker_max_markup_customer',  '0'),
  ('results_checker_max_markup_agent',     '0'),
  ('results_checker_max_quantity',         '50'),
  ('results_checker_reservation_timeout',  '10'),
  ('results_checker_paystack_fee_percent', '1.95'),
  ('page_access_results_checker',          'true')
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- SECTION 6: RPC — assign_results_checker_vouchers
-- Atomically reserves vouchers. All-or-nothing: raises INSUFFICIENT_INVENTORY
-- if exact quantity cannot be met. Uses FOR UPDATE SKIP LOCKED (FIFO).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.assign_results_checker_vouchers(
  p_type_id  UUID,
  p_quantity INTEGER,
  p_order_id UUID
)
RETURNS TABLE (
  id            UUID,
  pin           TEXT,
  serial_number TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_timeout_minutes INTEGER := 10;
  v_timeout_setting TEXT;
  v_reserved_count  INTEGER;
BEGIN
  -- Read reservation timeout from admin_settings
  SELECT value INTO v_timeout_setting
  FROM public.admin_settings
  WHERE key = 'results_checker_reservation_timeout';

  IF v_timeout_setting IS NOT NULL THEN
    v_timeout_minutes := v_timeout_setting::INTEGER;
  END IF;

  -- Atomically reserve exactly p_quantity vouchers (FIFO, skip locked)
  WITH selected AS (
    SELECT inv.id
    FROM public.results_checker_inventory inv
    WHERE inv.type_id = p_type_id
      AND inv.status = 'available'
    ORDER BY inv.created_at ASC
    LIMIT p_quantity
    FOR UPDATE SKIP LOCKED
  ),
  updated AS (
    UPDATE public.results_checker_inventory inv
    SET
      status                 = 'reserved',
      reserved_by_order      = p_order_id,
      reservation_expires_at = NOW() + (v_timeout_minutes || ' minutes')::INTERVAL,
      updated_at             = NOW()
    FROM selected
    WHERE inv.id = selected.id
    RETURNING inv.id, inv.pin, inv.serial_number
  )
  SELECT * FROM updated;

  -- Check exact quantity was reserved (all-or-nothing guarantee)
  GET DIAGNOSTICS v_reserved_count = ROW_COUNT;

  IF v_reserved_count < p_quantity THEN
    -- Roll back partial reservation
    UPDATE public.results_checker_inventory
    SET
      status                 = 'available',
      reserved_by_order      = NULL,
      reservation_expires_at = NULL,
      updated_at             = NOW()
    WHERE reserved_by_order = p_order_id;

    RAISE EXCEPTION 'INSUFFICIENT_INVENTORY';
  END IF;
END;
$$;

-- ============================================================================
-- SECTION 7: RPC — finalize_results_checker_sale
-- Marks reserved vouchers as sold after successful payment
-- ============================================================================

CREATE OR REPLACE FUNCTION public.finalize_results_checker_sale(
  p_order_id UUID,
  p_user_id  UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.results_checker_inventory
  SET
    status                 = 'sold',
    reserved_by_order      = NULL,
    reservation_expires_at = NULL,
    sold_to_user_id        = p_user_id,
    sold_at                = NOW(),
    updated_at             = NOW()
  WHERE reserved_by_order = p_order_id
    AND status = 'reserved';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ============================================================================
-- SECTION 8: RPC — release_expired_rc_reservations
-- Called by cron every 15 minutes to release timed-out reservations
-- ============================================================================

CREATE OR REPLACE FUNCTION public.release_expired_rc_reservations()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.results_checker_inventory
  SET
    status                 = 'available',
    reserved_by_order      = NULL,
    reservation_expires_at = NULL,
    updated_at             = NOW()
  WHERE status = 'reserved'
    AND reservation_expires_at < NOW();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ============================================================================
-- SECTION 9: RLS Policies
-- ============================================================================

-- results_checker_types: public read, service role write
ALTER TABLE public.results_checker_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rc_types_select_all"
  ON public.results_checker_types
  FOR SELECT
  USING (true);

CREATE POLICY "rc_types_write_service"
  ON public.results_checker_types
  FOR ALL
  TO service_role
  USING (true);

-- results_checker_inventory: service role only (PIN security)
ALTER TABLE public.results_checker_inventory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rc_inventory_service_only"
  ON public.results_checker_inventory
  FOR ALL
  USING (auth.role() = 'service_role');

-- results_checker_orders: users see own orders; service role sees all
ALTER TABLE public.results_checker_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rc_orders_user_select"
  ON public.results_checker_orders
  FOR SELECT
  USING (auth.uid() = user_id OR auth.role() = 'service_role');

CREATE POLICY "rc_orders_service_all"
  ON public.results_checker_orders
  FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================================================
-- SECTION 10: Profit log trigger
-- Widen CHECK constraint to allow 'results_checker' transaction type
-- ============================================================================

-- Widen the transaction_type CHECK constraint (safe — only adding a value)
ALTER TABLE public.admin_profit_logs
  DROP CONSTRAINT IF EXISTS admin_profit_logs_transaction_type_check;

ALTER TABLE public.admin_profit_logs
  ADD CONSTRAINT admin_profit_logs_transaction_type_check
  CHECK (transaction_type IN ('main', 'shop', 'results_checker'));

-- Widen the channel CHECK constraint similarly
ALTER TABLE public.admin_profit_logs
  DROP CONSTRAINT IF EXISTS admin_profit_logs_channel_check;

ALTER TABLE public.admin_profit_logs
  ADD CONSTRAINT admin_profit_logs_channel_check
  CHECK (channel IN ('main', 'shop', 'results_checker'));

-- Trigger function: fires on status → 'completed'
CREATE OR REPLACE FUNCTION public.log_rc_profit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NEW.status = 'completed'
    AND (OLD.status IS NULL OR OLD.status <> 'completed')
    AND NEW.cost_price_at_time IS NOT NULL
    AND NEW.cost_price_at_time > 0
  THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.admin_profit_logs
      WHERE transaction_type = 'results_checker'
        AND transaction_id = NEW.id
    ) THEN
      INSERT INTO public.admin_profit_logs (
        transaction_type,
        transaction_id,
        channel,
        role_at_time,
        selling_price,
        admin_cost,
        profit,
        calculation_note
      ) VALUES (
        'results_checker',
        NEW.id,
        'results_checker',
        NEW.user_role,
        NEW.total_paid,
        NEW.cost_price_at_time * NEW.quantity,
        NEW.total_paid - (NEW.cost_price_at_time * NEW.quantity),
        format(
          'RC order: %s paid - %s cost (%sx %s) = %s %s | role: %s | ref: %s',
          NEW.total_paid,
          NEW.cost_price_at_time * NEW.quantity,
          NEW.quantity,
          COALESCE(NEW.type_name, 'unknown'),
          NEW.total_paid - (NEW.cost_price_at_time * NEW.quantity),
          CASE
            WHEN (NEW.total_paid - NEW.cost_price_at_time * NEW.quantity) < 0
            THEN 'LOSS' ELSE 'PROFIT'
          END,
          COALESCE(NEW.user_role, 'unknown'),
          COALESCE(NEW.reference_code, 'N/A')
        )
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_rc_profit ON public.results_checker_orders;
CREATE TRIGGER trg_log_rc_profit
  AFTER UPDATE ON public.results_checker_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.log_rc_profit();

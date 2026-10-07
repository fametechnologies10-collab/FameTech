-- =============================================================================
-- RC Fulfillment Hardening (deep-audit fixes — 2026-06-28)
--
-- 1. assign_results_checker_vouchers — make it IDEMPOTENT PER ORDER.
--    Root cause of the double-assign races: the webhook + the charge status-poll
--    (and the backorder cron + admin upload + verify cron) can call assignment for
--    the same order concurrently. `FOR UPDATE SKIP LOCKED` makes each caller grab a
--    DIFFERENT batch → customer gets 2x PINs and the orphan batch is sold against no
--    order (inventory loss). Fix: serialize per-order with an advisory xact lock, and
--    if the order already holds inventory, return THAT batch instead of reserving a new
--    one. Closes both the storefront (webhook/poll) and backorder races at the source.
--
-- 2. release_expired_rc_reservations — never free vouchers of a PAID order. A function
--    that dies between assign and finalize leaves a paid order's vouchers `reserved`;
--    10 min later this cron flipped them back to `available` and the next buyer was sold
--    the exact PINs the paid customer owns.
--
-- 3. log_rc_profit — admin profit must EXCLUDE the shop owner's markup (separately
--    credited to the owner) and the Paystack fee (Paystack's money). It booked the whole
--    total_paid as admin selling price → admin profit overstated + markup double-counted.
-- =============================================================================

-- ── 1. Idempotent voucher assignment ─────────────────────────────────────────
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
SET search_path = public
AS $$
DECLARE
  v_timeout_minutes INTEGER := 10;
  v_timeout_setting TEXT;
  v_reserved_count  INTEGER := 0;
BEGIN
  -- Serialize concurrent calls for the SAME order (webhook ↔ status-poll ↔ cron ↔
  -- admin verify). Held until this function's transaction ends.
  PERFORM pg_advisory_xact_lock(hashtext(p_order_id::text));

  -- IDEMPOTENCY: if this order already holds inventory (reserved or sold), return that
  -- exact batch — never reserve a second one. This makes repeat/concurrent calls safe.
  IF EXISTS (
    SELECT 1 FROM public.results_checker_inventory
    WHERE reserved_by_order = p_order_id AND status IN ('reserved', 'sold')
  ) THEN
    RETURN QUERY
    SELECT inv.id, inv.pin, inv.serial_number
    FROM public.results_checker_inventory inv
    WHERE inv.reserved_by_order = p_order_id
      AND inv.status IN ('reserved', 'sold')
    ORDER BY inv.created_at ASC;
    RETURN;
  END IF;

  -- Reservation timeout from admin_settings
  SELECT value INTO v_timeout_setting
  FROM public.admin_settings
  WHERE key = 'results_checker_reservation_timeout';
  IF v_timeout_setting IS NOT NULL THEN
    v_timeout_minutes := v_timeout_setting::INTEGER;
  END IF;

  -- Reserve the oldest available stock for this type, then read ROW_COUNT immediately.
  UPDATE public.results_checker_inventory inv
  SET
    status                 = 'reserved',
    reserved_by_order      = p_order_id,
    reservation_expires_at = NOW() + (v_timeout_minutes || ' minutes')::INTERVAL,
    updated_at             = NOW()
  WHERE inv.id IN (
    SELECT sub.id
    FROM public.results_checker_inventory sub
    WHERE sub.type_id = p_type_id
      AND sub.status  = 'available'
    ORDER BY sub.created_at ASC
    LIMIT p_quantity
    FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS v_reserved_count = ROW_COUNT;

  -- All-or-nothing
  IF v_reserved_count < p_quantity THEN
    UPDATE public.results_checker_inventory
    SET status = 'available', reserved_by_order = NULL, reservation_expires_at = NULL, updated_at = NOW()
    WHERE reserved_by_order = p_order_id;
    RAISE EXCEPTION 'INSUFFICIENT_INVENTORY';
  END IF;

  RETURN QUERY
  SELECT inv.id, inv.pin, inv.serial_number
  FROM public.results_checker_inventory inv
  WHERE inv.reserved_by_order = p_order_id
    AND inv.type_id           = p_type_id
    AND inv.status            = 'reserved';
END;
$$;

-- Keep grants service-role only (re-assert after REPLACE).
REVOKE EXECUTE ON FUNCTION public.assign_results_checker_vouchers(UUID, INTEGER, UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.assign_results_checker_vouchers(UUID, INTEGER, UUID) TO service_role;

-- ── 1b. finalize must KEEP reserved_by_order so the idempotency guard above still ──
--    recognizes an already-fulfilled order AFTER finalize. The original NULLed it when
--    flipping reserved→sold, blinding the guard (a post-finalize concurrent/replayed
--    call would then reserve a SECOND batch). reserved_by_order on a sold row is just
--    provenance ("which order bought it") and is never targeted by reserve (status
--    ='available') or the expiry cron (status='reserved'), so keeping it is safe.
CREATE OR REPLACE FUNCTION public.finalize_results_checker_sale(
  p_order_id UUID,
  p_user_id  UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.results_checker_inventory
  SET
    status                 = 'sold',
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

REVOKE EXECUTE ON FUNCTION public.finalize_results_checker_sale(UUID, UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.finalize_results_checker_sale(UUID, UUID) TO service_role;

-- ── 2. Reservation-expiry cron must not free a PAID order's vouchers ──────────
CREATE OR REPLACE FUNCTION public.release_expired_rc_reservations()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.results_checker_inventory inv
  SET status = 'available', reserved_by_order = NULL, reservation_expires_at = NULL, updated_at = NOW()
  WHERE inv.status = 'reserved'
    AND inv.reservation_expires_at < NOW()
    AND NOT EXISTS (
      SELECT 1 FROM public.results_checker_orders o
      WHERE o.id = inv.reserved_by_order
        AND o.payment_status = 'completed'
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.release_expired_rc_reservations() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.release_expired_rc_reservations() TO service_role;

-- ── 3. Admin profit log: exclude shop markup + Paystack fee ───────────────────
CREATE OR REPLACE FUNCTION public.log_rc_profit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_selling NUMERIC;
  v_admin_cost    NUMERIC;
BEGIN
  IF NEW.status = 'completed'
    AND (OLD.status IS NULL OR OLD.status <> 'completed')
    AND NEW.cost_price_at_time IS NOT NULL
    AND NEW.cost_price_at_time > 0
  THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.admin_profit_logs
      WHERE transaction_type = 'results_checker' AND transaction_id = NEW.id
    ) THEN
      -- Admin revenue = what the buyer paid MINUS the shop owner's markup (credited to
      -- the owner separately) MINUS the Paystack fee (Paystack's money). Wallet/main-site
      -- orders have null markup/fee → COALESCE 0 → unchanged behaviour.
      v_admin_selling := NEW.total_paid
                         - COALESCE(NEW.shop_markup, 0) * NEW.quantity
                         - COALESCE(NEW.fee_amount, 0);
      v_admin_cost    := NEW.cost_price_at_time * NEW.quantity;

      INSERT INTO public.admin_profit_logs (
        transaction_type, transaction_id, channel, role_at_time,
        selling_price, admin_cost, profit, calculation_note
      ) VALUES (
        'results_checker', NEW.id, 'results_checker', NEW.user_role,
        v_admin_selling, v_admin_cost, v_admin_selling - v_admin_cost,
        format(
          'RC admin profit: %s admin-revenue - %s cost (%sx %s) = %s %s | markup %s, fee %s excluded | ref: %s',
          v_admin_selling, v_admin_cost, NEW.quantity, COALESCE(NEW.type_name, 'unknown'),
          v_admin_selling - v_admin_cost,
          CASE WHEN (v_admin_selling - v_admin_cost) < 0 THEN 'LOSS' ELSE 'PROFIT' END,
          COALESCE(NEW.shop_markup, 0) * NEW.quantity, COALESCE(NEW.fee_amount, 0),
          COALESCE(NEW.reference_code, 'N/A')
        )
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';

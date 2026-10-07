-- =============================================================================
-- FIX: assign_results_checker_vouchers
--
-- BUG: GET DIAGNOSTICS ROW_COUNT was placed after a SELECT statement.
--      PostgreSQL ROW_COUNT only reflects the last DML statement (UPDATE /
--      INSERT / DELETE). After a SELECT it is always 0, so the guard
--      `IF v_reserved_count < p_quantity` always fired, rolling back valid
--      reservations and returning INSUFFICIENT_INVENTORY even when stock exists.
--
-- FIX: Move GET DIAGNOSTICS immediately after the UPDATE DML inside a
--      separate block, then RETURN the reserved rows.
-- =============================================================================

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
  v_reserved_count  INTEGER := 0;
BEGIN
  -- Read reservation timeout from admin_settings
  SELECT value INTO v_timeout_setting
  FROM public.admin_settings
  WHERE key = 'results_checker_reservation_timeout';

  IF v_timeout_setting IS NOT NULL THEN
    v_timeout_minutes := v_timeout_setting::INTEGER;
  END IF;

  -- ── Step 1: Update and get ROW_COUNT immediately after DML ────────────────
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
      AND sub.status   = 'available'
    ORDER BY sub.created_at ASC
    LIMIT p_quantity
    FOR UPDATE SKIP LOCKED
  );

  -- ── ROW_COUNT is now accurate (read right after UPDATE) ───────────────────
  GET DIAGNOSTICS v_reserved_count = ROW_COUNT;

  -- ── Step 2: All-or-nothing guard ──────────────────────────────────────────
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

  -- ── Step 3: Return the reserved vouchers ──────────────────────────────────
  RETURN QUERY
  SELECT inv.id, inv.pin, inv.serial_number
  FROM public.results_checker_inventory inv
  WHERE inv.reserved_by_order = p_order_id
    AND inv.type_id            = p_type_id
    AND inv.status             = 'reserved';
END;
$$;

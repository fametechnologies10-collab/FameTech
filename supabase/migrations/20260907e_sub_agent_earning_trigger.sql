-- supabase/migrations/20260907e_sub_agent_earning_trigger.sql
-- =============================================================================
-- The symmetric credit/reverse trigger (spec §5.2, §8.3). One function,
-- attached to every order table a sub-agent's purchase can reach:
--   orders (data AND mashup, keyed by category — mashup rows never have a
--           pending ledger entry at all, per spec C9, so this trigger simply
--           finds nothing to do for them)
--   afa_orders
--   results_checker_orders
--   shop_orders (a sub's own storefront sale — spec §8)
--
-- airtime_orders is DELIBERATELY EXCLUDED (spec C9) — recruiter margin there
-- is always exactly zero, so a trigger could only ever no-op; that is pure
-- surface area for zero benefit, not "defense in depth."
--
-- The trigger contains NO pricing knowledge whatsoever. It only ever moves an
-- amount that was already decided and persisted as 'pending' by application
-- code (lib/sub-agent-earnings.ts) at the time the order was priced.
--
-- "Earned once even if completed a million times": the WHEN clause compares
-- OLD.status to NEW.status, so a redundant re-write to the same status value
-- never enters either branch. The ledger's UNIQUE(order_table, order_reference) plus the
-- wallet's two partial unique indexes (20260907d) are the second, independent
-- layer against replay.
-- =============================================================================

-- Core logic, table-agnostic — takes the order's reference and new status as
-- plain parameters rather than reading NEW directly, because the four target
-- tables do NOT share one reference-column name (confirmed against the live
-- schema: orders/afa_orders/results_checker_orders all have `reference_code`,
-- but shop_orders has no such column — only `paystack_reference` and
-- `fulfillment_reference`). A single trigger function reading `NEW.reference_code`
-- directly would runtime-error the first time it fired on shop_orders ("record
-- has no field reference_code"). Thin per-table wrapper triggers below extract
-- the right column and call this shared function instead.
CREATE OR REPLACE FUNCTION public.apply_sub_agent_earning_sync(p_order_reference TEXT, p_new_status TEXT, p_order_table TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_earning public.sub_agent_order_earnings%ROWTYPE;
  v_wallet_id UUID;
  v_tx_id UUID;
BEGIN
  IF p_order_reference IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO v_earning FROM public.sub_agent_order_earnings
    WHERE order_reference = p_order_reference AND order_table = p_order_table FOR UPDATE;

  IF NOT FOUND THEN
    -- No pending earning for this order (not a sub's order, or a zero-markup
    -- product per spec C9) — nothing to do.
    RETURN;
  END IF;

  IF p_new_status = 'completed' AND v_earning.status = 'pending' THEN
    -- Single race-free upsert: under concurrent first-ever credits for the
    -- same recruiter, a separate INSERT...ON CONFLICT DO NOTHING followed by
    -- a SELECT can race (a concurrent uncommitted insert makes the INSERT a
    -- no-op while also being invisible to the SELECT, yielding NULL and a
    -- NOT NULL violation downstream). DO UPDATE forces this statement to
    -- return the row's id either way.
    INSERT INTO public.commission_wallets (owner_id, balance, total_earned)
      VALUES (v_earning.recruiter_id, 0, 0)
      ON CONFLICT (owner_id) DO UPDATE SET owner_id = EXCLUDED.owner_id
      RETURNING id INTO v_wallet_id;

    INSERT INTO public.commission_wallet_transactions
      (commission_wallet_id, type, amount, description, status, order_reference, order_table)
    VALUES
      (v_wallet_id, 'sub_agent_margin', v_earning.amount,
       'Sub-agent order completed', 'completed', v_earning.order_reference, v_earning.order_table)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_tx_id;

    IF v_tx_id IS NULL THEN
      -- Already recorded by a concurrent/replayed call — balance already
      -- reflects it. Do not move the balance again; do not update the
      -- ledger status again (it was already moved by whichever call
      -- actually inserted the row).
      RETURN;
    END IF;

    UPDATE public.commission_wallets
      SET balance = balance + v_earning.amount, total_earned = total_earned + v_earning.amount, updated_at = NOW()
      WHERE id = v_wallet_id;

    UPDATE public.sub_agent_order_earnings
      SET status = 'credited', credited_at = NOW()
      WHERE id = v_earning.id;

  -- DELIBERATE: this branch only fires when v_earning.status = 'credited'.
  -- A row that reverses here becomes 'reversed', not 'pending' — so if the
  -- order's status later flips back to 'completed' again, the credit branch
  -- above (which requires v_earning.status = 'pending') will NOT re-fire and
  -- the earning will NOT auto re-credit. This is intentional: re-crediting
  -- after a reversal needs a human decision, not an automatic bounce-back.
  -- Do not "fix" this into a bounce-back without a deliberate product call.
  ELSIF p_new_status <> 'completed' AND v_earning.status = 'credited' THEN
    SELECT id INTO v_wallet_id FROM public.commission_wallets
      WHERE owner_id = v_earning.recruiter_id FOR UPDATE;

    -- Defensive only: a 'credited' earning implies the wallet already exists
    -- (created by the credit branch above), so this should be unreachable
    -- in practice. Guards against an AFTER UPDATE trigger raising on the
    -- NOT NULL commission_wallet_id below and aborting the order's own
    -- status change (e.g. blocking an admin's refund with an opaque error).
    IF v_wallet_id IS NULL THEN
      RETURN;
    END IF;

    INSERT INTO public.commission_wallet_transactions
      (commission_wallet_id, type, amount, description, status, order_reference, order_table)
    VALUES
      (v_wallet_id, 'sub_agent_margin_reversal', v_earning.amount,
       'Sub-agent order status changed after completion', 'completed', v_earning.order_reference, v_earning.order_table)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_tx_id;

    IF v_tx_id IS NULL THEN
      -- Already recorded by a concurrent/replayed call — balance already
      -- reflects it. Do not move the balance again; do not update the
      -- ledger status again (it was already moved by whichever call
      -- actually inserted the row).
      RETURN;
    END IF;

    -- DELIBERATE ASYMMETRY: only `balance` moves here, not `total_earned`
    -- (contrast the credit branch above, which updates both). `total_earned`
    -- is lifetime gross earnings and must not be reduced by a later reversal;
    -- only the current spendable `balance` does. Do not add total_earned
    -- here to "mirror" the credit branch — that would misrepresent history.
    UPDATE public.commission_wallets
      SET balance = balance - v_earning.amount, updated_at = NOW()
      WHERE id = v_wallet_id;

    UPDATE public.sub_agent_order_earnings
      SET status = 'reversed', reversed_at = NOW()
      WHERE id = v_earning.id;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_sub_agent_earning_sync(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_sub_agent_earning_sync(TEXT, TEXT, TEXT) FROM anon, authenticated;

-- Wrapper for the three tables keyed on reference_code.
CREATE OR REPLACE FUNCTION public.trg_sub_agent_earning_by_reference_code()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.apply_sub_agent_earning_sync(NEW.reference_code, NEW.status, TG_TABLE_NAME);
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_sub_agent_earning_by_reference_code() FROM PUBLIC;

-- Wrapper for shop_orders, keyed on paystack_reference — the column that
-- actually exists on that table and is assigned at checkout-initiation time,
-- before payment, matching the same "reference assigned early, stable
-- thereafter" shape the other three tables' reference_code already has.
--
-- paystack_reference is NULL for USSD-sourced shop orders (confirmed live:
-- 8,252 of 18,893 rows, 44% of the table) — website-sourced orders are the
-- only ones that get one. Falling back to shop_orders.id (always present,
-- unique, and immutable) means every row has a usable reference regardless
-- of source, closing what would otherwise be a permanent, silent earnings
-- gap for the entire USSD rail.
CREATE OR REPLACE FUNCTION public.trg_sub_agent_earning_by_paystack_reference()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.apply_sub_agent_earning_sync(COALESCE(NEW.paystack_reference, NEW.id::text), NEW.status, TG_TABLE_NAME);
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_sub_agent_earning_by_paystack_reference() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_sync_sub_agent_earning_orders ON public.orders;
CREATE TRIGGER trg_sync_sub_agent_earning_orders
  AFTER UPDATE OF status ON public.orders
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.trg_sub_agent_earning_by_reference_code();

DROP TRIGGER IF EXISTS trg_sync_sub_agent_earning_afa ON public.afa_orders;
CREATE TRIGGER trg_sync_sub_agent_earning_afa
  AFTER UPDATE OF status ON public.afa_orders
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.trg_sub_agent_earning_by_reference_code();

DROP TRIGGER IF EXISTS trg_sync_sub_agent_earning_rc ON public.results_checker_orders;
CREATE TRIGGER trg_sync_sub_agent_earning_rc
  AFTER UPDATE OF status ON public.results_checker_orders
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.trg_sub_agent_earning_by_reference_code();

DROP TRIGGER IF EXISTS trg_sync_sub_agent_earning_shop ON public.shop_orders;
CREATE TRIGGER trg_sync_sub_agent_earning_shop
  AFTER UPDATE OF status ON public.shop_orders
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.trg_sub_agent_earning_by_paystack_reference();

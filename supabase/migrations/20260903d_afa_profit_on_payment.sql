-- ═══════════════════════════════════════════════════════════
-- Task A — Credit AFA profit on payment, reverse on cancellation
-- ═══════════════════════════════════════════════════════════
--
-- Owner decision: AFA profit must credit like every other product — on
-- payment, not on admin completion. Because a registration can later be
-- cancelled, cancelling must reverse the credit.

-- 1. Rescope the once-only-crediting index so a reversal row (same
-- afa_order_id, type='profit_reversal') is not rejected by it. Only ever
-- enforced "one profit row per order" — narrowing the WHERE clause to
-- type='profit' preserves exactly that and nothing more. Safe for deployed
-- code: no code names this index directly, it's only a DB-level guard.
DROP INDEX IF EXISTS public.uq_shop_wallet_tx_afa_profit;
CREATE UNIQUE INDEX IF NOT EXISTS uq_shop_wallet_tx_afa_profit
  ON public.shop_wallet_transactions(afa_order_id)
  WHERE afa_order_id IS NOT NULL AND type = 'profit';

-- 2. Reversal RPC. Modeled on credit_shop_afa_profit (lock-before-check
-- idempotency) and on reverse_lead_margin's negative-balance handling
-- (balance is allowed to go negative — the owner owes it back — while
-- total_earned is floored at 0 so lifetime-earnings reporting never goes
-- negative). Unlike reverse_lead_margin this also surfaces the negative
-- state in the returned message per the plan's instruction.
CREATE OR REPLACE FUNCTION public.reverse_shop_afa_profit(p_afa_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner_id UUID;
  v_wallet_id UUID;
  v_profit_tx_id UUID;
  v_amount DECIMAL;
  v_existing_reversal_id UUID;
  v_new_balance DECIMAL;
BEGIN
  SELECT sp.owner_id
  INTO v_owner_id
  FROM public.afa_orders ao
  JOIN public.shop_profiles sp ON ao.shop_id = sp.id
  WHERE ao.id = p_afa_order_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'Order not found');
  END IF;

  SELECT id INTO v_wallet_id
  FROM public.shop_wallets
  WHERE owner_id = v_owner_id
  FOR UPDATE;

  IF v_wallet_id IS NULL THEN
    -- No wallet exists at all, so nothing could ever have been credited.
    RETURN jsonb_build_object('success', false, 'message', 'No profit to reverse');
  END IF;

  -- Find the original profit row for this order.
  SELECT id, amount INTO v_profit_tx_id, v_amount
  FROM public.shop_wallet_transactions
  WHERE afa_order_id = p_afa_order_id AND type = 'profit';

  IF v_profit_tx_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'No profit to reverse');
  END IF;

  -- Idempotency check runs under the wallet lock acquired above.
  SELECT id INTO v_existing_reversal_id
  FROM public.shop_wallet_transactions
  WHERE afa_order_id = p_afa_order_id AND type = 'profit_reversal';

  IF v_existing_reversal_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'message', 'Already reversed');
  END IF;

  UPDATE public.shop_wallets
  SET
    balance = balance - v_amount,
    total_earned = GREATEST(0, total_earned - v_amount),
    updated_at = NOW()
  WHERE id = v_wallet_id
  RETURNING balance INTO v_new_balance;

  INSERT INTO public.shop_wallet_transactions
    (shop_wallet_id, afa_order_id, type, amount, description, status)
  VALUES
    (v_wallet_id, p_afa_order_id, 'profit_reversal', v_amount, 'AFA Registration cancelled — profit reversed', 'completed');

  IF v_new_balance < 0 THEN
    RETURN jsonb_build_object('success', true, 'message', 'Reversed ' || v_amount || ' — wallet balance is now negative (' || v_new_balance || ')');
  END IF;

  RETURN jsonb_build_object('success', true, 'message', 'Reversed ' || v_amount);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reverse_shop_afa_profit(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reverse_shop_afa_profit(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.reverse_shop_afa_profit(uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.reverse_shop_afa_profit(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

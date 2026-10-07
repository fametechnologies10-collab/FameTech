-- Saved payout accounts (shop_payment_details) are trusted by /api/shop/withdraw as
-- ALREADY name-verified: a withdrawal using a savedDetailId skips the provider name
-- lookup. But owners could INSERT/UPDATE these rows straight from the browser
-- (RLS owner policies + authenticated grants), so the stored name/number was never
-- actually guaranteed to have been verified. Make INSERT/UPDATE server-only; new rows
-- come from POST /api/shop/payment-details (server-side name lookup) or the withdraw
-- route's post-withdrawal auto-save. Owners keep SELECT and DELETE on their own rows.
-- See docs/security-audits/2026-09-24-client-order-forgery.md (F5 re-classified).

DROP POLICY "Owners can insert their own payment details" ON public.shop_payment_details;
DROP POLICY "Owners can update their own payment details" ON public.shop_payment_details;

REVOKE INSERT, UPDATE ON public.shop_payment_details FROM anon, authenticated;

-- Reuses the guard from 20260924b_lock_client_money_writes.sql
CREATE TRIGGER trg_block_client_write BEFORE INSERT OR UPDATE ON public.shop_payment_details
  FOR EACH ROW EXECUTE FUNCTION public.block_client_money_writes();

-- Harden the save RPC: hard cap of 5 regardless of the caller's p_limit (the existing
-- trg_max_payment_details trigger also caps every insert at 5), a per-owner lock so
-- two concurrent saves cannot race the count, the first saved account becomes the
-- default, it now RETURNS whether it inserted (so POST /api/shop/payment-details can
-- report "limit reached" instead of a false success), and it is service_role-only.
-- The return type changes void -> boolean, which CREATE OR REPLACE cannot do.
DROP FUNCTION IF EXISTS public.save_shop_payment_detail_if_under_limit(uuid, text, text, text, text, text, text, integer);

CREATE FUNCTION public.save_shop_payment_detail_if_under_limit(
    p_owner_id uuid, p_account_name text, p_momo_number text, p_account_number text,
    p_network text, p_payment_type text, p_bank_id text, p_limit integer DEFAULT 5)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_count int;
    -- The caller may lower the cap, never raise it.
    v_limit int := LEAST(GREATEST(COALESCE(p_limit, 5), 0), 5);
BEGIN
    IF auth.uid() IS NOT NULL AND auth.uid() != p_owner_id THEN
        RAISE EXCEPTION 'ACCESS_DENIED: You may only save your own payment details';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('shop_payment_details:' || p_owner_id::text, 0));

    SELECT COUNT(*) INTO v_count
    FROM public.shop_payment_details
    WHERE shop_owner_id = p_owner_id;

    IF v_count >= v_limit THEN
        -- At the limit: no insert. The withdraw route's post-withdrawal auto-save
        -- ignores this; POST /api/shop/payment-details reports it to the owner.
        RETURN false;
    END IF;

    INSERT INTO public.shop_payment_details (
        shop_owner_id, account_name, momo_number, account_number,
        network, payment_type, bank_id, is_default
    ) VALUES (
        p_owner_id, p_account_name, p_momo_number, p_account_number,
        p_network, p_payment_type, p_bank_id, v_count = 0
    );
    RETURN true;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.save_shop_payment_detail_if_under_limit(uuid, text, text, text, text, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_shop_payment_detail_if_under_limit(uuid, text, text, text, text, text, text, integer)
  TO service_role;

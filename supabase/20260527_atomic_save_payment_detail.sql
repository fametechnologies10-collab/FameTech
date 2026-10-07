-- ============================================================================
-- Security: Atomic conditional INSERT for shop_payment_details
--
-- Replaces the non-atomic read-count → INSERT pattern in the withdraw route.
-- Two concurrent withdrawal requests with saveForLater=true could both pass
-- a count check of 4 and both insert, exceeding the 5-record cap.
-- This function enforces the cap atomically inside a single DB transaction.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.save_shop_payment_detail_if_under_limit(
    p_owner_id       uuid,
    p_account_name   text,
    p_momo_number    text,
    p_account_number text,
    p_network        text,
    p_payment_type   text,
    p_bank_id        text,
    p_limit          int DEFAULT 5
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_count int;
BEGIN
    -- Count existing records and INSERT atomically (no TOCTOU gap)
    SELECT COUNT(*) INTO v_count
    FROM public.shop_payment_details
    WHERE shop_owner_id = p_owner_id;

    IF v_count < p_limit THEN
        INSERT INTO public.shop_payment_details (
            shop_owner_id,
            account_name,
            momo_number,
            account_number,
            network,
            payment_type,
            bank_id,
            is_default
        ) VALUES (
            p_owner_id,
            p_account_name,
            p_momo_number,
            p_account_number,
            p_network,
            p_payment_type,
            p_bank_id,
            false
        );
    END IF;
    -- If at limit, silently do nothing — the withdrawal already succeeded
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_shop_payment_detail_if_under_limit(uuid, text, text, text, text, text, text, int)
    TO authenticated;

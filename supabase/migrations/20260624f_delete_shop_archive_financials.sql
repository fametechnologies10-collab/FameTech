-- =============================================================================
-- B3 — delete_shop_data must not destroy the financial/audit trail, 2026-06-24.
--
-- delete_shop_data() lets a shop owner delete their own shop. It DELETEs
-- shop_wallets and shop_profiles, which CASCADE-purge the financial ledger
-- (shop_wallet_transactions — profit + withdrawals) and order history
-- (shop_orders). That defeats dispute/chargeback/anti-fraud/accounting review:
-- a user can erase their entire money trail on demand.
--
-- Fix: snapshot the financial/audit rows into an admin-only archive table BEFORE
-- the cascading delete. The owner's operational data still goes away (their
-- request), but the money trail is retained for the business.
-- =============================================================================

-- 1. Admin-only archive store. RLS on; clients have no write; admins may read.
CREATE TABLE IF NOT EXISTS public.archived_shop_financial_records (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id     uuid        NOT NULL,
    shop_id      uuid,
    wallet_id    uuid,
    source_table text        NOT NULL,
    record       jsonb       NOT NULL,
    archived_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS archived_shop_financials_owner_idx ON public.archived_shop_financial_records(owner_id);
CREATE INDEX IF NOT EXISTS archived_shop_financials_shop_idx  ON public.archived_shop_financial_records(shop_id);

ALTER TABLE public.archived_shop_financial_records ENABLE ROW LEVEL SECURITY;

-- Clients never write this table (only the SECURITY DEFINER function does, as the
-- function owner, bypassing RLS). Admins may read for forensics.
REVOKE INSERT, UPDATE, DELETE ON public.archived_shop_financial_records FROM anon, authenticated;

DROP POLICY IF EXISTS "archived_financials_admin_read" ON public.archived_shop_financial_records;
CREATE POLICY "archived_financials_admin_read"
    ON public.archived_shop_financial_records
    FOR SELECT TO authenticated
    USING (is_admin());

-- 2. Re-define delete_shop_data to archive financials before the cascading delete.
CREATE OR REPLACE FUNCTION public.delete_shop_data()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_owner_id  UUID;
    v_shop_id   UUID;
    v_wallet_id UUID;
BEGIN
    v_owner_id := auth.uid();

    IF v_owner_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Not authenticated');
    END IF;

    SELECT id INTO v_shop_id   FROM public.shop_profiles WHERE owner_id = v_owner_id;
    SELECT id INTO v_wallet_id FROM public.shop_wallets  WHERE owner_id = v_owner_id;

    IF v_shop_id IS NULL AND v_wallet_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'No shop found to delete');
    END IF;

    -- ── Archive financial/audit rows BEFORE the cascading delete ──────────────
    IF v_wallet_id IS NOT NULL THEN
        INSERT INTO public.archived_shop_financial_records (owner_id, shop_id, wallet_id, source_table, record)
        SELECT v_owner_id, v_shop_id, v_wallet_id, 'shop_wallets', to_jsonb(w)
        FROM public.shop_wallets w WHERE w.id = v_wallet_id;

        INSERT INTO public.archived_shop_financial_records (owner_id, shop_id, wallet_id, source_table, record)
        SELECT v_owner_id, v_shop_id, v_wallet_id, 'shop_wallet_transactions', to_jsonb(t)
        FROM public.shop_wallet_transactions t WHERE t.shop_wallet_id = v_wallet_id;
    END IF;

    IF v_shop_id IS NOT NULL THEN
        INSERT INTO public.archived_shop_financial_records (owner_id, shop_id, wallet_id, source_table, record)
        SELECT v_owner_id, v_shop_id, v_wallet_id, 'shop_orders', to_jsonb(o)
        FROM public.shop_orders o WHERE o.shop_id = v_shop_id;
    END IF;

    -- ── Now perform the owner-requested deletion ──────────────────────────────
    IF v_wallet_id IS NOT NULL THEN
        DELETE FROM public.shop_wallets WHERE id = v_wallet_id;
    END IF;

    IF v_shop_id IS NOT NULL THEN
        DELETE FROM public.shop_profiles WHERE id = v_shop_id;
    END IF;

    RETURN jsonb_build_object('success', true, 'message', 'Shop deleted successfully');
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delete_shop_data() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delete_shop_data() FROM anon;
GRANT  EXECUTE ON FUNCTION public.delete_shop_data() TO authenticated;
GRANT  EXECUTE ON FUNCTION public.delete_shop_data() TO service_role;

NOTIFY pgrst, 'reload schema';

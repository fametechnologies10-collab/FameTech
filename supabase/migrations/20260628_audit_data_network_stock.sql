-- ============================================================================
-- 20260628_audit_data_network_stock.sql
--
-- The admin per-network "out of stock" toggle (POST /api/admin/packages/
-- network-stock) writes admin_settings.data_network_stock via the RLS client and
-- relies on the log_admin_settings_change() trigger to record auth.uid(). But
-- that trigger only audits a hardcoded key allowlist (see 20260622_admin_
-- dashboard_console.sql) which did NOT include 'data_network_stock', so those
-- changes were silently unaudited (MEDIUM finding, Stage-4 review).
--
-- Re-create the trigger function IDENTICAL to the original, adding only
-- 'data_network_stock' to the audited key allowlist. No trigger re-creation
-- needed: CREATE OR REPLACE swaps the function body in place.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.log_admin_settings_change()
RETURNS trigger AS $$
BEGIN
    IF NEW.key IN (
        'paystack_fee_percent','agent_paystack_fee_percent','dealer_paystack_fee_percent',
        'paystack_min_topup','paystack_max_topup','mtn_price_adjustment','agent_upgrade_price',
        'auto_fulfillment_enabled','ussd_enabled','phone_verification_enabled','page_access_storefront',
        'data_network_stock'
    ) AND (TG_OP = 'INSERT' OR NEW.value IS DISTINCT FROM OLD.value) THEN
        INSERT INTO public.admin_settings_audit(key, old_value, new_value, changed_by, source)
        VALUES (NEW.key,
                CASE WHEN TG_OP = 'UPDATE' THEN OLD.value ELSE NULL END,
                NEW.value, auth.uid(), 'settings');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

-- Trigger function must never be callable as a REST RPC.
REVOKE EXECUTE ON FUNCTION public.log_admin_settings_change()        FROM PUBLIC, anon, authenticated;

COMMIT;

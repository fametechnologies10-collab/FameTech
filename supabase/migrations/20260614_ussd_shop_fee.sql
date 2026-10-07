-- =============================================================================
-- USSD dedicated shop service fee (2026-06-14)
-- Seeds the admin_settings key read by lib/ussd/fee.ts:getShopUSSDFeePercent.
-- This fee is charged to the guest on shop storefront USSD orders and RETAINED
-- BY THE PLATFORM — it is never credited to the shop owner (same treatment as the
-- website shop Paystack fee). Default 0 = no fee until the admin sets a rate in
-- Admin → USSD → Shop Service Fee. admin_settings.value is jsonb; sibling keys
-- (ussd_fee_percent, ussd_storefront_mode, ...) store JSON *strings*, so seed the
-- JSON string "0" to match convention (read via parseFloat).
-- =============================================================================

INSERT INTO public.admin_settings (key, value) VALUES
    ('ussd_shop_fee_percent', '"0"')
ON CONFLICT (key) DO NOTHING;

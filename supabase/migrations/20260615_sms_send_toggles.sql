-- supabase/migrations/20260615_sms_send_toggles.sql
-- =============================================================================
-- SMS "order success" send toggles
-- =============================================================================
-- Two opt-out switches, both DEFAULT true so existing behaviour (always send)
-- is preserved for every current row:
--
--   * shop_profiles.sms_order_confirmation_enabled
--       Shop owners turn the customer order-confirmation SMS on/off
--       (gated in lib/shop-order-processor.ts).
--
--   * users.order_success_sms_enabled
--       Each user turns their own data order-success SMS on/off; applies to
--       BOTH single (/api/orders/purchase) and bulk (/api/orders/bulk-purchase)
--       purchases.
-- =============================================================================

ALTER TABLE public.shop_profiles
    ADD COLUMN IF NOT EXISTS sms_order_confirmation_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS order_success_sms_enabled BOOLEAN NOT NULL DEFAULT true;

-- 20260906_utility_sms_toggle.sql
-- Dedicated per-shop toggle for utility-bill completion SMS, separate from
-- sms_order_confirmation_enabled (which only ever covered data/airtime/mashup
-- confirmations — see lib/shop-order-processor.ts). Product decision: a shop
-- owner may want their data-bundle confirmations on but utility-bill
-- confirmations off (or vice versa), so this is its own switch rather than
-- reusing the existing one. Defaults TRUE to match sms_order_confirmation_enabled's
-- "defaults enabled" convention — this is a notification preference layered on
-- top of the already-gated utilities_enabled money-eligibility switch, not a
-- money-eligibility column itself, so it is NOT added to
-- protect_shop_admin_columns()'s pinned-column list.
ALTER TABLE public.shop_profiles
  ADD COLUMN IF NOT EXISTS utility_sms_confirmation_enabled boolean NOT NULL DEFAULT true;

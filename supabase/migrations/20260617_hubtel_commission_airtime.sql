-- 20260617_hubtel_commission_airtime.sql
-- Auto-fulfillment of airtime via Hubtel Commission Services.

ALTER TABLE airtime_orders
  ADD COLUMN IF NOT EXISTS airtime_fulfillment_attempts integer NOT NULL DEFAULT 0;

INSERT INTO admin_settings (key, value)
VALUES
  ('airtime_auto_fulfillment_enabled', 'false'),
  ('hubtel_airtime_networks', '{"MTN":false,"Telecel":false,"AT":false}'),
  ('hubtel_commission_paused', 'false')
ON CONFLICT (key) DO NOTHING;

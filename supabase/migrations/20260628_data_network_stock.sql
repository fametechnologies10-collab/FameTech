-- 20260628_data_network_stock.sql
-- Per-network "out of stock" switches for data bundles.
--  * admin_settings.data_network_stock  -> global (admin) per-network hide
--  * shop_profiles.oos_networks          -> per-shop per-network hide
-- "OFF"/out-of-stock hides the network's bundles; it never touches is_available
-- or in-flight orders.

-- 1) Per-shop out-of-stock networks (array of network names this shop hid).
ALTER TABLE public.shop_profiles
    ADD COLUMN IF NOT EXISTS oos_networks JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 2) Global admin per-network stock map. Seed all-in-stock; never overwrite if present.
INSERT INTO public.admin_settings (key, value)
VALUES ('data_network_stock', '{"MTN":false,"Telecel":false,"AT-iShare":false,"AT-BigTime":false}'::jsonb)
ON CONFLICT (key) DO NOTHING;

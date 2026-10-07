-- Add 1-month and 3-month dealer upgrade price settings
-- These are soft defaults; admin can overwrite via the Roles page.

INSERT INTO public.admin_settings (key, value)
VALUES
    ('dealer_upgrade_price_1m', '99.99'),
    ('dealer_upgrade_price_3m', '199.99')
ON CONFLICT (key) DO NOTHING;

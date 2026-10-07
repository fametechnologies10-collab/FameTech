-- Add configurable USSD service fee (percentage charged on all USSD MoMo payments)
-- Default: 1% — admin can change this value in the admin_settings table at any time.
-- Applied silently to the charged total; never shown as a separate line to users.

INSERT INTO public.admin_settings (key, value)
VALUES ('ussd_fee_percent', '1')
ON CONFLICT (key) DO NOTHING;

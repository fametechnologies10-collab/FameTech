-- Add configurable USSD help line number
INSERT INTO public.admin_settings (key, value)
VALUES ('ussd_helpline', '""')
ON CONFLICT (key) DO NOTHING;

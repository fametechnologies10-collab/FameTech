-- admin_settings.value is jsonb. 20260901_afa_shop_registration.sql seeded
-- ('storefront_afa_enabled', 'false'), which jsonb parses as a BOOLEAN, unlike
-- every sibling storefront toggle (stored as the JSON string "false"/"true")
-- and unlike what the admin UI writes. Left as a boolean, the gate's
-- `!== 'true'` check could never pass and the feature could never be enabled.
UPDATE public.admin_settings
SET value = to_jsonb(value::text)
WHERE key = 'storefront_afa_enabled'
  AND jsonb_typeof(value) = 'boolean';

NOTIFY pgrst, 'reload schema';

-- Add email to passkey_credentials so auth-verify can call generateLink without
-- a getUserById round-trip. Column is nullable so existing rows (if any survive
-- the truncate migration) are not broken; new registrations always populate it.
ALTER TABLE public.passkey_credentials
    ADD COLUMN IF NOT EXISTS email text;

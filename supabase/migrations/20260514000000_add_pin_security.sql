-- Add PIN Security Columns to users table
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS pin_hash text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS pin_reminder text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS pin_attempts integer DEFAULT 0;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS pin_locked_until timestamp with time zone;

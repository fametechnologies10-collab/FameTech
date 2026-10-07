-- ─────────────────────────────────────────────────────────────────────────────
-- Phone OTP Verifications
-- Used during signup to confirm phone number ownership via Moolre SMS.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.phone_otp_verifications (
    id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    phone       TEXT        NOT NULL UNIQUE,
    code        TEXT        NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    attempts    INTEGER     DEFAULT 0,
    used        BOOLEAN     DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_phone_otp_phone ON public.phone_otp_verifications (phone);

-- Service role only — no user-facing RLS needed
ALTER TABLE public.phone_otp_verifications ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- phone_verified column on users table
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'phone_verified'
    ) THEN
        ALTER TABLE public.users ADD COLUMN phone_verified BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Admin setting: phone_verification_enabled (default OFF)
-- Toggle from Admin → Settings → General to require SMS OTP on signup
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.admin_settings (key, value)
VALUES ('phone_verification_enabled', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

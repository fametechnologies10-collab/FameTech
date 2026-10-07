-- ─────────────────────────────────────────────────────────────────────────────
-- Passkey / FIDO2 WebAuthn tables
-- Run in Supabase SQL editor.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── passkey_credentials ───────────────────────────────────────────────────────
-- One row per registered passkey per user.
-- All writes happen via the service-role admin client (API routes) — RLS
-- restricts client-SDK reads to the owning user only.
CREATE TABLE IF NOT EXISTS public.passkey_credentials (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    credential_id   text        NOT NULL UNIQUE,        -- base64url rawId from authenticator
    public_key      bytea       NOT NULL,               -- COSE-encoded public key
    counter         bigint      NOT NULL DEFAULT 0,     -- clone-detection counter
    device_type     text        CHECK (device_type IN ('singleDevice', 'multiDevice')),
    backed_up       boolean     NOT NULL DEFAULT false, -- synced to iCloud/Google PM
    transports      text[],                             -- ['internal','hybrid','usb',...]
    friendly_name   text        NOT NULL DEFAULT 'Passkey',
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_used_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_passkey_cred_id
    ON public.passkey_credentials (credential_id);
CREATE INDEX IF NOT EXISTS idx_passkey_user_id
    ON public.passkey_credentials (user_id);

-- ── passkey_challenges ────────────────────────────────────────────────────────
-- Short-lived (5 min) challenge nonces — prevents replay attacks.
-- user_id is NULL during authentication (user not yet known pre-login).
-- All access is via service-role; no client SDK access.
CREATE TABLE IF NOT EXISTS public.passkey_challenges (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    challenge   text        NOT NULL UNIQUE,
    user_id     uuid        REFERENCES auth.users(id) ON DELETE CASCADE,
    flow        text        NOT NULL CHECK (flow IN ('registration', 'authentication')),
    expires_at  timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_passkey_challenge_val
    ON public.passkey_challenges (challenge);
CREATE INDEX IF NOT EXISTS idx_passkey_challenge_exp
    ON public.passkey_challenges (expires_at);

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE public.passkey_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.passkey_challenges   ENABLE ROW LEVEL SECURITY;

-- Users can read and delete their own passkeys via the client SDK.
-- INSERT/UPDATE always goes through the service-role API routes.
DROP POLICY IF EXISTS "Users read own passkeys"   ON public.passkey_credentials;
DROP POLICY IF EXISTS "Users delete own passkeys" ON public.passkey_credentials;

CREATE POLICY "Users read own passkeys"
    ON public.passkey_credentials FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users delete own passkeys"
    ON public.passkey_credentials FOR DELETE
    USING (auth.uid() = user_id);

-- passkey_challenges: zero client access — service_role only.
DROP POLICY IF EXISTS "No client access to challenges" ON public.passkey_challenges;
CREATE POLICY "No client access to challenges"
    ON public.passkey_challenges FOR ALL
    USING (false);

-- ── Optional: pg_cron cleanup (run if pg_cron extension is enabled) ───────────
-- SELECT cron.schedule(
--   'delete-expired-passkey-challenges',
--   '*/10 * * * *',
--   $$DELETE FROM public.passkey_challenges WHERE expires_at < now()$$
-- );

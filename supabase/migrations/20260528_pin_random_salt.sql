-- ============================================================================
-- PIN Random Salt (2026-05-28)
--
-- Adds a per-user random salt for PIN hashing. Before this change, the PIN
-- hash was salted with the user's UUID (`auth.uid()`), which is publicly
-- known and reusable across attacks. With a random 16-byte salt stored on
-- the row, an offline attacker who steals the hash can no longer
-- pre-compute the 1M-PIN search space against a fleet of users at once.
--
-- Migration plan:
--   1. ADD COLUMN pin_salt TEXT NULL — nullable so existing rows are valid.
--   2. Existing PINs continue to verify against user.id (legacy path).
--   3. Next time the user sets their PIN, the route generates a random salt
--      and stores it here. From then on, verify uses the stored salt.
--
-- No downtime. No password resets required.
-- ============================================================================

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS pin_salt TEXT NULL;

COMMENT ON COLUMN public.users.pin_salt IS
    'Random 16-byte hex salt for PIN PBKDF2 hashing. NULL = legacy PIN salted with user.id; new PINs always have a random salt.';

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';

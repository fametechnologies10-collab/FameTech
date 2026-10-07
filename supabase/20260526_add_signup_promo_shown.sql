-- Add signup_promo_shown to track whether the promo modal has been shown/interacted with
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS signup_promo_shown BOOLEAN NOT NULL DEFAULT false;

-- Back-fill all existing users so the modal never fires for pre-feature accounts.
-- New signups created after this migration runs get DEFAULT false and will see the promo.
UPDATE users SET signup_promo_shown = true;

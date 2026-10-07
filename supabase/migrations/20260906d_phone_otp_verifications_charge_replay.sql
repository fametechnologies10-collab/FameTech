-- 20260906d_phone_otp_verifications_charge_replay.sql
-- Adds the pre-charge MoMo-number OTP verification step for the Hubtel Direct Pay
-- utility rail. Previously, a first-time payer number hit a hard 428
-- "verify_number_required" from app/api/shop/utility/charge with ZERO frontend
-- integration anywhere (the /api/shop/verify-number route existed but nothing
-- ever called it) -- every unverified-number Hubtel utility charge was a dead end.
--
-- Fix: the charge route now returns { status: 'send_otp' } (reusing
-- ServiceChargeSheet's existing generic OTP step) instead of a 428, keyed by a new
-- transient `UTLV-` reference. These two columns let a single phone_otp_verifications
-- row double as the OTP-confirm state AND the "replay this exact charge once confirmed"
-- state, without a second table:
--   - verify_reference: the UTLV- reference the frontend polls submit-otp with (the
--     phone number itself is never sent back to submit-otp, only reference+otp).
--   - pending_charge: the exact params needed to re-run the Hubtel charge after OTP
--     confirmation (see lib/hubtel-checkout.ts's runHubtelUtilityCharge).
ALTER TABLE public.phone_otp_verifications
  ADD COLUMN IF NOT EXISTS verify_reference text,
  ADD COLUMN IF NOT EXISTS pending_charge jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS phone_otp_verifications_verify_reference_key
  ON public.phone_otp_verifications (verify_reference)
  WHERE verify_reference IS NOT NULL;

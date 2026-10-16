-- Closes a HIGH-severity phone-hijack bug found by payments-security-reviewer
-- (2026-10-16): the signup route was granting phone_verified=true to whoever
-- submitted a signup for a phone number with a stale used=true OTP row,
-- regardless of whether THEY were the one who solved the code. An attacker
-- who merely knew a victim's phone number (no SMS interception needed) could
-- hijack the victim's completed-but-abandoned OTP verification within its
-- window and permanently squat the number on their own account.
--
-- Fix: /api/auth/verify-phone(action:verify) now mints a high-entropy,
-- single-use claim token alongside marking the row used=true. The signup
-- route must present that exact token to atomically consume (DELETE ...
-- RETURNING) the row before phone_verified is set — binding the claim to
-- whoever actually completed verification, not to whoever's HTTP request
-- happens to name that phone number next.
ALTER TABLE public.phone_otp_verifications
  ADD COLUMN IF NOT EXISTS signup_claim_token text;

CREATE UNIQUE INDEX IF NOT EXISTS phone_otp_verifications_signup_claim_token_key
  ON public.phone_otp_verifications (signup_claim_token)
  WHERE signup_claim_token IS NOT NULL;

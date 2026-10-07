-- 20260906e_otp_verification_atomic_helpers.sql
-- Closes two gaps found by the payments-security-reviewer pass on the pre-charge
-- MoMo-number OTP step (fix/utility-checkout-bugs):
--
-- 1. bump_otp_attempts: confirmVerificationOtp's wrong-code path used to read
--    `attempts`, then write `attempts+1` in a SEPARATE statement -- two concurrent
--    wrong-code submissions against the same row both read the same starting value
--    and both write the same incremented result, silently undercounting the attempt
--    cap and letting an attacker get more than 3 real guesses at the 6-digit OTP by
--    firing requests in parallel. This RPC makes the increment itself the atomic
--    condition (single UPDATE ... RETURNING), so concurrent callers are serialized
--    by Postgres and each gets a distinct, correct post-increment count.
--
-- 2. phone_otp_verifications.charge_result: the pre-charge OTP step now doubles as
--    a payment-replay trigger (confirming the code replays a stashed Hubtel charge
--    via runHubtelUtilityCharge) -- if the confirm succeeds but the HTTP response
--    never reaches the browser (network drop, tab close), a retry of the same
--    {reference, otp} previously found the row already used and returned a bare
--    "Verification already used" error, with no way to recover the resulting order
--    reference even though the charge itself DID go through. Caching the charge
--    result on the (now-used) row lets a retried confirm return the original
--    result instead of a misleading failure.
ALTER TABLE public.phone_otp_verifications
  ADD COLUMN IF NOT EXISTS charge_result jsonb;

CREATE OR REPLACE FUNCTION public.bump_otp_attempts(p_id uuid)
RETURNS TABLE(attempts int)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  UPDATE public.phone_otp_verifications
     SET attempts = COALESCE(phone_otp_verifications.attempts, 0) + 1
   WHERE id = p_id AND used = false
   RETURNING phone_otp_verifications.attempts;
$$;

-- Matches every other SECURITY DEFINER RPC in this repo (e.g. claim_hubtel_receive_paid in
-- 20260714c_hubtel_receive_rpcs.sql) — Postgres grants EXECUTE to PUBLIC by default on
-- CREATE FUNCTION, which would otherwise let anon/authenticated call this directly via
-- PostgREST (bypassing confirmVerificationOtp's IP rate limits) given only a row id.
REVOKE ALL ON FUNCTION public.bump_otp_attempts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_otp_attempts(uuid) TO service_role;

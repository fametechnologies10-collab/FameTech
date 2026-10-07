-- =============================================================================
-- C1 (part 2 of 2) — REVOKE direct withdrawal-RPC access. BREAKING.
--
-- ⚠️ DEPLOY ORDER: apply this migration ONLY AFTER the new /api/shop/withdraw
-- route code (which calls process_shop_withdrawal via a SERVICE-ROLE client and
-- passes p_owner_id + p_name_verified) is LIVE in production. If applied while
-- the old route is still deployed, every production withdrawal breaks (the old
-- route calls the RPC as `authenticated`, which this migration revokes).
--
-- After this runs, process_shop_withdrawal is executable ONLY by service_role —
-- a shop owner can no longer call it directly via PostgREST to forge the payout
-- destination name. The only path becomes the hardened route, which always runs
-- Moolre name verification and records the real name_verified flag.
-- =============================================================================

REVOKE EXECUTE ON FUNCTION public.process_shop_withdrawal(
    UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, BOOLEAN
) FROM authenticated;

NOTIFY pgrst, 'reload schema';

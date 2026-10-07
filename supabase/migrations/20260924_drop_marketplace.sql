-- ============================================================================
-- DROP KFT MARKETPLACE — full teardown per owner decision (2026-09-24) to
-- discontinue the marketplace product. No backup taken (explicit decision).
-- Reverts supabase/migrations/20260709_marketplace_core.sql and
-- supabase/migrations/20260709b_marketplace_rpcs.sql.
-- CASCADE on the table drops removes their triggers, indexes, and RLS
-- policies automatically.
--
-- Storage (the `marketplace-images` bucket and its objects) is NOT handled by
-- this file — Supabase's storage.protect_delete() trigger rejects raw SQL
-- DELETE against storage.objects/storage.buckets ("Direct deletion from
-- storage tables is not allowed. Use the Storage API instead."). The bucket
-- was cleared and deleted manually via the Supabase Dashboard's Storage UI
-- (which calls the Storage API correctly), confirmed empty and gone via
-- SELECT against storage.buckets/storage.objects before this migration was
-- finalized. The storage.objects RLS policy "Marketplace Images Public Read"
-- (created in 20260709_marketplace_core.sql) is gone from the live project
-- too, but that happened as a side effect of the Dashboard bucket deletion,
-- not via any statement in this file — the explicit DROP POLICY below
-- reproduces that for a replay against an environment where the bucket
-- still exists.
-- ============================================================================

-- Tables (CASCADE removes dependent triggers/indexes/policies/FKs)
DROP TABLE IF EXISTS public.marketplace_moderation_actions CASCADE;
DROP TABLE IF EXISTS public.marketplace_reports CASCADE;
DROP TABLE IF EXISTS public.marketplace_listing_images CASCADE;
DROP TABLE IF EXISTS public.marketplace_listings CASCADE;
DROP TABLE IF EXISTS public.marketplace_categories CASCADE;
DROP TABLE IF EXISTS public.marketplace_seller_profiles CASCADE;

-- Standalone RPCs called from the deleted API routes
DROP FUNCTION IF EXISTS public.create_marketplace_listing CASCADE;
DROP FUNCTION IF EXISTS public.moderate_marketplace_listing CASCADE;
DROP FUNCTION IF EXISTS public.mark_marketplace_listing_sold CASCADE;
DROP FUNCTION IF EXISTS public.reveal_marketplace_contact CASCADE;
DROP FUNCTION IF EXISTS public.search_marketplace_listings CASCADE;
DROP FUNCTION IF EXISTS public.marketplace_admin_stats CASCADE;
DROP FUNCTION IF EXISTS public.suspend_marketplace_seller CASCADE;
DROP FUNCTION IF EXISTS public.set_marketplace_seller_verified CASCADE;
DROP FUNCTION IF EXISTS public.is_marketplace_seller_suspended CASCADE;

-- Guard-trigger functions. CASCADE on the table drops above removes the
-- TRIGGER objects (trg_guard_marketplace_seller_profiles,
-- trg_guard_marketplace_listings) since a trigger depends on its table, but
-- NOT the trigger's underlying function — a function has no pg_depend edge
-- to the table it happens to be attached to via a trigger. These two would
-- otherwise linger as orphaned SECURITY DEFINER functions indefinitely.
DROP FUNCTION IF EXISTS public.guard_marketplace_seller_profile_columns() CASCADE;
DROP FUNCTION IF EXISTS public.guard_marketplace_listings_protected_columns() CASCADE;

-- Storage cleanup (bucket `marketplace-images` and its objects) was done
-- manually via the Supabase Dashboard Storage UI — see the header comment
-- above for why raw SQL can't do this. The policy below is a table (RLS)
-- policy, not a storage-API-managed object, so a plain DROP POLICY works
-- here even though DELETE against storage.objects/storage.buckets does not.
DROP POLICY IF EXISTS "Marketplace Images Public Read" ON storage.objects;

NOTIFY pgrst, 'reload schema';

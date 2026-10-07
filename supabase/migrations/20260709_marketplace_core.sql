-- ============================================================================
-- KFT MARKET M3 — LISTINGS BACKEND, CORE SCHEMA (Task 2 of 12)
-- Plan: docs/superpowers/plans/2026-07-08-market-m3-listings-backend.md
--
-- Design:
--  * marketplace_* tables. ALL writes to seller profiles / listings / images /
--    categories / moderation actions happen via SECURITY DEFINER RPCs run as
--    service_role (Task 3, migration 20260709b) — never direct client writes.
--    Every such table therefore gets ENABLE ROW LEVEL SECURITY + a same-file
--    REVOKE INSERT,UPDATE,DELETE FROM anon,authenticated (red-team lesson,
--    2026-06: never leave broad default PostgREST write grants + RLS to
--    chance — the grant-level REVOKE is the real enforcement, RLS policies
--    are defense-in-depth).
--  * marketplace_reports is the one exception: reporters legitimately INSERT
--    their own report row directly (RLS-scoped to reporter_id = auth.uid());
--    UPDATE/DELETE are still revoked and there is no client SELECT policy
--    (admin reads via service-role route).
--  * Guard trigger on marketplace_listings blocks a client session (a
--    request carrying a user JWT, i.e. auth.uid() IS NOT NULL) from writing
--    to the moderation/visibility/promotion/identity columns even if a future
--    change ever restores a client UPDATE grant — mirrors the pattern in
--    20260624d_emergency_block_privilege_self_escalation.sql. service_role
--    RPC calls carry no user JWT (auth.uid() IS NULL there), so the RPC path
--    is unaffected.
--  * Public browsing = approved + active + not-sold + seller not suspended.
--    Sellers can always SELECT their own listings regardless of status.
--  * Storage bucket `marketplace-images` mirrors the folder-scoped RLS
--    pattern from shop-banners: public read, owner-folder-scoped write
--    (auth.uid()::text = (storage.foldername(name))[1]).
--  * NOT applied to prod — file only, owner-approved apply per project rule.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Extensions
-- ────────────────────────────────────────────────────────────────────────────

-- Supabase installs extensions into the dedicated `extensions` schema (matching
-- pgcrypto / uuid-ossp / pg_stat_statements on this project) and its security
-- advisor flags any extension in `public`. Pin the schema EXPLICITLY so a fresh
-- install lands there deterministically, then fully schema-qualify every trgm /
-- unaccent reference (the GIN opclass below + unaccent() in 20260709b) so name
-- resolution never depends on the session/function search_path. Without this,
-- `create_marketplace_listing` and `search_marketplace_listings` would throw
-- `function unaccent(text) does not exist` at runtime under `search_path =
-- public, pg_catalog` — taking down both posting and search. (Verified live:
-- both extensions are unset today and every other extension is in `extensions`.)
CREATE EXTENSION IF NOT EXISTS pg_trgm  WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

-- ────────────────────────────────────────────────────────────────────────────
-- 2a. marketplace_seller_profiles — lazy-created on first post (Task 3 RPC)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS marketplace_seller_profiles (
    user_id            UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    display_name       TEXT NOT NULL,
    region             TEXT NOT NULL,
    whatsapp           TEXT,
    is_suspended       BOOLEAN NOT NULL DEFAULT false,
    -- Client-unwritable phone-verification signal. Set ONLY by the
    -- set_marketplace_seller_verified SECURITY DEFINER RPC (20260709b), which
    -- is called ONLY from app/api/market/seller/verify-phone/route.ts after a
    -- real server-side OTP check. INSERT/UPDATE on this table is REVOKEd from
    -- anon/authenticated below, so no client session can ever set these —
    -- unlike users.phone_verified, which has a client-writable self-update
    -- RLS policy and is therefore NOT a valid verification gate.
    verified_phone     TEXT,
    phone_verified_at  TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE marketplace_seller_profiles IS
    'Marketplace seller identity. No public SELECT policy — public seller display '
    'comes via listing joins / a later view, never a direct table read. is_suspended '
    'drops ALL of a seller''s listings from the public marketplace_listings SELECT.';

COMMENT ON COLUMN marketplace_seller_profiles.phone_verified_at IS
    'Set only by set_marketplace_seller_verified (SECURITY DEFINER), called only '
    'from the authenticated server-side OTP route. Never client-writable — this is '
    'the real, unbypassable phone-verification gate for create_marketplace_listing.';

ALTER TABLE marketplace_seller_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS marketplace_seller_profiles_owner_select ON marketplace_seller_profiles;
CREATE POLICY marketplace_seller_profiles_owner_select ON marketplace_seller_profiles
    FOR SELECT USING (user_id = (SELECT auth.uid()));

-- INTENTIONALLY NO client INSERT/UPDATE/DELETE policy. There is NO legitimate
-- client write path to this table: the phone-verification signal
-- (verified_phone / phone_verified_at) and is_suspended are written ONLY by the
-- service-role RPCs set_marketplace_seller_verified / suspend_marketplace_seller
-- (20260709b). Earlier drafts carried owner_insert / owner_update policies; they
-- were dead weight (the REVOKE below already blocks client writes) AND a latent
-- bypass of the owner's #1 requirement — if a future migration ever re-granted
-- table writes to `authenticated` (the exact 2026-06 red-team incident class),
-- those permissive policies would have let a user set their own phone_verified_at
-- and post with an unverified number. Dropped. Only owner_select (above) remains
-- — the seller status route must read the caller's own row.
DROP POLICY IF EXISTS marketplace_seller_profiles_owner_insert ON marketplace_seller_profiles;
DROP POLICY IF EXISTS marketplace_seller_profiles_owner_update ON marketplace_seller_profiles;

REVOKE INSERT, UPDATE, DELETE ON public.marketplace_seller_profiles FROM anon, authenticated;

-- Belt-and-suspenders backstop mirroring the marketplace_listings guard trigger:
-- even if a future migration mistakenly restores BOTH a client write grant AND a
-- permissive policy on this table, a client session (auth.uid() IS NOT NULL) still
-- cannot write the verification / suspension columns. service_role RPC calls carry
-- no user JWT (auth.uid() IS NULL) and pass through untouched. This is the single
-- most important signal in the whole feature (the owner's #1 requirement), so it
-- gets BOTH the grant-level REVOKE above and this trigger.
CREATE OR REPLACE FUNCTION public.guard_marketplace_seller_profile_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF (SELECT auth.uid()) IS NOT NULL THEN
        IF TG_OP = 'INSERT' THEN
            IF NEW.verified_phone IS NOT NULL
                OR NEW.phone_verified_at IS NOT NULL
                OR NEW.is_suspended
            THEN
                RAISE EXCEPTION 'FORBIDDEN_COLUMN_WRITE';
            END IF;
        ELSIF TG_OP = 'UPDATE' THEN
            IF NEW.verified_phone     IS DISTINCT FROM OLD.verified_phone
                OR NEW.phone_verified_at IS DISTINCT FROM OLD.phone_verified_at
                OR NEW.is_suspended      IS DISTINCT FROM OLD.is_suspended
            THEN
                RAISE EXCEPTION 'FORBIDDEN_COLUMN_WRITE';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_marketplace_seller_profiles ON public.marketplace_seller_profiles;
CREATE TRIGGER trg_guard_marketplace_seller_profiles
    BEFORE INSERT OR UPDATE ON public.marketplace_seller_profiles
    FOR EACH ROW EXECUTE FUNCTION public.guard_marketplace_seller_profile_columns();

REVOKE EXECUTE ON FUNCTION public.guard_marketplace_seller_profile_columns()
    FROM PUBLIC, anon, authenticated;

-- is_marketplace_seller_suspended: SECURITY DEFINER so it BYPASSES
-- marketplace_seller_profiles' owner-only SELECT RLS. Used inside the public
-- SELECT policies below. A raw `NOT EXISTS (SELECT ... FROM
-- marketplace_seller_profiles ...)` subquery in an RLS policy is a SILENT
-- NO-OP: the subquery is itself evaluated under the *caller's* RLS, so an
-- anon / other-user session sees 0 rows → NOT EXISTS is always TRUE →
-- suspended sellers would stay publicly visible. This definer-rights helper
-- reads the flag regardless of the caller's RLS. Defined BEFORE any policy
-- that references it. Granted to anon+authenticated (they invoke it via the
-- policies); the function reveals only a single boolean, never PII.
CREATE OR REPLACE FUNCTION public.is_marketplace_seller_suspended(p_seller_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT COALESCE(
    (SELECT is_suspended FROM marketplace_seller_profiles WHERE user_id = p_seller_id),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.is_marketplace_seller_suspended(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_marketplace_seller_suspended(uuid) TO anon, authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 2b. marketplace_categories — seeded in section 5 from
--     app/marketplace-domain/_data/categories.ts
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS marketplace_categories (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id  UUID REFERENCES marketplace_categories(id),
    slug       TEXT UNIQUE NOT NULL,
    label      TEXT NOT NULL,
    icon       TEXT,
    tint       TEXT,
    sort       INT NOT NULL DEFAULT 0,
    is_active  BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE marketplace_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS marketplace_categories_public_select ON marketplace_categories;
CREATE POLICY marketplace_categories_public_select ON marketplace_categories
    FOR SELECT USING (is_active);

REVOKE INSERT, UPDATE, DELETE ON public.marketplace_categories FROM anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 2c. marketplace_listings — the core table. All writes via Task-3 RPCs.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS marketplace_listings (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id         UUID NOT NULL REFERENCES public.users(id),
    category_id       UUID NOT NULL REFERENCES marketplace_categories(id),
    title             TEXT NOT NULL,
    slug              TEXT UNIQUE NOT NULL,
    description       TEXT NOT NULL,
    price_pesewas     INT NOT NULL CHECK (price_pesewas >= 0),
    condition         TEXT NOT NULL CHECK (condition IN ('new', 'used')),
    region            TEXT NOT NULL,
    -- Server-sourced snapshot of the seller's VERIFIED users.phone_number at
    -- post time (Task-3 RPC). Never client input — not editable by clients.
    contact_phone     TEXT NOT NULL,
    -- Optional additional contact, format-validated at the route layer.
    contact_whatsapp  TEXT,
    moderation_status TEXT NOT NULL DEFAULT 'pending'
                          CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
    rejection_reason  TEXT,
    is_active         BOOLEAN NOT NULL DEFAULT true,
    is_sold           BOOLEAN NOT NULL DEFAULT false,
    bumped_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    promotion_tier    SMALLINT NOT NULL DEFAULT 0,
    promoted_until    TIMESTAMPTZ,
    search_tsv        TSVECTOR,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN marketplace_listings.contact_phone IS
    'Server-sourced snapshot of users.phone_number at post time (verified phone '
    'required). Set only by the create_marketplace_listing RPC — never a client param.';

ALTER TABLE marketplace_listings ENABLE ROW LEVEL SECURITY;

-- Public browsing: approved + active + not sold + seller not suspended.
-- Suspension is checked via the SECURITY DEFINER helper (a raw subquery over
-- marketplace_seller_profiles here would be a silent no-op under nested RLS).
DROP POLICY IF EXISTS marketplace_listings_public_select ON marketplace_listings;
CREATE POLICY marketplace_listings_public_select ON marketplace_listings
    FOR SELECT USING (
        moderation_status = 'approved'
        AND is_active
        AND NOT is_sold
        AND NOT public.is_marketplace_seller_suspended(marketplace_listings.seller_id)
    );

-- Sellers can always see their own listings, any status (pending/rejected too).
DROP POLICY IF EXISTS marketplace_listings_seller_select ON marketplace_listings;
CREATE POLICY marketplace_listings_seller_select ON marketplace_listings
    FOR SELECT USING (seller_id = (SELECT auth.uid()));

-- All writes via SECURITY DEFINER RPCs (service_role bypasses RLS + grants).
REVOKE INSERT, UPDATE, DELETE ON public.marketplace_listings FROM anon, authenticated;

-- Contact PII is never readable via table SELECT by any client. RLS is
-- row-level, not column-level: once a row is publicly selectable, anon could
-- otherwise `select=contact_phone,contact_whatsapp` and bulk-scrape verified
-- numbers. Column-level REVOKE from BOTH client roles closes anon AND
-- authenticated bulk-read. Contact is revealed only to a signed-in user,
-- per-listing, via a SECURITY DEFINER reveal RPC added in Task 3 (20260709b) —
-- no reveal RPC is defined in THIS file. service_role (RLS/grant bypass) still
-- reads these columns for the admin surfaces.
REVOKE SELECT (contact_phone, contact_whatsapp) ON public.marketplace_listings FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_marketplace_listings_search_tsv
    ON marketplace_listings USING GIN (search_tsv);

-- Schema-qualified opclass: pg_trgm lives in `extensions` (see section 1), and
-- an unqualified `gin_trgm_ops` here would not resolve under the migration
-- session's search_path.
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_title_trgm
    ON marketplace_listings USING GIN (title extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_marketplace_listings_category_status_bumped
    ON marketplace_listings (category_id, moderation_status, bumped_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_listings_seller
    ON marketplace_listings (seller_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 2d. marketplace_listing_images
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS marketplace_listing_images (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id   UUID NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    storage_path TEXT NOT NULL,
    sort         INT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE marketplace_listing_images ENABLE ROW LEVEL SECURITY;

-- Visible whenever the parent listing is publicly visible. Suspension checked
-- via the SECURITY DEFINER helper (a raw seller_profiles subquery here would be
-- a silent no-op under nested RLS).
DROP POLICY IF EXISTS marketplace_listing_images_public_select ON marketplace_listing_images;
CREATE POLICY marketplace_listing_images_public_select ON marketplace_listing_images
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM marketplace_listings l
            WHERE l.id = marketplace_listing_images.listing_id
              AND l.moderation_status = 'approved'
              AND l.is_active
              AND NOT l.is_sold
              AND NOT public.is_marketplace_seller_suspended(l.seller_id)
        )
    );

-- Or the seller owns the parent listing (any status).
DROP POLICY IF EXISTS marketplace_listing_images_seller_select ON marketplace_listing_images;
CREATE POLICY marketplace_listing_images_seller_select ON marketplace_listing_images
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM marketplace_listings l
            WHERE l.id = marketplace_listing_images.listing_id
              AND l.seller_id = (SELECT auth.uid())
        )
    );

REVOKE INSERT, UPDATE, DELETE ON public.marketplace_listing_images FROM anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 2e. marketplace_reports — the one table where a client INSERT grant stays.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS marketplace_reports (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id  UUID NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    reporter_id UUID NOT NULL REFERENCES public.users(id),
    reason      TEXT NOT NULL CHECK (reason IN ('scam', 'prohibited', 'wrong_category', 'offensive', 'duplicate', 'other')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (listing_id, reporter_id)
);

ALTER TABLE marketplace_reports ENABLE ROW LEVEL SECURITY;

-- Reporter can INSERT their own report row. No SELECT policy — admin reads
-- via service-role route only (RLS default-denies SELECT for anon/authenticated
-- with no matching policy).
DROP POLICY IF EXISTS marketplace_reports_reporter_insert ON marketplace_reports;
CREATE POLICY marketplace_reports_reporter_insert ON marketplace_reports
    FOR INSERT WITH CHECK (reporter_id = (SELECT auth.uid()));

-- anon is never a legitimate reporter (reporter_id = auth.uid() can never
-- match for an unauthenticated session anyway) — revoke INSERT for anon only.
REVOKE INSERT ON public.marketplace_reports FROM anon;
-- authenticated KEEPS INSERT (reporters need it) — only UPDATE/DELETE revoked.
REVOKE UPDATE, DELETE ON public.marketplace_reports FROM anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 2f. marketplace_moderation_actions — audit trail, service_role only.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS marketplace_moderation_actions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id UUID NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    admin_id   UUID NOT NULL REFERENCES public.users(id),
    action     TEXT NOT NULL,
    reason     TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE marketplace_moderation_actions ENABLE ROW LEVEL SECURITY;
-- No client policies at all — service_role (RLS-bypass) only, read and write.

REVOKE INSERT, UPDATE, DELETE ON public.marketplace_moderation_actions FROM anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Guard trigger — blocks a client-session UPDATE of the moderation /
--    visibility / promotion / identity columns on marketplace_listings.
--    Mirrors 20260624d_emergency_block_privilege_self_escalation.sql:
--    auth.uid() IS NOT NULL means the request carries a user JWT (a direct
--    client/PostgREST session); service_role RPC calls carry no user JWT
--    (auth.uid() IS NULL) and are unaffected. Belt-and-suspenders alongside
--    the REVOKE in 2c — still fires even if a client UPDATE grant is ever
--    mistakenly restored.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.guard_marketplace_listings_protected_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF (SELECT auth.uid()) IS NOT NULL THEN
        IF NEW.moderation_status IS DISTINCT FROM OLD.moderation_status
            OR NEW.is_active      IS DISTINCT FROM OLD.is_active
            OR NEW.promotion_tier IS DISTINCT FROM OLD.promotion_tier
            OR NEW.promoted_until IS DISTINCT FROM OLD.promoted_until
            OR NEW.slug           IS DISTINCT FROM OLD.slug
            OR NEW.seller_id      IS DISTINCT FROM OLD.seller_id
            -- contact_phone is the verified-at-post-time snapshot; is_sold is set
            -- only by mark_marketplace_listing_sold (service-role). Neither may be
            -- rewritten by a client session if a write grant is ever restored.
            OR NEW.contact_phone  IS DISTINCT FROM OLD.contact_phone
            OR NEW.is_sold        IS DISTINCT FROM OLD.is_sold
        THEN
            RAISE EXCEPTION 'FORBIDDEN_COLUMN_WRITE';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_marketplace_listings ON public.marketplace_listings;
CREATE TRIGGER trg_guard_marketplace_listings
    BEFORE UPDATE ON public.marketplace_listings
    FOR EACH ROW EXECUTE FUNCTION public.guard_marketplace_listings_protected_columns();

-- Invoked only by the trigger, never called directly by any client/role.
REVOKE EXECUTE ON FUNCTION public.guard_marketplace_listings_protected_columns()
    FROM PUBLIC, anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Storage bucket `marketplace-images` — folder-scoped RLS, mirrors
--    20260328_create_shop_banners_bucket.sql.
-- ────────────────────────────────────────────────────────────────────────────

-- Bucket-level MIME + size restrictions apply to EVERY write, including a direct
-- client Storage insert that would skip the upload route's magic-byte/size checks.
-- Without them an authenticated user could push oversized files or content served
-- under a chosen content-type onto the public storage domain. 5 MB + image-only
-- mirrors app/api/market/upload/route.ts (MAX_IMAGE_BYTES + ALLOWED_MIME_TYPES).
-- ON CONFLICT DO UPDATE (not DO NOTHING) so the limits are enforced even if the
-- bucket already exists from an earlier apply.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'marketplace-images', 'marketplace-images', true,
    5242880,
    ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
    file_size_limit    = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Marketplace Images Public Read" ON storage.objects;
CREATE POLICY "Marketplace Images Public Read"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'marketplace-images');

-- NO client Storage write policies. All uploads go through
-- app/api/market/upload/route.ts, which uploads via the SERVICE-ROLE client
-- (RLS-bypassing) only AFTER auth + phone-verify + magic-byte + size validation.
-- Granting authenticated users a direct folder-scoped INSERT/UPDATE/DELETE would
-- let them write straight to storage and skip that whole pipeline (the M2
-- finding), so those policies are intentionally absent. DROP defensively in case
-- an earlier draft of this migration created them.
DROP POLICY IF EXISTS "Marketplace Images Auth Insert" ON storage.objects;
DROP POLICY IF EXISTS "Marketplace Images Auth Update" ON storage.objects;
DROP POLICY IF EXISTS "Marketplace Images Auth Delete" ON storage.objects;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Seed marketplace_categories from app/marketplace-domain/_data/categories.ts
--    (the 12-entry CATEGORIES array — kept as the seed/icon-tint source of
--    truth; admin CRUD in Task 10c adds subcategories on top).
-- ────────────────────────────────────────────────────────────────────────────

INSERT INTO marketplace_categories (slug, label, icon, tint, sort, is_active) VALUES
    ('vehicles',               'Vehicles',            'car',           'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300', 0,  true),
    ('property',               'Property',            'home',          'bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300',                 1,  true),
    ('phones-tablets',         'Phones & Tablets',     'smartphone',    'bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300',     2,  true),
    ('electronics',            'Electronics',          'tv',            'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',         3,  true),
    ('home-furniture',         'Home & Furniture',     'sofa',          'bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300',              4,  true),
    ('fashion',                'Fashion',              'shirt',         'bg-fuchsia-50 text-fuchsia-700 dark:bg-fuchsia-950 dark:text-fuchsia-300',  5,  true),
    ('beauty',                 'Beauty & Health',      'sparkles',      'bg-pink-50 text-pink-700 dark:bg-pink-950 dark:text-pink-300',              6,  true),
    ('electronics-appliances', 'Appliances',           'refrigerator',  'bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300',              7,  true),
    ('jobs',                   'Jobs',                 'briefcase',     'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300',      8,  true),
    ('services',               'Services',             'wrench',        'bg-orange-50 text-orange-700 dark:bg-orange-950 dark:text-orange-300',      9,  true),
    ('agriculture',            'Agriculture & Food',   'wheat',         'bg-lime-50 text-lime-700 dark:bg-lime-950 dark:text-lime-300',              10, true),
    ('babies-kids',            'Babies & Kids',        'baby',          'bg-cyan-50 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300',              11, true)
ON CONFLICT (slug) DO NOTHING;

NOTIFY pgrst, 'reload schema';

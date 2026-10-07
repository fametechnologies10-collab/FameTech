-- ============================================================================
-- KFT MARKET M3 — LISTINGS BACKEND, RPCs (Task 3 of 12)
-- Plan: docs/superpowers/plans/2026-07-08-market-m3-listings-backend.md
--
-- Design:
--  * These SECURITY DEFINER functions are the ONLY write path for
--    marketplace_* tables (Task 2, migration 20260709_marketplace_core.sql,
--    REVOKEs INSERT/UPDATE/DELETE from anon/authenticated on every table).
--    Each function here is therefore an enforcement chokepoint, not just a
--    convenience wrapper — validation performed here is unbypassable via a
--    direct PostgREST call, unlike client-side/route-layer validation.
--  * create_marketplace_listing is the money/trust-critical one: it enforces
--    phone verification server-side against marketplace_seller_profiles.
--    verified_phone / phone_verified_at (client-unwritable — set only by
--    set_marketplace_seller_verified below, itself called only from the
--    authenticated server-side OTP route) and sources contact_phone from
--    that same server-held value (never a client parameter), so a forged
--    contact number OR a forged verification is impossible even via a raw
--    RPC call. This intentionally does NOT trust users.phone_verified, which
--    has a client-writable self-update RLS policy and is bypassable.
--  * search_marketplace_listings hardcodes the public-visibility filter
--    (approved + active + not-sold + seller not suspended) — this is NEVER
--    derived from caller-supplied parameters, so a malicious p_category_slug/
--    p_region/etc. cannot widen the result set to pending/rejected/suspended
--    listings.
--  * Every function: SECURITY DEFINER, SET search_path = public, pg_catalog
--    (prevents search_path hijacking), REVOKE ALL FROM PUBLIC, anon,
--    authenticated then GRANT EXECUTE only to the roles that legitimately
--    call it (service_role for admin/write RPCs called from server routes;
--    authenticated + service_role for the one user-facing reveal RPC).
--  * NOT applied to prod — file only, owner-approved apply per project rule.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1. create_marketplace_listing — the single write path for new listings.
--    Enforcement chokepoint: phone verification + server-sourced contact.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_marketplace_listing(
    p_seller_id         UUID,
    p_category_id       UUID,
    p_title             TEXT,
    p_slug              TEXT,
    p_description       TEXT,
    p_price_pesewas     INT,
    p_condition         TEXT,
    p_region            TEXT,
    p_image_paths       TEXT[],
    p_contact_whatsapp  TEXT DEFAULT NULL
)
RETURNS TABLE(id UUID, slug TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_phone        TEXT;
    v_verified_at  TIMESTAMPTZ;
    v_id           UUID;
    v_slug         TEXT;
BEGIN
    -- 1. Phone verification — the real, unbypassable enforcement. Gated on
    --    marketplace_seller_profiles.verified_phone / phone_verified_at, which
    --    are client-unwritable (INSERT/UPDATE REVOKEd from anon/authenticated
    --    in 20260709_marketplace_core.sql) and set ONLY by the
    --    set_marketplace_seller_verified RPC below, itself called ONLY from
    --    the authenticated server-side OTP route
    --    (app/api/market/seller/verify-phone/route.ts). Unlike users.phone_verified
    --    (client-writable via a self-update RLS policy — the bug this replaces),
    --    this cannot be forged by any client session. The profile must
    --    PRE-EXIST (created by the verify route); if it's missing, the SELECT
    --    below returns NULLs and this correctly raises PHONE_NOT_VERIFIED.
    SELECT verified_phone, phone_verified_at
      INTO v_phone, v_verified_at
      FROM public.marketplace_seller_profiles
     WHERE user_id = p_seller_id;

    IF v_verified_at IS NULL OR v_phone IS NULL THEN
        RAISE EXCEPTION 'PHONE_NOT_VERIFIED';
    END IF;

    -- 2. Category must exist and be active. Table-qualified column refs below
    --    are mandatory, not stylistic: RETURNS TABLE(id, slug) implicitly
    --    declares plpgsql OUT variables named "id"/"slug" in this function's
    --    scope, and a bare `id`/`slug` column reference against another
    --    table would raise "column reference is ambiguous" at runtime under
    --    the default plpgsql.variable_conflict = error.
    IF NOT EXISTS (
        SELECT 1 FROM public.marketplace_categories mc
         WHERE mc.id = p_category_id AND mc.is_active
    ) THEN
        RAISE EXCEPTION 'INVALID_CATEGORY';
    END IF;

    -- 3. Image count 1–8.
    IF p_image_paths IS NULL OR array_length(p_image_paths, 1) IS NULL
        OR array_length(p_image_paths, 1) < 1 OR array_length(p_image_paths, 1) > 8
    THEN
        RAISE EXCEPTION 'INVALID_IMAGE_COUNT';
    END IF;

    -- 4. Price sanity (CHECK constraint on the table also enforces this).
    IF p_price_pesewas IS NULL OR p_price_pesewas < 0 THEN
        RAISE EXCEPTION 'INVALID_PRICE';
    END IF;

    -- 5. Condition (CHECK constraint also enforces this).
    IF p_condition IS NULL OR p_condition NOT IN ('new', 'used') THEN
        RAISE EXCEPTION 'INVALID_CONDITION';
    END IF;

    -- 6. Slug availability — clean error before the unique-index 23505.
    IF EXISTS (SELECT 1 FROM public.marketplace_listings ml WHERE ml.slug = p_slug) THEN
        RAISE EXCEPTION 'SLUG_TAKEN';
    END IF;

    -- 7. Insert the listing. contact_phone is server-sourced (v_phone, from the
    --    seller profile), NEVER a client parameter — this is the whole point
    --    of this function. The seller profile itself is created only by
    --    set_marketplace_seller_verified, never lazily here.
    INSERT INTO public.marketplace_listings (
        seller_id, category_id, title, slug, description,
        price_pesewas, condition, region,
        contact_phone, contact_whatsapp,
        moderation_status, search_tsv
    ) VALUES (
        p_seller_id, p_category_id, p_title, p_slug, p_description,
        p_price_pesewas, p_condition, p_region,
        v_phone, p_contact_whatsapp,
        'pending',
        to_tsvector('english', extensions.unaccent(coalesce(p_title, '') || ' ' || coalesce(p_description, '')))
    )
    RETURNING marketplace_listings.id, marketplace_listings.slug
    INTO v_id, v_slug;

    -- 8. Insert images, preserving client order via WITH ORDINALITY.
    INSERT INTO public.marketplace_listing_images (listing_id, storage_path, sort)
    SELECT v_id, path, ord - 1
      FROM unnest(p_image_paths) WITH ORDINALITY AS t(path, ord);

    RETURN QUERY SELECT v_id, v_slug;
END;
$$;

REVOKE ALL ON FUNCTION public.create_marketplace_listing(
    UUID, UUID, TEXT, TEXT, TEXT, INT, TEXT, TEXT, TEXT[], TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_marketplace_listing(
    UUID, UUID, TEXT, TEXT, TEXT, INT, TEXT, TEXT, TEXT[], TEXT
) TO service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. moderate_marketplace_listing — admin approve/reject, idempotent (CAS on
--    moderation_status so a double-click / retry can never double-log).
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.moderate_marketplace_listing(
    p_listing_id UUID,
    p_admin_id   UUID,
    p_action     TEXT,
    p_reason     TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_id UUID;
BEGIN
    IF p_action NOT IN ('approve', 'reject') THEN
        RAISE EXCEPTION 'INVALID_ACTION';
    END IF;

    UPDATE public.marketplace_listings
       SET moderation_status = CASE WHEN p_action = 'approve' THEN 'approved' ELSE 'rejected' END,
           rejection_reason  = CASE WHEN p_action = 'reject' THEN p_reason ELSE NULL END,
           updated_at        = now()
     WHERE id = p_listing_id
       AND moderation_status = 'pending'
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        -- Either already moderated or the listing doesn't exist — treat both
        -- as a benign idempotent no-op rather than an error, so a retry/
        -- double-click never raises.
        RETURN 'already_moderated';
    END IF;

    INSERT INTO public.marketplace_moderation_actions (listing_id, admin_id, action, reason)
    VALUES (v_id, p_admin_id, p_action, p_reason);

    RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION public.moderate_marketplace_listing(UUID, UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.moderate_marketplace_listing(UUID, UUID, TEXT, TEXT)
    TO service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. mark_marketplace_listing_sold — seller marks own listing sold.
--    Ownership check lives in the WHERE clause (not a separate SELECT), so
--    there is no TOCTOU window between an ownership check and the write.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mark_marketplace_listing_sold(
    p_listing_id UUID,
    p_seller_id  UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_id UUID;
BEGIN
    UPDATE public.marketplace_listings
       SET is_sold = true,
           updated_at = now()
     WHERE id = p_listing_id
       AND seller_id = p_seller_id
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        RAISE EXCEPTION 'NOT_OWNER_OR_NOT_FOUND';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_marketplace_listing_sold(UUID, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_marketplace_listing_sold(UUID, UUID)
    TO service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. reveal_marketplace_contact — the auth-gated contact reveal. Required
--    because contact_phone/contact_whatsapp are column-REVOKEd from direct
--    client SELECT (Task 2). GRANT to `authenticated` (signed-in users only,
--    NOT anon) + service_role (admin surfaces). Visible to any signed-in
--    caller for a publicly-visible listing, or to the seller for their own
--    listing regardless of status — mirrors the table's own SELECT policies.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.reveal_marketplace_contact(
    p_listing_id UUID
)
RETURNS TABLE(contact_phone TEXT, contact_whatsapp TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF (SELECT auth.uid()) IS NULL THEN
        RAISE EXCEPTION 'AUTH_REQUIRED';
    END IF;

    RETURN QUERY
    SELECT l.contact_phone, l.contact_whatsapp
      FROM public.marketplace_listings l
     WHERE l.id = p_listing_id
       AND (
            (
                l.moderation_status = 'approved'
                AND l.is_active
                AND NOT l.is_sold
                AND NOT public.is_marketplace_seller_suspended(l.seller_id)
            )
            OR l.seller_id = (SELECT auth.uid())
       );
END;
$$;

REVOKE ALL ON FUNCTION public.reveal_marketplace_contact(UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reveal_marketplace_contact(UUID)
    TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. search_marketplace_listings — public discovery/search. Called from a
--    rate-limited public route via service_role, never directly by a client.
--    The visibility filter (approved + active + not-sold + seller not
--    suspended) is hardcoded and NEVER derived from any parameter.
--
--    RETURN SHAPE IS PII-FREE BY CONSTRUCTION: the RETURNS TABLE column list
--    below deliberately EXCLUDES contact_phone, contact_whatsapp (verified
--    seller PII) and rejection_reason (internal moderation note). A
--    SECURITY DEFINER function runs as the definer/table owner and therefore
--    BYPASSES the Task-2 column-level REVOKE, so a `SELECT l.*` / `SETOF
--    marketplace_listings` return here would bulk-leak every seller's phone/
--    WhatsApp on a public search endpoint regardless of what the route does.
--    Excluding the columns from the return type itself makes the leak
--    structurally impossible. Contact is revealed only per-listing, auth-
--    gated, via reveal_marketplace_contact (#4 above).
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.search_marketplace_listings(
    p_query          TEXT DEFAULT NULL,
    p_category_slug  TEXT DEFAULT NULL,
    p_region         TEXT DEFAULT NULL,
    p_min_pesewas    INT  DEFAULT NULL,
    p_max_pesewas    INT  DEFAULT NULL,
    p_limit          INT  DEFAULT 20,
    p_offset         INT  DEFAULT 0
)
RETURNS TABLE(
    id                UUID,
    seller_id         UUID,
    category_id       UUID,
    title             TEXT,
    slug              TEXT,
    description       TEXT,
    price_pesewas     INT,
    condition         TEXT,
    region            TEXT,
    moderation_status TEXT,
    is_active         BOOLEAN,
    is_sold           BOOLEAN,
    bumped_at         TIMESTAMPTZ,
    promotion_tier    SMALLINT,
    promoted_until    TIMESTAMPTZ,
    created_at        TIMESTAMPTZ,
    updated_at        TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    RETURN QUERY
    SELECT l.id, l.seller_id, l.category_id, l.title, l.slug, l.description,
           l.price_pesewas, l.condition, l.region, l.moderation_status,
           l.is_active, l.is_sold, l.bumped_at, l.promotion_tier, l.promoted_until,
           l.created_at, l.updated_at
      FROM public.marketplace_listings l
     WHERE l.moderation_status = 'approved'
       AND l.is_active
       AND NOT l.is_sold
       AND NOT public.is_marketplace_seller_suspended(l.seller_id)
       AND (
            p_query IS NULL OR p_query = ''
            OR l.search_tsv @@ plainto_tsquery('english', extensions.unaccent(p_query))
            OR l.title ILIKE '%' || p_query || '%'
       )
       AND (
            p_category_slug IS NULL
            OR l.category_id IN (
                SELECT c.id FROM public.marketplace_categories c WHERE c.slug = p_category_slug
            )
       )
       AND (p_region IS NULL OR p_region = 'All Ghana' OR l.region = p_region)
       AND (p_min_pesewas IS NULL OR l.price_pesewas >= p_min_pesewas)
       AND (p_max_pesewas IS NULL OR l.price_pesewas <= p_max_pesewas)
     ORDER BY
       ts_rank_cd(l.search_tsv, plainto_tsquery('english', extensions.unaccent(coalesce(p_query, '')))) * 4
         + extract(epoch FROM l.bumped_at) / 1e9
         + (CASE WHEN l.promotion_tier > 0 AND l.promoted_until > now() THEN 1.5 ELSE 0 END) DESC,
       l.bumped_at DESC,
       l.id DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$$;

REVOKE ALL ON FUNCTION public.search_marketplace_listings(
    TEXT, TEXT, TEXT, INT, INT, INT, INT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_marketplace_listings(
    TEXT, TEXT, TEXT, INT, INT, INT, INT
) TO service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 6. marketplace_admin_stats — admin dashboard counters. service_role only;
--    reads across ALL moderation statuses so it must never be reachable by
--    a client role (would leak pending/rejected volumes).
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.marketplace_admin_stats()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'total_listings',    (SELECT count(*) FROM public.marketplace_listings),
        'pending_listings',  (SELECT count(*) FROM public.marketplace_listings WHERE moderation_status = 'pending'),
        'approved_listings', (SELECT count(*) FROM public.marketplace_listings WHERE moderation_status = 'approved'),
        'rejected_listings', (SELECT count(*) FROM public.marketplace_listings WHERE moderation_status = 'rejected'),
        'active_sellers',    (SELECT count(DISTINCT seller_id) FROM public.marketplace_listings WHERE moderation_status = 'approved'),
        'open_reports',      (SELECT count(DISTINCT listing_id) FROM public.marketplace_reports),
        'listings_last_7d',  (SELECT count(*) FROM public.marketplace_listings WHERE created_at >= now() - interval '7 days')
    ) INTO v_result;

    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.marketplace_admin_stats()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.marketplace_admin_stats()
    TO service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. suspend_marketplace_seller — admin suspend/unsuspend. Flips
--    marketplace_seller_profiles.is_suspended, which drops (or restores) ALL
--    of that seller's listings from the public SELECT policy via the
--    is_marketplace_seller_suspended() helper (Task 2). Audited.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.suspend_marketplace_seller(
    p_user_id  UUID,
    p_admin_id UUID,
    p_suspend  BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_id UUID;
BEGIN
    UPDATE public.marketplace_seller_profiles
       SET is_suspended = p_suspend,
           updated_at   = now()
     WHERE user_id = p_user_id
    RETURNING user_id INTO v_id;

    IF v_id IS NULL THEN
        RAISE EXCEPTION 'SELLER_PROFILE_NOT_FOUND';
    END IF;

    INSERT INTO public.marketplace_moderation_actions (listing_id, admin_id, action, reason)
    SELECT l.id, p_admin_id,
           CASE WHEN p_suspend THEN 'suspend_seller' ELSE 'unsuspend_seller' END,
           NULL
      FROM public.marketplace_listings l
     WHERE l.seller_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.suspend_marketplace_seller(UUID, UUID, BOOLEAN)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.suspend_marketplace_seller(UUID, UUID, BOOLEAN)
    TO service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 8. set_marketplace_seller_verified — the ONLY write path for
--    marketplace_seller_profiles.verified_phone / phone_verified_at. Called
--    ONLY from app/api/market/seller/verify-phone/route.ts, an AUTHENTICATED
--    route, after that route completes a real server-side OTP send+verify
--    cycle (same OTP mechanics as /api/auth/verify-phone: hashed code in
--    phone_otp_verifications, rate-limited, atomic used-flag CAS). This is
--    the unbypassable replacement for the old users.phone_verified gate,
--    which any client could set to true directly via a self-update RLS
--    policy with no OTP required. service_role-only EXECUTE — a client
--    session can never call this RPC, and the underlying table's
--    INSERT/UPDATE grants are REVOKEd from anon/authenticated (Task 2), so
--    there is no path to this signal other than through the OTP route.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_marketplace_seller_verified(
    p_user_id        UUID,
    p_verified_phone TEXT,
    p_display_name   TEXT,
    p_region         TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
    INSERT INTO public.marketplace_seller_profiles (
        user_id, display_name, region, verified_phone, phone_verified_at
    ) VALUES (
        p_user_id, COALESCE(NULLIF(p_display_name, ''), 'Seller'), p_region, p_verified_phone, now()
    )
    ON CONFLICT (user_id) DO UPDATE SET
        verified_phone    = EXCLUDED.verified_phone,
        phone_verified_at = now(),
        display_name      = COALESCE(NULLIF(EXCLUDED.display_name, ''), marketplace_seller_profiles.display_name),
        region             = EXCLUDED.region,
        updated_at         = now();
END;
$$;

REVOKE ALL ON FUNCTION public.set_marketplace_seller_verified(UUID, TEXT, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_marketplace_seller_verified(UUID, TEXT, TEXT, TEXT)
    TO service_role;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- SHOP MULTI-SENDER IDs (Feature Wave 6, Task 2)
-- Additive only — does not touch any existing table/column/RPC.
--
-- Shops currently hold at most ONE sender-ID request at a time, tracked as
-- four columns directly on shop_profiles (sms_sender_id/sms_sender_status/
-- sms_sender_requested_at/sms_sender_reviewed_at — added in 20260708_sms_v2.sql).
-- This migration lets a shop hold up to 5 concurrent sender-ID requests
-- (mirrors the KFT SMS multi-sender lifecycle in sms_sender_ids /
-- 20260706c_sms_sender_kyc.sql, capped lower and without the Hubtel-submission
-- intermediate status or KYC-doc gate — shop senders stay the simpler
-- under_review -> approved|rejected|revoked flow shop owners already know).
--
-- CRITICAL INVARIANT: shop_profiles.sms_sender_id/sms_sender_status/
-- sms_sender_reviewed_at become a MIRROR of whichever shop_sender_ids row is
-- the shop's current default APPROVED sender (at most one, enforced by the
-- partial unique index below). lib/sms-confirmation-sender.ts
-- (resolveShopConfirmationSender / resolveShopSenderFromRow) and every F3
-- order-confirmation enforcement call site keep reading ONLY those mirror
-- columns — nothing in that file changes. The application-layer routes
-- (app/api/shop/sms/sender-request/route.ts POST/PATCH,
-- app/api/admin/shop-sms/route.ts review_shop_sender) are responsible for
-- keeping the mirror in sync every time the default sender changes.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.shop_sender_ids (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id       UUID NOT NULL REFERENCES public.shop_profiles(id) ON DELETE CASCADE,
    sender_text   TEXT NOT NULL CHECK (
                      length(trim(sender_text)) BETWEEN 3 AND 11
                      AND sender_text ~ '^[A-Za-z0-9 ]+$'
                  ),
    status        TEXT NOT NULL DEFAULT 'under_review'
                  CHECK (status IN ('under_review', 'approved', 'rejected', 'revoked')),
    is_default    BOOLEAN NOT NULL DEFAULT false,
    requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at   TIMESTAMPTZ,
    reason        TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shop_sender_ids_shop ON public.shop_sender_ids(shop_id);

-- Admin review queue (pending requests, oldest first).
CREATE INDEX IF NOT EXISTS idx_shop_sender_ids_review
    ON public.shop_sender_ids(requested_at) WHERE status = 'under_review';

-- At most one default sender per shop. This is the row mirrored onto
-- shop_profiles — the app layer must always clear the old default before (or
-- atomically with) setting a new one, but this index is the hard backstop.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_sender_ids_one_default
    ON public.shop_sender_ids(shop_id) WHERE is_default = true;

-- ────────────────────────────────────────────────────────────────────────────
-- RLS — owner SELECT-only (mirrors the shop_sms_wallets / shop_sms_logs
-- pattern in 20260612_shop_phase_c.sql). ALL writes go through the
-- authenticated shop route (owner's own requests/default-switch) or the
-- admin route (review) — both use the service-role client, never a client
-- INSERT/UPDATE/DELETE policy.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.shop_sender_ids ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shop_sender_ids_owner_select" ON public.shop_sender_ids;
CREATE POLICY "shop_sender_ids_owner_select" ON public.shop_sender_ids
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.shop_profiles sp
            WHERE sp.id = shop_sender_ids.shop_id
              AND sp.owner_id = (SELECT auth.uid())
        )
    );

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.shop_sender_ids FROM anon, authenticated;

COMMENT ON TABLE public.shop_sender_ids IS
    'Shop SMS sender-ID requests (Feature Wave 6 Task 2) — up to 5 live per shop. Exactly one APPROVED row per shop may be is_default=true (partial unique index); that row is mirrored into shop_profiles.sms_sender_id/sms_sender_status/sms_sender_reviewed_at so resolveShopConfirmationSender (lib/sms-confirmation-sender.ts) and all F3 order-confirmation enforcement need zero changes. Writes are service-role only via app/api/shop/sms/sender-request/route.ts (owner) and app/api/admin/shop-sms/route.ts review_shop_sender (admin).';

-- ============================================================================
-- Migration: Landing Settings + admin_settings RLS hardening checks
-- Date: 2026-04-23
-- Purpose:
--   1) Seed landing-page configurable settings (data packages, customer count,
--      agent pricing, testimonials).
--   2) Ensure admin_settings keeps strict RLS posture (admin/sub-admin read,
--      admin write only).
-- ============================================================================

BEGIN;

-- Ensure RLS remains enabled.
ALTER TABLE public.admin_settings ENABLE ROW LEVEL SECURITY;

-- Ensure admin read policy exists (admin + sub-admin).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'admin_settings'
      AND policyname = 'Admin read access to admin settings'
  ) THEN
    CREATE POLICY "Admin read access to admin settings"
    ON public.admin_settings
    FOR SELECT
    TO authenticated
    USING (
      EXISTS (
        SELECT 1
        FROM public.users
        WHERE users.id = auth.uid()
          AND users.role IN ('admin', 'sub-admin')
      )
    );
  END IF;
END
$$;

-- Ensure admin modify policy exists (admin only).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'admin_settings'
      AND policyname = 'Admin modify access to admin settings'
  ) THEN
    CREATE POLICY "Admin modify access to admin settings"
    ON public.admin_settings
    FOR ALL
    TO authenticated
    USING (
      EXISTS (
        SELECT 1
        FROM public.users
        WHERE users.id = auth.uid()
          AND users.role = 'admin'
      )
    )
    WITH CHECK (
      EXISTS (
        SELECT 1
        FROM public.users
        WHERE users.id = auth.uid()
          AND users.role = 'admin'
      )
    );
  END IF;
END
$$;

-- Seed / update landing settings.
INSERT INTO public.admin_settings (key, value)
VALUES
  (
    'landing_data_packages',
    '[
      {"network":"MTN","volume":"1GB","price":"4.30"},
      {"network":"MTN","volume":"2GB","price":"9.00"},
      {"network":"Telecel","volume":"1GB","price":"4.50"},
      {"network":"AT-iShare","volume":"1GB","price":"4.50"}
    ]'::jsonb
  ),
  ('landing_customer_count', '"5,000+"'::jsonb),
  (
    'landing_agent_pricing',
    '[
      {"key":"3d","title":"Starter","duration":"3 Days Access","price":"9.99","badge":"Quick Start"},
      {"key":"14d","title":"Most Popular","duration":"14 Days Access","price":"49.99","badge":"Best Value"},
      {"key":"30d","title":"Premium","duration":"30 Days Access","price":"99.99","badge":"Business Ready"},
      {"key":"permanent","title":"Lifetime","duration":"Permanent Access","price":"149.99","badge":"One Time"}
    ]'::jsonb
  ),
  (
    'landing_testimonials',
    '[
      {"name":"Efua A.","role":"Retail Buyer - Accra","rating":5,"quote":"Very easy to use. I buy MTN data in seconds and always get delivery fast."},
      {"name":"Kojo M.","role":"Reseller - Kumasi","rating":5,"quote":"Setting up my shop was simple. The branded shop link helped me grow repeat customers."},
      {"name":"Nana Y.","role":"Student - Cape Coast","rating":4,"quote":"Wallet payments are smooth, and support replies quickly when I need help."},
      {"name":"Abena K.","role":"Agent Member","rating":5,"quote":"Agent plans are clear, and I like that I can manage everything from one dashboard."}
    ]'::jsonb
  )
ON CONFLICT (key)
DO UPDATE SET
  value = EXCLUDED.value,
  updated_at = NOW();

COMMIT;


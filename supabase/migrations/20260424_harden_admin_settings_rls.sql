-- ============================================================================
-- Migration: Harden admin_settings RLS policies
-- Date: 2026-04-24
-- Priority 5 security fix:
--   1) Drop the over-broad FOR ALL policy that unintentionally allowed DELETE.
--   2) Replace with explicit FOR INSERT + FOR UPDATE policies (no DELETE allowed).
--   3) Eliminate policy overlap: the old SELECT policy for admin+sub-admin was
--      being OR'd with the FOR ALL policy's SELECT clause, making the access model
--      hard to reason about.
--   4) Enforce a permanent DELETE prohibition at the RLS level.
-- ============================================================================

BEGIN;

-- Step 1: Drop the over-broad FOR ALL policy
-- Cannot use IF EXISTS on older Postgres — use a safe DO block.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'admin_settings'
      AND policyname = 'Admin modify access to admin settings'
  ) THEN
    DROP POLICY "Admin modify access to admin settings" ON public.admin_settings;
  END IF;
END
$$;

-- Step 2: Drop the existing read policy so we can recreate a clean version.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'admin_settings'
      AND policyname = 'Admin read access to admin settings'
  ) THEN
    DROP POLICY "Admin read access to admin settings" ON public.admin_settings;
  END IF;
END
$$;

-- Step 3: Ensure RLS stays enabled.
ALTER TABLE public.admin_settings ENABLE ROW LEVEL SECURITY;

-- Step 4: Re-create SELECT policy — admin + sub-admin may read.
CREATE POLICY "admin_settings_select"
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

-- Step 5: INSERT policy — admin only.
CREATE POLICY "admin_settings_insert"
ON public.admin_settings
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.users
    WHERE users.id = auth.uid()
      AND users.role = 'admin'
  )
);

-- Step 6: UPDATE policy — admin only.
CREATE POLICY "admin_settings_update"
ON public.admin_settings
FOR UPDATE
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

-- Step 7: DELETE is intentionally NOT granted to any role via RLS.
-- Attempting to DELETE rows in admin_settings will be silently blocked by RLS
-- for all authenticated users including admins. If a row must be removed, it
-- must be done via the Supabase dashboard by a super-user with RLS bypassed.

COMMIT;

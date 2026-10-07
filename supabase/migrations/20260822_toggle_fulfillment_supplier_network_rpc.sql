-- ============================================================================
-- MIGRATION: toggle_fulfillment_supplier_network RPC
-- Date:      2026-08-22
--
-- Problem: the "Connect/Disconnect" supplier-network toggle is about to be exposed
-- on a SECOND page (app/admin/ishare), in addition to app/admin/fulfillment. The
-- existing client-side toggle reads the whole `admin_settings.fulfillment_settings`
-- JSON blob into React state, mutates its local copy, and writes the WHOLE blob
-- back. Two pages (or two open tabs of the same page) each holding their own
-- snapshot is a lost-update race: toggle on page A, toggle on page B, and B's
-- write — built from ITS stale snapshot — silently clobbers A's change. For a
-- setting that decides which wholesaler a customer's paid order is routed to,
-- that is a real money-routing risk, not a cosmetic one.
--
-- Fix: move the read-modify-write server-side into one Postgres function that
-- locks the settings row before reading, so concurrent callers serialize instead
-- of racing. Any number of pages can now safely expose this control.
--
-- Storage format note (verified live 2026-08-22): admin_settings.value is a jsonb
-- column, but the app has always written this specific key DOUBLE-ENCODED — a
-- jsonb SCALAR STRING holding JSON text, not a jsonb object — because the client
-- does JSON.stringify(...) before upserting into a jsonb column. Confirmed via
-- `SELECT jsonb_typeof(value) FROM admin_settings WHERE key='fulfillment_settings'`
-- returning 'string'. This function unwraps that shape on read and re-produces it
-- on write, so every other existing reader/writer of this key (saveSettings's
-- fallback-key writes, fetchSettings's tolerant parse) keeps working unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.toggle_fulfillment_supplier_network(
  p_supplier_key text,
  p_network text,
  p_enable boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_raw jsonb;
  v_current jsonb;
  v_new jsonb;
  v_key text;
  v_allowed CONSTANT text[] := ARRAY[
    'networks', 'codecraft_networks', 'xpress_networks', 'ghdata_networks',
    'agentportal_networks', 'bundleportal_networks', 'hendylinks_networks',
    'atishare_console_networks'
  ];
BEGIN
  IF NOT (p_supplier_key = ANY(v_allowed)) THEN
    RAISE EXCEPTION 'invalid_supplier_key: %', p_supplier_key;
  END IF;
  IF p_network IS NULL OR length(trim(p_network)) = 0 THEN
    RAISE EXCEPTION 'invalid_network';
  END IF;

  -- Row lock BEFORE the read: this is what makes two concurrent callers safe.
  -- The second call blocks here until the first call's transaction commits, then
  -- reads the FIRST call's already-applied result rather than a stale snapshot —
  -- same "lock before check" discipline as this codebase's wallet RPCs.
  PERFORM 1 FROM public.admin_settings WHERE key = 'fulfillment_settings' FOR UPDATE;

  SELECT value INTO v_raw FROM public.admin_settings WHERE key = 'fulfillment_settings';

  IF v_raw IS NULL THEN
    v_current := '{}'::jsonb;
  ELSIF jsonb_typeof(v_raw) = 'string' THEN
    v_current := COALESCE(NULLIF(v_raw #>> '{}', ''), '{}')::jsonb;
  ELSE
    v_current := v_raw;
  END IF;

  v_new := v_current;
  FOREACH v_key IN ARRAY v_allowed LOOP
    IF v_key = p_supplier_key THEN
      -- The supplier being toggled: set exactly the requested value for this network.
      v_new := jsonb_set(
        v_new, ARRAY[v_key],
        COALESCE(v_new -> v_key, '{}'::jsonb) || jsonb_build_object(p_network, p_enable),
        true
      );
    ELSIF p_enable THEN
      -- Enabling a supplier for a network disables every OTHER supplier for that
      -- SAME network only — their other networks are left untouched. Disabling
      -- never touches any other supplier's map at all (matches the existing
      -- client-side toggleNetwork semantics exactly).
      v_new := jsonb_set(
        v_new, ARRAY[v_key],
        COALESCE(v_new -> v_key, '{}'::jsonb) || jsonb_build_object(p_network, false),
        true
      );
    END IF;
  END LOOP;

  INSERT INTO public.admin_settings (key, value)
  VALUES ('fulfillment_settings', to_jsonb(v_new::text))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  -- Returns the REAL (single-encoded) object, not the double-encoded storage
  -- form — the API route hands this straight back to the client as JSON.
  RETURN v_new;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.toggle_fulfillment_supplier_network(text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.toggle_fulfillment_supplier_network(text, text, boolean) TO service_role;

NOTIFY pgrst, 'reload schema';

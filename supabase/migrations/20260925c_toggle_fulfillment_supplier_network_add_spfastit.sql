-- ============================================================================
-- MIGRATION: toggle_fulfillment_supplier_network — allow spfastit_networks
-- Date:      2026-09-25
--
-- 20260822_toggle_fulfillment_supplier_network_rpc.sql hardcoded its v_allowed array of
-- supplier settings keys. Adding 'spfastit' to lib/order-supplier.ts's
-- SUPPLIER_NETWORK_SETTING_KEYS (Task 1) does NOT teach this RPC about it — without this
-- migration, the admin "Connect" toggle for SPFastIT would fail with
-- invalid_supplier_key: spfastit_networks. Function body otherwise byte-identical to
-- 20260822_toggle_fulfillment_supplier_network_rpc.sql.
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
    'atishare_console_networks', 'spfastit_networks'
  ];
BEGIN
  IF NOT (p_supplier_key = ANY(v_allowed)) THEN
    RAISE EXCEPTION 'invalid_supplier_key: %', p_supplier_key;
  END IF;
  IF p_network IS NULL OR length(trim(p_network)) = 0 THEN
    RAISE EXCEPTION 'invalid_network';
  END IF;

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
      v_new := jsonb_set(
        v_new, ARRAY[v_key],
        COALESCE(v_new -> v_key, '{}'::jsonb) || jsonb_build_object(p_network, p_enable),
        true
      );
    ELSIF p_enable THEN
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

  RETURN v_new;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.toggle_fulfillment_supplier_network(text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.toggle_fulfillment_supplier_network(text, text, boolean) TO service_role;

NOTIFY pgrst, 'reload schema';

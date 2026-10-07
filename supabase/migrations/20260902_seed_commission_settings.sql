-- ============================================================================
-- 20260902_seed_commission_settings.sql
-- Seeds the four commission-wallet admin_settings keys that
-- app/api/admin/utilities/settings/route.ts already accepts/validates but
-- that never existed as rows — without a seed, lib/commission-wallet.ts's
-- TypeScript fallbacks (2% fee, 0 flat, GHS 20 min, transfers enabled) apply
-- silently with no admin-visible control until the first save.
--
-- admin_settings.value is jsonb; matches the storage format of existing keys
-- (e.g. utility_min_amount) — a JSON string, not a raw scalar.
-- ============================================================================

INSERT INTO public.admin_settings (key, value) VALUES
  ('commission_withdrawal_fee_percent', to_jsonb('2'::text)),
  ('commission_withdrawal_fee_flat', to_jsonb('0'::text)),
  ('commission_min_withdrawal_amount', to_jsonb('20'::text)),
  ('commission_transfer_enabled', to_jsonb('true'::text))
ON CONFLICT (key) DO NOTHING;

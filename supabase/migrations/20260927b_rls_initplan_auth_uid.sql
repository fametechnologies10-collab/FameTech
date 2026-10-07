-- PERF: Supabase advisor auth_rls_initplan (26 policies). A bare auth.uid() in a policy
-- is re-evaluated for EVERY row scanned; wrapped as (select auth.uid()) Postgres runs it
-- once per statement as an initPlan. Semantics are identical — only the wrapper changes.
-- Generated from the live pg_policies text (2026-09-27) with
--   regexp_replace(expr, '(?<!SELECT )auth\.uid\(\)', '(select auth.uid())', 'g')
-- and verified after apply: stripping the wrapper back out reproduces the original
-- expressions exactly (md5 fingerprint d358a0e1b9fc9cd60b170e564d691f02 before and after).
-- ALTER POLICY without TO/AS keeps each policy's roles, command and permissiveness.
-- Rollback: re-run the same statements with (select auth.uid()) replaced by auth.uid().

ALTER POLICY admin_settings_audit_select ON public.admin_settings_audit
  USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = (select auth.uid())) AND (users.role = 'admin'::text)))));

ALTER POLICY "Admins manage airtime batches" ON public.airtime_fulfillment_batches
  USING ((EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = (select auth.uid())) AND (u.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));

ALTER POLICY "admins read manual sends" ON public.atishare_console_manual_sends
  USING ((EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = (select auth.uid())) AND (u.role = 'admin'::text)))));

ALTER POLICY commission_wallet_tx_admin_select ON public.commission_wallet_transactions
  USING ((EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = (select auth.uid())) AND (u.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));

ALTER POLICY commission_wallet_tx_owner_select ON public.commission_wallet_transactions
  USING ((EXISTS ( SELECT 1
   FROM commission_wallets w
  WHERE ((w.id = commission_wallet_transactions.commission_wallet_id) AND (w.owner_id = (select auth.uid()))))));

ALTER POLICY commission_wallets_admin_select ON public.commission_wallets
  USING ((EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = (select auth.uid())) AND (u.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));

ALTER POLICY commission_wallets_owner_select ON public.commission_wallets
  USING (((select auth.uid()) = owner_id));

ALTER POLICY mtn_whitelist_status_admin_only ON public.mtn_whitelist_status
  USING ((EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = (select auth.uid())) AND (u.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = (select auth.uid())) AND (u.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));

ALTER POLICY "Users can delete own notifications" ON public.notifications
  USING (((select auth.uid()) = user_id));

ALTER POLICY "Users can update own notifications" ON public.notifications
  USING (((select auth.uid()) = user_id))
  WITH CHECK (((select auth.uid()) = user_id));

ALTER POLICY "Users can view own notifications" ON public.notifications
  USING (((select auth.uid()) = user_id));

ALTER POLICY nr_batches_admin_only ON public.number_registration_batches
  USING ((EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = (select auth.uid())) AND (u.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = (select auth.uid())) AND (u.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));

ALTER POLICY nr_registrations_admin_only ON public.number_registrations
  USING ((EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = (select auth.uid())) AND (u.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = (select auth.uid())) AND (u.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));

ALTER POLICY "Users delete own passkeys" ON public.passkey_credentials
  USING (((select auth.uid()) = user_id));

ALTER POLICY "Users read own passkeys" ON public.passkey_credentials
  USING (((select auth.uid()) = user_id));

ALTER POLICY shop_invites_lead_all ON public.shop_invites
  USING ((shop_id IN ( SELECT shop_profiles.id
   FROM shop_profiles
  WHERE (shop_profiles.owner_id = (select auth.uid())))));

ALTER POLICY shop_order_splits_beneficiary_read ON public.shop_order_splits
  USING ((beneficiary_shop_id IN ( SELECT shop_profiles.id
   FROM shop_profiles
  WHERE (shop_profiles.owner_id = (select auth.uid())))));

ALTER POLICY shop_orders_parent_read ON public.shop_orders
  USING ((parent_shop_id IN ( SELECT shop_profiles.id
   FROM shop_profiles
  WHERE (shop_profiles.owner_id = (select auth.uid())))));

ALTER POLICY shop_wallet_tx_lead_read ON public.shop_wallet_transactions
  USING ((shop_wallet_id IN ( SELECT sw.id
   FROM (shop_wallets sw
     JOIN sub_agents sa ON ((sa.user_id = sw.owner_id)))
  WHERE (sa.upline_shop_id IN ( SELECT shop_profiles.id
           FROM shop_profiles
          WHERE (shop_profiles.owner_id = (select auth.uid())))))));

ALTER POLICY sub_agent_default_pricing_recruiter_read ON public.sub_agent_default_pricing
  USING ((recruiter_id = (select auth.uid())));

ALTER POLICY sub_agent_order_earnings_party_read ON public.sub_agent_order_earnings
  USING (((recruiter_id = (select auth.uid())) OR (sub_user_id = (select auth.uid()))));

ALTER POLICY sub_agent_pricing_party_read ON public.sub_agent_pricing
  USING (((recruiter_id = (select auth.uid())) OR (sub_user_id = (select auth.uid()))));

ALTER POLICY sub_agents_lead_read ON public.sub_agents
  USING ((upline_shop_id IN ( SELECT shop_profiles.id
   FROM shop_profiles
  WHERE (shop_profiles.owner_id = (select auth.uid())))));

ALTER POLICY sub_agents_self_read ON public.sub_agents
  USING ((user_id = (select auth.uid())));

ALTER POLICY "insert own acceptance" ON public.terms_acceptances
  WITH CHECK (((select auth.uid()) = user_id));

ALTER POLICY "read own acceptance" ON public.terms_acceptances
  USING (((select auth.uid()) = user_id));

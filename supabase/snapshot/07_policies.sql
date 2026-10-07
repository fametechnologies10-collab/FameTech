-- Fametech schema snapshot: RLS policies (public + storage.objects)
-- Source: read-only introspection of the KiNG FLEXY GH production DB (schema only, NO data).
-- Apply files in numeric order to a FRESH Supabase project.

CREATE POLICY admin_custom_list_users_admin_only ON public.admin_custom_list_users AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY admin_custom_lists_admin_only ON public.admin_custom_lists AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY "Admins can view profit logs" ON public.admin_profit_logs AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY admin_settings_insert ON public.admin_settings AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = 'admin'::text)))));
CREATE POLICY admin_settings_select ON public.admin_settings AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY admin_settings_update ON public.admin_settings AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = 'admin'::text)))));
CREATE POLICY admin_settings_audit_select ON public.admin_settings_audit AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = 'admin'::text)))));
CREATE POLICY afa_orders_select_combined ON public.afa_orders AS PERMISSIVE FOR SELECT TO public USING (((user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM shop_profiles
  WHERE ((shop_profiles.owner_id = ( SELECT auth.uid() AS uid)) AND (shop_profiles.id = afa_orders.shop_id)))) OR (EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text])))))));
CREATE POLICY "Admins manage airtime batches" ON public.airtime_fulfillment_batches AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = ( SELECT auth.uid() AS uid)) AND (u.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY airtime_orders_select_combined ON public.airtime_orders AS PERMISSIVE FOR SELECT TO public USING (((user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))) OR ((shop_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM shop_profiles sp
  WHERE ((sp.id = airtime_orders.shop_id) AND (sp.owner_id = ( SELECT auth.uid() AS uid))))))));
CREATE POLICY "api_keys: admin full access" ON public.api_keys AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = 'admin'::text)))));
CREATE POLICY "api_keys: select own or admin" ON public.api_keys AS PERMISSIVE FOR SELECT TO public USING (((user_id = ( SELECT auth.uid() AS uid)) OR is_admin()));
CREATE POLICY "api_keys: user select own" ON public.api_keys AS PERMISSIVE FOR SELECT TO public USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "api_logs: admin read all" ON public.api_logs AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = 'admin'::text)))));
CREATE POLICY "api_logs: select own or admin" ON public.api_logs AS PERMISSIVE FOR SELECT TO public USING (((user_id = ( SELECT auth.uid() AS uid)) OR is_admin()));
CREATE POLICY "api_logs: user read own" ON public.api_logs AS PERMISSIVE FOR SELECT TO public USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY archived_financials_admin_read ON public.archived_shop_financial_records AS PERMISSIVE FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "admins read manual sends" ON public.atishare_console_manual_sends AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = ( SELECT auth.uid() AS uid)) AND (u.role = 'admin'::text)))));
CREATE POLICY commission_wallet_tx_admin_select ON public.commission_wallet_transactions AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = ( SELECT auth.uid() AS uid)) AND (u.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY commission_wallet_tx_owner_select ON public.commission_wallet_transactions AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM commission_wallets w
  WHERE ((w.id = commission_wallet_transactions.commission_wallet_id) AND (w.owner_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY commission_wallets_admin_select ON public.commission_wallets AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = ( SELECT auth.uid() AS uid)) AND (u.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY commission_wallets_owner_select ON public.commission_wallets AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = owner_id));
CREATE POLICY "Users can create complaints" ON public.complaints AS PERMISSIVE FOR INSERT TO public WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can view own complaints" ON public.complaints AS PERMISSIVE FOR SELECT TO public USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can view own customer purchases" ON public.customer_purchases AS PERMISSIVE FOR SELECT TO public USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Admins can delete packages" ON public.data_packages AS PERMISSIVE FOR DELETE TO public USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY "Admins can insert packages" ON public.data_packages AS PERMISSIVE FOR INSERT TO public WITH CHECK ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY "Admins can update packages" ON public.data_packages AS PERMISSIVE FOR UPDATE TO public USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY "Anyone can view packages" ON public.data_packages AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "Admins can do everything with batches" ON public.download_batches AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY "Admin full access to fulfillment logs" ON public.fulfillment_logs AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY "Service role full access" ON public.guest_push_subscriptions AS PERMISSIVE FOR ALL TO service_role USING (true);
CREATE POLICY momo_claim_attempts_admin_write ON public.momo_claim_attempts AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY momo_transactions_admin_delete ON public.momo_transactions AS PERMISSIVE FOR DELETE TO public USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY momo_transactions_admin_insert ON public.momo_transactions AS PERMISSIVE FOR INSERT TO public WITH CHECK ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY momo_transactions_admin_update ON public.momo_transactions AS PERMISSIVE FOR UPDATE TO public USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY momo_transactions_select_combined ON public.momo_transactions AS PERMISSIVE FOR SELECT TO public USING (((claimed_by = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text])))))));
CREATE POLICY "Admin full access to mtn fulfillment tracking" ON public.mtn_fulfillment_tracking AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY mtn_whitelist_server_status_admin_read ON public.mtn_whitelist_server_status AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = ( SELECT auth.uid() AS uid)) AND (u.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY mtn_whitelist_status_admin_only ON public.mtn_whitelist_status AS PERMISSIVE FOR ALL TO authenticated USING ((EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = ( SELECT auth.uid() AS uid)) AND (u.role = ANY (ARRAY['admin'::text, 'sub-admin'::text])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = ( SELECT auth.uid() AS uid)) AND (u.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY "Users can delete own notifications" ON public.notifications AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own notifications" ON public.notifications AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own notifications" ON public.notifications AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY nr_batches_admin_only ON public.number_registration_batches AS PERMISSIVE FOR ALL TO authenticated USING ((EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = ( SELECT auth.uid() AS uid)) AND (u.role = ANY (ARRAY['admin'::text, 'sub-admin'::text])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = ( SELECT auth.uid() AS uid)) AND (u.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY nr_registrations_admin_only ON public.number_registrations AS PERMISSIVE FOR ALL TO authenticated USING ((EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = ( SELECT auth.uid() AS uid)) AND (u.role = ANY (ARRAY['admin'::text, 'sub-admin'::text])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = ( SELECT auth.uid() AS uid)) AND (u.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY "Shop Banners Auth Delete" ON storage.objects AS PERMISSIVE FOR DELETE TO authenticated USING (((bucket_id = 'shop-banners'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));
CREATE POLICY shop_logos_delete_user_folder ON storage.objects AS PERMISSIVE FOR DELETE TO authenticated USING (((bucket_id = 'shop-logos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));
CREATE POLICY shop_logos_insert_user_folder ON storage.objects AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'shop-logos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));
CREATE POLICY shop_logos_update_user_folder ON storage.objects AS PERMISSIVE FOR UPDATE TO authenticated USING (((bucket_id = 'shop-logos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));
CREATE POLICY "Users can view own orders" ON public.orders AS PERMISSIVE FOR SELECT TO public USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "No client access to challenges" ON public.passkey_challenges AS PERMISSIVE FOR ALL TO public USING (false);
CREATE POLICY "Users delete own passkeys" ON public.passkey_credentials AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users read own passkeys" ON public.passkey_credentials AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Admin only access" ON public.pending_settlements AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY phone_blacklist_admin_only ON public.phone_blacklist AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY push_subscriptions_combined ON public.push_subscriptions AS PERMISSIVE FOR ALL TO authenticated, service_role USING (((user_id = ( SELECT auth.uid() AS uid)) OR (( SELECT auth.role() AS role) = 'service_role'::text))) WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) OR (( SELECT auth.role() AS role) = 'service_role'::text)));
CREATE POLICY rc_complaints_select_combined ON public.results_checker_complaints AS PERMISSIVE FOR SELECT TO public USING (((user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM shop_profiles
  WHERE ((shop_profiles.owner_id = ( SELECT auth.uid() AS uid)) AND (shop_profiles.id = results_checker_complaints.shop_id)))) OR (( SELECT auth.role() AS role) = 'service_role'::text)));
CREATE POLICY rc_complaints_service_delete ON public.results_checker_complaints AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY rc_complaints_service_insert ON public.results_checker_complaints AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY rc_complaints_service_update ON public.results_checker_complaints AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY rc_inventory_service_only ON public.results_checker_inventory AS PERMISSIVE FOR ALL TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY rc_orders_select_combined ON public.results_checker_orders AS PERMISSIVE FOR SELECT TO public USING (((user_id = ( SELECT auth.uid() AS uid)) OR (( SELECT auth.role() AS role) = 'service_role'::text)));
CREATE POLICY rc_orders_service_delete ON public.results_checker_orders AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY rc_orders_service_insert ON public.results_checker_orders AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY rc_orders_service_update ON public.results_checker_orders AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY rc_orders_shop_owner_select ON public.results_checker_orders AS PERMISSIVE FOR SELECT TO public USING ((shop_id IN ( SELECT shop_profiles.id
   FROM shop_profiles
  WHERE (shop_profiles.owner_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY rc_types_select_all ON public.results_checker_types AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY rc_types_write_service ON public.results_checker_types AS PERMISSIVE FOR ALL TO service_role USING (true);
CREATE POLICY shop_announcements_owner_delete ON public.shop_announcements AS PERMISSIVE FOR DELETE TO public USING ((EXISTS ( SELECT 1
   FROM shop_profiles
  WHERE ((shop_profiles.owner_id = ( SELECT auth.uid() AS uid)) AND (shop_profiles.id = shop_announcements.shop_id)))));
CREATE POLICY shop_announcements_owner_insert ON public.shop_announcements AS PERMISSIVE FOR INSERT TO public WITH CHECK ((EXISTS ( SELECT 1
   FROM shop_profiles
  WHERE ((shop_profiles.owner_id = ( SELECT auth.uid() AS uid)) AND (shop_profiles.id = shop_announcements.shop_id)))));
CREATE POLICY shop_announcements_owner_update ON public.shop_announcements AS PERMISSIVE FOR UPDATE TO public USING ((EXISTS ( SELECT 1
   FROM shop_profiles
  WHERE ((shop_profiles.owner_id = ( SELECT auth.uid() AS uid)) AND (shop_profiles.id = shop_announcements.shop_id)))));
CREATE POLICY shop_announcements_select_combined ON public.shop_announcements AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY shop_customers_owner_select ON public.shop_customers AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM shop_profiles sp
  WHERE ((sp.id = shop_customers.shop_id) AND (sp.owner_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY shop_customers_owner_update ON public.shop_customers AS PERMISSIVE FOR UPDATE TO public USING ((EXISTS ( SELECT 1
   FROM shop_profiles sp
  WHERE ((sp.id = shop_customers.shop_id) AND (sp.owner_id = ( SELECT auth.uid() AS uid)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM shop_profiles sp
  WHERE ((sp.id = shop_customers.shop_id) AND (sp.owner_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY shop_global_settings_admin_delete ON public.shop_global_settings AS PERMISSIVE FOR DELETE TO authenticated USING (is_admin());
CREATE POLICY shop_global_settings_admin_insert ON public.shop_global_settings AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY shop_global_settings_admin_update ON public.shop_global_settings AS PERMISSIVE FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY shop_global_settings_read ON public.shop_global_settings AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY shop_invites_lead_all ON public.shop_invites AS PERMISSIVE FOR ALL TO public USING ((shop_id IN ( SELECT shop_profiles.id
   FROM shop_profiles
  WHERE (shop_profiles.owner_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY shop_order_splits_beneficiary_read ON public.shop_order_splits AS PERMISSIVE FOR SELECT TO public USING ((beneficiary_shop_id IN ( SELECT shop_profiles.id
   FROM shop_profiles
  WHERE (shop_profiles.owner_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY shop_orders_parent_read ON public.shop_orders AS PERMISSIVE FOR SELECT TO public USING ((parent_shop_id IN ( SELECT shop_profiles.id
   FROM shop_profiles
  WHERE (shop_profiles.owner_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY shop_orders_select_combined ON public.shop_orders AS PERMISSIVE FOR SELECT TO public USING (((EXISTS ( SELECT 1
   FROM shop_profiles
  WHERE ((shop_profiles.owner_id = ( SELECT auth.uid() AS uid)) AND (shop_profiles.id = shop_orders.shop_id)))) OR (EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text])))))));
CREATE POLICY "Owners can delete their own payment details" ON public.shop_payment_details AS PERMISSIVE FOR DELETE TO public USING ((shop_owner_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY shop_payment_details_select_combined ON public.shop_payment_details AS PERMISSIVE FOR SELECT TO public USING (((shop_owner_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text])))))));
CREATE POLICY shop_pricing_delete_owner_or_admin ON public.shop_pricing AS PERMISSIVE FOR DELETE TO public USING (((EXISTS ( SELECT 1
   FROM shop_profiles
  WHERE ((shop_profiles.owner_id = ( SELECT auth.uid() AS uid)) AND (shop_profiles.id = shop_pricing.shop_id)))) OR is_admin()));
CREATE POLICY shop_pricing_insert_owner_or_admin ON public.shop_pricing AS PERMISSIVE FOR INSERT TO public WITH CHECK (((EXISTS ( SELECT 1
   FROM shop_profiles
  WHERE ((shop_profiles.owner_id = ( SELECT auth.uid() AS uid)) AND (shop_profiles.id = shop_pricing.shop_id)))) OR is_admin()));
CREATE POLICY shop_pricing_select_combined ON public.shop_pricing AS PERMISSIVE FOR SELECT TO public USING (((EXISTS ( SELECT 1
   FROM shop_profiles
  WHERE ((shop_profiles.owner_id = ( SELECT auth.uid() AS uid)) AND (shop_profiles.id = shop_pricing.shop_id)))) OR (EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))) OR (EXISTS ( SELECT 1
   FROM shop_profiles
  WHERE ((shop_profiles.id = shop_pricing.shop_id) AND (shop_profiles.approval_status = 'approved'::text) AND (shop_profiles.is_active = true))))));
CREATE POLICY shop_pricing_update_owner_or_admin ON public.shop_pricing AS PERMISSIVE FOR UPDATE TO public USING (((EXISTS ( SELECT 1
   FROM shop_profiles
  WHERE ((shop_profiles.owner_id = ( SELECT auth.uid() AS uid)) AND (shop_profiles.id = shop_pricing.shop_id)))) OR is_admin()));
CREATE POLICY "Admins can view shop pricing logs" ON public.shop_pricing_logs AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text]))))));
CREATE POLICY shop_pricing_pending_combined ON public.shop_pricing_pending AS PERMISSIVE FOR ALL TO public USING (((EXISTS ( SELECT 1
   FROM shop_profiles
  WHERE ((shop_profiles.owner_id = ( SELECT auth.uid() AS uid)) AND (shop_profiles.id = shop_pricing_pending.shop_id)))) OR (EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text])))))));
CREATE POLICY shop_profiles_select_combined ON public.shop_profiles AS PERMISSIVE FOR SELECT TO public USING ((((approval_status = 'approved'::text) AND (is_active = true)) OR (owner_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text])))))));
CREATE POLICY shop_profiles_update_combined ON public.shop_profiles AS PERMISSIVE FOR UPDATE TO public USING (((owner_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text])))))));
CREATE POLICY rc_markups_owner_all ON public.shop_rc_markups AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM shop_profiles sp
  WHERE ((sp.id = shop_rc_markups.shop_id) AND (sp.owner_id = ( SELECT auth.uid() AS uid)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM shop_profiles sp
  WHERE ((sp.id = shop_rc_markups.shop_id) AND (sp.owner_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY rc_markups_public_read ON public.shop_rc_markups AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY shop_sender_ids_owner_select ON public.shop_sender_ids AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM shop_profiles sp
  WHERE ((sp.id = shop_sender_ids.shop_id) AND (sp.owner_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY sms_activations_owner_select ON public.shop_sms_activations AS PERMISSIVE FOR SELECT TO public USING ((owner_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY sms_bundles_public_read ON public.shop_sms_bundles AS PERMISSIVE FOR SELECT TO public USING ((is_active = true));
CREATE POLICY shop_sms_group_members_admin ON public.shop_sms_group_members AS PERMISSIVE FOR ALL TO public USING (is_admin());
CREATE POLICY shop_sms_group_members_select ON public.shop_sms_group_members AS PERMISSIVE FOR SELECT TO public USING ((shop_id IN ( SELECT shop_profiles.id
   FROM shop_profiles
  WHERE (shop_profiles.owner_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY shop_sms_groups_admin ON public.shop_sms_groups AS PERMISSIVE FOR ALL TO public USING (is_admin());
CREATE POLICY shop_sms_groups_select ON public.shop_sms_groups AS PERMISSIVE FOR SELECT TO public USING ((shop_id IN ( SELECT shop_profiles.id
   FROM shop_profiles
  WHERE (shop_profiles.owner_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY sms_logs_owner_select ON public.shop_sms_logs AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM shop_profiles sp
  WHERE ((sp.id = shop_sms_logs.shop_id) AND (sp.owner_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY sms_purchases_owner_select ON public.shop_sms_purchases AS PERMISSIVE FOR SELECT TO public USING ((owner_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY shop_sms_templates_admin ON public.shop_sms_templates AS PERMISSIVE FOR ALL TO public USING (is_admin());
CREATE POLICY shop_sms_templates_delete ON public.shop_sms_templates AS PERMISSIVE FOR DELETE TO public USING ((shop_id IN ( SELECT shop_profiles.id
   FROM shop_profiles
  WHERE (shop_profiles.owner_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY shop_sms_templates_insert ON public.shop_sms_templates AS PERMISSIVE FOR INSERT TO public WITH CHECK ((shop_id IN ( SELECT shop_profiles.id
   FROM shop_profiles
  WHERE (shop_profiles.owner_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY shop_sms_templates_select ON public.shop_sms_templates AS PERMISSIVE FOR SELECT TO public USING ((shop_id IN ( SELECT shop_profiles.id
   FROM shop_profiles
  WHERE (shop_profiles.owner_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY shop_sms_templates_update ON public.shop_sms_templates AS PERMISSIVE FOR UPDATE TO public USING ((shop_id IN ( SELECT shop_profiles.id
   FROM shop_profiles
  WHERE (shop_profiles.owner_id = ( SELECT auth.uid() AS uid))))) WITH CHECK ((shop_id IN ( SELECT shop_profiles.id
   FROM shop_profiles
  WHERE (shop_profiles.owner_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY sms_wallets_owner_select ON public.shop_sms_wallets AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM shop_profiles sp
  WHERE ((sp.id = shop_sms_wallets.shop_id) AND (sp.owner_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY "Admins update shop transactions" ON public.shop_wallet_transactions AS PERMISSIVE FOR UPDATE TO public USING (is_admin());
CREATE POLICY shop_wallet_transactions_select_combined ON public.shop_wallet_transactions AS PERMISSIVE FOR SELECT TO public USING (((shop_wallet_id IN ( SELECT shop_wallets.id
   FROM shop_wallets
  WHERE (shop_wallets.owner_id = ( SELECT auth.uid() AS uid)))) OR (EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text])))))));
CREATE POLICY shop_wallet_tx_lead_read ON public.shop_wallet_transactions AS PERMISSIVE FOR SELECT TO public USING ((shop_wallet_id IN ( SELECT sw.id
   FROM (shop_wallets sw
     JOIN sub_agents sa ON ((sa.user_id = sw.owner_id)))
  WHERE (sa.upline_shop_id IN ( SELECT shop_profiles.id
           FROM shop_profiles
          WHERE (shop_profiles.owner_id = ( SELECT auth.uid() AS uid)))))));
CREATE POLICY shop_wallets_select_combined ON public.shop_wallets AS PERMISSIVE FOR SELECT TO public USING (((owner_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text])))))));
CREATE POLICY sms_accounts_owner_select ON public.sms_accounts AS PERMISSIVE FOR SELECT TO public USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY sms_bundles_public_read ON public.sms_bundles AS PERMISSIVE FOR SELECT TO public USING ((is_active = true));
CREATE POLICY sms_business_profiles_owner_select ON public.sms_business_profiles AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM sms_accounts a
  WHERE ((a.id = sms_business_profiles.account_id) AND (a.user_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY sms_campaigns_owner_select ON public.sms_campaigns AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM sms_accounts a
  WHERE ((a.id = sms_campaigns.account_id) AND (a.user_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY sms_contact_groups_owner_all ON public.sms_contact_groups AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM sms_accounts a
  WHERE ((a.id = sms_contact_groups.account_id) AND (a.user_id = ( SELECT auth.uid() AS uid)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM sms_accounts a
  WHERE ((a.id = sms_contact_groups.account_id) AND (a.user_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY sms_contacts_admin_all ON public.sms_contacts AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY sms_credit_ledger_owner_select ON public.sms_credit_ledger AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM sms_accounts a
  WHERE ((a.id = sms_credit_ledger.account_id) AND (a.user_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY sms_group_contacts_owner_all ON public.sms_group_contacts AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM (sms_contact_groups g
     JOIN sms_accounts a ON ((a.id = g.account_id)))
  WHERE ((g.id = sms_group_contacts.group_id) AND (a.user_id = ( SELECT auth.uid() AS uid)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM (sms_contact_groups g
     JOIN sms_accounts a ON ((a.id = g.account_id)))
  WHERE ((g.id = sms_group_contacts.group_id) AND (a.user_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY sms_groups_admin_all ON public.sms_groups AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY sms_messages_owner_select ON public.sms_messages AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM sms_accounts a
  WHERE ((a.id = sms_messages.account_id) AND (a.user_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY sms_purchases_owner_select ON public.sms_purchases AS PERMISSIVE FOR SELECT TO public USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY sms_sender_ids_owner_select ON public.sms_sender_ids AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM sms_accounts a
  WHERE ((a.id = sms_sender_ids.account_id) AND (a.user_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY sms_templates_admin_all ON public.sms_templates AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY sms_templates_authenticated_read ON public.sms_templates AS PERMISSIVE FOR SELECT TO authenticated USING (true);
CREATE POLICY sms_user_templates_owner_all ON public.sms_user_templates AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM sms_accounts a
  WHERE ((a.id = sms_user_templates.account_id) AND (a.user_id = ( SELECT auth.uid() AS uid)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM sms_accounts a
  WHERE ((a.id = sms_user_templates.account_id) AND (a.user_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY sms_wallets_owner_select ON public.sms_wallets AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM sms_accounts a
  WHERE ((a.id = sms_wallets.account_id) AND (a.user_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY sub_agent_default_pricing_recruiter_read ON public.sub_agent_default_pricing AS PERMISSIVE FOR SELECT TO public USING ((recruiter_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY sub_agent_order_earnings_party_read ON public.sub_agent_order_earnings AS PERMISSIVE FOR SELECT TO public USING (((recruiter_id = ( SELECT auth.uid() AS uid)) OR (sub_user_id = ( SELECT auth.uid() AS uid))));
CREATE POLICY sub_agent_pricing_party_read ON public.sub_agent_pricing AS PERMISSIVE FOR SELECT TO public USING (((recruiter_id = ( SELECT auth.uid() AS uid)) OR (sub_user_id = ( SELECT auth.uid() AS uid))));
CREATE POLICY sub_agents_lead_read ON public.sub_agents AS PERMISSIVE FOR SELECT TO public USING ((upline_shop_id IN ( SELECT shop_profiles.id
   FROM shop_profiles
  WHERE (shop_profiles.owner_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY sub_agents_self_read ON public.sub_agents AS PERMISSIVE FOR SELECT TO public USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY support_messages_owner_mark_read ON public.support_messages AS PERMISSIVE FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM support_threads t
  WHERE ((t.id = support_messages.thread_id) AND (t.user_id = ( SELECT auth.uid() AS uid)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM support_threads t
  WHERE ((t.id = support_messages.thread_id) AND (t.user_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY support_messages_owner_select ON public.support_messages AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM support_threads t
  WHERE ((t.id = support_messages.thread_id) AND (t.user_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY support_threads_owner_select ON public.support_threads AS PERMISSIVE FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY system_announcements_admin_delete ON public.system_announcements AS PERMISSIVE FOR DELETE TO public USING (is_admin());
CREATE POLICY system_announcements_admin_insert ON public.system_announcements AS PERMISSIVE FOR INSERT TO public WITH CHECK (is_admin());
CREATE POLICY system_announcements_admin_update ON public.system_announcements AS PERMISSIVE FOR UPDATE TO public USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY system_announcements_select_combined ON public.system_announcements AS PERMISSIVE FOR SELECT TO public USING (((is_active = true) OR (EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text])))))));
CREATE POLICY "insert own acceptance" ON public.terms_acceptances AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "read own acceptance" ON public.terms_acceptances AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "read current terms" ON public.terms_versions AS PERMISSIVE FOR SELECT TO public USING ((is_current = true));
CREATE POLICY user_payment_references_select_own_or_admin ON public.user_payment_references AS PERMISSIVE FOR SELECT TO public USING (((user_id = ( SELECT auth.uid() AS uid)) OR is_admin()));
CREATE POLICY "Users can insert their own profile" ON public.users AS PERMISSIVE FOR INSERT TO public WITH CHECK ((id = ( SELECT auth.uid() AS uid)));
CREATE POLICY users_select_combined ON public.users AS PERMISSIVE FOR SELECT TO public USING (((id = ( SELECT auth.uid() AS uid)) OR is_admin()));
CREATE POLICY users_update_combined ON public.users AS PERMISSIVE FOR UPDATE TO public USING (((id = ( SELECT auth.uid() AS uid)) OR is_admin()));
CREATE POLICY utility_orders_owner_select ON public.utility_orders AS PERMISSIVE FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY usa_owner_all ON public.utility_saved_accounts AS PERMISSIVE FOR ALL TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY wallet_payments_select_combined ON public.wallet_payments AS PERMISSIVE FOR SELECT TO public USING (((user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.role = ANY (ARRAY['admin'::text, 'sub-admin'::text])))))));
CREATE POLICY "Users can view own transactions" ON public.wallet_transactions AS PERMISSIVE FOR SELECT TO public USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can view own wallet" ON public.wallets AS PERMISSIVE FOR SELECT TO public USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY website_requests_owner_select ON public.website_requests AS PERMISSIVE FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));

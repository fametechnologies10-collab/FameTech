-- Fametech schema snapshot: triggers
-- Source: read-only introspection of the KiNG FLEXY GH production DB (schema only, NO data).
-- Apply files in numeric order to a FRESH Supabase project.

CREATE TRIGGER trg_log_admin_settings_change AFTER INSERT OR UPDATE ON public.admin_settings FOR EACH ROW EXECUTE FUNCTION log_admin_settings_change();
CREATE TRIGGER trg_block_client_insert BEFORE INSERT ON public.afa_orders FOR EACH ROW EXECUTE FUNCTION block_client_money_writes();
CREATE TRIGGER trg_sync_sub_agent_earning_afa AFTER UPDATE OF status ON public.afa_orders FOR EACH ROW WHEN ((old.status IS DISTINCT FROM new.status)) EXECUTE FUNCTION trg_sub_agent_earning_by_reference_code();
CREATE TRIGGER trg_block_client_insert BEFORE INSERT ON public.airtime_orders FOR EACH ROW EXECUTE FUNCTION block_client_money_writes();
CREATE TRIGGER trg_auto_update_shop_pricing AFTER UPDATE OF price, agent_price, dealer_price ON public.data_packages FOR EACH ROW EXECUTE FUNCTION auto_update_shop_pricing_on_platform_cost();
CREATE TRIGGER trg_guest_push_updated_at BEFORE UPDATE ON public.guest_push_subscriptions FOR EACH ROW EXECUTE FUNCTION update_guest_push_subscriptions_updated_at();
CREATE TRIGGER trg_block_client_insert BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION block_client_money_writes();
CREATE TRIGGER trg_log_main_profit AFTER UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION log_main_profit();
CREATE TRIGGER trg_sync_sub_agent_earning_orders AFTER UPDATE OF status ON public.orders FOR EACH ROW WHEN ((old.status IS DISTINCT FROM new.status)) EXECUTE FUNCTION trg_sub_agent_earning_by_reference_code();
CREATE TRIGGER push_subscriptions_updated_at_trigger BEFORE UPDATE ON public.push_subscriptions FOR EACH ROW EXECUTE FUNCTION update_push_subscriptions_updated_at();
CREATE TRIGGER trg_log_rc_profit AFTER UPDATE ON public.results_checker_orders FOR EACH ROW EXECUTE FUNCTION log_rc_profit();
CREATE TRIGGER trg_shop_customers_from_rc_orders AFTER INSERT ON public.results_checker_orders FOR EACH ROW EXECUTE FUNCTION upsert_shop_customer_from_rc_order();
CREATE TRIGGER trg_sync_sub_agent_earning_rc AFTER UPDATE OF status ON public.results_checker_orders FOR EACH ROW WHEN ((old.status IS DISTINCT FROM new.status)) EXECUTE FUNCTION trg_sub_agent_earning_by_reference_code();
CREATE TRIGGER trg_log_shop_profit AFTER UPDATE ON public.shop_orders FOR EACH ROW EXECUTE FUNCTION log_shop_profit();
CREATE TRIGGER trg_shop_customers_from_orders AFTER INSERT ON public.shop_orders FOR EACH ROW EXECUTE FUNCTION upsert_shop_customer_from_order();
CREATE TRIGGER trg_sync_sub_agent_earning_shop AFTER UPDATE OF status ON public.shop_orders FOR EACH ROW WHEN ((old.status IS DISTINCT FROM new.status)) EXECUTE FUNCTION trg_sub_agent_earning_by_paystack_reference();
CREATE TRIGGER trg_block_client_write BEFORE INSERT OR UPDATE ON public.shop_payment_details FOR EACH ROW EXECUTE FUNCTION block_client_money_writes();
CREATE TRIGGER trg_max_payment_details BEFORE INSERT ON public.shop_payment_details FOR EACH ROW EXECUTE FUNCTION enforce_max_payment_details();
CREATE TRIGGER trg_single_default_payment AFTER INSERT OR UPDATE ON public.shop_payment_details FOR EACH ROW EXECUTE FUNCTION enforce_single_default_payment();
CREATE TRIGGER enforce_shop_admin_columns BEFORE UPDATE ON public.shop_profiles FOR EACH ROW EXECUTE FUNCTION protect_shop_admin_columns();
CREATE TRIGGER trg_cascade_lead_suspend AFTER UPDATE OF approval_status ON public.shop_profiles FOR EACH ROW EXECUTE FUNCTION cascade_lead_suspend();
CREATE TRIGGER trg_enforce_sub_agent_recruit_cap BEFORE INSERT ON public.sub_agents FOR EACH ROW EXECUTE FUNCTION enforce_sub_agent_recruit_cap();
CREATE TRIGGER trg_support_thread_bump AFTER INSERT ON public.support_messages FOR EACH ROW EXECUTE FUNCTION bump_support_thread_last_message();
CREATE TRIGGER trg_support_thread_cap BEFORE INSERT ON public.support_threads FOR EACH ROW EXECUTE FUNCTION enforce_support_thread_cap();
CREATE TRIGGER trg_support_threads_updated_at BEFORE UPDATE ON public.support_threads FOR EACH ROW EXECUTE FUNCTION update_support_threads_updated_at();
CREATE TRIGGER trg_block_client_write BEFORE INSERT OR UPDATE ON public.user_payment_references FOR EACH ROW EXECUTE FUNCTION block_client_money_writes();
CREATE TRIGGER on_user_created_wallet AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION handle_new_user_wallet();
CREATE TRIGGER trg_enforce_subagent_contact_lock BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION enforce_subagent_contact_lock();
CREATE TRIGGER trg_guard_users_privilege BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION guard_users_privilege_change();
CREATE TRIGGER trg_utility_orders_updated_at BEFORE UPDATE ON public.utility_orders FOR EACH ROW EXECUTE FUNCTION update_utility_orders_updated_at();
CREATE TRIGGER trg_block_client_write BEFORE INSERT OR UPDATE ON public.wallet_transactions FOR EACH ROW EXECUTE FUNCTION block_client_money_writes();
CREATE TRIGGER trg_block_client_write BEFORE INSERT OR UPDATE ON public.wallets FOR EACH ROW EXECUTE FUNCTION block_client_money_writes();
CREATE TRIGGER trg_website_request_cap BEFORE INSERT ON public.website_requests FOR EACH ROW EXECUTE FUNCTION enforce_website_request_cap();
CREATE TRIGGER trg_website_requests_updated_at BEFORE UPDATE ON public.website_requests FOR EACH ROW EXECUTE FUNCTION update_website_requests_updated_at();

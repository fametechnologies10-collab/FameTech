-- Fametech schema snapshot: tables
-- Source: read-only introspection of the original source production database (schema only, NO data).
-- Apply files in numeric order to a FRESH Supabase project.

CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  admin_id uuid NOT NULL,
  action text NOT NULL,
  target_user_id uuid NOT NULL,
  old_value jsonb,
  new_value jsonb,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.admin_custom_list_users (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  list_id uuid NOT NULL,
  user_id uuid NOT NULL,
  added_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.admin_custom_lists (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.admin_payment_actions (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  admin_id uuid,
  action text NOT NULL,
  reference text,
  source text,
  outcome text,
  detail jsonb,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.admin_presence (
  admin_id uuid NOT NULL,
  last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.admin_profit_logs (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  transaction_type text NOT NULL,
  transaction_id uuid NOT NULL,
  channel text NOT NULL,
  role_at_time text,
  selling_price numeric(12,2),
  amount_paid_to_admin numeric(12,2),
  admin_cost numeric(12,2) NOT NULL,
  profit numeric(12,2) NOT NULL,
  is_loss boolean GENERATED ALWAYS AS ((profit < (0)::numeric)) STORED,
  calculation_note text NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.admin_settings (
  key text NOT NULL,
  value jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.admin_settings_audit (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  key text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  changed_by uuid,
  changed_at timestamp with time zone DEFAULT now(),
  source text
);

CREATE TABLE IF NOT EXISTS public.afa_orders (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid,
  full_name text NOT NULL,
  phone text NOT NULL,
  ghana_card text NOT NULL,
  location text NOT NULL,
  region text NOT NULL,
  occupation text NOT NULL,
  status text DEFAULT 'pending'::text,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  id_type text,
  id_number text,
  payment_amount numeric(12,2) DEFAULT 0.00,
  reference_code text NOT NULL,
  transaction_id uuid,
  date_of_birth date,
  source text DEFAULT 'web'::text NOT NULL,
  payment_method text DEFAULT 'momo'::text,
  api_key_id uuid,
  shop_id uuid,
  guest_phone text,
  cost_price numeric,
  selling_price numeric,
  profit numeric,
  parent_shop_id uuid,
  parent_profit numeric,
  refund_method text,
  refund_reason text,
  refunded_at timestamp with time zone,
  refunded_by uuid,
  paystack_reference text
);

CREATE TABLE IF NOT EXISTS public.airtime_fulfillment_batches (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  created_by uuid,
  batch_name text NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  order_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  order_count integer DEFAULT 0 NOT NULL,
  completed_count integer DEFAULT 0 NOT NULL,
  failed_count integer DEFAULT 0 NOT NULL,
  fulfillment_service text,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.airtime_orders (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid,
  user_role text DEFAULT 'customer'::text NOT NULL,
  beneficiary_phone text NOT NULL,
  network text NOT NULL,
  airtime_amount numeric(12,2) NOT NULL,
  fee_rate numeric(5,2) DEFAULT 0 NOT NULL,
  fee_amount numeric(12,2) DEFAULT 0 NOT NULL,
  total_paid numeric(12,2) NOT NULL,
  use_exact_amount boolean DEFAULT false,
  status text DEFAULT 'pending'::text,
  reference_code text NOT NULL,
  fulfillment_note text,
  fulfilled_by uuid,
  fulfilled_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  shop_id uuid,
  shop_name text,
  type text DEFAULT 'airtime'::text NOT NULL,
  bundle_preference text,
  admin_fee_amount numeric(12,2) DEFAULT 0 NOT NULL,
  shop_fee_amount numeric(12,2) DEFAULT 0 NOT NULL,
  fulfillment_service text,
  fulfillment_request_id text,
  fulfillment_metadata jsonb,
  airtime_fulfillment_attempts integer DEFAULT 0 NOT NULL,
  refunded_by uuid,
  refunded_at timestamp with time zone,
  refund_reason text,
  source text DEFAULT 'web'::text,
  api_key_id uuid,
  commission_amount numeric,
  partner_commission_amount numeric,
  commission_credited_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.api_keys (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  key_hash text NOT NULL,
  key_prefix text NOT NULL,
  name text DEFAULT 'My API Key'::text NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  rate_limits jsonb,
  last_used_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  key_type text DEFAULT 'standard'::text NOT NULL,
  webhook_url text,
  webhook_secret text
);

CREATE TABLE IF NOT EXISTS public.api_logs (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  api_key_id uuid,
  user_id uuid,
  endpoint text NOT NULL,
  method text NOT NULL,
  status_code integer NOT NULL,
  response_time_ms integer,
  ip_address text,
  error_message text,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.archived_shop_financial_records (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  owner_id uuid NOT NULL,
  shop_id uuid,
  wallet_id uuid,
  source_table text NOT NULL,
  record jsonb NOT NULL,
  archived_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.atishare_console_manual_sends (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  admin_id uuid NOT NULL,
  phone text NOT NULL,
  bundle_mb integer NOT NULL,
  client_reference text NOT NULL,
  transaction_id text,
  status text DEFAULT 'queued'::text NOT NULL,
  response jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.commission_wallet_transactions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  commission_wallet_id uuid NOT NULL,
  utility_order_id uuid,
  type text NOT NULL,
  amount numeric NOT NULL,
  description text,
  status text DEFAULT 'completed'::text NOT NULL,
  momo_number text,
  network text,
  account_name text,
  name_verified boolean,
  payout_provider text,
  paystack_transfer_reference text,
  paystack_transfer_code text,
  paystack_transfer_status text,
  paystack_recipient_code text,
  paystack_fee numeric,
  poll_attempts integer DEFAULT 0 NOT NULL,
  last_polled_at timestamp with time zone,
  failure_reason text,
  admin_note text,
  processed_by uuid,
  processed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  fee numeric,
  net_amount numeric,
  airtime_order_id uuid,
  order_reference text,
  order_table text
);

CREATE TABLE IF NOT EXISTS public.commission_wallets (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  owner_id uuid NOT NULL,
  balance numeric DEFAULT 0 NOT NULL,
  total_earned numeric DEFAULT 0 NOT NULL,
  total_withdrawn numeric DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.complaints (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  order_id uuid NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  status text DEFAULT 'pending'::text,
  priority text DEFAULT 'medium'::text,
  resolution_notes text,
  evidence jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.customer_purchases (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  customer_phone text NOT NULL,
  total_purchases integer DEFAULT 0,
  total_spent numeric(12,2) DEFAULT 0.00,
  first_purchase_at timestamp with time zone DEFAULT now(),
  last_purchase_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.data_packages (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  network text NOT NULL,
  size text NOT NULL,
  price numeric(12,2) NOT NULL,
  cost_price numeric(12,2) DEFAULT 0.00,
  description text,
  is_available boolean DEFAULT true,
  sort_order integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  agent_price numeric DEFAULT 0,
  dealer_price numeric DEFAULT 0,
  ussd_price numeric(12,2),
  ussd_enabled boolean DEFAULT false NOT NULL,
  category text DEFAULT 'data'::text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.download_batches (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  filename text NOT NULL,
  network text NOT NULL,
  order_count integer NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  idempotency_key text
);

CREATE TABLE IF NOT EXISTS public.fulfillment_logs (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  order_id uuid NOT NULL,
  status text DEFAULT 'pending'::text,
  api_response jsonb,
  codecraft_reference text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.guest_push_subscriptions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  shop_id uuid NOT NULL,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  guest_phone text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.hubtel_receive_charges (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  reference_code text NOT NULL,
  service_type text NOT NULL,
  order_id uuid,
  shop_id uuid,
  amount numeric NOT NULL,
  channel text NOT NULL,
  provider_transaction_id text,
  charges numeric,
  amount_charged numeric,
  fees_on_customer boolean,
  status text DEFAULT 'pending'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  paid_at timestamp with time zone,
  expires_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.momo_claim_attempts (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  transaction_id_input text NOT NULL,
  result text NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.momo_transactions (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  transaction_id text NOT NULL,
  amount numeric(12,2) NOT NULL,
  sender_name text NOT NULL,
  sender_network text NOT NULL,
  raw_sms text,
  status text DEFAULT 'pending'::text NOT NULL,
  claimed_by uuid,
  claimed_at timestamp with time zone,
  claim_fee_percent numeric(5,2) DEFAULT 0,
  claim_fee_amount numeric(12,2) DEFAULT 0,
  net_amount numeric(12,2),
  created_at timestamp with time zone DEFAULT now(),
  is_auto_claimed boolean DEFAULT false NOT NULL,
  claimed_via_ref text
);

CREATE TABLE IF NOT EXISTS public.mtn_fulfillment_tracking (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  order_id uuid NOT NULL,
  status text DEFAULT 'pending'::text,
  api_response jsonb,
  retry_count integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mtn_whitelist_server_status (
  phone_number text NOT NULL,
  server smallint NOT NULL,
  status text NOT NULL,
  checked_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.mtn_whitelist_status (
  phone_number text NOT NULL,
  status text NOT NULL,
  checked_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  type text NOT NULL,
  is_read boolean DEFAULT false,
  action_url text,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.number_registration_batches (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  filename text NOT NULL,
  network text DEFAULT 'MTN'::text NOT NULL,
  number_count integer DEFAULT 0 NOT NULL,
  status text DEFAULT 'submitted'::text NOT NULL,
  idempotency_key text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  confirmed_by uuid,
  confirmed_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.number_registrations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  phone_number text NOT NULL,
  network text DEFAULT 'MTN'::text NOT NULL,
  status text DEFAULT 'new'::text NOT NULL,
  batch_id uuid,
  source text DEFAULT 'order'::text NOT NULL,
  first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  submitted_at timestamp with time zone,
  registered_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.order_retry_attempts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  source_order_id uuid NOT NULL,
  attempt_no integer NOT NULL,
  new_order_id uuid,
  mode text NOT NULL,
  actor_id uuid NOT NULL,
  actor_role text NOT NULL,
  charged_amount numeric DEFAULT 0 NOT NULL,
  funding_wallet_user_id uuid,
  supplier text,
  supplier_reference text,
  status text NOT NULL,
  error_message text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.orders (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid,
  phone_number text NOT NULL,
  network text NOT NULL,
  size text NOT NULL,
  price numeric(12,2) NOT NULL,
  cost_price_at_time numeric(12,2) DEFAULT 0.00,
  status text DEFAULT 'pending'::text,
  payment_status text DEFAULT 'paid'::text,
  reference_code text NOT NULL,
  fulfillment_method text DEFAULT 'auto'::text,
  codecraft_reference text,
  error_message text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  download_batch_id uuid,
  shop_name text,
  shop_order_id uuid,
  role_at_time text,
  dakazina_reference text,
  source text DEFAULT 'web'::text NOT NULL,
  api_key_id uuid,
  payment_method text DEFAULT 'momo'::text,
  category text DEFAULT 'data'::text NOT NULL,
  fulfillment_note text,
  refunded_by uuid,
  refunded_at timestamp with time zone,
  refund_reason text,
  ghdata_order_id text,
  retry_of_order_id uuid,
  retry_count integer DEFAULT 0 NOT NULL,
  last_retry_at timestamp with time zone,
  retry_from_status text,
  retried_by uuid,
  retried_by_role text,
  bundleportal_reference text,
  hendylinks_order_id text,
  dakazina_order_code text,
  atishare_console_reference text,
  atishare_console_transaction_id text,
  self_completed_at timestamp with time zone,
  self_completed_by uuid,
  self_completed_by_role text,
  dispatch_claimed_at timestamp with time zone,
  spfastit_reference text
);

CREATE TABLE IF NOT EXISTS public.passkey_challenges (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  challenge text NOT NULL,
  user_id uuid,
  flow text NOT NULL,
  expires_at timestamp with time zone DEFAULT (now() + '00:05:00'::interval) NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.passkey_credentials (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  credential_id text NOT NULL,
  public_key bytea NOT NULL,
  counter bigint DEFAULT 0 NOT NULL,
  device_type text,
  backed_up boolean DEFAULT false NOT NULL,
  transports text[],
  friendly_name text DEFAULT 'Passkey'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  last_used_at timestamp with time zone,
  email text
);

CREATE TABLE IF NOT EXISTS public.pending_settlements (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  wallet_transaction_id uuid,
  amount_owed numeric(10,2) NOT NULL,
  amount_settled numeric(10,2) DEFAULT 0 NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  payment_method text,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  settled_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.phone_blacklist (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  phone_number text NOT NULL,
  reason text,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.phone_otp_verifications (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  phone text NOT NULL,
  code text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  attempts integer DEFAULT 0,
  used boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  verify_reference text,
  pending_charge jsonb,
  charge_result jsonb
);

CREATE TABLE IF NOT EXISTS public.phone_recovery_attempts (
  user_id uuid NOT NULL,
  attempt_count integer DEFAULT 0 NOT NULL,
  window_started_at timestamp with time zone DEFAULT now() NOT NULL,
  locked_until timestamp with time zone,
  hard_locked boolean DEFAULT false NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.results_checker_complaints (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  order_id uuid NOT NULL,
  user_id uuid,
  shop_id uuid,
  description text NOT NULL,
  status text DEFAULT 'open'::text,
  admin_note text,
  resolved_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.results_checker_inventory (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  type_id uuid NOT NULL,
  pin text NOT NULL,
  serial_number text NOT NULL,
  status text DEFAULT 'available'::text,
  reserved_by_order uuid,
  reservation_expires_at timestamp with time zone,
  sold_to_user_id uuid,
  sold_at timestamp with time zone,
  batch_id text,
  expiry_date date,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.results_checker_orders (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid,
  user_role text DEFAULT 'customer'::text,
  shop_id uuid,
  shop_name text,
  shop_markup numeric(12,2) DEFAULT 0,
  customer_name text,
  customer_email text,
  customer_phone text,
  type_id uuid,
  type_name text,
  quantity integer NOT NULL,
  unit_price numeric(12,2),
  cost_price_at_time numeric(12,2),
  fee_amount numeric(12,2) DEFAULT 0,
  total_paid numeric(12,2) NOT NULL,
  merchant_commission numeric(12,2) DEFAULT 0,
  inventory_ids uuid[],
  status text DEFAULT 'pending'::text,
  payment_status text DEFAULT 'pending'::text,
  reference_code text,
  delivered_via text[],
  fulfilled_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  source text DEFAULT 'website'::text NOT NULL,
  payment_method text DEFAULT 'momo'::text,
  api_key_id uuid
);

CREATE TABLE IF NOT EXISTS public.results_checker_types (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  name text NOT NULL,
  customer_price numeric(12,2) NOT NULL,
  agent_price numeric(12,2) NOT NULL,
  cost_price numeric(12,2) NOT NULL,
  is_active boolean DEFAULT true,
  display_order integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  bulk_pricing jsonb DEFAULT '[]'::jsonb,
  ussd_price numeric(12,2),
  dealer_price numeric(12,2) DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS public.security_events (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  event_type text NOT NULL,
  reference text,
  shop_id uuid,
  paid_amount numeric,
  expected_amount numeric,
  guest_phone text,
  network text,
  order_type text,
  detail jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.shop_afa_pending_orders (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  paystack_reference text NOT NULL,
  shop_id uuid NOT NULL,
  guest_phone text NOT NULL,
  guest_email text,
  order_payload jsonb NOT NULL,
  cost_price numeric NOT NULL,
  selling_price numeric NOT NULL,
  profit numeric NOT NULL,
  status text DEFAULT 'awaiting_payment'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  fulfilled_at timestamp with time zone,
  paystack_fee numeric
);

CREATE TABLE IF NOT EXISTS public.shop_announcements (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  shop_id uuid NOT NULL,
  message text NOT NULL,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.shop_customers (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  shop_id uuid NOT NULL,
  phone text NOT NULL,
  name text,
  tags text[] DEFAULT '{}'::text[] NOT NULL,
  notes text,
  total_orders integer DEFAULT 0 NOT NULL,
  total_spent numeric(12,2) DEFAULT 0 NOT NULL,
  first_order_at timestamp with time zone,
  last_order_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.shop_global_settings (
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.shop_invites (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  shop_id uuid NOT NULL,
  code text NOT NULL,
  max_uses integer,
  used_count integer DEFAULT 0 NOT NULL,
  expires_at timestamp with time zone,
  revoked_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.shop_order_splits (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  order_id uuid NOT NULL,
  beneficiary_shop_id uuid NOT NULL,
  level smallint NOT NULL,
  profit numeric(12,2) NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.shop_orders (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  shop_id uuid NOT NULL,
  package_id uuid,
  guest_phone text NOT NULL,
  network text NOT NULL,
  package_size text NOT NULL,
  selling_price numeric(12,2) NOT NULL,
  cost_price numeric(12,2) NOT NULL,
  profit numeric(12,2) NOT NULL,
  paystack_reference text,
  status text DEFAULT 'pending'::text,
  fulfillment_reference text,
  error_message text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  admin_cost_at_time numeric(12,2),
  owner_role_at_time text,
  codecraft_reference_id text,
  fulfilled_by text,
  dakazina_reference text,
  source text DEFAULT 'website'::text NOT NULL,
  refunded_by uuid,
  refunded_at timestamp with time zone,
  refund_reason text,
  refund_method text,
  parent_shop_id uuid,
  parent_profit numeric(12,2),
  payer_momo_number text,
  payer_momo_name text,
  payer_momo_network text,
  payer_momo_resolved_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.shop_payment_details (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  shop_owner_id uuid NOT NULL,
  account_name text NOT NULL,
  momo_number text NOT NULL,
  network text NOT NULL,
  is_default boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  payment_type text DEFAULT 'momo'::text,
  bank_id text,
  bank_name text,
  account_number text
);

CREATE TABLE IF NOT EXISTS public.shop_pricing (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  shop_id uuid NOT NULL,
  package_id uuid NOT NULL,
  selling_price numeric(12,2) NOT NULL,
  profit_margin numeric(12,2) DEFAULT 1 NOT NULL,
  last_auto_updated_at timestamp with time zone,
  sub_price numeric(12,2)
);

CREATE TABLE IF NOT EXISTS public.shop_pricing_logs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  shop_id uuid NOT NULL,
  package_id uuid NOT NULL,
  old_cost_price numeric(12,2),
  new_cost_price numeric(12,2),
  old_selling_price numeric(12,2),
  new_selling_price numeric(12,2),
  changed_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.shop_pricing_pending (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  shop_id uuid NOT NULL,
  package_id uuid NOT NULL,
  selling_price numeric(12,2) NOT NULL,
  submitted_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.shop_profiles (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  owner_id uuid NOT NULL,
  shop_name text NOT NULL,
  shop_slug text NOT NULL,
  description text,
  owner_phone text,
  owner_email text,
  whatsapp_number text,
  logo_url text,
  brand_color text DEFAULT '#2563eb'::text,
  brand_accent text DEFAULT '#1e40af'::text,
  approval_status text DEFAULT 'pending'::text,
  approval_note text,
  approved_by uuid,
  approved_at timestamp with time zone,
  fulfillment_mode text DEFAULT 'auto'::text,
  paystack_fee_percent numeric(5,2),
  withdrawal_fee_percent numeric(5,2),
  withdrawal_fee_flat numeric(12,2),
  min_withdrawal_amount numeric(12,2),
  is_active boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  pricing_status text DEFAULT 'not_submitted'::text,
  pricing_note text,
  pricing_submitted_at timestamp with time zone,
  pricing_approved_at timestamp with time zone,
  pricing_approved_by uuid,
  pricing_rejection_acknowledged boolean DEFAULT true,
  airtime_fee_mtn numeric DEFAULT 1,
  airtime_fee_telecel numeric DEFAULT 1,
  airtime_fee_at numeric DEFAULT 1,
  banner_url text,
  community_link text,
  divider_style text DEFAULT 'asymmetric-curve'::text,
  banner_pos_x integer DEFAULT 50,
  banner_pos_y integer DEFAULT 50,
  banner_zoom numeric DEFAULT 1,
  results_checker_markup_customer numeric(12,2) DEFAULT 1,
  results_checker_markup_agent numeric(12,2) DEFAULT 1,
  mashup_fee_percent numeric DEFAULT 1,
  results_checker_markup_dealer numeric(10,2) DEFAULT 0 NOT NULL,
  setup_progress jsonb DEFAULT '{}'::jsonb NOT NULL,
  setup_completed_at timestamp with time zone,
  ussd_code text,
  ussd_active boolean DEFAULT false NOT NULL,
  ussd_activated_at timestamp with time zone,
  sms_order_confirmation_enabled boolean DEFAULT true NOT NULL,
  oos_networks jsonb DEFAULT '[]'::jsonb NOT NULL,
  sms_sender_id text,
  sms_sender_status text,
  sms_sender_requested_at timestamp with time zone,
  sms_sender_reviewed_at timestamp with time zone,
  utilities_enabled boolean DEFAULT false NOT NULL,
  afa_selling_price numeric,
  afa_fee_percent numeric,
  utility_sms_confirmation_enabled boolean DEFAULT true NOT NULL
);

CREATE TABLE IF NOT EXISTS public.shop_rc_markups (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  shop_id uuid NOT NULL,
  exam_type_id uuid NOT NULL,
  markup numeric(10,2) DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.shop_sender_ids (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  shop_id uuid NOT NULL,
  sender_text text NOT NULL,
  status text DEFAULT 'under_review'::text NOT NULL,
  is_default boolean DEFAULT false NOT NULL,
  requested_at timestamp with time zone DEFAULT now() NOT NULL,
  reviewed_at timestamp with time zone,
  reason text,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.shop_sms_activations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  shop_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  amount_paid numeric(10,2) NOT NULL,
  paid_from text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  bonus_claimed boolean DEFAULT false NOT NULL,
  bonus_claimed_at timestamp with time zone,
  sms_suspended boolean DEFAULT false NOT NULL
);

CREATE TABLE IF NOT EXISTS public.shop_sms_bundles (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  credits integer NOT NULL,
  price numeric(10,2) NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.shop_sms_delivery_receipts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  log_id uuid NOT NULL,
  phone text NOT NULL,
  provider_message_id text,
  status text DEFAULT 'sent'::text NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.shop_sms_group_members (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  group_id uuid NOT NULL,
  shop_id uuid NOT NULL,
  phone text NOT NULL,
  name text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.shop_sms_groups (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  shop_id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.shop_sms_logs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  shop_id uuid NOT NULL,
  message text NOT NULL,
  recipients_count integer NOT NULL,
  segments integer NOT NULL,
  credits_used integer NOT NULL,
  status text DEFAULT 'sent'::text NOT NULL,
  flagged boolean DEFAULT false NOT NULL,
  flag_reason text,
  provider text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  source text DEFAULT 'manual'::text NOT NULL,
  delivered_count integer DEFAULT 0 NOT NULL,
  undelivered_count integer DEFAULT 0 NOT NULL,
  pending_count integer DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS public.shop_sms_purchases (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  shop_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  bundle_id uuid,
  credits integer NOT NULL,
  price numeric(10,2) NOT NULL,
  paid_from text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.shop_sms_refund_failures (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  shop_id uuid NOT NULL,
  credits integer NOT NULL,
  reason text,
  resolved boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.shop_sms_send_claims (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  shop_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.shop_sms_templates (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  shop_id uuid NOT NULL,
  name text NOT NULL,
  body text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.shop_sms_wallets (
  shop_id uuid NOT NULL,
  credits integer DEFAULT 0 NOT NULL,
  total_purchased integer DEFAULT 0 NOT NULL,
  total_used integer DEFAULT 0 NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.shop_wallet_transactions (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  shop_wallet_id uuid NOT NULL,
  shop_order_id uuid,
  type text NOT NULL,
  amount numeric(12,2) NOT NULL,
  fee numeric(12,2) DEFAULT 0.00,
  net_amount numeric(12,2),
  description text NOT NULL,
  momo_number text,
  status text DEFAULT 'completed'::text,
  admin_note text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  account_name text,
  network text,
  balance_snapshot numeric(12,2),
  moolre_transaction_id text,
  moolre_external_ref text,
  moolre_status integer,
  payment_type text DEFAULT 'momo'::text,
  bank_id text,
  processed_at timestamp with time zone,
  account_number text,
  bank_name text,
  branch text,
  ussd_ref text,
  payout_provider text,
  paystack_recipient_code text,
  paystack_transfer_code text,
  paystack_transfer_reference text,
  paystack_transfer_status text,
  paystack_fee numeric(12,2),
  processed_by uuid,
  failure_reason text,
  last_polled_at timestamp with time zone,
  poll_attempts integer DEFAULT 0 NOT NULL,
  created_by uuid,
  credit_source text,
  name_verified boolean,
  sub_approval_status text DEFAULT 'not_required'::text NOT NULL,
  sub_approved_by uuid,
  sub_approval_note text,
  escalate_after timestamp with time zone,
  auto_escalated boolean DEFAULT false NOT NULL,
  order_reference text,
  utility_order_id uuid,
  afa_order_id uuid
);

CREATE TABLE IF NOT EXISTS public.shop_wallets (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  owner_id uuid NOT NULL,
  balance numeric(12,2) DEFAULT 0.00,
  total_earned numeric(12,2) DEFAULT 0.00,
  total_withdrawn numeric(12,2) DEFAULT 0.00,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sms_accounts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  mode text DEFAULT 'platform'::text NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  suspended_reason text,
  default_sender text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  business_on_hold boolean DEFAULT false NOT NULL,
  use_own_sender_for_confirmations boolean DEFAULT false NOT NULL,
  webhook_url text,
  webhook_secret text,
  low_balance_threshold integer DEFAULT 50 NOT NULL,
  low_balance_notified_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.sms_bundles (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  credits integer NOT NULL,
  price numeric(10,2) NOT NULL,
  business_price numeric(10,2),
  is_active boolean DEFAULT true NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  mode text DEFAULT 'platform'::text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.sms_business_profiles (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  business_name text NOT NULL,
  description text NOT NULL,
  domain_link text,
  ghana_card_number_masked text,
  status text DEFAULT 'draft'::text NOT NULL,
  review_notes text,
  reviewed_by uuid,
  reviewed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  whatsapp_verified boolean DEFAULT false NOT NULL,
  whatsapp_verification_note text,
  contact_whatsapp_number text
);

CREATE TABLE IF NOT EXISTS public.sms_campaigns (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  sender_used text,
  mode_at_send text NOT NULL,
  message text NOT NULL,
  recipients_count integer NOT NULL,
  segments integer NOT NULL,
  credits_charged integer DEFAULT 0 NOT NULL,
  status text NOT NULL,
  flagged boolean DEFAULT false NOT NULL,
  flag_reason text,
  flag_severity text,
  scheduled_at timestamp with time zone,
  claimed_at timestamp with time zone,
  settled_at timestamp with time zone,
  source text DEFAULT 'dashboard'::text NOT NULL,
  provider text DEFAULT 'hubtel'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.sms_contact_groups (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.sms_contacts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  group_id uuid NOT NULL,
  first_name text,
  last_name text,
  phone_number text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.sms_credit_ledger (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  delta integer NOT NULL,
  balance_after integer,
  kind text NOT NULL,
  idempotency_key text NOT NULL,
  reference text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.sms_group_contacts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  group_id uuid NOT NULL,
  phone_number text NOT NULL,
  first_name text,
  last_name text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.sms_groups (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  description text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.sms_messages (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  campaign_id uuid NOT NULL,
  account_id uuid NOT NULL,
  recipient text NOT NULL,
  chunk_no integer DEFAULT 0 NOT NULL,
  provider text DEFAULT 'hubtel'::text NOT NULL,
  provider_message_id text,
  status text DEFAULT 'queued'::text NOT NULL,
  status_detail text,
  network_id text,
  rate numeric(10,4),
  status_updated_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.sms_purchases (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  user_id uuid NOT NULL,
  bundle_id uuid,
  credits integer NOT NULL,
  price numeric(10,2) NOT NULL,
  paid_from text NOT NULL,
  payment_reference text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.sms_sender_ids (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  sender_text text NOT NULL,
  status text DEFAULT 'under_review'::text NOT NULL,
  is_default boolean DEFAULT false NOT NULL,
  hubtel_reference text,
  rejection_reason text,
  requested_at timestamp with time zone DEFAULT now() NOT NULL,
  approved_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.sms_templates (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  body text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.sms_user_templates (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  name text NOT NULL,
  body text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.sms_wallets (
  account_id uuid NOT NULL,
  credits integer DEFAULT 0 NOT NULL,
  total_purchased integer DEFAULT 0 NOT NULL,
  total_used integer DEFAULT 0 NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.sub_agent_default_pricing (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  recruiter_id uuid NOT NULL,
  product_type text NOT NULL,
  product_ref text NOT NULL,
  markup numeric(12,2) NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.sub_agent_order_earnings (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  order_reference text NOT NULL,
  order_table text NOT NULL,
  recruiter_id uuid NOT NULL,
  sub_user_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  credited_at timestamp with time zone,
  reversed_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.sub_agent_pricing (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  recruiter_id uuid NOT NULL,
  sub_user_id uuid NOT NULL,
  product_type text NOT NULL,
  product_ref text NOT NULL,
  markup numeric(12,2) NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.sub_agents (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  upline_shop_id uuid,
  status text DEFAULT 'pending'::text NOT NULL,
  markup_ceiling numeric(12,2),
  approved_by uuid,
  approved_at timestamp with time zone,
  joined_via_invite uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  may_recruit boolean DEFAULT false NOT NULL,
  upline_user_id uuid,
  pending_key_hash text,
  pending_key_expires_at timestamp with time zone,
  must_change_password boolean DEFAULT true NOT NULL
);

CREATE TABLE IF NOT EXISTS public.support_messages (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  thread_id uuid NOT NULL,
  sender_role text NOT NULL,
  sender_id uuid NOT NULL,
  body text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  delivered_to_user_at timestamp with time zone,
  delivered_to_admin_at timestamp with time zone,
  read_by_user_at timestamp with time zone,
  read_by_admin_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.support_threads (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  order_id uuid,
  subject text NOT NULL,
  category text DEFAULT 'other'::text NOT NULL,
  phone_number text NOT NULL,
  whatsapp_number text NOT NULL,
  status text DEFAULT 'open'::text NOT NULL,
  closed_at timestamp with time zone,
  closed_by uuid,
  last_message_at timestamp with time zone DEFAULT now() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.system_announcements (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  visible_on text DEFAULT 'main_site'::text,
  cta_primary_label text,
  cta_primary_url text,
  cta_secondary_label text,
  cta_secondary_url text,
  status text DEFAULT 'published'::text NOT NULL,
  scheduled_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.terms_acceptances (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  version text NOT NULL,
  accepted_at timestamp with time zone DEFAULT now() NOT NULL,
  ip_address text,
  user_agent text
);

CREATE TABLE IF NOT EXISTS public.terms_versions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  version text NOT NULL,
  effective_date date NOT NULL,
  sections jsonb DEFAULT '[]'::jsonb NOT NULL,
  changelog jsonb DEFAULT '[]'::jsonb NOT NULL,
  requires_reacceptance boolean DEFAULT true NOT NULL,
  is_current boolean DEFAULT false NOT NULL,
  created_by uuid,
  published_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.user_payment_references (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  reference_code text NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.users (
  id uuid NOT NULL,
  email text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  phone_number text,
  role text DEFAULT 'customer'::text,
  status text DEFAULT 'active'::text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  agent_expires_at timestamp with time zone,
  pin_hash text,
  pin_reminder text,
  pin_attempts integer DEFAULT 0,
  pin_locked_until timestamp with time zone,
  dealer_expires_at timestamp with time zone,
  signup_promo_shown boolean DEFAULT false NOT NULL,
  pin_salt text,
  auto_upgrade_enabled boolean DEFAULT false NOT NULL,
  auto_upgrade_plan text,
  phone_verified boolean DEFAULT false,
  order_success_sms_enabled boolean DEFAULT true NOT NULL,
  notification_prefs jsonb DEFAULT '{}'::jsonb NOT NULL,
  terms_accepted_version text,
  terms_accepted_at timestamp with time zone,
  suspended_until timestamp with time zone,
  suspension_reason text,
  suspended_at timestamp with time zone,
  suspended_by uuid
);

CREATE TABLE IF NOT EXISTS public.ussd_callback_retry_queue (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  session_id text NOT NULL,
  hubtel_order_id text NOT NULL,
  service_status text NOT NULL,
  metadata jsonb,
  attempts integer DEFAULT 0 NOT NULL,
  first_failed_at timestamp with time zone DEFAULT now() NOT NULL,
  last_attempt_at timestamp with time zone,
  resolved boolean DEFAULT false NOT NULL,
  resolved_at timestamp with time zone,
  escalated boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  claimed_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.ussd_customers (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  mobile text NOT NULL,
  operator text,
  first_seen timestamp with time zone DEFAULT now() NOT NULL,
  last_seen timestamp with time zone DEFAULT now() NOT NULL,
  total_orders integer DEFAULT 0 NOT NULL,
  total_spent numeric(12,2) DEFAULT 0 NOT NULL,
  last_service text
);

CREATE TABLE IF NOT EXISTS public.ussd_pending_orders (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  session_id text NOT NULL,
  mobile text NOT NULL,
  service_type text NOT NULL,
  order_payload jsonb NOT NULL,
  user_id uuid,
  price numeric(12,2) NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  hubtel_order_id text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  fulfilled_at timestamp with time zone,
  expires_at timestamp with time zone DEFAULT (now() + '02:00:00'::interval) NOT NULL,
  shop_id uuid,
  operator text,
  claimed_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.ussd_refund_queue (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  session_id text NOT NULL,
  order_id uuid,
  user_id uuid,
  mobile text NOT NULL,
  service_type text NOT NULL,
  amount numeric NOT NULL,
  payment_method text NOT NULL,
  hubtel_order_id text,
  wallet_debit_reference text,
  reason text,
  status text DEFAULT 'pending'::text NOT NULL,
  refunded_by uuid,
  refunded_at timestamp with time zone,
  refund_reference text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.ussd_sessions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  session_id text NOT NULL,
  mobile text NOT NULL,
  operator text,
  platform text DEFAULT 'USSD'::text NOT NULL,
  steps integer DEFAULT 0 NOT NULL,
  service_used text,
  completed boolean DEFAULT false NOT NULL,
  interrupted_state jsonb,
  interrupted_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.utility_orders (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid,
  shop_id uuid,
  api_key_id uuid,
  source text NOT NULL,
  biller text NOT NULL,
  account_number text NOT NULL,
  account_name text,
  destination_phone text,
  customer_email text,
  amount numeric(12,2) NOT NULL,
  payment_method text NOT NULL,
  payment_reference text,
  payment_status text DEFAULT 'unpaid'::text NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  reference_code text NOT NULL,
  fulfillment_attempts integer DEFAULT 0 NOT NULL,
  fulfillment_request_id text,
  commission_amount numeric(12,4),
  partner_commission_amount numeric(12,4),
  commission_credited_at timestamp with time zone,
  lookup_snapshot jsonb,
  fulfillment_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  paystack_fee numeric,
  refund_reason text,
  refunded_by uuid,
  refunded_at timestamp with time zone,
  payer_momo_number text,
  payer_momo_name text,
  payer_momo_network text,
  payer_momo_resolved_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.utility_refund_queue (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  utility_order_id uuid NOT NULL,
  source text NOT NULL,
  biller text NOT NULL,
  amount numeric NOT NULL,
  momo_number text,
  shop_id uuid,
  user_id uuid,
  reason text,
  status text DEFAULT 'pending'::text NOT NULL,
  refunded_by uuid,
  refunded_at timestamp with time zone,
  refund_reference text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.utility_saved_accounts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  biller text NOT NULL,
  account_number text NOT NULL,
  account_name text,
  destination_phone text,
  label text,
  last_paid_at timestamp with time zone,
  last_amount numeric(12,2),
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.verified_phone_numbers (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  phone text NOT NULL,
  first_verified_at timestamp with time zone DEFAULT now() NOT NULL,
  verified_via text DEFAULT 'sms_otp'::text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.wallet_payments (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  wallet_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL,
  fee numeric(12,2) DEFAULT 0.00,
  total_amount numeric(12,2) NOT NULL,
  reference text NOT NULL,
  provider text DEFAULT 'paystack'::text,
  status text DEFAULT 'pending'::text,
  provider_reference text,
  metadata jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.wallet_transactions (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  wallet_id uuid NOT NULL,
  user_id uuid NOT NULL,
  type text NOT NULL,
  amount numeric(12,2) NOT NULL,
  description text NOT NULL,
  reference text,
  source text NOT NULL,
  status text DEFAULT 'pending'::text,
  created_at timestamp with time zone DEFAULT now(),
  metadata jsonb
);

CREATE TABLE IF NOT EXISTS public.wallets (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  balance numeric(12,2) DEFAULT 0.00,
  total_credited numeric(12,2) DEFAULT 0.00,
  total_spent numeric(12,2) DEFAULT 0.00,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.website_requests (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  request_type text DEFAULT 'full_request'::text NOT NULL,
  category text,
  budget_ghs numeric,
  features jsonb,
  description text NOT NULL,
  reference_sites text,
  timeline text,
  contact_phone text NOT NULL,
  contact_whatsapp text,
  status text DEFAULT 'new'::text NOT NULL,
  closed_outcome text,
  admin_notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  contacted_at timestamp with time zone,
  closed_at timestamp with time zone
);

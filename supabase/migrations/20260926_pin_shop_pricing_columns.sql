-- Shop owners' fee/markup/price columns on shop_profiles were writable directly via
-- the REST API (owner UPDATE policy), bypassing app/api/shop/pricing/route.ts, which
-- clamps negatives to 0 and enforces the caps (e.g. shop fee + admin fee <= 10%).
-- A negative value would underprice USSD/storefront sales at the platform's expense;
-- an over-cap value would overcharge customers. The pricing route writes these via the
-- service role, so pin them for authenticated writers exactly like utilities_enabled.
-- Also add non-negative CHECK constraints as a backstop against any future server bug.
-- Verified 2026-09-26: 278 shops, 0 negative values, max 10; the only writer of these
-- columns is the pricing route (service role). See docs/security-audits/ (F12).

CREATE OR REPLACE FUNCTION public.protect_shop_admin_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Only enforce restriction for standard authenticated users (shop owners).
  -- Server-side calls using the service role bypass RLS entirely and
  -- are NOT subject to this trigger guard (auth.role() will be null or 'service_role').
  IF auth.role() = 'authenticated' THEN
    -- Force sensitive admin-only columns to remain unchanged
    NEW.paystack_fee_percent      := OLD.paystack_fee_percent;
    NEW.withdrawal_fee_percent    := OLD.withdrawal_fee_percent;
    NEW.withdrawal_fee_flat       := OLD.withdrawal_fee_flat;
    NEW.min_withdrawal_amount     := OLD.min_withdrawal_amount;
    NEW.approval_status           := OLD.approval_status;
    NEW.fulfillment_mode          := OLD.fulfillment_mode;
    NEW.is_active                 := OLD.is_active;
    NEW.approved_by               := OLD.approved_by;
    NEW.approved_at               := OLD.approved_at;
    -- utilities_enabled is money-eligibility state: app/api/shop/utility-settings/route.ts
    -- gates enabling it behind an agent/dealer role check, and credit_utility_commission's
    -- shop_id branch pays commission with NO role re-check on the strength of that gate.
    -- Without pinning it here, an authenticated owner could PATCH shop_profiles directly
    -- via the REST API and self-enable, bypassing the role gate entirely. The legitimate
    -- write goes through the service-role client, which this guard does not apply to.
    NEW.utilities_enabled         := OLD.utilities_enabled;
    -- Owner pricing: only app/api/shop/pricing/route.ts (service role) may change these —
    -- it clamps negatives and enforces the fee caps; a direct write could do neither.
    NEW.airtime_fee_mtn                   := OLD.airtime_fee_mtn;
    NEW.airtime_fee_telecel               := OLD.airtime_fee_telecel;
    NEW.airtime_fee_at                    := OLD.airtime_fee_at;
    NEW.mashup_fee_percent                := OLD.mashup_fee_percent;
    NEW.results_checker_markup_customer   := OLD.results_checker_markup_customer;
    NEW.results_checker_markup_agent      := OLD.results_checker_markup_agent;
    NEW.results_checker_markup_dealer     := OLD.results_checker_markup_dealer;
    NEW.afa_fee_percent                   := OLD.afa_fee_percent;
    NEW.afa_selling_price                 := OLD.afa_selling_price;
  END IF;
  RETURN NEW;
END;
$function$;

ALTER TABLE public.shop_profiles
  ADD CONSTRAINT shop_profiles_owner_pricing_nonnegative CHECK (
        coalesce(airtime_fee_mtn, 0) >= 0
    AND coalesce(airtime_fee_telecel, 0) >= 0
    AND coalesce(airtime_fee_at, 0) >= 0
    AND coalesce(mashup_fee_percent, 0) >= 0
    AND coalesce(results_checker_markup_customer, 0) >= 0
    AND coalesce(results_checker_markup_agent, 0) >= 0
    AND coalesce(results_checker_markup_dealer, 0) >= 0
    AND coalesce(afa_fee_percent, 0) >= 0
    AND (afa_selling_price IS NULL OR afa_selling_price > 0)
  );

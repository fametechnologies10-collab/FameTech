-- find_drifted_shop_pricing() had zero coverage for new-model sub-agents:
--   - branch 1 (general) explicitly excludes any owner who exists in sub_agents at all
--     (`WHERE NOT EXISTS (SELECT 1 FROM sub_agents WHERE user_id = owner_id)`).
--   - branch 2 (sub-agent) joins on sa.upline_shop_id, the OLD retired shop-wholesale
--     model. Every new-model sub-agent has upline_shop_id = NULL, so this branch
--     matches nothing for them.
--
-- Net effect: a new-model sub-agent's storefront price can drift underwater (from an
-- admin price change, or a recruiter markup change) with zero alert, unlike every
-- other role. This migration adds a third UNION ALL branch covering active new-model
-- sub-agents (sub_agents.upline_user_id IS NOT NULL), computing owner_cost as the
-- RECRUITER's live role-based cost (effective_owner_cost, same helper the existing
-- branches already call, applied to the recruiter's role) plus the sub's configured
-- markup for that package -- mirroring resolveSubAgentMarkup's exact
-- override-then-default-then-zero precedence (lib/sub-agent-pricing.ts) in SQL.
--
-- Data-packages-only scope, matching this function's existing scope -- no equivalent
-- drift detection exists for results-checker or AFA pricing today, for ANY role;
-- that is a separate, pre-existing gap this migration does not attempt to close.
--
-- CREATE OR REPLACE replaces the whole function body, so the two existing branches
-- are reproduced here byte-for-byte from the live definition (verified via
-- `select pg_get_functiondef(oid) from pg_proc where proname = 'find_drifted_shop_pricing'`
-- on project ubvjtacdmwynqcxuposj immediately before writing this migration) --
-- only the third branch is new.
--
-- Fix round (same day, review finding): the third branch's join originally lacked
-- `sa.upline_shop_id IS NULL`, so a sub_agents row carrying BOTH upline_shop_id (old
-- model) and upline_user_id (new model) would be evaluated by both branch 2 and
-- branch 3 -- zero impact live (confirmed: none of the 4 shops in that overlapping
-- state currently drift under either branch), but would emit a duplicated,
-- differently-based alert for the same row the moment an admin changed a price.
-- Added to make the three branches mutually exclusive by construction.
CREATE OR REPLACE FUNCTION public.find_drifted_shop_pricing()
 RETURNS TABLE(shop_id uuid, package_id uuid, owner_id uuid, role text, selling_price numeric, owner_cost numeric, sub_price numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    sp.shop_id, sp.package_id, spf.owner_id, u.role,
    sp.selling_price,
    public.effective_owner_cost(dp.price, dp.agent_price, dp.dealer_price, u.role) AS owner_cost,
    sp.sub_price
  FROM public.shop_pricing sp
  JOIN public.shop_profiles spf ON spf.id = sp.shop_id
  JOIN public.users u           ON u.id  = spf.owner_id
  JOIN public.data_packages dp  ON dp.id = sp.package_id
  WHERE NOT EXISTS (SELECT 1 FROM public.sub_agents sa WHERE sa.user_id = spf.owner_id)
    AND (
      sp.selling_price <= public.effective_owner_cost(dp.price, dp.agent_price, dp.dealer_price, u.role)
      OR (sp.sub_price IS NOT NULL
          AND sp.sub_price < public.effective_owner_cost(dp.price, dp.agent_price, dp.dealer_price, u.role))
    )

  UNION ALL

  SELECT
    sp.shop_id, sp.package_id, spf.owner_id, 'sub-agent'::text AS role,
    sp.selling_price,
    up.sub_price AS owner_cost,
    sp.sub_price
  FROM public.shop_pricing sp
  JOIN public.shop_profiles spf ON spf.id = sp.shop_id
  JOIN public.sub_agents sa     ON sa.user_id = spf.owner_id
  JOIN public.shop_pricing up   ON up.shop_id = sa.upline_shop_id AND up.package_id = sp.package_id
  WHERE up.sub_price IS NOT NULL
    AND sp.selling_price < up.sub_price

  UNION ALL

  SELECT
    sp.shop_id, sp.package_id, spf.owner_id, 'subagent'::text AS role,
    sp.selling_price,
    public.effective_owner_cost(dp.price, dp.agent_price, dp.dealer_price, ru.role)
      + COALESCE(
          (SELECT sap.markup FROM public.sub_agent_pricing sap
           WHERE sap.sub_user_id = spf.owner_id AND sap.product_type = 'data' AND sap.product_ref = sp.package_id::text),
          (SELECT sadp.markup FROM public.sub_agent_default_pricing sadp
           WHERE sadp.recruiter_id = sa.upline_user_id AND sadp.product_type = 'data' AND sadp.product_ref = sp.package_id::text),
          0
        ) AS owner_cost,
    sp.sub_price
  FROM public.shop_pricing sp
  JOIN public.shop_profiles spf ON spf.id = sp.shop_id
  JOIN public.sub_agents sa     ON sa.user_id = spf.owner_id AND sa.status = 'active' AND sa.upline_user_id IS NOT NULL AND sa.upline_shop_id IS NULL
  JOIN public.users ru          ON ru.id = sa.upline_user_id
  JOIN public.data_packages dp  ON dp.id = sp.package_id
  WHERE sp.selling_price <= (
    public.effective_owner_cost(dp.price, dp.agent_price, dp.dealer_price, ru.role)
    + COALESCE(
        (SELECT sap.markup FROM public.sub_agent_pricing sap
         WHERE sap.sub_user_id = spf.owner_id AND sap.product_type = 'data' AND sap.product_ref = sp.package_id::text),
        (SELECT sadp.markup FROM public.sub_agent_default_pricing sadp
         WHERE sadp.recruiter_id = sa.upline_user_id AND sadp.product_type = 'data' AND sadp.product_ref = sp.package_id::text),
        0
      )
  );
$function$;

-- 20260928_subagent_password_reset_and_cap.sql
--
-- Two independent changes to the sub-agent feature:
-- 1. Adds must_change_password to sub_agents, defaulting true, and
--    retroactively sets it true for every existing row (including
--    legacy shop-invite rows and suspended/pending ones — checked again
--    at login time so a reactivated sub is still prompted).
-- 2. Raises the platform-wide recruit cap from 5 to 50
--    (shop_global_settings.sub_agent_max_recruits), per product decision
--    2026-09-28.

ALTER TABLE public.sub_agents
    ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT true;

UPDATE public.sub_agents
    SET must_change_password = true;

UPDATE public.shop_global_settings
    SET value = '50'
    WHERE key = 'sub_agent_max_recruits';

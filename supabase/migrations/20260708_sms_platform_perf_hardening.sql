-- ============================================================================
-- KFT SMS PLATFORM — performance hardening (post-launch advisor findings)
--
-- Applied after the initial 3 SMS migrations landed clean on security (0
-- sms_* findings). These are PERFORMANCE-only advisor findings, fixed while
-- the tables are empty and the feature is still off:
--
--  1. RLS policies calling auth.uid() directly are re-evaluated PER ROW.
--     ALTER POLICY to (select auth.uid()) makes Postgres evaluate it once
--     per statement (InitPlan) instead — same semantics, faster at scale.
--     https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select
--  2. Five foreign keys had no covering index (slow cascade deletes / joins).
--
-- Safe to re-run: ALTER POLICY is idempotent-in-effect, indexes use
-- IF NOT EXISTS.
-- ============================================================================

-- ── 1. RLS: auth.uid() → (select auth.uid()) ────────────────────────────────

ALTER POLICY sms_accounts_owner_select ON sms_accounts
    USING (user_id = (select auth.uid()));

ALTER POLICY sms_business_profiles_owner_select ON sms_business_profiles
    USING (EXISTS (
        SELECT 1 FROM sms_accounts a
        WHERE a.id = sms_business_profiles.account_id AND a.user_id = (select auth.uid())
    ));

ALTER POLICY sms_campaigns_owner_select ON sms_campaigns
    USING (EXISTS (
        SELECT 1 FROM sms_accounts a
        WHERE a.id = sms_campaigns.account_id AND a.user_id = (select auth.uid())
    ));

ALTER POLICY sms_contact_groups_owner_all ON sms_contact_groups
    USING (EXISTS (
        SELECT 1 FROM sms_accounts a
        WHERE a.id = sms_contact_groups.account_id AND a.user_id = (select auth.uid())
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM sms_accounts a
        WHERE a.id = sms_contact_groups.account_id AND a.user_id = (select auth.uid())
    ));

ALTER POLICY sms_credit_ledger_owner_select ON sms_credit_ledger
    USING (EXISTS (
        SELECT 1 FROM sms_accounts a
        WHERE a.id = sms_credit_ledger.account_id AND a.user_id = (select auth.uid())
    ));

ALTER POLICY sms_group_contacts_owner_all ON sms_group_contacts
    USING (EXISTS (
        SELECT 1 FROM sms_contact_groups g JOIN sms_accounts a ON a.id = g.account_id
        WHERE g.id = sms_group_contacts.group_id AND a.user_id = (select auth.uid())
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM sms_contact_groups g JOIN sms_accounts a ON a.id = g.account_id
        WHERE g.id = sms_group_contacts.group_id AND a.user_id = (select auth.uid())
    ));

ALTER POLICY sms_messages_owner_select ON sms_messages
    USING (EXISTS (
        SELECT 1 FROM sms_accounts a
        WHERE a.id = sms_messages.account_id AND a.user_id = (select auth.uid())
    ));

ALTER POLICY sms_purchases_owner_select ON sms_purchases
    USING (user_id = (select auth.uid()));

ALTER POLICY sms_sender_ids_owner_select ON sms_sender_ids
    USING (EXISTS (
        SELECT 1 FROM sms_accounts a
        WHERE a.id = sms_sender_ids.account_id AND a.user_id = (select auth.uid())
    ));

ALTER POLICY sms_user_templates_owner_all ON sms_user_templates
    USING (EXISTS (
        SELECT 1 FROM sms_accounts a
        WHERE a.id = sms_user_templates.account_id AND a.user_id = (select auth.uid())
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM sms_accounts a
        WHERE a.id = sms_user_templates.account_id AND a.user_id = (select auth.uid())
    ));

ALTER POLICY sms_wallets_owner_select ON sms_wallets
    USING (EXISTS (
        SELECT 1 FROM sms_accounts a
        WHERE a.id = sms_wallets.account_id AND a.user_id = (select auth.uid())
    ));

-- ── 2. Missing FK covering indexes ───────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_sms_purchases_user_id ON sms_purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_sms_purchases_bundle_id ON sms_purchases(bundle_id);
CREATE INDEX IF NOT EXISTS idx_sms_business_profiles_reviewed_by ON sms_business_profiles(reviewed_by);
CREATE INDEX IF NOT EXISTS idx_sms_contact_groups_account_id ON sms_contact_groups(account_id);
CREATE INDEX IF NOT EXISTS idx_sms_user_templates_account_id ON sms_user_templates(account_id);

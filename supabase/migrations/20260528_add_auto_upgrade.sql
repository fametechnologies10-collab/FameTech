-- Add auto-upgrade fields to users table
-- auto_upgrade_enabled: user opts in to automatic renewal on expiry
-- auto_upgrade_plan: which plan to auto-renew ('3d','14d','30d','permanent' for agent; '6m' for dealer)

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS auto_upgrade_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS auto_upgrade_plan TEXT CHECK (auto_upgrade_plan IN ('3d', '14d', '30d', 'permanent', '6m'));

-- Index for the cron job — only scan users who have it enabled
CREATE INDEX IF NOT EXISTS idx_users_auto_upgrade_enabled
    ON public.users (auto_upgrade_enabled)
    WHERE auto_upgrade_enabled = TRUE;

COMMENT ON COLUMN public.users.auto_upgrade_enabled IS 'Whether the user has opted in to automatic role renewal from wallet balance';
COMMENT ON COLUMN public.users.auto_upgrade_plan IS 'Plan to auto-renew when auto_upgrade_enabled is true (3d|14d|30d|permanent for agent; 6m for dealer)';

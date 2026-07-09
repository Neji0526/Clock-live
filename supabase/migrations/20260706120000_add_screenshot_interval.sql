
-- Admin-configurable screenshot capture interval (minutes), applied team-wide.
-- The desktop agent reads this from app_config and captures one screenshot per
-- interval on every platform (Windows, Linux, macOS). Default 10 minutes.
ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS screenshot_interval_minutes integer NOT NULL DEFAULT 10
  CONSTRAINT app_config_screenshot_interval_chk CHECK (screenshot_interval_minutes BETWEEN 1 AND 60);

-- Re-issue the column-level SELECT grant so non-admin authenticated users (and
-- the desktop agent's authenticated session) can read the new column, while the
-- billing_* columns stay hidden. Mirrors 20260705142325.
REVOKE SELECT ON public.app_config FROM authenticated;
GRANT SELECT (id, screenshot_retention_days, updated_at, idle_threshold_sec, max_break_sec, low_engagement_minutes, session_timeout_minutes, heartbeat_sec, screenshot_interval_minutes) ON public.app_config TO authenticated;

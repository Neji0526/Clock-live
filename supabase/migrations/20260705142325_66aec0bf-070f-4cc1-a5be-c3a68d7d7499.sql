
-- 1. app_config: column-level grants (hide billing_* from non-admins)
REVOKE SELECT ON public.app_config FROM authenticated;
GRANT SELECT (id, screenshot_retention_days, updated_at, idle_threshold_sec, max_break_sec, low_engagement_minutes, session_timeout_minutes, heartbeat_sec) ON public.app_config TO authenticated;

-- 2. clients: column-level grants (hide bill_rate_cents, bill_currency from non-admins)
REVOKE SELECT ON public.clients FROM authenticated;
GRANT SELECT (id, name, archived, created_at) ON public.clients TO authenticated;

-- 3. profiles: attach guard triggers and tighten self-update policy
DROP POLICY IF EXISTS "profiles self update" ON public.profiles;
CREATE POLICY "profiles self update" ON public.profiles
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP TRIGGER IF EXISTS trg_guard_profile_privileged_fields ON public.profiles;
CREATE TRIGGER trg_guard_profile_privileged_fields
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_privileged_fields();

DROP TRIGGER IF EXISTS trg_guard_profile_privileged_insert ON public.profiles;
CREATE TRIGGER trg_guard_profile_privileged_insert
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_privileged_insert();

-- 4. Revoke anon EXECUTE on SECURITY DEFINER functions not intended to be public.
--    get_client_share_billable is intentionally callable by anon (public share tokens).
REVOKE EXECUTE ON FUNCTION public.bridge_session_idle_and_close(uuid, timestamptz) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.bump_session_heartbeat_engagement() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.tg_open_default_work_segment() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.start_break(uuid, text, text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_break(uuid, text, text) TO authenticated;

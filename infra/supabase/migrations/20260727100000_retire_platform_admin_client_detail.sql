-- Retire public.platform_admin_client_detail.
--
-- Resolves the duplication flagged in infra/supabase/SCHEMA-DRIFT.md between this
-- function and public.platform_admin_tenant_detail. They overlap in purpose and
-- take the same argument (target_tenant_id uuid), and having both invites them to
-- drift apart.
--
-- platform_admin_tenant_detail is the one that survives:
--   * it is the only one called from application code
--     (apps/console/src/lib/supabase/platform-rpc.ts),
--   * it is covered by apps/console/test/client-action-contract.test.ts, and
--   * it is the one infra/supabase/scripts/verify-structure.mjs asserts.
--
-- platform_admin_client_detail has zero callers anywhere in the repository. It
-- arrived via the 2026-07-24 hand-applied migrations and was recovered into source
-- control on 2026-07-27 as 20260724213043_platform_admin_client_detail.sql. That
-- file is the reason this drop is safe rather than one-way: the full body is in
-- git, so recreating it is a revert away.
--
-- Not a security fix. The function authorises itself with
-- public.platform_admin_is_authorized() and returns {"ok": false, "code":
-- "access_denied"} to anyone else, so leaving it in place was not an exposure.
-- This is dead-code removal.

begin;

drop function if exists public.platform_admin_client_detail(uuid);

commit;

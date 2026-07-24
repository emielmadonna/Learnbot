begin;

-- These tables are private implementation details. They are read and mutated
-- through owner-owned SECURITY DEFINER routines or the server-only
-- service_role boundary; they are not a browser/Data API surface.
--
-- Do not add a broad authenticated policy here. The existing grants already
-- deny anon/authenticated table access, while the postgres owner and
-- service_role retain the privileged paths required by the application.
-- RLS is enabled as defense in depth, but FORCE is intentionally omitted so
-- owner-owned SECURITY DEFINER routines continue to work without a policy
-- designed for direct client access.

alter table app_private.supabase_auth_principal_links
  enable row level security;

alter table app_private.user_access_accounts
  enable row level security;

alter table app_private.tenant_owner_claims
  enable row level security;

alter table app_private.supabase_auth_tenant_selections
  enable row level security;

alter table app_private.learning_operation_secrets
  enable row level security;

commit;

begin;

alter table app_private.supabase_auth_principal_links enable row level security;
alter table app_private.user_access_accounts enable row level security;
alter table app_private.tenant_owner_claims enable row level security;
alter table app_private.supabase_auth_tenant_selections enable row level security;
alter table app_private.learning_operation_secrets enable row level security;

commit;

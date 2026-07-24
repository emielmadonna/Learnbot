-- Durable, opaque identity facts for verified authentication, tenant
-- memberships, service principals, invitations and SCIM. The legacy
-- memberships table remains untouched because it assumes UUID actors and a
-- smaller SQL-era role vocabulary.

begin;

create table public.identity_principals (
  principal_id text primary key check (length(principal_id) between 1 and 512),
  principal_kind text not null check (principal_kind in ('human', 'service')),
  authentication_method text not null
    check (authentication_method in (
      'oidc', 'saml', 'host_signed', 'service_principal'
    )),
  issuer text not null check (length(issuer) between 1 and 2048),
  subject text not null check (length(subject) between 1 and 2048),
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  unique (authentication_method, issuer, subject),
  check (
    (principal_kind = 'service' and authentication_method = 'service_principal')
    or
    (principal_kind = 'human' and authentication_method <> 'service_principal')
  )
);
create unique index identity_principals_idempotency_uq
  on public.identity_principals (idempotency_key)
  where idempotency_key is not null;

create table public.identity_memberships (
  membership_id text not null check (length(membership_id) between 1 and 512),
  tenant_id uuid not null references public.tenants(tenant_id),
  principal_id text not null references public.identity_principals(principal_id),
  role text not null check (role in (
    'tenant_owner', 'tenant_admin', 'creator', 'teacher', 'student', 'service'
  )),
  status text not null default 'active'
    check (status in ('active', 'suspended', 'revoked')),
  provisioned_by text not null
    check (provisioned_by in ('invitation', 'scim', 'manual', 'host')),
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null check (length(idempotency_key) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  primary key (tenant_id, membership_id),
  unique (tenant_id, principal_id),
  unique (tenant_id, membership_id, principal_id),
  unique (tenant_id, idempotency_key),
  check (deleted_at is null or status = 'revoked')
);
create index identity_memberships_principal_active_idx
  on public.identity_memberships (principal_id, tenant_id, membership_id)
  where status = 'active' and deleted_at is null;
create index identity_memberships_tenant_role_idx
  on public.identity_memberships (tenant_id, role, status);

create table public.identity_service_principals (
  service_principal_id text not null
    check (length(service_principal_id) between 1 and 512),
  tenant_id uuid not null references public.tenants(tenant_id),
  client_id text not null check (length(client_id) between 1 and 512),
  principal_id text not null references public.identity_principals(principal_id),
  status text not null default 'active'
    check (status in ('active', 'revoked')),
  scopes text[] not null default '{}'::text[]
    check (array_position(scopes, '') is null),
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null check (length(idempotency_key) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  primary key (tenant_id, service_principal_id),
  unique (tenant_id, client_id),
  unique (tenant_id, idempotency_key),
  check (deleted_at is null or status = 'revoked')
);
create unique index identity_service_principals_client_uq
  on public.identity_service_principals (client_id);

create table public.identity_invitations (
  invitation_id text not null check (length(invitation_id) between 1 and 512),
  tenant_id uuid not null references public.tenants(tenant_id),
  email_normalized text not null
    check (
      email_normalized = lower(btrim(email_normalized))
      and length(email_normalized) between 3 and 320
    ),
  role text not null check (role in (
    'tenant_owner', 'tenant_admin', 'creator', 'teacher', 'student'
  )),
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz not null,
  accepted_by_principal_id text
    references public.identity_principals(principal_id),
  accepted_at timestamptz,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null check (length(idempotency_key) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  primary key (tenant_id, invitation_id),
  unique (tenant_id, idempotency_key),
  check (
    (status = 'accepted'
      and accepted_by_principal_id is not null
      and accepted_at is not null)
    or
    (status <> 'accepted'
      and accepted_by_principal_id is null
      and accepted_at is null)
  )
);
create unique index identity_invitations_id_uq
  on public.identity_invitations (invitation_id);
create index identity_invitations_pending_idx
  on public.identity_invitations (tenant_id, email_normalized, expires_at)
  where status = 'pending' and deleted_at is null;

create table public.identity_invitation_acceptances (
  acceptance_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  invitation_id text not null,
  principal_id text not null references public.identity_principals(principal_id),
  membership_id text not null,
  record_version bigint not null default 1 check (record_version = 1),
  idempotency_key text not null check (length(idempotency_key) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, invitation_id)
    references public.identity_invitations(tenant_id, invitation_id),
  foreign key (tenant_id, membership_id, principal_id)
    references public.identity_memberships(
      tenant_id, membership_id, principal_id
    ),
  unique (tenant_id, invitation_id, idempotency_key),
  check (deleted_at is null)
);

create table public.identity_scim_bindings (
  scim_binding_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  external_id text not null check (length(external_id) between 1 and 512),
  principal_id text not null references public.identity_principals(principal_id),
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null check (length(idempotency_key) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  unique (tenant_id, external_id),
  unique (tenant_id, idempotency_key)
);
create index identity_scim_bindings_principal_idx
  on public.identity_scim_bindings (tenant_id, principal_id);

create table public.identity_scim_receipts (
  scim_receipt_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  membership_id text not null,
  principal_id text not null,
  role text not null check (role in (
    'tenant_owner', 'tenant_admin', 'creator', 'teacher', 'student', 'service'
  )),
  status text not null check (status in ('active', 'suspended', 'revoked')),
  provisioned_by text not null check (provisioned_by = 'scim'),
  membership_created_at timestamptz not null,
  membership_updated_at timestamptz not null,
  record_version bigint not null default 1 check (record_version = 1),
  idempotency_key text not null check (length(idempotency_key) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, membership_id, principal_id)
    references public.identity_memberships(
      tenant_id, membership_id, principal_id
    ),
  unique (tenant_id, idempotency_key),
  check (deleted_at is null)
);

-- Bootstrap membership discovery is deliberately server-only and matches one
-- exact opaque principal. It is used before a tenant JWT can exist.
create or replace function app_private.list_active_identity_memberships(
  target_principal_id text
)
returns table (
  membership_id text,
  tenant_id uuid,
  principal_id text,
  role text,
  status text,
  provisioned_by text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    m.membership_id, m.tenant_id, m.principal_id, m.role, m.status,
    m.provisioned_by, m.created_at, m.updated_at
  from public.identity_memberships m
  where target_principal_id is not null
    and length(target_principal_id) > 0
    and m.principal_id = target_principal_id
    and m.status = 'active'
    and m.deleted_at is null;
$$;

create or replace function app_private.resolve_identity_invitation_tenant(
  target_invitation_id text
)
returns table (tenant_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select i.tenant_id
  from public.identity_invitations i
  where target_invitation_id is not null
    and length(target_invitation_id) > 0
    and i.invitation_id = target_invitation_id
    and i.deleted_at is null;
$$;

create or replace function
  app_private.resolve_identity_service_principal_tenant(
    target_client_id text
  )
returns table (tenant_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select s.tenant_id
  from public.identity_service_principals s
  where target_client_id is not null
    and length(target_client_id) > 0
    and s.client_id = target_client_id
    and s.deleted_at is null;
$$;

-- Append-only receipt facts cannot be rewritten, including by privileged
-- database roles.
create trigger identity_invitation_acceptances_reject_update
before update on public.identity_invitation_acceptances
for each row execute function app_private.reject_mutation();
create trigger identity_invitation_acceptances_reject_delete
before delete on public.identity_invitation_acceptances
for each row execute function app_private.reject_mutation();
create trigger identity_scim_receipts_reject_update
before update on public.identity_scim_receipts
for each row execute function app_private.reject_mutation();
create trigger identity_scim_receipts_reject_delete
before delete on public.identity_scim_receipts
for each row execute function app_private.reject_mutation();

alter table public.identity_principals enable row level security;
alter table public.identity_principals force row level security;
alter table public.identity_memberships enable row level security;
alter table public.identity_memberships force row level security;
alter table public.identity_service_principals enable row level security;
alter table public.identity_service_principals force row level security;
alter table public.identity_invitations enable row level security;
alter table public.identity_invitations force row level security;
alter table public.identity_invitation_acceptances enable row level security;
alter table public.identity_invitation_acceptances force row level security;
alter table public.identity_scim_bindings enable row level security;
alter table public.identity_scim_bindings force row level security;
alter table public.identity_scim_receipts enable row level security;
alter table public.identity_scim_receipts force row level security;

-- Opaque principal IDs cannot be compared to the legacy UUID `sub` helper.
-- Browser-authenticated access therefore fails closed. Identity persistence is
-- a trusted-server boundary using service_role plus explicit tenant predicates.
create policy identity_principals_deny_authenticated
  on public.identity_principals for all to authenticated
  using (false) with check (false);
create policy identity_memberships_deny_authenticated
  on public.identity_memberships for all to authenticated
  using (false) with check (false);
create policy identity_service_principals_deny_authenticated
  on public.identity_service_principals for all to authenticated
  using (false) with check (false);
create policy identity_invitations_deny_authenticated
  on public.identity_invitations for all to authenticated
  using (false) with check (false);
create policy identity_invitation_acceptances_deny_authenticated
  on public.identity_invitation_acceptances for all to authenticated
  using (false) with check (false);
create policy identity_scim_bindings_deny_authenticated
  on public.identity_scim_bindings for all to authenticated
  using (false) with check (false);
create policy identity_scim_receipts_deny_authenticated
  on public.identity_scim_receipts for all to authenticated
  using (false) with check (false);

revoke all on table
  public.identity_principals,
  public.identity_memberships,
  public.identity_service_principals,
  public.identity_invitations,
  public.identity_invitation_acceptances,
  public.identity_scim_bindings,
  public.identity_scim_receipts
from anon, authenticated;

grant usage on schema app_private to service_role;
grant execute on function
  app_private.list_active_identity_memberships(text),
  app_private.resolve_identity_invitation_tenant(text),
  app_private.resolve_identity_service_principal_tenant(text)
to service_role;
revoke all on function
  app_private.list_active_identity_memberships(text),
  app_private.resolve_identity_invitation_tenant(text),
  app_private.resolve_identity_service_principal_tenant(text)
from public, anon, authenticated;

grant select, insert, update on table
  public.identity_principals,
  public.identity_memberships,
  public.identity_service_principals,
  public.identity_invitations,
  public.identity_invitation_acceptances,
  public.identity_scim_bindings,
  public.identity_scim_receipts
to service_role;

commit;

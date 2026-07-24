-- Tenant-scoped onboarding state, checklist evidence and opaque-principal
-- audit facts. Invitation and membership lifecycle remains in migration 0008.
-- O-07/O-13 references are nullable by design and launch remains an
-- application-level fail-closed gate until approved policy records exist.

begin;

create table public.onboarding_workspaces (
  onboarding_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  status text not null default 'draft'
    check (status in (
      'draft', 'in_progress', 'blocked', 'ready_for_review',
      'ready_for_launch', 'live'
    )),
  circle_plan text not null default 'unconfirmed'
    check (circle_plan in (
      'unconfirmed', 'professional', 'business_plus', 'not_circle'
    )),
  expected_identity_mode text not null default 'unconfirmed'
    check (expected_identity_mode in (
      'unconfirmed', 'self_reported', 'verified'
    )),
  owner_membership_id text,
  recording_policy_ref text,
  retention_policy_ref text,
  launched_at timestamptz,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null check (length(idempotency_key) between 1 and 256),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  unique (tenant_id),
  unique (tenant_id, onboarding_id),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, owner_membership_id)
    references public.identity_memberships(tenant_id, membership_id),
  check (
    (status = 'live' and launched_at is not null)
    or
    (status <> 'live' and launched_at is null)
  ),
  check (deleted_at is null),
  check (
    (circle_plan = 'professional'
      and expected_identity_mode = 'self_reported')
    or
    (circle_plan = 'business_plus'
      and expected_identity_mode = 'verified')
    or
    (circle_plan = 'not_circle'
      and expected_identity_mode in ('unconfirmed', 'verified'))
    or
    (circle_plan = 'unconfirmed'
      and expected_identity_mode = 'unconfirmed')
  )
);
create index onboarding_workspaces_status_idx
  on public.onboarding_workspaces (status, updated_at desc);
create index onboarding_workspaces_owner_idx
  on public.onboarding_workspaces (tenant_id, owner_membership_id)
  where owner_membership_id is not null;

create table public.onboarding_steps (
  onboarding_step_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  onboarding_id uuid not null,
  step_key text not null check (step_key in (
    'tenant_profile',
    'identity_mode',
    'provider_funding',
    'source_ingestion',
    'assistant_voice_guide',
    'diagram_review',
    'context_mapping',
    'widget_branding',
    'privacy_consent',
    'recording_policy',
    'retention_policy',
    'playground_qa',
    'install_verification',
    'client_handoff'
  )),
  status text not null default 'not_started'
    check (status in (
      'not_started', 'in_progress', 'complete', 'blocked', 'not_applicable'
    )),
  required boolean not null default true,
  evidence_ref text,
  completed_by_principal_id text
    references public.identity_principals(principal_id),
  completed_at timestamptz,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null check (length(idempotency_key) between 1 and 256),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, onboarding_id)
    references public.onboarding_workspaces(tenant_id, onboarding_id),
  unique (tenant_id, onboarding_id, step_key),
  unique (tenant_id, idempotency_key),
  check (
    (status = 'complete'
      and completed_by_principal_id is not null
      and completed_at is not null)
    or
    (status <> 'complete'
      and completed_by_principal_id is null
      and completed_at is null)
  ),
  check (deleted_at is null)
);
create index onboarding_steps_readiness_idx
  on public.onboarding_steps (
    tenant_id, onboarding_id, required, status, step_key
  );

-- The legacy audit_ledger uses UUID actors. Verified OIDC/SAML/service
-- principals are intentionally opaque text identifiers, so identity and
-- onboarding actions use a separate append-only ledger.
create table public.identity_audit_events (
  identity_audit_event_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  actor_principal_id text
    references public.identity_principals(principal_id),
  action text not null check (length(action) between 1 and 256),
  outcome text not null check (outcome in ('allowed', 'denied')),
  resource_type text not null check (length(resource_type) between 1 and 128),
  resource_id text not null check (length(resource_id) between 1 and 512),
  request_id text not null check (length(request_id) between 1 and 512),
  trace_id text not null check (length(trace_id) between 1 and 512),
  safe_metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  record_version bigint not null default 1 check (record_version = 1),
  idempotency_key text not null check (length(idempotency_key) between 1 and 256),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  unique (tenant_id, identity_audit_event_id),
  unique (tenant_id, idempotency_key),
  check (deleted_at is null),
  check (jsonb_typeof(safe_metadata) = 'object')
);
create index identity_audit_events_resource_idx
  on public.identity_audit_events (
    tenant_id, resource_type, resource_id, occurred_at desc
  );
create index identity_audit_events_trace_idx
  on public.identity_audit_events (tenant_id, trace_id, occurred_at);

create trigger identity_audit_events_reject_update
before update on public.identity_audit_events
for each row execute function app_private.reject_mutation();
create trigger identity_audit_events_reject_delete
before delete on public.identity_audit_events
for each row execute function app_private.reject_mutation();

alter table public.onboarding_workspaces enable row level security;
alter table public.onboarding_workspaces force row level security;
alter table public.onboarding_steps enable row level security;
alter table public.onboarding_steps force row level security;
alter table public.identity_audit_events enable row level security;
alter table public.identity_audit_events force row level security;

-- Browser roles do not receive direct onboarding/identity-table access.
-- Authenticated UI requests go through the verified server boundary, which
-- supplies the tenant predicate for every statement.
create policy onboarding_workspaces_deny_authenticated
  on public.onboarding_workspaces for all to authenticated
  using (false) with check (false);
create policy onboarding_steps_deny_authenticated
  on public.onboarding_steps for all to authenticated
  using (false) with check (false);
create policy identity_audit_events_deny_authenticated
  on public.identity_audit_events for all to authenticated
  using (false) with check (false);

revoke all on table
  public.onboarding_workspaces,
  public.onboarding_steps,
  public.identity_audit_events
from anon, authenticated;

grant select, insert, update on table
  public.onboarding_workspaces,
  public.onboarding_steps
to service_role;
grant select, insert on table public.identity_audit_events to service_role;

commit;

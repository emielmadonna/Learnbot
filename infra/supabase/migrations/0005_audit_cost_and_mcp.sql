-- Append-only operating ledgers and deny-by-default MCP authorization facts.

begin;

create table public.audit_ledger (
  audit_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  actor_id uuid,
  actor_type text not null
    check (actor_type in ('student', 'creator', 'owner', 'system', 'agent')),
  actor_role text,
  action text not null,
  resource_type text not null,
  resource_id text,
  policy_decision text not null
    check (policy_decision in ('allow', 'deny', 'not_applicable')),
  decision_reason text,
  before_hash text,
  after_hash text,
  change_ref text,
  request_id text,
  trace_id text not null,
  source_ip_hash text,
  user_agent_hash text,
  record_version bigint not null default 1 check (record_version = 1),
  idempotency_key text not null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz not null,
  supersedes_audit_id uuid,
  foreign key (tenant_id, supersedes_audit_id)
    references public.audit_ledger(tenant_id, audit_id),
  unique (tenant_id, audit_id),
  unique (tenant_id, idempotency_key),
  check (deleted_at is null)
);
create index audit_ledger_resource_idx
  on public.audit_ledger (tenant_id, resource_type, resource_id, occurred_at desc);
create index audit_ledger_trace_idx
  on public.audit_ledger (tenant_id, trace_id, occurred_at);

create trigger audit_ledger_reject_update
before update on public.audit_ledger
for each row execute function app_private.reject_mutation();
create trigger audit_ledger_reject_delete
before delete on public.audit_ledger
for each row execute function app_private.reject_mutation();

create table public.cost_ledger (
  cost_entry_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  request_id text,
  trace_id text not null,
  job_id uuid,
  conversation_id uuid,
  capability text not null,
  provider_key text not null,
  model_key text,
  quantity numeric(20,6) not null check (quantity >= 0),
  unit text not null,
  estimated_cost_minor bigint not null default 0 check (estimated_cost_minor >= 0),
  final_cost_minor bigint check (final_cost_minor is null or final_cost_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  funding_source text not null
    check (funding_source in ('platform', 'tenant_byok')),
  attempt_number integer not null default 1 check (attempt_number > 0),
  provider_metadata_safe jsonb not null default '{}'::jsonb,
  record_version bigint not null default 1 check (record_version = 1),
  idempotency_key text not null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz not null,
  supersedes_cost_entry_id uuid,
  foreign key (tenant_id, conversation_id)
    references public.conversations(tenant_id, conversation_id),
  foreign key (tenant_id, job_id)
    references public.ingestion_jobs(tenant_id, ingestion_job_id),
  foreign key (tenant_id, supersedes_cost_entry_id)
    references public.cost_ledger(tenant_id, cost_entry_id),
  unique (tenant_id, cost_entry_id),
  unique (tenant_id, idempotency_key),
  check (deleted_at is null)
);
create index cost_ledger_period_idx
  on public.cost_ledger (tenant_id, occurred_at, capability);
create index cost_ledger_trace_idx
  on public.cost_ledger (tenant_id, trace_id);

create trigger cost_ledger_reject_update
before update on public.cost_ledger
for each row execute function app_private.reject_mutation();
create trigger cost_ledger_reject_delete
before delete on public.cost_ledger
for each row execute function app_private.reject_mutation();

create table public.mcp_grants (
  mcp_grant_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  actor_id uuid not null,
  actor_role text not null
    check (actor_role in ('owner', 'client_admin', 'client_viewer', 'student', 'system_worker')),
  server_key text not null,
  tool_pattern text not null,
  permissions text[] not null default '{}'::text[],
  risk_ceiling text not null default 'read'
    check (risk_ceiling in ('read', 'low_write', 'high_write')),
  normalized_input_hash text,
  budget_minor bigint not null default 0 check (budget_minor >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  max_invocations integer not null default 1 check (max_invocations > 0),
  status text not null default 'active'
    check (status in ('active', 'exhausted', 'expired', 'revoked')),
  granted_by uuid not null,
  reason text not null,
  confirmation_token_hash text,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null,
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz not null,
  unique (tenant_id, mcp_grant_id),
  unique (tenant_id, idempotency_key),
  check (expires_at > starts_at),
  check (revoked_at is null or status = 'revoked')
);
create index mcp_grants_authorize_idx
  on public.mcp_grants (
    tenant_id, actor_id, server_key, status, expires_at
  );

create table public.mcp_invocations (
  mcp_invocation_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  mcp_grant_id uuid,
  actor_id uuid not null,
  actor_role text not null
    check (actor_role in ('owner', 'client_admin', 'client_viewer', 'student', 'system_worker')),
  server_key text not null,
  tool_name text not null,
  tool_version text not null,
  risk text not null check (risk in ('read', 'low_write', 'high_write')),
  authorization_decision text not null
    check (authorization_decision in ('allow', 'deny')),
  decision_reason text not null,
  normalized_input_hash text not null,
  input_ref text,
  output_hash text,
  output_ref text,
  status text not null
    check (status in ('authorized', 'denied', 'running', 'succeeded', 'failed', 'cancelled')),
  retry_number integer not null default 0 check (retry_number >= 0),
  estimated_cost_minor bigint not null default 0 check (estimated_cost_minor >= 0),
  final_cost_minor bigint check (final_cost_minor is null or final_cost_minor >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  trace_id text not null,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz not null,
  foreign key (tenant_id, mcp_grant_id)
    references public.mcp_grants(tenant_id, mcp_grant_id),
  unique (tenant_id, mcp_invocation_id),
  unique (tenant_id, idempotency_key),
  check (
    (authorization_decision = 'deny' and status = 'denied')
    or (
      authorization_decision = 'allow'
      and mcp_grant_id is not null
      and status <> 'denied'
    )
  )
);
create index mcp_invocations_trace_idx
  on public.mcp_invocations (tenant_id, trace_id, created_at);
create index mcp_invocations_authorization_idx
  on public.mcp_invocations (
    tenant_id, actor_id, authorization_decision, created_at desc
  );

commit;

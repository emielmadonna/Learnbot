-- Durable command execution, course revision and transactional telemetry
-- primitives. No lifecycle duration is selected here: retain_until remains
-- nullable until the tenant retention policy is approved.

begin;

create table public.course_revisions (
  revision_id text not null,
  tenant_id uuid not null references public.tenants(tenant_id),
  course_id uuid not null,
  revision_number bigint not null check (revision_number > 0),
  revision_kind text not null
    check (revision_kind in ('created', 'edited', 'published', 'rolled_back')),
  command_id text not null,
  actor_id uuid,
  audit_note text,
  rollback_target_revision_number bigint,
  content_hash text not null check (length(content_hash) > 0),
  snapshot jsonb not null,
  record_version bigint not null default 1 check (record_version = 1),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  primary key (tenant_id, revision_id),
  foreign key (tenant_id, course_id)
    references public.courses(tenant_id, course_id),
  unique (tenant_id, course_id, revision_id),
  unique (tenant_id, course_id, revision_number, revision_id),
  unique (tenant_id, course_id, revision_number),
  unique (tenant_id, idempotency_key),
  check (deleted_at is null),
  check (
    (
      revision_kind = 'rolled_back'
      and rollback_target_revision_number is not null
      and rollback_target_revision_number > 0
      and rollback_target_revision_number < revision_number
    )
    or (
      revision_kind <> 'rolled_back'
      and rollback_target_revision_number is null
    )
  )
);
create index course_revisions_course_history_idx
  on public.course_revisions (tenant_id, course_id, revision_number desc);
create index course_revisions_command_idx
  on public.course_revisions (tenant_id, command_id);

create table public.course_revision_heads (
  tenant_id uuid not null,
  course_id uuid not null,
  current_revision_number bigint not null default 0
    check (current_revision_number >= 0),
  current_revision_id text,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  primary key (tenant_id, course_id),
  foreign key (tenant_id, course_id)
    references public.courses(tenant_id, course_id),
  foreign key (
    tenant_id, course_id, current_revision_number, current_revision_id
  ) references public.course_revisions(
    tenant_id, course_id, revision_number, revision_id
  ),
  check (
    (current_revision_number = 0 and current_revision_id is null)
    or (current_revision_number > 0 and current_revision_id is not null)
  )
);

create table public.command_receipts (
  command_receipt_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  scope text not null check (length(scope) > 0),
  idempotency_key text not null check (length(idempotency_key) > 0),
  request_fingerprint text not null check (length(request_fingerprint) > 0),
  command_name text not null check (length(command_name) > 0),
  actor_id uuid,
  status text not null default 'pending'
    check (status in ('pending', 'completed')),
  result jsonb,
  committed_at timestamptz,
  record_version bigint not null default 1 check (record_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  unique (tenant_id, scope, idempotency_key),
  check (deleted_at is null),
  check (
    (status = 'pending' and result is null and committed_at is null)
    or (status = 'completed' and committed_at is not null)
  )
);
create index command_receipts_actor_idx
  on public.command_receipts (tenant_id, actor_id, created_at desc);

create table public.telemetry_outbox (
  outbox_id text not null,
  tenant_id uuid not null references public.tenants(tenant_id),
  idempotency_key text not null check (length(idempotency_key) > 0),
  topic text not null check (length(topic) > 0),
  payload jsonb not null,
  payload_fingerprint text not null check (length(payload_fingerprint) > 0),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'delivered')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null,
  locked_by text,
  locked_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  record_version bigint not null default 1 check (record_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  primary key (tenant_id, outbox_id),
  unique (tenant_id, idempotency_key),
  check (deleted_at is null),
  check (
    (status = 'pending' and locked_by is null and locked_at is null and delivered_at is null)
    or (
      status = 'processing'
      and locked_by is not null
      and locked_at is not null
      and delivered_at is null
    )
    or (
      status = 'delivered'
      and locked_by is null
      and locked_at is null
      and delivered_at is not null
    )
  )
);
create index telemetry_outbox_claim_idx
  on public.telemetry_outbox (
    tenant_id, available_at, created_at, outbox_id
  )
  where status = 'pending';
create index telemetry_outbox_delivery_idx
  on public.telemetry_outbox (tenant_id, status, updated_at);

create or replace function app_private.protect_command_receipt_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.tenant_id is distinct from old.tenant_id
    or new.scope is distinct from old.scope
    or new.idempotency_key is distinct from old.idempotency_key
    or new.request_fingerprint is distinct from old.request_fingerprint
    or new.command_name is distinct from old.command_name
    or new.actor_id is distinct from old.actor_id
    or old.status = 'completed'
  then
    raise exception 'command_receipts identity and completed facts are immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create or replace function app_private.protect_course_revision_head_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.tenant_id is distinct from old.tenant_id
    or new.course_id is distinct from old.course_id
  then
    raise exception 'course_revision_heads tenant and course identity are immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create or replace function app_private.protect_telemetry_outbox_payload()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.tenant_id is distinct from old.tenant_id
    or new.outbox_id is distinct from old.outbox_id
    or new.idempotency_key is distinct from old.idempotency_key
    or new.topic is distinct from old.topic
    or new.payload is distinct from old.payload
    or new.payload_fingerprint is distinct from old.payload_fingerprint
    or old.status = 'delivered'
  then
    raise exception 'telemetry_outbox payload and delivered facts are immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger course_revisions_reject_update
before update on public.course_revisions
for each row execute function app_private.reject_mutation();
create trigger course_revisions_reject_delete
before delete on public.course_revisions
for each row execute function app_private.reject_mutation();

create trigger course_revision_heads_reject_delete
before delete on public.course_revision_heads
for each row execute function app_private.reject_mutation();
create trigger course_revision_heads_protect_update
before update on public.course_revision_heads
for each row execute function app_private.protect_course_revision_head_identity();

create trigger command_receipts_protect_update
before update on public.command_receipts
for each row execute function app_private.protect_command_receipt_identity();
create trigger command_receipts_reject_delete
before delete on public.command_receipts
for each row execute function app_private.reject_mutation();

create trigger telemetry_outbox_protect_update
before update on public.telemetry_outbox
for each row execute function app_private.protect_telemetry_outbox_payload();
create trigger telemetry_outbox_reject_delete
before delete on public.telemetry_outbox
for each row execute function app_private.reject_mutation();

alter table public.course_revisions enable row level security;
alter table public.course_revisions force row level security;
alter table public.course_revision_heads enable row level security;
alter table public.course_revision_heads force row level security;
alter table public.command_receipts enable row level security;
alter table public.command_receipts force row level security;
alter table public.telemetry_outbox enable row level security;
alter table public.telemetry_outbox force row level security;

create policy course_revisions_select on public.course_revisions
  for select to authenticated
  using (app_private.can_manage_tenant(tenant_id));
create policy course_revisions_insert on public.course_revisions
  for insert to authenticated
  with check (app_private.can_manage_tenant(tenant_id));

create policy course_revision_heads_select on public.course_revision_heads
  for select to authenticated
  using (app_private.can_manage_tenant(tenant_id));
create policy course_revision_heads_insert on public.course_revision_heads
  for insert to authenticated
  with check (app_private.can_manage_tenant(tenant_id));
create policy course_revision_heads_update on public.course_revision_heads
  for update to authenticated
  using (app_private.can_manage_tenant(tenant_id))
  with check (app_private.can_manage_tenant(tenant_id));

create policy command_receipts_worker on public.command_receipts
  for all to authenticated
  using (app_private.is_system_worker(tenant_id))
  with check (app_private.is_system_worker(tenant_id));
create policy telemetry_outbox_worker on public.telemetry_outbox
  for all to authenticated
  using (app_private.is_system_worker(tenant_id))
  with check (app_private.is_system_worker(tenant_id));

grant select, insert on public.course_revisions to authenticated;
grant select, insert, update on public.course_revision_heads to authenticated;
grant select, insert, update on
  public.command_receipts,
  public.telemetry_outbox
to authenticated;

revoke all on function app_private.protect_command_receipt_identity() from public;
revoke all on function app_private.protect_course_revision_head_identity() from public;
revoke all on function app_private.protect_telemetry_outbox_payload() from public;

commit;

-- Durable signed-upload intent state and immutable scanner callback receipts.
-- Raw object bytes and provider credentials never enter these tables.

begin;

create table public.upload_intents (
  intent_id text not null check (length(intent_id) between 1 and 512),
  tenant_id uuid not null references public.tenants(tenant_id),
  actor_id text not null check (length(actor_id) between 1 and 512),
  filename text not null check (length(filename) between 1 and 255),
  media_type text not null check (length(media_type) between 1 and 255),
  declared_size_bytes bigint not null check (declared_size_bytes > 0),
  object_key text not null check (length(object_key) between 1 and 1024),
  expires_at timestamptz not null,
  status text not null check (
    status in ('quarantined', 'blocked', 'promotion_failed', 'promoted')
  ),
  disposition text not null default 'quarantine'
    check (disposition = 'quarantine'),
  signed_upload jsonb not null,
  scan_results jsonb not null default '[]'::jsonb
    check (jsonb_typeof(scan_results) = 'array'),
  failure jsonb,
  promotion jsonb,
  promotion_attempts integer not null default 0
    check (promotion_attempts >= 0),
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null check (length(idempotency_key) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  primary key (tenant_id, intent_id),
  unique (intent_id),
  unique (tenant_id, object_key),
  unique (tenant_id, idempotency_key),
  check (deleted_at is null),
  check (
    (status = 'promoted' and promotion is not null and failure is null)
    or
    (
      status in ('blocked', 'promotion_failed')
      and promotion is null
      and failure is not null
    )
    or
    (
      status = 'quarantined'
      and promotion is null
      and failure is null
    )
  )
);
create index upload_intents_owner_status_idx
  on public.upload_intents (tenant_id, actor_id, status, created_at desc);
create index upload_intents_expiry_idx
  on public.upload_intents (tenant_id, expires_at)
  where status = 'quarantined';

create table public.upload_callback_receipts (
  upload_callback_receipt_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  intent_id text not null,
  callback_id text not null check (length(callback_id) between 1 and 512),
  fingerprint text not null check (length(fingerprint) between 1 and 2048),
  record_version bigint not null default 1 check (record_version = 1),
  idempotency_key text not null check (length(idempotency_key) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, intent_id)
    references public.upload_intents(tenant_id, intent_id),
  unique (tenant_id, intent_id, callback_id),
  unique (tenant_id, intent_id, idempotency_key),
  check (deleted_at is null)
);

create or replace function app_private.protect_upload_intent_update()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.tenant_id is distinct from old.tenant_id
    or new.intent_id is distinct from old.intent_id
    or new.actor_id is distinct from old.actor_id
    or new.filename is distinct from old.filename
    or new.media_type is distinct from old.media_type
    or new.declared_size_bytes is distinct from old.declared_size_bytes
    or new.object_key is distinct from old.object_key
    or new.expires_at is distinct from old.expires_at
    or new.disposition is distinct from old.disposition
    or new.signed_upload is distinct from old.signed_upload
    or new.idempotency_key is distinct from old.idempotency_key
    or new.created_at is distinct from old.created_at
    or new.record_version <> old.record_version + 1
    or new.updated_at < old.updated_at
    or new.promotion_attempts < old.promotion_attempts
    or jsonb_array_length(new.scan_results)
      < jsonb_array_length(old.scan_results)
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(old.scan_results)
        with ordinality as prior_scan(value, position)
      where new.scan_results -> ((prior_scan.position - 1)::integer)
        is distinct from prior_scan.value
    )
    or (
      old.status in ('blocked', 'promoted')
      and new is distinct from old
    )
    or (
      old.status = 'promotion_failed'
      and new.status not in ('promotion_failed', 'promoted')
    )
  then
    raise exception 'upload intent identity and terminal facts are immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger upload_intents_protect_update
before update on public.upload_intents
for each row execute function app_private.protect_upload_intent_update();
create trigger upload_intents_reject_delete
before delete on public.upload_intents
for each row execute function app_private.reject_mutation();
create trigger upload_callback_receipts_reject_update
before update on public.upload_callback_receipts
for each row execute function app_private.reject_mutation();
create trigger upload_callback_receipts_reject_delete
before delete on public.upload_callback_receipts
for each row execute function app_private.reject_mutation();

alter table public.upload_intents enable row level security;
alter table public.upload_intents force row level security;
alter table public.upload_callback_receipts enable row level security;
alter table public.upload_callback_receipts force row level security;

-- Opaque identity principals do not use the legacy UUID actor helper.
-- Only a trusted server role may persist callbacks, with exact tenant, actor
-- and intent predicates still required by the adapter.
create policy upload_intents_deny_authenticated
  on public.upload_intents for all to authenticated
  using (false) with check (false);
create policy upload_callback_receipts_deny_authenticated
  on public.upload_callback_receipts for all to authenticated
  using (false) with check (false);

revoke all on table
  public.upload_intents,
  public.upload_callback_receipts
from anon, authenticated;
grant select, insert, update on table public.upload_intents to service_role;
grant select, insert on table public.upload_callback_receipts to service_role;

revoke all on function app_private.protect_upload_intent_update()
from public, anon, authenticated;

commit;

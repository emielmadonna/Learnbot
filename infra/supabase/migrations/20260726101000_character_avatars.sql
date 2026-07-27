-- Phase 9: character avatars (docs/PLAN.md Section 7.1).
--
-- The assistant gets a face: a creator supplies a photo of themselves (or of
-- someone who gave them permission) and a stylized, five-pose character set
-- is generated from it. Three non-negotiables shape this migration:
--
--   1. Consent is a recorded step, never a buried checkbox. A generated set
--      cannot exist without a prior, verbatim-recorded affirmation in
--      public.audit_ledger, tied to the exact photo it names. That tie is
--      enforced in SQL (agent_avatar_create_set below requires a matching
--      audit_ledger row), not just in the calling route, so there is no path
--      — including a direct RPC call — that skips it. Creators generate
--      their OWN avatar: every write RPC here requires tenant_owner or
--      tenant_admin, so there is no path that generates a likeness of a
--      student.
--   2. Metering and image generation itself live in application code
--      (apps/console/src/app/api/agent/avatar/route.ts), calling the same
--      public.learning_reserve_provider_call / learning_record_provider_cost
--      RPCs every other provider call already uses (migration
--      20260726096000). Nothing new is needed here for that — those RPCs
--      already accept any capability key of 1-100 characters.
--   3. Review before publish. A generated set lands in 'pending_review' and
--      only becomes visible as the tenant's live avatar once
--      agent_avatar_review_set publishes it. A generated likeness never
--      auto-publishes.
--
-- Storage reuses the existing tenant-private bucket and
-- "<tenant>/branding/..." key convention from migration 20260725120000 —
-- this migration adds no bucket and no storage policy. Every member of the
-- tenant can already sign a read under that prefix; writes are already
-- restricted to tenant owners/admins. Nothing here changes storage.objects.
--
-- Checked against infra/supabase/SCHEMA-DRIFT.md: this migration creates new
-- objects only (one table, five functions) and does not `create or replace`
-- any function named there, so it cannot revert the live drift.

begin;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table public.agent_avatar_sets (
  avatar_set_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  version_number integer not null check (version_number > 0),
  status text not null default 'pending_review'
    check (status in ('pending_review', 'published', 'retired', 'rejected')),
  source_photo_storage_key text not null
    check (
      length(source_photo_storage_key) between 1 and 1024
      and source_photo_storage_key not like '%..%'
    ),
  provider_key text not null check (length(provider_key) between 1 and 100),
  model_key text
    check (model_key is null or length(model_key) between 1 and 100),
  -- Shape (exactly the five PLAN Section 7.1 poses, each carrying a
  -- tenant-scoped storage key) is validated by
  -- app_private.agent_avatar_poses_valid in the write RPC below rather than
  -- as a table CHECK, because the tenant-scoped prefix it validates against
  -- depends on another column of the same row plus per-key structure that a
  -- CHECK expression cannot express as clearly as PL/pgSQL can.
  poses jsonb not null check (jsonb_typeof(poses) = 'object'),
  consent_audit_id uuid not null,
  consent_recorded_at timestamptz not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_by uuid,
  published_at timestamptz,
  rejected_by uuid,
  rejected_at timestamptz,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null,
  unique (tenant_id, avatar_set_id),
  unique (tenant_id, idempotency_key),
  unique (tenant_id, version_number),
  -- Ties every generated set to a real, previously recorded consent
  -- affirmation. public.audit_ledger is append-only (0005), so this edge can
  -- never be retargeted at a later, different consent record.
  foreign key (tenant_id, consent_audit_id)
    references public.audit_ledger(tenant_id, audit_id),
  check (
    status <> 'published'
    or (published_by is not null and published_at is not null)
  ),
  check (
    status <> 'rejected'
    or (rejected_by is not null and rejected_at is not null)
  )
);

create index agent_avatar_sets_tenant_head_idx
  on public.agent_avatar_sets (tenant_id, version_number desc);
create index agent_avatar_sets_tenant_status_idx
  on public.agent_avatar_sets (tenant_id, status, version_number desc);

-- No direct table access at all, from any role. Every read and write goes
-- through a SECURITY DEFINER RPC below, the same deny-by-default shape as
-- public.provider_rate_events (migration 20260726096000).
alter table public.agent_avatar_sets enable row level security;
alter table public.agent_avatar_sets force row level security;
revoke all on table public.agent_avatar_sets from public, anon, authenticated;
drop policy if exists agent_avatar_sets_no_direct_access
  on public.agent_avatar_sets;
create policy agent_avatar_sets_no_direct_access
  on public.agent_avatar_sets
  for all
  using (false)
  with check (false);

create trigger agent_avatar_sets_set_updated_at
before update on public.agent_avatar_sets
for each row execute function app_private.set_updated_at_and_version();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Exactly the five PLAN Section 7.1 poses, each an object naming a
-- tenant-scoped storage key. No more, no fewer — a partial set never reaches
-- 'pending_review'.
create or replace function app_private.agent_avatar_poses_valid(
  poses jsonb,
  target_tenant_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  asset_prefix text := target_tenant_id::text || '/branding/';
  expected_poses constant text[] :=
    array['idle', 'listening', 'speaking', 'thinking', 'unsure'];
  actual_poses text[];
  pose_key text;
  pose_value jsonb;
  storage_key text;
begin
  if poses is null or jsonb_typeof(poses) <> 'object' then
    return false;
  end if;
  select coalesce(array_agg(key order by key), '{}'::text[])
  into actual_poses
  from jsonb_object_keys(poses) as key;
  if actual_poses <> expected_poses then
    return false;
  end if;
  foreach pose_key in array expected_poses loop
    pose_value := poses -> pose_key;
    if jsonb_typeof(pose_value) <> 'object' then
      return false;
    end if;
    storage_key := pose_value ->> 'storageKey';
    if storage_key is null
      or length(storage_key) = 0
      or length(storage_key) > 1024
      or storage_key not like asset_prefix || '%'
      or storage_key like '%..%'
    then
      return false;
    end if;
  end loop;
  return true;
end;
$$;
revoke execute on function app_private.agent_avatar_poses_valid(jsonb, uuid)
  from public, anon, authenticated, service_role;

-- JSON projection, mirroring app_private.agent_configuration_json's role for
-- public.tenant_branding.
create or replace function app_private.agent_avatar_set_json(
  target_row public.agent_avatar_sets
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select case
    when target_row.avatar_set_id is null then null
    else jsonb_build_object(
      'avatarSetId', target_row.avatar_set_id,
      'versionNumber', target_row.version_number,
      'status', target_row.status,
      'sourcePhotoStorageKey', target_row.source_photo_storage_key,
      'providerKey', target_row.provider_key,
      'modelKey', target_row.model_key,
      'poses', target_row.poses,
      'consentAuditId', target_row.consent_audit_id,
      'consentRecordedAt', target_row.consent_recorded_at,
      'createdAt', target_row.created_at,
      'publishedAt', target_row.published_at,
      'rejectedAt', target_row.rejected_at
    )
  end;
$$;
revoke execute on function app_private.agent_avatar_set_json(
  public.agent_avatar_sets
) from public, anon, authenticated, service_role;

-- Append-only operating evidence for consent and every avatar state change,
-- following the exact shape of app_private.authoring_append_audit /
-- agent_configuration_audit (idempotent insert, 7-year retention) but
-- returning the new row's audit_id — agent_avatar_create_set below must be
-- able to name the consent record it was built from.
create or replace function app_private.agent_avatar_audit(
  target_tenant_id uuid,
  actor_identity_role text,
  audit_action text,
  audit_decision text,
  audit_reason text,
  audit_resource_type text,
  target_resource_id text,
  source_request_id text,
  source_trace_id text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  written_audit_id uuid;
  computed_idempotency_key text := 'agent-avatar-audit:' || encode(
    extensions.digest(
      target_tenant_id::text || chr(31) || audit_action || chr(31) ||
      coalesce(target_resource_id, '') || chr(31) ||
      coalesce(source_request_id, ''),
      'sha256'
    ),
    'hex'
  );
begin
  insert into public.audit_ledger (
    tenant_id, actor_id, actor_type, actor_role, action, resource_type,
    resource_id, policy_decision, decision_reason, request_id, trace_id,
    retain_until, idempotency_key
  ) values (
    target_tenant_id,
    auth.uid(),
    case actor_identity_role
      when 'tenant_owner' then 'owner'
      when 'tenant_admin' then 'owner'
      when 'creator' then 'creator'
      when 'teacher' then 'creator'
      when 'student' then 'student'
      when 'service' then 'system'
      else 'system'
    end,
    actor_identity_role,
    audit_action,
    audit_resource_type,
    target_resource_id,
    audit_decision,
    audit_reason,
    source_request_id,
    source_trace_id,
    now() + interval '7 years',
    computed_idempotency_key
  )
  on conflict (tenant_id, idempotency_key) do nothing;

  select a.audit_id into written_audit_id
  from public.audit_ledger a
  where a.tenant_id = target_tenant_id
    and a.idempotency_key = computed_idempotency_key;

  return written_audit_id;
end;
$$;
revoke execute on function app_private.agent_avatar_audit(
  uuid, text, text, text, text, text, text, text, text
) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Write path: consent, generation record, review
-- ---------------------------------------------------------------------------

-- Records the creator's consent affirmation verbatim, tied to the exact
-- source photo it names. This IS the "designed step, not a buried checkbox"
-- PLAN Section 7.1 requires: the two accepted statements are exact and
-- distinguish "this is me" from "this is someone who gave me permission",
-- and the wording that was agreed to is what lands in
-- audit_ledger.decision_reason — not just a boolean.
create or replace function public.agent_avatar_record_consent(
  source_photo_storage_key text,
  consent_statement text,
  request_id text,
  trace_id text,
  idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  command record;
  result jsonb;
  asset_prefix text;
  normalized_key text := btrim(coalesce(source_photo_storage_key, ''));
  normalized_statement text := btrim(coalesce(consent_statement, ''));
  self_statement constant text :=
    'This is a photo of me. I consent to generating a stylized character likeness from it.';
  permission_statement constant text :=
    'This is a photo of someone else who has given me their permission to generate a stylized character likeness from it.';
  request_fingerprint text;
  written_audit_id uuid;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;
  if request_id is null or length(request_id) not between 1 and 200
    or trace_id is null or length(trace_id) not between 1 and 200
    or idempotency_key is null
    or length(idempotency_key) not between 1 and 256
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  -- Creators generate their own avatar; there is no path here that can
  -- record consent, or generate a set, on behalf of a student.
  if caller.identity_role not in ('tenant_owner', 'tenant_admin') then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  asset_prefix := caller.tenant_id::text || '/branding/';
  if length(normalized_key) = 0
    or length(normalized_key) > 1024
    or normalized_key not like asset_prefix || '%'
    or normalized_key like '%..%'
    or normalized_statement not in (self_statement, permission_statement)
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  request_fingerprint := encode(
    extensions.digest(
      normalized_key || chr(31) || normalized_statement, 'sha256'
    ),
    'hex'
  );
  select * into command
  from app_private.onboarding_begin_command(
    caller.tenant_id, 'agent.avatar.consent', idempotency_key,
    request_fingerprint, 'agent_avatar_record_consent'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    return jsonb_build_object('ok', false, 'code', 'idempotency_conflict');
  end if;

  written_audit_id := app_private.agent_avatar_audit(
    caller.tenant_id, caller.identity_role, 'agent.avatar.consent.recorded',
    'allow', normalized_statement, 'agent_avatar_consent', normalized_key,
    request_id, trace_id
  );

  result := jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', caller.tenant_id,
    'consentAuditId', written_audit_id,
    'sourcePhotoStorageKey', normalized_key,
    'recordedAt', now()
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id, 'agent.avatar.consent', idempotency_key, result
  );
  return result;
end;
$$;

-- Records a completed generation (the application has already called the
-- ImageGenerationProvider, metered it, and written the five pose images to
-- storage — this RPC only records the durable fact). Refuses unless
-- consent_audit_id names a real, matching, previously recorded consent row.
create or replace function public.agent_avatar_create_set(
  consent_audit_id uuid,
  source_photo_storage_key text,
  poses jsonb,
  provider_key text,
  model_key text,
  request_id text,
  trace_id text,
  idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  command record;
  result jsonb;
  consent_found boolean;
  normalized_key text := btrim(coalesce(source_photo_storage_key, ''));
  normalized_provider text := btrim(coalesce(provider_key, ''));
  normalized_model text := nullif(btrim(coalesce(model_key, '')), '');
  request_fingerprint text;
  next_version integer;
  written public.agent_avatar_sets%rowtype;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;
  if request_id is null or length(request_id) not between 1 and 200
    or trace_id is null or length(trace_id) not between 1 and 200
    or idempotency_key is null
    or length(idempotency_key) not between 1 and 256
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if caller.identity_role not in ('tenant_owner', 'tenant_admin') then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  if consent_audit_id is null
    or length(normalized_key) = 0
    or length(normalized_provider) = 0
    or length(normalized_provider) > 100
    or not app_private.agent_avatar_poses_valid(poses, caller.tenant_id)
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select true into consent_found
  from public.audit_ledger a
  where a.tenant_id = caller.tenant_id
    and a.audit_id = consent_audit_id
    and a.action = 'agent.avatar.consent.recorded'
    and a.policy_decision = 'allow'
    and a.resource_id = normalized_key;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'consent_required');
  end if;

  request_fingerprint := encode(
    extensions.digest(
      consent_audit_id::text || chr(31) || normalized_key || chr(31) ||
      poses::text || chr(31) || normalized_provider || chr(31) ||
      coalesce(normalized_model, ''),
      'sha256'
    ),
    'hex'
  );
  select * into command
  from app_private.onboarding_begin_command(
    caller.tenant_id, 'agent.avatar.create', idempotency_key,
    request_fingerprint, 'agent_avatar_create_set'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    return jsonb_build_object('ok', false, 'code', 'idempotency_conflict');
  end if;

  -- Serialise concurrent generations on the tenant row so the version
  -- sequence cannot fork between the read below and the insert.
  perform 1
  from public.tenants t
  where t.tenant_id = caller.tenant_id
    and t.deleted_at is null
  for update;
  if not found then
    result := jsonb_build_object('ok', false, 'code', 'tenant_not_found');
    perform app_private.onboarding_complete_command(
      caller.tenant_id, 'agent.avatar.create', idempotency_key, result
    );
    return result;
  end if;

  select coalesce(max(version_number), 0) + 1 into next_version
  from public.agent_avatar_sets
  where tenant_id = caller.tenant_id;

  insert into public.agent_avatar_sets (
    tenant_id, version_number, status, source_photo_storage_key,
    provider_key, model_key, poses, consent_audit_id, consent_recorded_at,
    created_by, idempotency_key
  ) values (
    caller.tenant_id,
    next_version,
    'pending_review',
    normalized_key,
    normalized_provider,
    normalized_model,
    poses,
    consent_audit_id,
    now(),
    auth.uid(),
    'agent-avatar-set:' || encode(
      extensions.digest(
        caller.tenant_id::text || chr(31) ||
          agent_avatar_create_set.idempotency_key,
        'sha256'
      ),
      'hex'
    )
  )
  returning * into written;

  perform app_private.agent_avatar_audit(
    caller.tenant_id, caller.identity_role, 'agent.avatar.generated', 'allow',
    'pending_review', 'agent_avatar_set', written.avatar_set_id::text,
    request_id, trace_id
  );

  result := jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'avatarSet', app_private.agent_avatar_set_json(written)
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id, 'agent.avatar.create', idempotency_key, result
  );
  return result;
end;
$$;

-- The creator's review decision. A generated likeness never auto-publishes —
-- this is the only path that can move a set out of 'pending_review', and it
-- requires the same tenant_owner/tenant_admin role as generation itself.
create or replace function public.agent_avatar_review_set(
  target_avatar_set_id uuid,
  decision text,
  request_id text,
  trace_id text,
  idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  command record;
  result jsonb;
  normalized_decision text := lower(btrim(coalesce(decision, '')));
  target public.agent_avatar_sets%rowtype;
  request_fingerprint text;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;
  if request_id is null or length(request_id) not between 1 and 200
    or trace_id is null or length(trace_id) not between 1 and 200
    or idempotency_key is null
    or length(idempotency_key) not between 1 and 256
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if caller.identity_role not in ('tenant_owner', 'tenant_admin') then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if target_avatar_set_id is null
    or normalized_decision not in ('publish', 'reject')
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  request_fingerprint := encode(
    extensions.digest(
      target_avatar_set_id::text || chr(31) || normalized_decision, 'sha256'
    ),
    'hex'
  );
  select * into command
  from app_private.onboarding_begin_command(
    caller.tenant_id, 'agent.avatar.review', idempotency_key,
    request_fingerprint, 'agent_avatar_review_set'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    return jsonb_build_object('ok', false, 'code', 'idempotency_conflict');
  end if;

  select * into target
  from public.agent_avatar_sets s
  where s.tenant_id = caller.tenant_id
    and s.avatar_set_id = target_avatar_set_id
  for update;
  if not found then
    result := jsonb_build_object('ok', false, 'code', 'not_found');
    perform app_private.onboarding_complete_command(
      caller.tenant_id, 'agent.avatar.review', idempotency_key, result
    );
    return result;
  end if;
  if target.status <> 'pending_review' then
    result := jsonb_build_object('ok', false, 'code', 'invalid_state');
    perform app_private.onboarding_complete_command(
      caller.tenant_id, 'agent.avatar.review', idempotency_key, result
    );
    return result;
  end if;

  if normalized_decision = 'publish' then
    -- Exactly one published set per tenant. Superseding a live set retires
    -- it rather than deleting it, so the review-and-publish history stays
    -- intact — the same idea tenant_branding's status flip already uses.
    update public.agent_avatar_sets
    set status = 'retired'
    where tenant_id = caller.tenant_id
      and status = 'published';

    update public.agent_avatar_sets
    set status = 'published', published_by = auth.uid(), published_at = now()
    where tenant_id = caller.tenant_id
      and avatar_set_id = target_avatar_set_id
    returning * into target;
  else
    update public.agent_avatar_sets
    set status = 'rejected', rejected_by = auth.uid(), rejected_at = now()
    where tenant_id = caller.tenant_id
      and avatar_set_id = target_avatar_set_id
    returning * into target;
  end if;

  perform app_private.agent_avatar_audit(
    caller.tenant_id,
    caller.identity_role,
    case
      when normalized_decision = 'publish' then 'agent.avatar.published'
      else 'agent.avatar.rejected'
    end,
    'allow',
    normalized_decision,
    'agent_avatar_set',
    target.avatar_set_id::text,
    request_id,
    trace_id
  );

  result := jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'avatarSet', app_private.agent_avatar_set_json(target)
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id, 'agent.avatar.review', idempotency_key, result
  );
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Read path
-- ---------------------------------------------------------------------------

create or replace function public.agent_list_avatar_sets()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;
  if caller.identity_role not in ('tenant_owner', 'tenant_admin') then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', caller.tenant_id,
    'sets', coalesce(
      (
        select jsonb_agg(
          app_private.agent_avatar_set_json(s) order by s.version_number desc
        )
        from (
          select *
          from public.agent_avatar_sets
          where tenant_id = caller.tenant_id
          order by version_number desc
          limit 20
        ) s
      ),
      '[]'::jsonb
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function public.agent_avatar_record_consent(
  text, text, text, text, text
) from public, anon, service_role;
revoke execute on function public.agent_avatar_create_set(
  uuid, text, jsonb, text, text, text, text, text
) from public, anon, service_role;
revoke execute on function public.agent_avatar_review_set(
  uuid, text, text, text, text
) from public, anon, service_role;
revoke execute on function public.agent_list_avatar_sets()
  from public, anon, service_role;

grant execute on function public.agent_avatar_record_consent(
  text, text, text, text, text
) to authenticated;
grant execute on function public.agent_avatar_create_set(
  uuid, text, jsonb, text, text, text, text, text
) to authenticated;
grant execute on function public.agent_avatar_review_set(
  uuid, text, text, text, text
) to authenticated;
grant execute on function public.agent_list_avatar_sets()
  to authenticated;

commit;

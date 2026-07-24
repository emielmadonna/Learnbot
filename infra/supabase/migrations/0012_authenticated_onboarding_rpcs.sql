-- UID-bound onboarding RPCs. Every public function derives tenant, principal
-- and membership from the durable Supabase Auth bridge introduced in 0011.
-- Raw invitation email remains private; O-07/O-13 cannot be completed here.

begin;

create or replace function app_private.onboarding_rpc_context()
returns table (
  tenant_id uuid,
  membership_id text,
  principal_id text,
  identity_role text
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    c.tenant_id,
    c.membership_id,
    c.principal_id,
    c.identity_role
  from app_private.supabase_auth_context_for_user(auth.uid()) c
  join auth.users u on u.id = auth.uid()
  where auth.uid() is not null
    and coalesce(
      (app_private.jwt_claims() ->> 'is_anonymous')::boolean,
      false
    ) is false
    and coalesce(u.email_confirmed_at, u.phone_confirmed_at) is not null
    and u.deleted_at is null;
$$;

create or replace function app_private.onboarding_mask_email(
  normalized_email text
)
returns text
language sql
immutable
security invoker
set search_path = pg_catalog
as $$
  select case
    when normalized_email is null or position('@' in normalized_email) < 2
      then '***'
    else
      left(split_part(normalized_email, '@', 1), 1)
      || '***@'
      || split_part(normalized_email, '@', 2)
  end;
$$;

create or replace function app_private.onboarding_begin_command(
  target_tenant_id uuid,
  command_scope text,
  command_idempotency_key text,
  fingerprint text,
  command_name text
)
returns table (
  command_state text,
  prior_result jsonb
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  inserted_count integer;
  receipt record;
begin
  insert into public.command_receipts (
    tenant_id, scope, idempotency_key, request_fingerprint,
    command_name, actor_id, status
  ) values (
    target_tenant_id, command_scope, command_idempotency_key, fingerprint,
    command_name, null, 'pending'
  )
  on conflict (tenant_id, scope, idempotency_key) do nothing;
  get diagnostics inserted_count = row_count;

  select r.request_fingerprint, r.status, r.result
  into receipt
  from public.command_receipts r
  where r.tenant_id = target_tenant_id
    and r.scope = command_scope
    and r.idempotency_key = command_idempotency_key
  for update;

  if not found then
    command_state := 'invalid_state';
    prior_result := null;
  elsif receipt.request_fingerprint <> fingerprint then
    command_state := 'conflict';
    prior_result := null;
  elsif receipt.status = 'completed' then
    command_state := 'replayed';
    prior_result := receipt.result;
  elsif inserted_count = 1 then
    command_state := 'new';
    prior_result := null;
  else
    command_state := 'invalid_state';
    prior_result := null;
  end if;
  return next;
end;
$$;

create or replace function app_private.onboarding_complete_command(
  target_tenant_id uuid,
  command_scope text,
  command_idempotency_key text,
  command_result jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  update public.command_receipts
  set status = 'completed',
      result = command_result,
      committed_at = clock_timestamp(),
      updated_at = clock_timestamp(),
      record_version = record_version + 1
  where tenant_id = target_tenant_id
    and scope = command_scope
    and idempotency_key = command_idempotency_key
    and status = 'pending';
  if not found then
    raise object_not_in_prerequisite_state
      using message = 'Onboarding command receipt is not pending';
  end if;
end;
$$;

create or replace function app_private.onboarding_append_audit(
  target_tenant_id uuid,
  target_principal_id text,
  audit_action text,
  audit_outcome text,
  target_resource_type text,
  target_resource_id text,
  request_id text,
  trace_id text,
  safe_metadata jsonb
)
returns void
language sql
security definer
set search_path = pg_catalog
as $$
  insert into public.identity_audit_events (
    tenant_id, actor_principal_id, action, outcome, resource_type,
    resource_id, request_id, trace_id, safe_metadata, idempotency_key
  ) values (
    target_tenant_id,
    target_principal_id,
    audit_action,
    audit_outcome,
    target_resource_type,
    target_resource_id,
    request_id,
    trace_id,
    coalesce(safe_metadata, '{}'::jsonb),
    'onboarding-rpc-audit:' ||
      encode(
        extensions.digest(
          target_tenant_id::text || chr(31) ||
          coalesce(target_principal_id, '') || chr(31) ||
          request_id || chr(31) || audit_action || chr(31) || audit_outcome,
          'sha256'
        ),
        'hex'
      )
  )
  on conflict (tenant_id, idempotency_key) do nothing;
$$;

create or replace function app_private.onboarding_snapshot_for_tenant(
  target_tenant_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  with tenant_record as (
    select
      t.tenant_id,
      t.display_name,
      t.slug,
      t.status,
      t.region,
      coalesce(t.settings ->> 'planId', 'unconfirmed') as plan_id
    from public.tenants t
    where t.tenant_id = target_tenant_id
      and t.deleted_at is null
  ),
  workspace as (
    select w.*
    from public.onboarding_workspaces w
    where w.tenant_id = target_tenant_id
      and w.deleted_at is null
  ),
  branding as (
    select b.*
    from public.tenant_branding b
    where b.tenant_id = target_tenant_id
      and b.deleted_at is null
    order by b.version_number desc
    limit 1
  ),
  incomplete as (
    select
      s.step_key || ':' || s.status as blocker
    from public.onboarding_steps s
    where s.tenant_id = target_tenant_id
      and s.required
      and s.status not in ('complete', 'not_applicable')
    union all
    select 'O-07:voice_recording_policy_decision_required'
    from workspace w
    where w.recording_policy_ref is null
    union all
    select 'O-13:retention_policy_decision_required'
    from workspace w
    where w.retention_policy_ref is null
  )
  select jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenant', jsonb_build_object(
      'tenantId', t.tenant_id,
      'displayName', t.display_name,
      'slug', t.slug,
      'status', t.status,
      'planId', t.plan_id,
      'region', t.region
    ),
    'onboarding', jsonb_build_object(
      'onboardingId', w.onboarding_id,
      'status', w.status,
      'version', w.record_version,
      'updatedAt', w.updated_at
    ),
    'branding', jsonb_build_object(
      'version', b.version_number,
      'status', b.status,
      'assistantName', b.assistant_name,
      'primaryColor', b.primary_color,
      'accentColor', b.accent_color,
      'surfaceColor', b.surface_color,
      'textColor', b.text_color,
      'welcomeMessage', b.welcome_message
    ),
    'identity', jsonb_build_object(
      'circlePlan', w.circle_plan,
      'expectedMode', w.expected_identity_mode
    ),
    'steps', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'key', s.step_key,
          'status', s.status,
          'required', s.required,
          'evidenceRef', s.evidence_ref,
          'updatedAt', s.updated_at
        )
        order by s.created_at, s.step_key
      )
      from public.onboarding_steps s
      where s.tenant_id = target_tenant_id
        and s.onboarding_id = w.onboarding_id
    ), '[]'::jsonb),
    'invitations', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'invitationId', i.invitation_id,
          'emailHint', app_private.onboarding_mask_email(i.email_normalized),
          'role', i.role,
          'status', case
            when i.status = 'pending' and i.expires_at <= now()
              then 'expired'
            else i.status
          end,
          'expiresAt', i.expires_at,
          'createdAt', i.created_at
        )
        order by i.created_at desc, i.invitation_id
      )
      from public.identity_invitations i
      where i.tenant_id = target_tenant_id
        and i.deleted_at is null
    ), '[]'::jsonb),
    'launch', jsonb_build_object(
      'ready', not exists (select 1 from incomplete),
      'blockers', coalesce(
        (select jsonb_agg(x.blocker order by x.blocker) from incomplete x),
        '[]'::jsonb
      )
    ),
    'audit', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'eventId', a.identity_audit_event_id,
          'action', a.action,
          'outcome', a.outcome,
          'resourceType', a.resource_type,
          'resourceId', a.resource_id,
          'requestId', a.request_id,
          'traceId', a.trace_id,
          'safeMetadata', a.safe_metadata,
          'occurredAt', a.occurred_at
        )
        order by a.occurred_at desc, a.identity_audit_event_id
      )
      from (
        select *
        from public.identity_audit_events
        where tenant_id = target_tenant_id
        order by occurred_at desc, identity_audit_event_id
        limit 50
      ) a
    ), '[]'::jsonb)
  )
  from tenant_record t
  join workspace w on w.tenant_id = t.tenant_id
  left join branding b on b.tenant_id = t.tenant_id;
$$;

create or replace function public.onboarding_get_snapshot()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  result jsonb;
begin
  select * into caller from app_private.onboarding_rpc_context();
  if not found then
    return jsonb_build_object(
      'ok', false,
      'code', 'tenant_selection_required'
    );
  end if;
  if caller.identity_role not in (
    'tenant_owner', 'tenant_admin', 'creator', 'teacher'
  ) then
    perform app_private.onboarding_append_audit(
      caller.tenant_id, caller.principal_id, 'onboarding.snapshot.read',
      'denied', 'onboarding_workspace', caller.tenant_id::text,
      'snapshot-read:' || auth.uid()::text,
      'snapshot-read:' || auth.uid()::text,
      jsonb_build_object('reason', 'role_not_allowed')
    );
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  result := app_private.onboarding_snapshot_for_tenant(caller.tenant_id);
  if result is null then
    return jsonb_build_object('ok', false, 'code', 'onboarding_not_found');
  end if;
  return result;
end;
$$;

create or replace function public.onboarding_update_tenant_profile(
  requested_display_name text,
  requested_slug text,
  requested_plan_id text,
  requested_assistant_name text,
  requested_primary_color text,
  requested_accent_color text,
  requested_circle_plan text,
  expected_version bigint,
  idempotency_key text,
  request_id text,
  trace_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  command record;
  workspace record;
  result jsonb;
  normalized_slug text := lower(btrim(requested_slug));
  normalized_circle_plan text := lower(btrim(requested_circle_plan));
  expected_mode text;
  request_fingerprint text;
  new_branding_version integer;
begin
  select * into caller from app_private.onboarding_rpc_context();
  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'tenant_selection_required'
    );
  end if;
  if request_id is null or length(request_id) not between 1 and 200
    or trace_id is null or length(trace_id) not between 1 and 200
    or idempotency_key is null
    or length(idempotency_key) not between 1 and 256
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if caller.identity_role not in ('tenant_owner', 'tenant_admin') then
    perform app_private.onboarding_append_audit(
      caller.tenant_id, caller.principal_id, 'onboarding.profile.update',
      'denied', 'onboarding_workspace', caller.tenant_id::text,
      request_id, trace_id, jsonb_build_object('reason', 'role_not_allowed')
    );
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if requested_display_name is null
      or length(btrim(requested_display_name)) not between 1 and 160
    or requested_slug is null
    or normalized_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$'
    or requested_plan_id is null
      or length(btrim(requested_plan_id)) not between 1 and 80
    or requested_assistant_name is null
      or length(btrim(requested_assistant_name)) not between 1 and 80
    or requested_primary_color is null
    or requested_primary_color !~ '^#[0-9A-Fa-f]{6}$'
    or requested_accent_color is null
    or requested_accent_color !~ '^#[0-9A-Fa-f]{6}$'
    or requested_circle_plan is null
    or normalized_circle_plan not in (
      'unconfirmed', 'professional', 'business_plus', 'not_circle'
    )
    or expected_version is null or expected_version < 1
  then
    perform app_private.onboarding_append_audit(
      caller.tenant_id, caller.principal_id, 'onboarding.profile.update',
      'denied', 'onboarding_workspace', caller.tenant_id::text,
      request_id, trace_id, jsonb_build_object('reason', 'invalid_request')
    );
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  expected_mode := case normalized_circle_plan
    when 'professional' then 'self_reported'
    when 'business_plus' then 'verified'
    else 'unconfirmed'
  end;
  request_fingerprint := encode(
    extensions.digest(
      concat_ws(
        chr(31),
        btrim(requested_display_name),
        normalized_slug,
        btrim(requested_plan_id),
        btrim(requested_assistant_name),
        upper(requested_primary_color),
        upper(requested_accent_color),
        normalized_circle_plan,
        expected_version::text
      ),
      'sha256'
    ),
    'hex'
  );
  select * into command
  from app_private.onboarding_begin_command(
    caller.tenant_id, 'onboarding.profile.update', idempotency_key,
    request_fingerprint, 'onboarding_update_tenant_profile'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    perform app_private.onboarding_append_audit(
      caller.tenant_id, caller.principal_id, 'onboarding.profile.update',
      'denied', 'onboarding_workspace', caller.tenant_id::text,
      request_id, trace_id,
      jsonb_build_object('reason', 'idempotency_conflict')
    );
    return jsonb_build_object(
      'ok', false, 'code', 'idempotency_conflict'
    );
  end if;

  select w.* into workspace
  from public.onboarding_workspaces w
  where w.tenant_id = caller.tenant_id
  for update;
  if not found then
    result := jsonb_build_object('ok', false, 'code', 'onboarding_not_found');
    perform app_private.onboarding_complete_command(
      caller.tenant_id, 'onboarding.profile.update', idempotency_key, result
    );
    return result;
  end if;
  if workspace.record_version <> expected_version then
    result := jsonb_build_object(
      'ok', false, 'code', 'version_conflict',
      'currentVersion', workspace.record_version
    );
    perform app_private.onboarding_append_audit(
      caller.tenant_id, caller.principal_id, 'onboarding.profile.update',
      'denied', 'onboarding_workspace', workspace.onboarding_id::text,
      request_id, trace_id,
      jsonb_build_object(
        'reason', 'version_conflict',
        'current_version', workspace.record_version
      )
    );
    perform app_private.onboarding_complete_command(
      caller.tenant_id, 'onboarding.profile.update', idempotency_key, result
    );
    return result;
  end if;
  if exists (
    select 1 from public.tenants t
    where t.slug = normalized_slug
      and t.tenant_id <> caller.tenant_id
  ) then
    result := jsonb_build_object('ok', false, 'code', 'slug_conflict');
    perform app_private.onboarding_append_audit(
      caller.tenant_id, caller.principal_id, 'onboarding.profile.update',
      'denied', 'tenant', caller.tenant_id::text, request_id, trace_id,
      jsonb_build_object('reason', 'slug_conflict')
    );
    perform app_private.onboarding_complete_command(
      caller.tenant_id, 'onboarding.profile.update', idempotency_key, result
    );
    return result;
  end if;

  update public.tenants
  set display_name = btrim(requested_display_name),
      slug = normalized_slug,
      settings = jsonb_set(
        settings,
        array['planId'],
        to_jsonb(btrim(requested_plan_id)),
        true
      ),
      updated_at = clock_timestamp(),
      record_version = record_version + 1
  where tenant_id = caller.tenant_id;

  select coalesce(max(b.version_number), 0) + 1
  into new_branding_version
  from public.tenant_branding b
  where b.tenant_id = caller.tenant_id;
  insert into public.tenant_branding (
    tenant_id, status, version_number, assistant_name, primary_color,
    accent_color, surface_color, text_color, launcher, welcome_message,
    voice_configuration, idempotency_key
  )
  select
    caller.tenant_id,
    'draft',
    new_branding_version,
    btrim(requested_assistant_name),
    upper(requested_primary_color),
    upper(requested_accent_color),
    coalesce(previous.surface_color, '#F7F8FC'),
    coalesce(previous.text_color, '#101828'),
    coalesce(previous.launcher, '{}'::jsonb),
    coalesce(previous.welcome_message, 'How can I help you learn today?'),
    coalesce(previous.voice_configuration, '{}'::jsonb),
    'onboarding-profile-branding:' ||
      encode(
        extensions.digest(
          caller.tenant_id::text || chr(31) || idempotency_key,
          'sha256'
        ),
        'hex'
      )
  from (select true) anchor
  left join lateral (
    select b.*
    from public.tenant_branding b
    where b.tenant_id = caller.tenant_id
    order by b.version_number desc
    limit 1
  ) previous on true;

  update public.onboarding_workspaces
  set circle_plan = normalized_circle_plan,
      expected_identity_mode = expected_mode,
      status = 'in_progress',
      record_version = record_version + 1,
      updated_at = clock_timestamp()
  where tenant_id = caller.tenant_id
    and onboarding_id = workspace.onboarding_id
    and record_version = expected_version;
  if not found then
    raise serialization_failure
      using message = 'Onboarding version changed during update';
  end if;

  update public.onboarding_steps
  set status = 'complete',
      evidence_ref = 'onboarding-profile:' || request_id,
      completed_by_principal_id = caller.principal_id,
      completed_at = clock_timestamp(),
      record_version = record_version + 1,
      updated_at = clock_timestamp()
  where tenant_id = caller.tenant_id
    and onboarding_id = workspace.onboarding_id
    and step_key = 'tenant_profile';
  update public.onboarding_steps
  set status = case
        when normalized_circle_plan = 'unconfirmed'
          then 'in_progress'
        else 'complete'
      end,
      evidence_ref = 'onboarding-identity-mode:' || request_id,
      completed_by_principal_id = case
        when normalized_circle_plan = 'unconfirmed' then null
        else caller.principal_id
      end,
      completed_at = case
        when normalized_circle_plan = 'unconfirmed'
          then null
        else clock_timestamp()
      end,
      record_version = record_version + 1,
      updated_at = clock_timestamp()
  where tenant_id = caller.tenant_id
    and onboarding_id = workspace.onboarding_id
    and step_key = 'identity_mode';

  perform app_private.onboarding_append_audit(
    caller.tenant_id, caller.principal_id, 'onboarding.profile.update',
    'allowed', 'onboarding_workspace', workspace.onboarding_id::text,
    request_id, trace_id,
    jsonb_build_object(
      'circle_plan', normalized_circle_plan,
      'branding_version', new_branding_version,
      'workspace_version', expected_version + 1
    )
  );
  result := app_private.onboarding_snapshot_for_tenant(caller.tenant_id);
  perform app_private.onboarding_complete_command(
    caller.tenant_id, 'onboarding.profile.update', idempotency_key, result
  );
  return result;
end;
$$;

create or replace function public.onboarding_update_step(
  requested_step_key text,
  requested_status text,
  requested_evidence_ref text,
  expected_version bigint,
  idempotency_key text,
  request_id text,
  trace_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  command record;
  workspace record;
  result jsonb;
  normalized_step_key text := lower(btrim(requested_step_key));
  normalized_step_status text := lower(btrim(requested_status));
  request_fingerprint text;
begin
  select * into caller from app_private.onboarding_rpc_context();
  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'tenant_selection_required'
    );
  end if;
  if request_id is null or length(request_id) not between 1 and 200
    or trace_id is null or length(trace_id) not between 1 and 200
    or idempotency_key is null
    or length(idempotency_key) not between 1 and 256
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if caller.identity_role not in ('tenant_owner', 'tenant_admin') then
    perform app_private.onboarding_append_audit(
      caller.tenant_id, caller.principal_id, 'onboarding.step.update',
      'denied', 'onboarding_step', normalized_step_key, request_id, trace_id,
      jsonb_build_object('reason', 'role_not_allowed')
    );
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if normalized_step_key in ('recording_policy', 'retention_policy') then
    perform app_private.onboarding_append_audit(
      caller.tenant_id, caller.principal_id, 'onboarding.step.update',
      'denied', 'onboarding_step', normalized_step_key, request_id, trace_id,
      jsonb_build_object('reason', 'policy_decision_required')
    );
    return jsonb_build_object(
      'ok', false, 'code', 'policy_decision_required',
      'stepKey', normalized_step_key
    );
  end if;
  if requested_step_key is null
    or length(normalized_step_key) not between 1 and 64
    or requested_status is null
    or length(normalized_step_status) not between 1 and 32
    or normalized_step_status not in (
      'not_started', 'in_progress', 'complete', 'blocked', 'not_applicable'
    )
    or expected_version is null or expected_version < 1
    or (
      normalized_step_status = 'complete'
      and (
        requested_evidence_ref is null
        or length(btrim(requested_evidence_ref)) not between 1 and 512
      )
    )
    or (
      requested_evidence_ref is not null
      and length(btrim(requested_evidence_ref)) > 512
    )
  then
    perform app_private.onboarding_append_audit(
      caller.tenant_id, caller.principal_id, 'onboarding.step.update',
      'denied', 'onboarding_step', coalesce(normalized_step_key, 'invalid'),
      request_id, trace_id, jsonb_build_object('reason', 'invalid_request')
    );
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  request_fingerprint := encode(
    extensions.digest(
      concat_ws(
        chr(31), normalized_step_key, normalized_step_status,
        coalesce(btrim(requested_evidence_ref), ''), expected_version::text
      ),
      'sha256'
    ),
    'hex'
  );
  select * into command
  from app_private.onboarding_begin_command(
    caller.tenant_id, 'onboarding.step.update', idempotency_key,
    request_fingerprint, 'onboarding_update_step'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    perform app_private.onboarding_append_audit(
      caller.tenant_id, caller.principal_id, 'onboarding.step.update',
      'denied', 'onboarding_step', normalized_step_key, request_id, trace_id,
      jsonb_build_object('reason', 'idempotency_conflict')
    );
    return jsonb_build_object(
      'ok', false, 'code', 'idempotency_conflict'
    );
  end if;

  select w.* into workspace
  from public.onboarding_workspaces w
  where w.tenant_id = caller.tenant_id
  for update;
  if not found then
    result := jsonb_build_object(
      'ok', false, 'code', 'onboarding_not_found'
    );
    perform app_private.onboarding_complete_command(
      caller.tenant_id, 'onboarding.step.update', idempotency_key, result
    );
    return result;
  end if;
  if workspace.record_version <> expected_version then
    result := jsonb_build_object(
      'ok', false, 'code', 'version_conflict',
      'currentVersion', workspace.record_version
    );
    perform app_private.onboarding_append_audit(
      caller.tenant_id, caller.principal_id, 'onboarding.step.update',
      'denied', 'onboarding_step', normalized_step_key, request_id, trace_id,
      jsonb_build_object('reason', 'version_conflict')
    );
    perform app_private.onboarding_complete_command(
      caller.tenant_id, 'onboarding.step.update', idempotency_key, result
    );
    return result;
  end if;
  if not exists (
    select 1
    from public.onboarding_steps s
    where s.tenant_id = caller.tenant_id
      and s.onboarding_id = workspace.onboarding_id
      and s.step_key = normalized_step_key
  ) then
    result := jsonb_build_object('ok', false, 'code', 'step_not_found');
    perform app_private.onboarding_complete_command(
      caller.tenant_id, 'onboarding.step.update', idempotency_key, result
    );
    return result;
  end if;

  update public.onboarding_steps
  set status = normalized_step_status,
      evidence_ref = nullif(btrim(requested_evidence_ref), ''),
      completed_by_principal_id = case
        when normalized_step_status = 'complete' then caller.principal_id
        else null
      end,
      completed_at = case
        when normalized_step_status = 'complete' then clock_timestamp()
        else null
      end,
      record_version = record_version + 1,
      updated_at = clock_timestamp()
  where tenant_id = caller.tenant_id
    and onboarding_id = workspace.onboarding_id
    and step_key = normalized_step_key;
  update public.onboarding_workspaces
  set status = 'in_progress',
      record_version = record_version + 1,
      updated_at = clock_timestamp()
  where tenant_id = caller.tenant_id
    and onboarding_id = workspace.onboarding_id
    and record_version = expected_version;

  perform app_private.onboarding_append_audit(
    caller.tenant_id, caller.principal_id, 'onboarding.step.update',
    'allowed', 'onboarding_step', normalized_step_key, request_id, trace_id,
    jsonb_build_object(
      'status', normalized_step_status,
      'workspace_version', expected_version + 1
    )
  );
  result := app_private.onboarding_snapshot_for_tenant(caller.tenant_id);
  perform app_private.onboarding_complete_command(
    caller.tenant_id, 'onboarding.step.update', idempotency_key, result
  );
  return result;
end;
$$;

create or replace function public.onboarding_create_invitation(
  invited_email text,
  invited_role text,
  expires_in_hours integer,
  idempotency_key text,
  request_id text,
  trace_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  command record;
  workspace record;
  normalized_email text := lower(btrim(invited_email));
  normalized_role text := lower(btrim(invited_role));
  request_fingerprint text;
  invitation_id text;
  result jsonb;
begin
  select * into caller from app_private.onboarding_rpc_context();
  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'tenant_selection_required'
    );
  end if;
  if request_id is null or length(request_id) not between 1 and 200
    or trace_id is null or length(trace_id) not between 1 and 200
    or idempotency_key is null
    or length(idempotency_key) not between 1 and 256
    or invited_email is null
    or normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
    or length(normalized_email) not between 3 and 320
    or expires_in_hours is null
    or expires_in_hours not between 1 and 168
    or invited_role is null
    or normalized_role not in ('tenant_admin', 'creator', 'teacher')
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if not (
    caller.identity_role = 'tenant_owner'
    or (
      caller.identity_role = 'tenant_admin'
      and normalized_role in ('creator', 'teacher')
    )
  ) then
    perform app_private.onboarding_append_audit(
      caller.tenant_id, caller.principal_id,
      'onboarding.invitation.create', 'denied',
      'identity_invitation', 'new', request_id, trace_id,
      jsonb_build_object('reason', 'role_assignment_denied')
    );
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  request_fingerprint := encode(
    extensions.digest(
      concat_ws(
        chr(31), normalized_email, normalized_role, expires_in_hours::text
      ),
      'sha256'
    ),
    'hex'
  );
  select * into command
  from app_private.onboarding_begin_command(
    caller.tenant_id, 'onboarding.invitation.create', idempotency_key,
    request_fingerprint, 'onboarding_create_invitation'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    perform app_private.onboarding_append_audit(
      caller.tenant_id, caller.principal_id,
      'onboarding.invitation.create', 'denied',
      'identity_invitation', 'new', request_id, trace_id,
      jsonb_build_object('reason', 'idempotency_conflict')
    );
    return jsonb_build_object(
      'ok', false, 'code', 'idempotency_conflict'
    );
  end if;
  if exists (
    select 1
    from public.identity_invitations i
    where i.tenant_id = caller.tenant_id
      and i.email_normalized = normalized_email
      and i.status = 'pending'
      and i.expires_at > now()
      and i.deleted_at is null
  ) then
    result := jsonb_build_object(
      'ok', false, 'code', 'pending_invitation_exists'
    );
    perform app_private.onboarding_append_audit(
      caller.tenant_id, caller.principal_id,
      'onboarding.invitation.create', 'denied',
      'identity_invitation', 'existing', request_id, trace_id,
      jsonb_build_object('reason', 'pending_invitation_exists')
    );
    perform app_private.onboarding_complete_command(
      caller.tenant_id, 'onboarding.invitation.create',
      idempotency_key, result
    );
    return result;
  end if;

  invitation_id := 'onboarding-invite:' ||
    encode(
      extensions.digest(
        caller.tenant_id::text || chr(31) || idempotency_key,
        'sha256'
      ),
      'hex'
    );
  insert into public.identity_invitations (
    invitation_id, tenant_id, email_normalized, role, status, expires_at,
    idempotency_key
  ) values (
    invitation_id,
    caller.tenant_id,
    normalized_email,
    normalized_role,
    'pending',
    now() + make_interval(hours => expires_in_hours),
    'onboarding-rpc-invite:' ||
      encode(
        extensions.digest(
          caller.tenant_id::text || chr(31) || idempotency_key,
          'sha256'
        ),
        'hex'
      )
  );

  select w.* into workspace
  from public.onboarding_workspaces w
  where w.tenant_id = caller.tenant_id
  for update;
  if found then
    update public.onboarding_steps
    set status = case
          when status = 'complete' then status
          else 'in_progress'
        end,
        evidence_ref = case
          when status = 'complete' then evidence_ref
          else 'invitation-issued:' || invitation_id
        end,
        record_version = record_version + 1,
        updated_at = clock_timestamp()
    where tenant_id = caller.tenant_id
      and onboarding_id = workspace.onboarding_id
      and step_key = 'client_handoff';
    update public.onboarding_workspaces
    set status = 'in_progress',
        record_version = record_version + 1,
        updated_at = clock_timestamp()
    where tenant_id = caller.tenant_id
      and onboarding_id = workspace.onboarding_id;
  end if;

  perform app_private.onboarding_append_audit(
    caller.tenant_id, caller.principal_id,
    'onboarding.invitation.create', 'allowed',
    'identity_invitation', invitation_id, request_id, trace_id,
    jsonb_build_object(
      'role', normalized_role,
      'expires_in_hours', expires_in_hours
    )
  );
  result := app_private.onboarding_snapshot_for_tenant(caller.tenant_id)
    || jsonb_build_object(
      'invitationResult',
      jsonb_build_object(
        'invitationId', invitation_id,
        'emailHint', app_private.onboarding_mask_email(normalized_email),
        'role', normalized_role,
        'status', 'pending'
      )
    );
  perform app_private.onboarding_complete_command(
    caller.tenant_id, 'onboarding.invitation.create',
    idempotency_key, result
  );
  return result;
end;
$$;

create or replace function public.onboarding_revoke_invitation(
  target_invitation_id text,
  idempotency_key text,
  request_id text,
  trace_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  command record;
  invitation record;
  workspace record;
  request_fingerprint text;
  result jsonb;
begin
  select * into caller from app_private.onboarding_rpc_context();
  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'tenant_selection_required'
    );
  end if;
  if target_invitation_id is null
    or length(target_invitation_id) not between 1 and 512
    or idempotency_key is null
    or length(idempotency_key) not between 1 and 256
    or request_id is null or length(request_id) not between 1 and 200
    or trace_id is null or length(trace_id) not between 1 and 200
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if caller.identity_role not in ('tenant_owner', 'tenant_admin') then
    perform app_private.onboarding_append_audit(
      caller.tenant_id, caller.principal_id,
      'onboarding.invitation.revoke', 'denied',
      'identity_invitation', target_invitation_id,
      request_id, trace_id,
      jsonb_build_object('reason', 'role_not_allowed')
    );
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  request_fingerprint := encode(
    extensions.digest(target_invitation_id, 'sha256'),
    'hex'
  );
  select * into command
  from app_private.onboarding_begin_command(
    caller.tenant_id, 'onboarding.invitation.revoke', idempotency_key,
    request_fingerprint, 'onboarding_revoke_invitation'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    perform app_private.onboarding_append_audit(
      caller.tenant_id, caller.principal_id,
      'onboarding.invitation.revoke', 'denied',
      'identity_invitation', target_invitation_id, request_id, trace_id,
      jsonb_build_object('reason', 'idempotency_conflict')
    );
    return jsonb_build_object(
      'ok', false, 'code', 'idempotency_conflict'
    );
  end if;

  select i.* into invitation
  from public.identity_invitations i
  where i.tenant_id = caller.tenant_id
    and i.invitation_id = target_invitation_id
    and i.deleted_at is null
  for update;
  if not found then
    result := jsonb_build_object(
      'ok', false, 'code', 'invitation_invalid'
    );
    perform app_private.onboarding_append_audit(
      caller.tenant_id, caller.principal_id,
      'onboarding.invitation.revoke', 'denied',
      'identity_invitation', target_invitation_id, request_id, trace_id,
      jsonb_build_object('reason', 'invitation_invalid')
    );
    perform app_private.onboarding_complete_command(
      caller.tenant_id, 'onboarding.invitation.revoke',
      idempotency_key, result
    );
    return result;
  end if;
  if invitation.status <> 'pending' or invitation.expires_at <= now() then
    result := jsonb_build_object(
      'ok', false, 'code', 'invitation_invalid'
    );
    perform app_private.onboarding_append_audit(
      caller.tenant_id, caller.principal_id,
      'onboarding.invitation.revoke', 'denied',
      'identity_invitation', target_invitation_id, request_id, trace_id,
      jsonb_build_object('reason', 'invitation_invalid')
    );
    perform app_private.onboarding_complete_command(
      caller.tenant_id, 'onboarding.invitation.revoke',
      idempotency_key, result
    );
    return result;
  end if;

  update public.identity_invitations
  set status = 'revoked',
      updated_at = clock_timestamp(),
      record_version = record_version + 1
  where tenant_id = caller.tenant_id
    and invitation_id = target_invitation_id
    and status = 'pending';
  select w.* into workspace
  from public.onboarding_workspaces w
  where w.tenant_id = caller.tenant_id
  for update;
  if found then
    update public.onboarding_workspaces
    set record_version = record_version + 1,
        updated_at = clock_timestamp()
    where tenant_id = caller.tenant_id
      and onboarding_id = workspace.onboarding_id;
  end if;
  perform app_private.onboarding_append_audit(
    caller.tenant_id, caller.principal_id,
    'onboarding.invitation.revoke', 'allowed',
    'identity_invitation', target_invitation_id, request_id, trace_id,
    jsonb_build_object('previous_status', 'pending')
  );
  result := app_private.onboarding_snapshot_for_tenant(caller.tenant_id)
    || jsonb_build_object(
      'invitationResult',
      jsonb_build_object(
        'invitationId', target_invitation_id,
        'status', 'revoked'
      )
    );
  perform app_private.onboarding_complete_command(
    caller.tenant_id, 'onboarding.invitation.revoke',
    idempotency_key, result
  );
  return result;
end;
$$;

create or replace function public.onboarding_accept_invitation(
  target_invitation_id text,
  idempotency_key text,
  request_id text,
  trace_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller_id uuid := auth.uid();
  caller_email text;
  invitation record;
  command record;
  principal_id text;
  existing_membership record;
  membership_id text;
  selection_version bigint;
  workspace record;
  request_fingerprint text;
  result jsonb;
begin
  if caller_id is null
    or coalesce(
      (app_private.jwt_claims() ->> 'is_anonymous')::boolean,
      false
    )
    or target_invitation_id is null
    or length(target_invitation_id) not between 1 and 512
    or idempotency_key is null
    or length(idempotency_key) not between 1 and 256
    or request_id is null or length(request_id) not between 1 and 200
    or trace_id is null or length(trace_id) not between 1 and 200
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  select lower(btrim(u.email))
  into caller_email
  from auth.users u
  where u.id = caller_id
    and u.email is not null
    and u.email_confirmed_at is not null
    and u.deleted_at is null;
  if caller_email is null then
    return jsonb_build_object(
      'ok', false, 'code', 'verified_email_required'
    );
  end if;

  select i.* into invitation
  from public.identity_invitations i
  where i.invitation_id = target_invitation_id
    and i.deleted_at is null
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invitation_invalid');
  end if;
  request_fingerprint := encode(
    extensions.digest(
      target_invitation_id || chr(31) || caller_id::text,
      'sha256'
    ),
    'hex'
  );
  select * into command
  from app_private.onboarding_begin_command(
    invitation.tenant_id, 'onboarding.invitation.accept', idempotency_key,
    request_fingerprint, 'onboarding_accept_invitation'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    perform app_private.onboarding_append_audit(
      invitation.tenant_id, null,
      'onboarding.invitation.accept', 'denied',
      'identity_invitation', target_invitation_id, request_id, trace_id,
      jsonb_build_object('reason', 'idempotency_conflict')
    );
    return jsonb_build_object(
      'ok', false, 'code', 'idempotency_conflict'
    );
  end if;
  if invitation.status <> 'pending'
    or invitation.expires_at <= now()
    or invitation.email_normalized <> caller_email
  then
    result := jsonb_build_object(
      'ok', false, 'code', 'invitation_invalid'
    );
    perform app_private.onboarding_append_audit(
      invitation.tenant_id, null,
      'onboarding.invitation.accept', 'denied',
      'identity_invitation', target_invitation_id, request_id, trace_id,
      jsonb_build_object('reason', 'invitation_invalid')
    );
    perform app_private.onboarding_complete_command(
      invitation.tenant_id, 'onboarding.invitation.accept',
      idempotency_key, result
    );
    return result;
  end if;

  select l.principal_id into principal_id
  from app_private.supabase_auth_principal_links l
  where l.auth_user_id = caller_id;
  if principal_id is null then
    principal_id := 'supabase-auth:' || caller_id::text;
    insert into public.identity_principals (
      principal_id, principal_kind, authentication_method, issuer, subject,
      idempotency_key
    ) values (
      principal_id, 'human', 'host_signed', 'supabase-auth', caller_id::text,
      'onboarding-accept-principal:' || caller_id::text
    )
    on conflict (principal_id) do nothing;
    insert into app_private.supabase_auth_principal_links (
      auth_user_id, principal_id, idempotency_key
    ) values (
      caller_id, principal_id, 'onboarding-accept-link:' || caller_id::text
    );
  end if;

  select m.* into existing_membership
  from public.identity_memberships m
  where m.tenant_id = invitation.tenant_id
    and m.principal_id = principal_id
  for update;
  if found then
    if existing_membership.role <> invitation.role
      or existing_membership.status <> 'active'
      or existing_membership.deleted_at is not null
    then
      result := jsonb_build_object(
        'ok', false, 'code', 'membership_conflict'
      );
      perform app_private.onboarding_append_audit(
        invitation.tenant_id, principal_id,
        'onboarding.invitation.accept', 'denied',
        'identity_invitation', target_invitation_id, request_id, trace_id,
        jsonb_build_object('reason', 'membership_conflict')
      );
      perform app_private.onboarding_complete_command(
        invitation.tenant_id, 'onboarding.invitation.accept',
        idempotency_key, result
      );
      return result;
    end if;
    membership_id := existing_membership.membership_id;
  else
    membership_id :=
      'supabase-auth-invite:' ||
      invitation.tenant_id::text || ':' || caller_id::text;
    insert into public.identity_memberships (
      membership_id, tenant_id, principal_id, role, status, provisioned_by,
      idempotency_key
    ) values (
      membership_id,
      invitation.tenant_id,
      principal_id,
      invitation.role,
      'active',
      'invitation',
      'onboarding-accept-membership:' ||
        encode(
          extensions.digest(
            invitation.tenant_id::text || chr(31) ||
            target_invitation_id || chr(31) || caller_id::text,
            'sha256'
          ),
          'hex'
        )
    );
  end if;

  update public.identity_invitations
  set status = 'accepted',
      accepted_by_principal_id = principal_id,
      accepted_at = clock_timestamp(),
      updated_at = clock_timestamp(),
      record_version = record_version + 1
  where tenant_id = invitation.tenant_id
    and invitation_id = target_invitation_id
    and status = 'pending';
  insert into public.identity_invitation_acceptances (
    tenant_id, invitation_id, principal_id, membership_id, idempotency_key
  ) values (
    invitation.tenant_id,
    target_invitation_id,
    principal_id,
    membership_id,
    'onboarding-rpc-acceptance:' ||
      encode(
        extensions.digest(
          invitation.tenant_id::text || chr(31) ||
          target_invitation_id || chr(31) || idempotency_key,
          'sha256'
        ),
        'hex'
      )
  );

  insert into app_private.supabase_auth_tenant_selections (
    auth_user_id, principal_id, tenant_id, membership_id
  ) values (
    caller_id, principal_id, invitation.tenant_id, membership_id
  )
  on conflict (auth_user_id) do update
    set principal_id = excluded.principal_id,
        tenant_id = excluded.tenant_id,
        membership_id = excluded.membership_id,
        selection_version = case
          when (
            app_private.supabase_auth_tenant_selections.principal_id,
            app_private.supabase_auth_tenant_selections.tenant_id,
            app_private.supabase_auth_tenant_selections.membership_id
          ) is distinct from (
            excluded.principal_id,
            excluded.tenant_id,
            excluded.membership_id
          )
          then
            app_private.supabase_auth_tenant_selections.selection_version + 1
          else app_private.supabase_auth_tenant_selections.selection_version
        end,
        selected_at = clock_timestamp(),
        updated_at = clock_timestamp()
  returning
    app_private.supabase_auth_tenant_selections.selection_version
  into selection_version;

  select w.* into workspace
  from public.onboarding_workspaces w
  where w.tenant_id = invitation.tenant_id
  for update;
  if found then
    update public.onboarding_steps
    set status = 'complete',
        evidence_ref = 'invitation-accepted:' || target_invitation_id,
        completed_by_principal_id = principal_id,
        completed_at = clock_timestamp(),
        record_version = record_version + 1,
        updated_at = clock_timestamp()
    where tenant_id = invitation.tenant_id
      and onboarding_id = workspace.onboarding_id
      and step_key = 'client_handoff';
    update public.onboarding_workspaces
    set status = 'in_progress',
        record_version = record_version + 1,
        updated_at = clock_timestamp()
    where tenant_id = invitation.tenant_id
      and onboarding_id = workspace.onboarding_id;
  end if;

  perform app_private.onboarding_append_audit(
    invitation.tenant_id, principal_id,
    'onboarding.invitation.accept', 'allowed',
    'identity_invitation', target_invitation_id, request_id, trace_id,
    jsonb_build_object(
      'membership_id', membership_id,
      'identity_role', invitation.role
    )
  );
  select s.selection_version into selection_version
  from app_private.supabase_auth_tenant_selections s
  where s.auth_user_id = caller_id;
  result := jsonb_build_object(
    'ok', true,
    'accepted', true,
    'tenantId', invitation.tenant_id,
    'tenantSlug', (
      select t.slug
      from public.tenants t
      where t.tenant_id = invitation.tenant_id
    ),
    'membershipId', membership_id,
    'identityRole', invitation.role,
    'selectionVersion', selection_version,
    'claimsRefreshRequired', true
  );
  perform app_private.onboarding_complete_command(
    invitation.tenant_id, 'onboarding.invitation.accept',
    idempotency_key, result
  );
  return result;
end;
$$;

revoke execute on function app_private.onboarding_rpc_context()
  from public, anon, authenticated, service_role;
revoke execute on function app_private.onboarding_mask_email(text)
  from public, anon, authenticated, service_role;
revoke execute on function app_private.onboarding_begin_command(
  uuid, text, text, text, text
) from public, anon, authenticated, service_role;
revoke execute on function app_private.onboarding_complete_command(
  uuid, text, text, jsonb
) from public, anon, authenticated, service_role;
revoke execute on function app_private.onboarding_append_audit(
  uuid, text, text, text, text, text, text, text, jsonb
) from public, anon, authenticated, service_role;
revoke execute on function app_private.onboarding_snapshot_for_tenant(uuid)
  from public, anon, authenticated, service_role;

revoke execute on function public.onboarding_get_snapshot()
  from public, anon, service_role;
revoke execute on function public.onboarding_update_tenant_profile(
  text, text, text, text, text, text, text, bigint, text, text, text
) from public, anon, service_role;
revoke execute on function public.onboarding_update_step(
  text, text, text, bigint, text, text, text
) from public, anon, service_role;
revoke execute on function public.onboarding_create_invitation(
  text, text, integer, text, text, text
) from public, anon, service_role;
revoke execute on function public.onboarding_revoke_invitation(
  text, text, text, text
) from public, anon, service_role;
revoke execute on function public.onboarding_accept_invitation(
  text, text, text, text
) from public, anon, service_role;

grant execute on function public.onboarding_get_snapshot()
  to authenticated;
grant execute on function public.onboarding_update_tenant_profile(
  text, text, text, text, text, text, text, bigint, text, text, text
) to authenticated;
grant execute on function public.onboarding_update_step(
  text, text, text, bigint, text, text, text
) to authenticated;
grant execute on function public.onboarding_create_invitation(
  text, text, integer, text, text, text
) to authenticated;
grant execute on function public.onboarding_revoke_invitation(
  text, text, text, text
) to authenticated;
grant execute on function public.onboarding_accept_invitation(
  text, text, text, text
) to authenticated;

commit;

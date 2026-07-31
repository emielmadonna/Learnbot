-- Durable, tenant-scoped privacy controls and a tenant-safe plan/usage read.
--
-- The policy table is deliberately RPC-only. A browser cannot read or mutate
-- rows directly, even if a future Data API configuration exposes new public
-- tables automatically. The public functions bind every operation to the
-- verified, database-selected tenant and require an owner/admin membership.
--
-- Data exports are synchronous, bounded snapshots. They include workspace,
-- course, membership, learning-progress and conversation data, while omitting
-- credentials, storage keys, provider references, true provider cost and
-- platform margin.

begin;

create table public.tenant_data_policies (
  tenant_id uuid primary key references public.tenants(tenant_id),
  retention_days integer not null default 365
    check (retention_days between 30 and 3650),
  exports_enabled boolean not null default true,
  default_export_format text not null default 'json'
    check (default_export_format in ('json', 'csv')),
  updated_by uuid,
  record_version bigint not null default 1 check (record_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tenant_data_policies enable row level security;
alter table public.tenant_data_policies force row level security;
revoke all on table public.tenant_data_policies
  from public, anon, authenticated;

drop policy if exists tenant_data_policies_deny_all
  on public.tenant_data_policies;
create policy tenant_data_policies_deny_all
  on public.tenant_data_policies
  for all to anon, authenticated
  using (false)
  with check (false);

create trigger tenant_data_policies_set_version
before update on public.tenant_data_policies
for each row execute function app_private.set_updated_at_and_version();

insert into public.tenant_data_policies (tenant_id)
select t.tenant_id
from public.tenants t
where t.deleted_at is null
on conflict (tenant_id) do nothing;

create or replace function app_private.tenant_data_settings_audit(
  target_tenant_id uuid,
  caller_role text,
  audit_action text,
  audit_resource_type text,
  audit_resource_id text,
  audit_reason text,
  audit_before_hash text,
  audit_after_hash text,
  audit_change_ref text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  written_audit_id uuid;
  operation_id uuid := gen_random_uuid();
begin
  insert into public.audit_ledger (
    tenant_id,
    actor_id,
    actor_type,
    actor_role,
    action,
    resource_type,
    resource_id,
    policy_decision,
    decision_reason,
    before_hash,
    after_hash,
    change_ref,
    request_id,
    trace_id,
    idempotency_key,
    retain_until
  )
  values (
    target_tenant_id,
    auth.uid(),
    case when caller_role = 'tenant_owner' then 'owner' else 'creator' end,
    caller_role,
    audit_action,
    audit_resource_type,
    audit_resource_id,
    'allow',
    audit_reason,
    audit_before_hash,
    audit_after_hash,
    audit_change_ref,
    operation_id::text,
    operation_id::text,
    'tenant-data-settings:' || operation_id::text,
    statement_timestamp() + interval '7 years'
  )
  returning audit_id into written_audit_id;

  return written_audit_id;
end;
$$;
revoke execute on function app_private.tenant_data_settings_audit(
  uuid, text, text, text, text, text, text, text, text
) from public, anon, authenticated, service_role;

create or replace function public.tenant_get_data_policy()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  policy record;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;
  if caller.identity_role not in ('tenant_owner', 'tenant_admin') then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select * into policy
  from public.tenant_data_policies p
  where p.tenant_id = caller.tenant_id;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', caller.tenant_id,
    'retentionDays', coalesce(policy.retention_days, 365),
    'exportsEnabled', coalesce(policy.exports_enabled, true),
    'defaultExportFormat', coalesce(policy.default_export_format, 'json'),
    'recordVersion', coalesce(policy.record_version, 0),
    'updatedAt', policy.updated_at
  );
end;
$$;

create or replace function public.tenant_set_data_policy(
  retention_days integer,
  exports_enabled boolean,
  default_export_format text,
  expected_version bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  previous_policy public.tenant_data_policies%rowtype;
  updated_policy public.tenant_data_policies%rowtype;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;
  if caller.identity_role not in ('tenant_owner', 'tenant_admin') then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if retention_days is null
    or retention_days not between 30 and 3650
    or exports_enabled is null
    or default_export_format not in ('json', 'csv')
    or expected_version is null
    or expected_version < 0
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select * into previous_policy
  from public.tenant_data_policies p
  where p.tenant_id = caller.tenant_id
  for update;

  if not found then
    if expected_version <> 0 then
      return jsonb_build_object('ok', false, 'code', 'version_conflict');
    end if;

    insert into public.tenant_data_policies (
      tenant_id,
      retention_days,
      exports_enabled,
      default_export_format,
      updated_by
    )
    values (
      caller.tenant_id,
      tenant_set_data_policy.retention_days,
      tenant_set_data_policy.exports_enabled,
      tenant_set_data_policy.default_export_format,
      auth.uid()
    )
    on conflict (tenant_id) do nothing
    returning * into updated_policy;

    if not found then
      return jsonb_build_object('ok', false, 'code', 'version_conflict');
    end if;
  else
    if previous_policy.record_version <> expected_version then
      return jsonb_build_object('ok', false, 'code', 'version_conflict');
    end if;

    update public.tenant_data_policies p
    set retention_days = tenant_set_data_policy.retention_days,
        exports_enabled = tenant_set_data_policy.exports_enabled,
        default_export_format =
          tenant_set_data_policy.default_export_format,
        updated_by = auth.uid()
    where p.tenant_id = caller.tenant_id
      and p.record_version = expected_version
    returning * into updated_policy;

    if not found then
      return jsonb_build_object('ok', false, 'code', 'version_conflict');
    end if;
  end if;

  perform app_private.tenant_data_settings_audit(
    caller.tenant_id,
    caller.identity_role,
    'tenant.data_policy.updated',
    'tenant_data_policy',
    caller.tenant_id::text,
    'A tenant administrator updated the durable data policy.',
    case
      when previous_policy.tenant_id is null then null
      else md5(jsonb_build_object(
        'retentionDays', previous_policy.retention_days,
        'exportsEnabled', previous_policy.exports_enabled,
        'defaultExportFormat', previous_policy.default_export_format,
        'recordVersion', previous_policy.record_version
      )::text)
    end,
    md5(jsonb_build_object(
      'retentionDays', updated_policy.retention_days,
      'exportsEnabled', updated_policy.exports_enabled,
      'defaultExportFormat', updated_policy.default_export_format,
      'recordVersion', updated_policy.record_version
    )::text),
    'retention_days=' || updated_policy.retention_days::text ||
      ';exports_enabled=' || updated_policy.exports_enabled::text ||
      ';default_export_format=' || updated_policy.default_export_format
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', updated_policy.tenant_id,
    'retentionDays', updated_policy.retention_days,
    'exportsEnabled', updated_policy.exports_enabled,
    'defaultExportFormat', updated_policy.default_export_format,
    'recordVersion', updated_policy.record_version,
    'updatedAt', updated_policy.updated_at
  );
end;
$$;

create or replace function public.tenant_prepare_data_export(
  requested_format text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  policy record;
  export_records jsonb;
  export_record_count bigint := 0;
  export_truncated boolean := false;
  tenant_slug text;
  generated_at timestamptz := statement_timestamp();
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;
  if caller.identity_role not in ('tenant_owner', 'tenant_admin') then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if requested_format not in ('json', 'csv') then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select * into policy
  from public.tenant_data_policies p
  where p.tenant_id = caller.tenant_id;
  if coalesce(policy.exports_enabled, true) is false then
    return jsonb_build_object('ok', false, 'code', 'exports_disabled');
  end if;

  select t.slug into tenant_slug
  from public.tenants t
  where t.tenant_id = caller.tenant_id
    and t.deleted_at is null;

  with export_source as (
    select
      'workspace'::text as category,
      t.tenant_id::text as record_id,
      jsonb_build_object(
        'tenantId', t.tenant_id,
        'slug', t.slug,
        'displayName', t.display_name,
        'status', t.status,
        'region', t.region,
        'createdAt', t.created_at,
        'updatedAt', t.updated_at
      ) as record_data
    from public.tenants t
    where t.tenant_id = caller.tenant_id

    union all

    select
      'membership',
      m.membership_id,
      jsonb_build_object(
        'membershipId', m.membership_id,
        'principalId', m.principal_id,
        'role', m.role,
        'status', m.status,
        'provisionedBy', m.provisioned_by,
        'createdAt', m.created_at,
        'updatedAt', m.updated_at
      )
    from public.identity_memberships m
    where m.tenant_id = caller.tenant_id

    union all

    select
      'course',
      c.course_id::text,
      jsonb_build_object(
        'courseId', c.course_id,
        'externalId', c.external_id,
        'title', c.title,
        'description', c.description,
        'status', c.status,
        'publishedAt', c.published_at,
        'createdAt', c.created_at,
        'updatedAt', c.updated_at
      )
    from public.courses c
    where c.tenant_id = caller.tenant_id

    union all

    select
      'module',
      m.module_id::text,
      jsonb_build_object(
        'moduleId', m.module_id,
        'courseId', m.course_id,
        'externalId', m.external_id,
        'title', m.title,
        'position', m.position,
        'status', m.status,
        'createdAt', m.created_at,
        'updatedAt', m.updated_at
      )
    from public.modules m
    where m.tenant_id = caller.tenant_id

    union all

    select
      'lesson',
      l.lesson_id::text,
      jsonb_build_object(
        'lessonId', l.lesson_id,
        'courseId', l.course_id,
        'moduleId', l.module_id,
        'externalId', l.external_id,
        'title', l.title,
        'position', l.position,
        'status', l.status,
        'createdAt', l.created_at,
        'updatedAt', l.updated_at
      )
    from public.lessons l
    where l.tenant_id = caller.tenant_id

    union all

    select
      'content_block',
      b.content_block_id::text,
      jsonb_build_object(
        'contentBlockId', b.content_block_id,
        'courseId', b.course_id,
        'lessonId', b.lesson_id,
        'blockType', b.block_type,
        'position', b.position,
        'content', b.content,
        'schemaVersion', b.schema_version,
        'createdAt', b.created_at,
        'updatedAt', b.updated_at
      )
    from public.content_blocks b
    where b.tenant_id = caller.tenant_id

    union all

    select
      'lesson_progress',
      p.lesson_progress_id::text,
      jsonb_build_object(
        'lessonProgressId', p.lesson_progress_id,
        'userId', p.user_id,
        'courseId', p.course_id,
        'moduleId', p.module_id,
        'lessonId', p.lesson_id,
        'progressState', p.progress_state,
        'startedAt', p.started_at,
        'completedAt', p.completed_at,
        'lastActivityAt', p.last_activity_at,
        'createdAt', p.created_at,
        'updatedAt', p.updated_at
      )
    from public.lesson_progress p
    where p.tenant_id = caller.tenant_id

    union all

    select
      'conversation',
      c.conversation_id::text,
      jsonb_build_object(
        'conversationId', c.conversation_id,
        'subjectUserId', c.subject_user_id,
        'courseId', c.course_id,
        'moduleId', c.module_id,
        'lessonId', c.lesson_id,
        'status', c.status,
        'title', c.title,
        'startedAt', c.started_at,
        'endedAt', c.ended_at,
        'createdAt', c.created_at,
        'updatedAt', c.updated_at
      )
    from public.conversations c
    where c.tenant_id = caller.tenant_id

    union all

    select
      'message',
      m.message_id::text,
      jsonb_build_object(
        'messageId', m.message_id,
        'conversationId', m.conversation_id,
        'actorId', m.actor_id,
        'actorType', m.actor_type,
        'modality', m.modality,
        'status', m.status,
        'body', m.body,
        'structuredContent', m.structured_content,
        'sequenceNumber', m.sequence_number,
        'createdAt', m.created_at,
        'updatedAt', m.updated_at
      )
    from public.messages m
    where m.tenant_id = caller.tenant_id

    union all

    select
      'usage_event',
      e.usage_event_id::text,
      jsonb_build_object(
        'usageEventId', e.usage_event_id,
        'principalId', e.principal_id,
        'membershipId', e.membership_id,
        'identityRole', e.identity_role,
        'eventName', e.event_name,
        'properties', e.properties,
        'occurredAt', e.occurred_at
      )
    from public.learning_usage_events e
    where e.tenant_id = caller.tenant_id
  ),
  ranked as (
    select
      source.category,
      source.record_id,
      source.record_data,
      count(*) over () as total_records
    from export_source source
    order by source.category, source.record_id
    limit 10001
  ),
  bounded as (
    select *
    from ranked
    order by category, record_id
    limit 10000
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'category', bounded.category,
          'recordId', bounded.record_id,
          'data', bounded.record_data
        )
        order by bounded.category, bounded.record_id
      ),
      '[]'::jsonb
    ),
    coalesce(max(bounded.total_records), 0),
    coalesce(max(bounded.total_records), 0) > 10000
  into export_records, export_record_count, export_truncated
  from bounded;

  perform app_private.tenant_data_settings_audit(
    caller.tenant_id,
    caller.identity_role,
    'tenant.data_export.generated',
    'tenant_data_export',
    caller.tenant_id::text,
    'A tenant administrator generated a bounded tenant data export.',
    null,
    md5(jsonb_build_object(
      'format', requested_format,
      'recordCount', export_record_count,
      'truncated', export_truncated,
      'generatedAt', generated_at
    )::text),
    'format=' || requested_format ||
      ';record_count=' || export_record_count::text ||
      ';truncated=' || export_truncated::text
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', caller.tenant_id,
    'tenantSlug', tenant_slug,
    'format', requested_format,
    'generatedAt', generated_at,
    'retentionDays', coalesce(policy.retention_days, 365),
    'recordCount', export_record_count,
    'truncated', export_truncated,
    'records', export_records
  );
end;
$$;

-- Backward-compatible enrichment of the existing tenant-safe billing RPC.
-- Only billed totals, counts and the already tenant-readable safeguard policy
-- are returned. True cost, markup and margin stay behind platform-admin RPCs.
create or replace function public.tenant_get_billing_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  sub record;
  cost_policy record;
  day_billed bigint := 0;
  month_billed bigint := 0;
  day_calls bigint := 0;
  month_calls bigint := 0;
  enabled_sections jsonb := '[]'::jsonb;
  day_start timestamptz := date_trunc('day', statement_timestamp());
  month_start timestamptz := date_trunc('month', statement_timestamp());
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;
  if caller.identity_role not in ('tenant_owner', 'tenant_admin') then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select * into sub
  from public.tenant_subscriptions s
  where s.tenant_id = caller.tenant_id;

  select * into cost_policy
  from public.tenant_cost_policies p
  where p.tenant_id = caller.tenant_id;

  select
    coalesce(sum(r.billed_micro)
      filter (where r.reported_at >= day_start), 0),
    coalesce(sum(r.billed_micro), 0)
  into day_billed, month_billed
  from public.billing_usage_reports r
  where r.tenant_id = caller.tenant_id
    and r.reported_at >= month_start;

  select
    count(*) filter (where c.occurred_at >= day_start),
    count(*)
  into day_calls, month_calls
  from public.cost_ledger c
  where c.tenant_id = caller.tenant_id
    and c.occurred_at >= month_start;

  select coalesce(
    jsonb_agg(s.section_key order by s.section_key)
      filter (where s.enabled),
    '[]'::jsonb
  )
  into enabled_sections
  from public.tenant_sections s
  where s.tenant_id = caller.tenant_id;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'plan', coalesce(sub.plan, 'unconfirmed'),
    'subscriptionStatus', coalesce(sub.subscription_status, 'none'),
    'dunningStage', coalesce(sub.dunning_stage, 'none'),
    'gracePeriodEndsAt', sub.grace_period_ends_at,
    'currentPeriodEnd', sub.current_period_end,
    'cancelAtPeriodEnd', coalesce(sub.cancel_at_period_end, false),
    'currency', coalesce(cost_policy.currency, 'USD'),
    'microUnitsPerMajorUnit', 1000000,
    'dayToDateBilledMicro', day_billed,
    'monthToDateBilledMicro', month_billed,
    'callsToday', day_calls,
    'callsThisMonth', month_calls,
    'limits', jsonb_build_object(
      'dailyBudgetMicro', cost_policy.daily_budget_micro,
      'monthlyBudgetMicro', cost_policy.monthly_budget_micro,
      'maxCallsPerMinute', cost_policy.max_calls_per_minute,
      'maxCallsPerDay', cost_policy.max_calls_per_day,
      'maxSubjectCallsPerMinute', cost_policy.max_subject_calls_per_minute,
      'enforcement', cost_policy.enforcement
    ),
    'enabledSections', enabled_sections,
    'generatedAt', statement_timestamp(),
    'message', case coalesce(sub.dunning_stage, 'none')
      when 'grace' then
        'A recent payment failed. Update billing before ' ||
          to_char(sub.grace_period_ends_at, 'YYYY-MM-DD') ||
          ' to keep every section active.'
      when 'dark' then
        'Payment is still failing. Premium sections are paused until billing is resolved.'
      else null
    end
  );
end;
$$;

revoke all on function public.tenant_get_data_policy()
  from public, anon, authenticated, service_role;
revoke all on function public.tenant_set_data_policy(
  integer, boolean, text, bigint
) from public, anon, authenticated, service_role;
revoke all on function public.tenant_prepare_data_export(text)
  from public, anon, authenticated, service_role;
revoke all on function public.tenant_get_billing_summary()
  from public, anon, authenticated, service_role;

grant execute on function public.tenant_get_data_policy()
  to authenticated;
grant execute on function public.tenant_set_data_policy(
  integer, boolean, text, bigint
) to authenticated;
grant execute on function public.tenant_prepare_data_export(text)
  to authenticated;
grant execute on function public.tenant_get_billing_summary()
  to authenticated;

commit;

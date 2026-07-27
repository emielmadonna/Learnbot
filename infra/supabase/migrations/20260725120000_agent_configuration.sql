-- Editable per-tenant agent configuration. One agent per tenant, stored on the
-- existing versioned public.tenant_branding draft/published chain. Every
-- presentation and behaviour field becomes writable through a single
-- authenticated RPC with optimistic concurrency, idempotency and audit.

begin;

alter table public.tenant_branding
  add column if not exists icon_glyph text,
  add column if not exists persona_instructions text,
  add column if not exists agent_tone text,
  add column if not exists agent_voice text,
  add column if not exists agent_course_scope jsonb not null
    default '"all"'::jsonb;

alter table public.tenant_branding
  drop constraint if exists tenant_branding_icon_glyph_check;
alter table public.tenant_branding
  add constraint tenant_branding_icon_glyph_check
  check (icon_glyph is null or length(icon_glyph) between 1 and 16);

alter table public.tenant_branding
  drop constraint if exists tenant_branding_persona_instructions_check;
alter table public.tenant_branding
  add constraint tenant_branding_persona_instructions_check
  check (
    persona_instructions is null
    or length(persona_instructions) between 1 and 4000
  );

alter table public.tenant_branding
  drop constraint if exists tenant_branding_agent_tone_check;
alter table public.tenant_branding
  add constraint tenant_branding_agent_tone_check
  check (
    agent_tone is null
    or agent_tone in (
      'neutral', 'friendly', 'encouraging', 'professional',
      'socratic', 'concise'
    )
  );

alter table public.tenant_branding
  drop constraint if exists tenant_branding_agent_voice_check;
alter table public.tenant_branding
  add constraint tenant_branding_agent_voice_check
  check (
    agent_voice is null
    or agent_voice ~ '^[a-z0-9][a-z0-9._-]{0,60}$'
  );

-- Course scope is either the literal "all" or a JSON array of course UUID
-- strings. CHECK constraints cannot contain subqueries, so element shape is
-- asserted with an immutable regular expression over the normalised jsonb text.
alter table public.tenant_branding
  drop constraint if exists tenant_branding_agent_course_scope_check;
alter table public.tenant_branding
  add constraint tenant_branding_agent_course_scope_check
  check (
    agent_course_scope = '"all"'::jsonb
    or (
      jsonb_typeof(agent_course_scope) = 'array'
      and jsonb_array_length(agent_course_scope) between 1 and 200
      and agent_course_scope::text ~ (
        '^\[\s*"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}'
        || '-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"'
        || '(\s*,\s*"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}'
        || '-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")*\s*\]$'
      )
    )
  );

alter table public.tenant_branding
  drop constraint if exists tenant_branding_logo_storage_key_check;
alter table public.tenant_branding
  add constraint tenant_branding_logo_storage_key_check
  check (
    logo_storage_key is null
    or (
      length(logo_storage_key) between 1 and 1024
      and logo_storage_key not like '%..%'
    )
  );

alter table public.tenant_branding
  drop constraint if exists tenant_branding_avatar_storage_key_check;
alter table public.tenant_branding
  add constraint tenant_branding_avatar_storage_key_check
  check (
    avatar_storage_key is null
    or (
      length(avatar_storage_key) between 1 and 1024
      and avatar_storage_key not like '%..%'
    )
  );

create index if not exists tenant_branding_agent_head_idx
  on public.tenant_branding (tenant_id, version_number desc);

-- Brand assets live beside quarantine uploads in the private tenant bucket at
-- <tenant_uuid>/branding/<owner_user_uuid>/<asset_uuid>/<safe-filename>.
-- Every active member of the tenant may sign a read for the branding prefix so
-- the learner surface can render the configured logo and avatar. Writes stay
-- restricted to tenant owners and admins through a RESTRICTIVE guard, which is
-- ANDed with the permissive owner policy from migration 0006.
drop policy if exists tenant_private_branding_read on storage.objects;
create policy tenant_private_branding_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'tenant-private'
    and (storage.foldername(name))[1] = app_private.current_tenant_id()::text
    and (storage.foldername(name))[2] = 'branding'
  );

drop policy if exists tenant_private_branding_write_guard on storage.objects;
create policy tenant_private_branding_write_guard on storage.objects
  as restrictive
  for insert to authenticated
  with check (
    bucket_id <> 'tenant-private'
    or (storage.foldername(name))[2] is distinct from 'branding'
    or app_private.has_any_role(array['owner', 'client_admin'])
  );

drop policy if exists tenant_private_branding_delete_guard on storage.objects;
create policy tenant_private_branding_delete_guard on storage.objects
  as restrictive
  for delete to authenticated
  using (
    bucket_id <> 'tenant-private'
    or (storage.foldername(name))[2] is distinct from 'branding'
    or app_private.has_any_role(array['owner', 'client_admin'])
  );

create or replace function app_private.agent_configuration_defaults()
returns jsonb
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'assistantName', 'Learning assistant',
    'iconGlyph', null,
    'primaryColor', '#2F4BFF',
    'accentColor', '#12B981',
    'surfaceColor', '#F7F8FC',
    'textColor', '#101828',
    'welcomeMessage', 'How can I help you learn today?',
    'personaInstructions', null,
    'tone', 'neutral',
    'voice', null,
    'courseScope', '"all"'::jsonb,
    'logoStorageKey', null,
    'avatarStorageKey', null
  );
$$;
revoke execute on function app_private.agent_configuration_defaults()
  from public, anon, authenticated, service_role;

create or replace function app_private.agent_configuration_json(
  branding public.tenant_branding
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select case when branding.tenant_branding_id is null then null else
    jsonb_build_object(
      'brandingId', branding.tenant_branding_id,
      'status', branding.status,
      'version', branding.version_number,
      'assistantName', branding.assistant_name,
      'iconGlyph', branding.icon_glyph,
      'primaryColor', branding.primary_color,
      'accentColor', branding.accent_color,
      'surfaceColor', branding.surface_color,
      'textColor', branding.text_color,
      'welcomeMessage', branding.welcome_message,
      'personaInstructions', branding.persona_instructions,
      'tone', coalesce(branding.agent_tone, 'neutral'),
      'voice', branding.agent_voice,
      'courseScope', branding.agent_course_scope,
      'logoStorageKey', branding.logo_storage_key,
      'avatarStorageKey', branding.avatar_storage_key,
      'privacyCopy', branding.privacy_copy,
      'publishedAt', branding.published_at,
      'updatedAt', branding.updated_at
    )
  end;
$$;
revoke execute on function app_private.agent_configuration_json(
  public.tenant_branding
) from public, anon, authenticated, service_role;

create or replace function app_private.agent_configuration_audit(
  target_tenant_id uuid,
  actor_identity_role text,
  audit_action text,
  audit_decision text,
  audit_reason text,
  target_resource_id text,
  source_request_id text,
  source_trace_id text,
  source_change_ref text
)
returns void
language sql
security definer
set search_path = pg_catalog
as $$
  -- Parameter names deliberately avoid audit_ledger column names so the
  -- INSERT ... VALUES expressions can never resolve to a column instead.
  insert into public.audit_ledger (
    tenant_id, actor_id, actor_type, actor_role, action, resource_type,
    resource_id, policy_decision, decision_reason, change_ref, request_id,
    trace_id, retain_until, idempotency_key
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
    'tenant_branding',
    target_resource_id,
    audit_decision,
    audit_reason,
    source_change_ref,
    source_request_id,
    source_trace_id,
    now() + interval '7 years',
    'agent-configuration-audit:' ||
      encode(
        extensions.digest(
          target_tenant_id::text || chr(31) || audit_action || chr(31) ||
          audit_decision || chr(31) || coalesce(source_request_id, '') ||
          chr(31) || coalesce(audit_reason, ''),
          'sha256'
        ),
        'hex'
      )
  )
  on conflict (tenant_id, idempotency_key) do nothing;
$$;
revoke execute on function app_private.agent_configuration_audit(
  uuid, text, text, text, text, text, text, text, text
) from public, anon, authenticated, service_role;

create or replace function public.tenant_get_agent_configuration()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  head public.tenant_branding%rowtype;
  published_row public.tenant_branding%rowtype;
  draft_row public.tenant_branding%rowtype;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;
  if caller.identity_role not in ('tenant_owner', 'tenant_admin') then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select b.* into head
  from public.tenant_branding b
  where b.tenant_id = caller.tenant_id
    and b.deleted_at is null
  order by b.version_number desc
  limit 1;

  select b.* into published_row
  from public.tenant_branding b
  where b.tenant_id = caller.tenant_id
    and b.deleted_at is null
    and b.status = 'published'
  order by b.version_number desc
  limit 1;

  select b.* into draft_row
  from public.tenant_branding b
  where b.tenant_id = caller.tenant_id
    and b.deleted_at is null
    and b.status = 'draft'
  order by b.version_number desc
  limit 1;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', caller.tenant_id,
    'expectedVersion', coalesce(head.version_number, 0),
    'published', app_private.agent_configuration_json(published_row),
    'draft', app_private.agent_configuration_json(draft_row),
    'defaults', app_private.agent_configuration_defaults(),
    'toneOptions', jsonb_build_array(
      'neutral', 'friendly', 'encouraging', 'professional',
      'socratic', 'concise'
    ),
    'assetPrefix', caller.tenant_id::text || '/branding/'
  );
end;
$$;

create or replace function public.tenant_update_agent_configuration(
  requested_assistant_name text,
  requested_icon_glyph text,
  requested_primary_color text,
  requested_accent_color text,
  requested_surface_color text,
  requested_text_color text,
  requested_welcome_message text,
  requested_persona_instructions text,
  requested_agent_tone text,
  requested_agent_voice text,
  requested_course_scope jsonb,
  requested_logo_storage_key text,
  requested_avatar_storage_key text,
  requested_publish boolean,
  expected_version integer,
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
  head public.tenant_branding%rowtype;
  written public.tenant_branding%rowtype;
  result jsonb;
  request_fingerprint text;
  normalized_name text := btrim(coalesce(requested_assistant_name, ''));
  normalized_glyph text := nullif(
    btrim(coalesce(requested_icon_glyph, '')), ''
  );
  normalized_welcome text := btrim(coalesce(requested_welcome_message, ''));
  normalized_persona text := nullif(
    btrim(coalesce(requested_persona_instructions, '')), ''
  );
  normalized_tone text := lower(
    btrim(coalesce(requested_agent_tone, 'neutral'))
  );
  normalized_voice text := nullif(
    lower(btrim(coalesce(requested_agent_voice, ''))), ''
  );
  normalized_scope jsonb := coalesce(requested_course_scope, '"all"'::jsonb);
  normalized_logo_key text := nullif(
    btrim(coalesce(requested_logo_storage_key, '')), ''
  );
  normalized_avatar_key text := nullif(
    btrim(coalesce(requested_avatar_storage_key, '')), ''
  );
  publish_requested boolean := coalesce(requested_publish, false);
  asset_prefix text;
  scope_uuid_pattern constant text :=
    '^\[\s*"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}'
    || '-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"'
    || '(\s*,\s*"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}'
    || '-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")*\s*\]$';
  unknown_courses integer;
  next_version integer;
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
    perform app_private.agent_configuration_audit(
      caller.tenant_id, caller.identity_role, 'agent.configuration.update',
      'deny', 'role_not_allowed', caller.tenant_id::text,
      request_id, trace_id, null::text
    );
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  asset_prefix := caller.tenant_id::text || '/branding/';
  if length(normalized_name) not between 1 and 80
    or (normalized_glyph is not null and length(normalized_glyph) > 16)
    or requested_primary_color is null
    or requested_primary_color !~ '^#[0-9A-Fa-f]{6}$'
    or requested_accent_color is null
    or requested_accent_color !~ '^#[0-9A-Fa-f]{6}$'
    or requested_surface_color is null
    or requested_surface_color !~ '^#[0-9A-Fa-f]{6}$'
    or requested_text_color is null
    or requested_text_color !~ '^#[0-9A-Fa-f]{6}$'
    or length(normalized_welcome) not between 1 and 500
    or (normalized_persona is not null and length(normalized_persona) > 4000)
    or normalized_tone not in (
      'neutral', 'friendly', 'encouraging', 'professional',
      'socratic', 'concise'
    )
    or (normalized_voice is not null
      and normalized_voice !~ '^[a-z0-9][a-z0-9._-]{0,60}$')
    or expected_version is null
    or expected_version < 0
    or (
      normalized_scope <> '"all"'::jsonb
      and (
        jsonb_typeof(normalized_scope) <> 'array'
        or jsonb_array_length(normalized_scope) not between 1 and 200
        or normalized_scope::text !~ scope_uuid_pattern
      )
    )
    or (
      normalized_logo_key is not null
      and (
        normalized_logo_key not like asset_prefix || '%'
        or normalized_logo_key like '%..%'
        or length(normalized_logo_key) > 1024
      )
    )
    or (
      normalized_avatar_key is not null
      and (
        normalized_avatar_key not like asset_prefix || '%'
        or normalized_avatar_key like '%..%'
        or length(normalized_avatar_key) > 1024
      )
    )
  then
    perform app_private.agent_configuration_audit(
      caller.tenant_id, caller.identity_role, 'agent.configuration.update',
      'deny', 'invalid_request', caller.tenant_id::text,
      request_id, trace_id, null::text
    );
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  if normalized_scope <> '"all"'::jsonb then
    select count(*)::integer into unknown_courses
    from jsonb_array_elements_text(normalized_scope) as scoped(course_ref)
    where not exists (
      select 1
      from public.courses c
      where c.tenant_id = caller.tenant_id
        and c.course_id = scoped.course_ref::uuid
        and c.deleted_at is null
    );
    if unknown_courses > 0 then
      perform app_private.agent_configuration_audit(
        caller.tenant_id, caller.identity_role, 'agent.configuration.update',
        'deny', 'course_scope_invalid', caller.tenant_id::text,
        request_id, trace_id, null::text
      );
      return jsonb_build_object('ok', false, 'code', 'course_scope_invalid');
    end if;
  end if;

  request_fingerprint := encode(
    extensions.digest(
      concat_ws(
        chr(31),
        normalized_name,
        coalesce(normalized_glyph, ''),
        upper(requested_primary_color),
        upper(requested_accent_color),
        upper(requested_surface_color),
        upper(requested_text_color),
        normalized_welcome,
        coalesce(normalized_persona, ''),
        normalized_tone,
        coalesce(normalized_voice, ''),
        normalized_scope::text,
        coalesce(normalized_logo_key, ''),
        coalesce(normalized_avatar_key, ''),
        publish_requested::text,
        expected_version::text
      ),
      'sha256'
    ),
    'hex'
  );
  select * into command
  from app_private.onboarding_begin_command(
    caller.tenant_id, 'agent.configuration', idempotency_key,
    request_fingerprint, 'tenant_update_agent_configuration'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    perform app_private.agent_configuration_audit(
      caller.tenant_id, caller.identity_role, 'agent.configuration.update',
      'deny', 'idempotency_conflict', caller.tenant_id::text,
      request_id, trace_id, null::text
    );
    return jsonb_build_object('ok', false, 'code', 'idempotency_conflict');
  end if;

  -- Serialise concurrent agent edits on the tenant row so the version chain
  -- cannot fork between the read below and the insert.
  perform 1
  from public.tenants t
  where t.tenant_id = caller.tenant_id
    and t.deleted_at is null
  for update;
  if not found then
    result := jsonb_build_object('ok', false, 'code', 'tenant_not_found');
    perform app_private.onboarding_complete_command(
      caller.tenant_id, 'agent.configuration', idempotency_key, result
    );
    return result;
  end if;

  select b.* into head
  from public.tenant_branding b
  where b.tenant_id = caller.tenant_id
    and b.deleted_at is null
  order by b.version_number desc
  limit 1;

  if coalesce(head.version_number, 0) <> expected_version then
    result := jsonb_build_object(
      'ok', false,
      'code', 'version_conflict',
      'currentVersion', coalesce(head.version_number, 0)
    );
    perform app_private.agent_configuration_audit(
      caller.tenant_id, caller.identity_role, 'agent.configuration.update',
      'deny', 'version_conflict', caller.tenant_id::text,
      request_id, trace_id, null::text
    );
    perform app_private.onboarding_complete_command(
      caller.tenant_id, 'agent.configuration', idempotency_key, result
    );
    return result;
  end if;

  select coalesce(max(b.version_number), 0) + 1
  into next_version
  from public.tenant_branding b
  where b.tenant_id = caller.tenant_id;

  if publish_requested then
    update public.tenant_branding
    set status = 'retired'
    where tenant_id = caller.tenant_id
      and status = 'published';
  end if;

  insert into public.tenant_branding (
    tenant_id, status, version_number, assistant_name, icon_glyph,
    logo_storage_key, avatar_storage_key, primary_color, accent_color,
    surface_color, text_color, launcher, welcome_message, voice_configuration,
    privacy_copy, persona_instructions, agent_tone, agent_voice,
    agent_course_scope, published_by, published_at, idempotency_key
  ) values (
    caller.tenant_id,
    case when publish_requested then 'published' else 'draft' end,
    next_version,
    normalized_name,
    normalized_glyph,
    normalized_logo_key,
    normalized_avatar_key,
    upper(requested_primary_color),
    upper(requested_accent_color),
    upper(requested_surface_color),
    upper(requested_text_color),
    coalesce(head.launcher, '{}'::jsonb),
    normalized_welcome,
    coalesce(head.voice_configuration, '{}'::jsonb),
    head.privacy_copy,
    normalized_persona,
    normalized_tone,
    normalized_voice,
    normalized_scope,
    case when publish_requested then auth.uid() else null end,
    case when publish_requested then clock_timestamp() else null end,
    'agent-configuration:' ||
      encode(
        extensions.digest(
          caller.tenant_id::text || chr(31) ||
          tenant_update_agent_configuration.idempotency_key,
          'sha256'
        ),
        'hex'
      )
  )
  returning * into written;

  result := jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', caller.tenant_id,
    'expectedVersion', written.version_number,
    'configuration', app_private.agent_configuration_json(written)
  );
  perform app_private.agent_configuration_audit(
    caller.tenant_id, caller.identity_role, 'agent.configuration.update',
    'allow',
    case when publish_requested then 'published' else 'draft_saved' end,
    written.tenant_branding_id::text, request_id, trace_id,
    'agent-configuration:' || request_fingerprint
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id, 'agent.configuration', idempotency_key, result
  );
  return result;
end;
$$;

-- The agent's own instructions, resolved for one tenant. Private, because any
-- caller that can read this text can design prompts around it.
create or replace function app_private.agent_directive_for_tenant(
  target_tenant_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'assistantName', b.assistant_name,
    'personaInstructions', b.persona_instructions,
    'tone', coalesce(b.agent_tone, 'neutral'),
    'voice', b.agent_voice,
    'courseScope', b.agent_course_scope,
    'version', b.version_number
  )
  from public.tenant_branding b
  where b.tenant_id = target_tenant_id
    and b.deleted_at is null
    and b.status = 'published'
  order by b.version_number desc
  limit 1;
$$;
revoke execute on function app_private.agent_directive_for_tenant(uuid)
  from public, anon, authenticated, service_role;

-- Server-only read of the published persona for the answer path. The caller
-- must hold both a verified tenant membership and the conversation answer
-- operation token, which lives solely in the application server environment.
-- A browser session therefore cannot retrieve the persona text.
create or replace function public.learning_get_agent_directive(
  operation_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  directive jsonb;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;
  if not app_private.learning_operation_token_is_valid(
    'conversation.answer.record',
    operation_token
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  directive := app_private.agent_directive_for_tenant(caller.tenant_id);
  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'assistantName', directive ->> 'assistantName',
    'personaInstructions', directive -> 'personaInstructions',
    'tone', coalesce(directive ->> 'tone', 'neutral'),
    'courseScope', coalesce(directive -> 'courseScope', '"all"'::jsonb)
  );
end;
$$;

-- Redefinition of the durable workspace read from migration 0017. The branding
-- payload now carries the complete agent configuration so the learner surface
-- and the response route observe every edited field.
create or replace function public.learning_get_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  result jsonb;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;

  with visible_courses as (
    select c.*
    from public.courses c
    where c.tenant_id = caller.tenant_id
      and c.deleted_at is null
      and (
        caller.identity_role <> 'student'
        or c.status = 'published'
      )
    order by
      case c.status when 'published' then 0 else 1 end,
      c.updated_at desc,
      c.course_id
    limit 50
  ),
  tenant_record as (
    select t.*
    from public.tenants t
    where t.tenant_id = caller.tenant_id
      and t.deleted_at is null
  ),
  branding_record as (
    select b.*
    from public.tenant_branding b
    where b.tenant_id = caller.tenant_id
      and b.deleted_at is null
      and (
        b.status = 'published'
        or caller.identity_role <> 'student'
      )
    order by
      case b.status when 'published' then 0 else 1 end,
      b.version_number desc
    limit 1
  )
  select jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenant', jsonb_build_object(
      'tenantId', t.tenant_id,
      'slug', t.slug,
      'displayName', t.display_name,
      'status', t.status
    ),
    'identity', jsonb_build_object(
      'role', caller.identity_role,
      'canAuthor', caller.identity_role in (
        'tenant_owner', 'tenant_admin', 'creator', 'teacher'
      )
    ),
    -- Presentation fields theme every learner surface and stay readable by
    -- every member. The persona and tone are the assistant's own instructions:
    -- exposing them to a learner would hand them the text to design around, so
    -- they are withheld from every role below tenant administrator. The answer
    -- path reads them through public.learning_get_agent_directive instead.
    'branding', case when b.tenant_branding_id is null then null else
      jsonb_build_object(
        'assistantName', b.assistant_name,
        'primaryColor', b.primary_color,
        'accentColor', b.accent_color,
        'surfaceColor', b.surface_color,
        'textColor', b.text_color,
        'iconGlyph', b.icon_glyph,
        'welcomeMessage', b.welcome_message,
        'logoStorageKey', b.logo_storage_key,
        'avatarStorageKey', b.avatar_storage_key,
        'voice', b.agent_voice,
        'courseScope', b.agent_course_scope
      )
      || case
        when caller.identity_role in ('tenant_owner', 'tenant_admin')
        then jsonb_build_object(
          'personaInstructions', b.persona_instructions,
          'tone', coalesce(b.agent_tone, 'neutral')
        )
        else '{}'::jsonb
      end
    end,
    'courses', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'courseId', c.course_id,
          'title', c.title,
          'description', c.description,
          'status', c.status,
          'recordVersion', c.record_version,
          'progress', jsonb_build_object(
            'state', coalesce(sp.progress_state, 'not_started'),
            'lessonsCompleted', coalesce(sp.lessons_completed, 0),
            'lessonsTotal', coalesce(
              nullif(sp.lessons_total, 0),
              (
                select count(*)::integer
                from public.lessons total_lesson
                where total_lesson.tenant_id = c.tenant_id
                  and total_lesson.course_id = c.course_id
                  and total_lesson.deleted_at is null
                  and (
                    caller.identity_role <> 'student'
                    or total_lesson.status = 'published'
                  )
              ),
              0
            ),
            'percentComplete', coalesce(sp.percent_complete, 0),
            'lastActivityAt', sp.last_activity_at
          ),
          'modules', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'moduleId', m.module_id,
                'title', m.title,
                'position', m.position,
                'status', m.status,
                'lessons', coalesce((
                  select jsonb_agg(
                    jsonb_build_object(
                      'lessonId', l.lesson_id,
                      'title', l.title,
                      'position', l.position,
                      'status', l.status,
                      'progressState', coalesce(lp.progress_state, 'not_started'),
                      'blocks', coalesce((
                        select jsonb_agg(
                          jsonb_build_object(
                            'contentBlockId', cb.content_block_id,
                            'type', cb.block_type,
                            'position', cb.position,
                            'content', cb.content
                          )
                          order by cb.position, cb.content_block_id
                        )
                        from public.content_blocks cb
                        where cb.tenant_id = l.tenant_id
                          and cb.lesson_id = l.lesson_id
                          and cb.deleted_at is null
                      ), '[]'::jsonb)
                    )
                    order by l.position, l.lesson_id
                  )
                  from public.lessons l
                  left join public.lesson_progress lp
                    on lp.tenant_id = l.tenant_id
                   and lp.lesson_id = l.lesson_id
                   and lp.user_id = auth.uid()
                   and lp.deleted_at is null
                  where l.tenant_id = m.tenant_id
                    and l.module_id = m.module_id
                    and l.deleted_at is null
                    and (
                      caller.identity_role <> 'student'
                      or l.status = 'published'
                    )
                ), '[]'::jsonb)
              )
              order by m.position, m.module_id
            )
            from public.modules m
            where m.tenant_id = c.tenant_id
              and m.course_id = c.course_id
              and m.deleted_at is null
              and (
                caller.identity_role <> 'student'
                or m.status = 'published'
              )
          ), '[]'::jsonb)
        )
        order by
          case c.status when 'published' then 0 else 1 end,
          c.updated_at desc,
          c.course_id
      )
      from visible_courses c
      left join public.student_progress sp
        on sp.tenant_id = c.tenant_id
       and sp.course_id = c.course_id
       and sp.user_id = auth.uid()
       and sp.deleted_at is null
    ), '[]'::jsonb)
  )
  into result
  from tenant_record t
  left join branding_record b on true;

  return coalesce(
    result,
    jsonb_build_object('ok', false, 'code', 'tenant_not_found')
  );
end;
$$;

revoke execute on function public.tenant_get_agent_configuration()
  from public, anon, service_role;
revoke execute on function public.tenant_update_agent_configuration(
  text, text, text, text, text, text, text, text, text, text, jsonb, text,
  text, boolean, integer, text, text, text
) from public, anon, service_role;
revoke execute on function public.learning_get_agent_directive(text)
  from public, anon, service_role;
revoke execute on function public.learning_get_workspace()
  from public, anon, service_role;
grant execute on function public.tenant_get_agent_configuration()
  to authenticated;
grant execute on function public.learning_get_agent_directive(text)
  to authenticated;
grant execute on function public.tenant_update_agent_configuration(
  text, text, text, text, text, text, text, text, text, text, jsonb, text,
  text, boolean, integer, text, text, text
) to authenticated;
grant execute on function public.learning_get_workspace()
  to authenticated;

commit;

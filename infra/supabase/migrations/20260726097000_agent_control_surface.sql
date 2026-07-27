-- Phase 4b: the agent control surface (docs/PLAN.md Section 6).
--
-- Extends the versioned public.tenant_branding chain introduced by migration
-- 20260725120000 with the remaining creator-facing knobs: generation
-- parameters, voice behaviour, a longer free-form instruction block, grounding
-- behaviour (retrieval count, similarity floor, refusal wording) and
-- escalation copy. It also adds explicit revision history and rollback,
-- reusing the append-only-version idea that public.course_revisions /
-- learning_rollback_course already established for course content — here the
-- "revision log" is the tenant_branding chain itself (every save, draft or
-- published, already appends a new immutable row; nothing is ever updated in
-- place except the single `status` flip that retires the previously published
-- row), so rollback is "insert a new head that copies an old row's fields",
-- exactly the same idea `learning_rollback_course` uses against its own
-- snapshot table.
--
-- Structural boundary (PLAN Section 6.2): this migration adds no column and no
-- function parameter that can hold a platform base instruction, a system
-- prompt, or anything that could replace the grounding/citation/safety rules.
-- Every creator-editable text field returned by this migration is a separate,
-- labelled JSON key (personaInstructions / extendedInstructions /
-- noResultsMessage / escalationMessage / welcomeMessage) — never concatenated
-- into one opaque string at rest. The only place those strings are combined
-- with the platform's own instructions is the existing, unmodified
-- src/lib/learning-provider.ts, which already wraps personaInstructions in an
-- explicit <tenant_persona> boundary and states in the system prompt that it
-- "never overrides the grounding, citation or safety rules above" — this
-- migration extends the same directive contract those call sites already read
-- through public.learning_get_agent_directive.

begin;

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.tenant_branding
  add column if not exists agent_model text
    not null default 'gpt-5.6-luna',
  add column if not exists agent_temperature numeric(3, 2)
    not null default 0.40,
  add column if not exists agent_top_p numeric(3, 2)
    not null default 1.00,
  add column if not exists agent_max_output_tokens integer
    not null default 800,
  add column if not exists extended_instructions text,
  add column if not exists voice_enabled boolean
    not null default true,
  add column if not exists voice_speaking_rate numeric(3, 2)
    not null default 1.00,
  add column if not exists voice_barge_in_enabled boolean
    not null default true,
  add column if not exists retrieval_count integer
    not null default 6,
  add column if not exists retrieval_similarity_floor numeric(4, 3)
    not null default 0.200,
  -- Identical wording to the hardcoded fallback in
  -- src/lib/learning-provider.ts, so introducing this column changes no
  -- existing answer until a future phase threads it into that call site.
  add column if not exists no_results_message text
    not null default (
      'I couldn''t find this in the published learning yet. ' ||
      'Try naming the course, lesson, or idea you want to understand.'
    ),
  add column if not exists escalation_enabled boolean
    not null default false,
  add column if not exists escalation_trigger text
    not null default 'manual',
  add column if not exists escalation_message text;

-- The platform-allowed model set. A single function, not a hardcoded literal
-- in every CHECK and default, so extending the set later is a one-function
-- redefinition rather than a column rewrite.
create or replace function app_private.agent_allowed_models()
returns text[]
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select array['gpt-5.6-luna', 'gpt-5.6-luna-mini', 'gpt-5.6-luna-pro'];
$$;
revoke execute on function app_private.agent_allowed_models()
  from public, anon, authenticated, service_role;

alter table public.tenant_branding
  drop constraint if exists tenant_branding_agent_model_check;
alter table public.tenant_branding
  add constraint tenant_branding_agent_model_check
  check (agent_model = any (app_private.agent_allowed_models()));

alter table public.tenant_branding
  drop constraint if exists tenant_branding_agent_temperature_check;
alter table public.tenant_branding
  add constraint tenant_branding_agent_temperature_check
  check (agent_temperature >= 0 and agent_temperature <= 2);

alter table public.tenant_branding
  drop constraint if exists tenant_branding_agent_top_p_check;
alter table public.tenant_branding
  add constraint tenant_branding_agent_top_p_check
  check (agent_top_p > 0 and agent_top_p <= 1);

alter table public.tenant_branding
  drop constraint if exists tenant_branding_agent_max_output_tokens_check;
alter table public.tenant_branding
  add constraint tenant_branding_agent_max_output_tokens_check
  check (agent_max_output_tokens between 64 and 4000);

alter table public.tenant_branding
  drop constraint if exists tenant_branding_extended_instructions_check;
alter table public.tenant_branding
  add constraint tenant_branding_extended_instructions_check
  check (
    extended_instructions is null
    or length(extended_instructions) between 1 and 8000
  );

alter table public.tenant_branding
  drop constraint if exists tenant_branding_voice_speaking_rate_check;
alter table public.tenant_branding
  add constraint tenant_branding_voice_speaking_rate_check
  check (voice_speaking_rate >= 0.5 and voice_speaking_rate <= 2.0);

alter table public.tenant_branding
  drop constraint if exists tenant_branding_retrieval_count_check;
alter table public.tenant_branding
  add constraint tenant_branding_retrieval_count_check
  check (retrieval_count between 1 and 20);

alter table public.tenant_branding
  drop constraint if exists tenant_branding_retrieval_similarity_floor_check;
alter table public.tenant_branding
  add constraint tenant_branding_retrieval_similarity_floor_check
  check (
    retrieval_similarity_floor >= 0 and retrieval_similarity_floor <= 1
  );

alter table public.tenant_branding
  drop constraint if exists tenant_branding_no_results_message_check;
alter table public.tenant_branding
  add constraint tenant_branding_no_results_message_check
  check (length(no_results_message) between 1 and 500);

alter table public.tenant_branding
  drop constraint if exists tenant_branding_escalation_trigger_check;
alter table public.tenant_branding
  add constraint tenant_branding_escalation_trigger_check
  check (
    escalation_trigger in (
      'manual', 'always_available', 'after_no_results',
      'after_repeated_question'
    )
  );

alter table public.tenant_branding
  drop constraint if exists tenant_branding_escalation_message_check;
alter table public.tenant_branding
  add constraint tenant_branding_escalation_message_check
  check (
    escalation_message is null
    or length(escalation_message) between 1 and 500
  );

-- Escalation copy is meaningless without escalation switched on, and a
-- creator who switches it on without writing anything would ship a silent
-- dead end to a student who needs a human. Enforced at the column, not just
-- in the UI, so a direct RPC call cannot skip it either.
alter table public.tenant_branding
  drop constraint if exists tenant_branding_escalation_requires_message_check;
alter table public.tenant_branding
  add constraint tenant_branding_escalation_requires_message_check
  check (not escalation_enabled or escalation_message is not null);

-- ---------------------------------------------------------------------------
-- Defaults and projection
-- ---------------------------------------------------------------------------

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
    'avatarStorageKey', null,
    'model', 'gpt-5.6-luna',
    'temperature', 0.40,
    'topP', 1.00,
    'maxOutputTokens', 800,
    'extendedInstructions', null,
    'voiceEnabled', true,
    'voiceSpeakingRate', 1.00,
    'voiceBargeInEnabled', true,
    'retrievalCount', 6,
    'retrievalSimilarityFloor', 0.200,
    'noResultsMessage',
      'I couldn''t find this in the published learning yet. ' ||
      'Try naming the course, lesson, or idea you want to understand.',
    'escalationEnabled', false,
    'escalationTrigger', 'manual',
    'escalationMessage', null
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
      'model', branding.agent_model,
      'temperature', branding.agent_temperature,
      'topP', branding.agent_top_p,
      'maxOutputTokens', branding.agent_max_output_tokens,
      'extendedInstructions', branding.extended_instructions,
      'voiceEnabled', branding.voice_enabled,
      'voiceSpeakingRate', branding.voice_speaking_rate,
      'voiceBargeInEnabled', branding.voice_barge_in_enabled,
      'retrievalCount', branding.retrieval_count,
      'retrievalSimilarityFloor', branding.retrieval_similarity_floor,
      'noResultsMessage', branding.no_results_message,
      'escalationEnabled', branding.escalation_enabled,
      'escalationTrigger', branding.escalation_trigger,
      'escalationMessage', branding.escalation_message,
      'publishedAt', branding.published_at,
      'updatedAt', branding.updated_at
    )
  end;
$$;
revoke execute on function app_private.agent_configuration_json(
  public.tenant_branding
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
    'modelOptions', to_jsonb(app_private.agent_allowed_models()),
    'escalationTriggerOptions', jsonb_build_array(
      'manual', 'always_available', 'after_no_results',
      'after_repeated_question'
    ),
    'assetPrefix', caller.tenant_id::text || '/branding/'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Write path
-- ---------------------------------------------------------------------------

-- The parameter list grows in this migration, so the function must be
-- dropped and recreated rather than replaced in place.
drop function if exists public.tenant_update_agent_configuration(
  text, text, text, text, text, text, text, text, text, text, jsonb, text,
  text, boolean, integer, text, text, text
);

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
  requested_model text,
  requested_temperature numeric,
  requested_top_p numeric,
  requested_max_output_tokens integer,
  requested_extended_instructions text,
  requested_voice_enabled boolean,
  requested_voice_speaking_rate numeric,
  requested_voice_barge_in_enabled boolean,
  requested_retrieval_count integer,
  requested_retrieval_similarity_floor numeric,
  requested_no_results_message text,
  requested_escalation_enabled boolean,
  requested_escalation_trigger text,
  requested_escalation_message text,
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
  normalized_model text := lower(btrim(coalesce(requested_model, '')));
  normalized_extended text := nullif(
    btrim(coalesce(requested_extended_instructions, '')), ''
  );
  normalized_escalation_trigger text := lower(
    btrim(coalesce(requested_escalation_trigger, 'manual'))
  );
  normalized_escalation_message text := nullif(
    btrim(coalesce(requested_escalation_message, '')), ''
  );
  normalized_no_results text := btrim(
    coalesce(requested_no_results_message, '')
  );
  escalation_enabled_value boolean := coalesce(
    requested_escalation_enabled, false
  );
  voice_enabled_value boolean := coalesce(requested_voice_enabled, true);
  voice_barge_in_value boolean := coalesce(
    requested_voice_barge_in_enabled, true
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
    -- Generation. The model is chosen from the platform-allowed set only —
    -- there is no path through this RPC to an arbitrary model string.
    or normalized_model <> all (app_private.agent_allowed_models())
    or requested_temperature is null
    or requested_temperature < 0 or requested_temperature > 2
    or requested_top_p is null
    or requested_top_p <= 0 or requested_top_p > 1
    or requested_max_output_tokens is null
    or requested_max_output_tokens not between 64 and 4000
    or (normalized_extended is not null and length(normalized_extended) > 8000)
    -- Voice.
    or requested_voice_speaking_rate is null
    or requested_voice_speaking_rate < 0.5
    or requested_voice_speaking_rate > 2.0
    -- Grounding behaviour. The floor and count are configurable; whether an
    -- empty retrieval refuses is not — there is no parameter here that can
    -- turn that decision off.
    or requested_retrieval_count is null
    or requested_retrieval_count not between 1 and 20
    or requested_retrieval_similarity_floor is null
    or requested_retrieval_similarity_floor < 0
    or requested_retrieval_similarity_floor > 1
    or length(normalized_no_results) not between 1 and 500
    -- Escalation.
    or normalized_escalation_trigger not in (
      'manual', 'always_available', 'after_no_results',
      'after_repeated_question'
    )
    or (
      escalation_enabled_value
      and (
        normalized_escalation_message is null
        or length(normalized_escalation_message) > 500
      )
    )
    or (
      normalized_escalation_message is not null
      and length(normalized_escalation_message) > 500
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
        normalized_model,
        requested_temperature::text,
        requested_top_p::text,
        requested_max_output_tokens::text,
        coalesce(normalized_extended, ''),
        voice_enabled_value::text,
        requested_voice_speaking_rate::text,
        voice_barge_in_value::text,
        requested_retrieval_count::text,
        requested_retrieval_similarity_floor::text,
        normalized_no_results,
        escalation_enabled_value::text,
        normalized_escalation_trigger,
        coalesce(normalized_escalation_message, ''),
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
    agent_course_scope, agent_model, agent_temperature, agent_top_p,
    agent_max_output_tokens, extended_instructions, voice_enabled,
    voice_speaking_rate, voice_barge_in_enabled, retrieval_count,
    retrieval_similarity_floor, no_results_message, escalation_enabled,
    escalation_trigger, escalation_message, published_by, published_at,
    idempotency_key
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
    normalized_model,
    requested_temperature,
    requested_top_p,
    requested_max_output_tokens,
    normalized_extended,
    voice_enabled_value,
    requested_voice_speaking_rate,
    voice_barge_in_value,
    requested_retrieval_count,
    requested_retrieval_similarity_floor,
    normalized_no_results,
    escalation_enabled_value,
    normalized_escalation_trigger,
    normalized_escalation_message,
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

-- ---------------------------------------------------------------------------
-- Revision history and rollback
--
-- Every draft save and every publish already appends an immutable new row to
-- public.tenant_branding rather than mutating an existing one (the only
-- in-place UPDATE the write path above performs is retiring the previously
-- published row's status). That row chain already *is* the append-only
-- revision log course_revisions provides for course content; these two RPCs
-- just expose it and let a creator restore an old head, the same shape as
-- learning_list_course_revisions / learning_rollback_course.
-- ---------------------------------------------------------------------------

create or replace function public.tenant_list_agent_configuration_revisions()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  items jsonb;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;
  if caller.identity_role not in ('tenant_owner', 'tenant_admin') then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'version', b.version_number,
        'status', b.status,
        'assistantName', b.assistant_name,
        'welcomeMessage', b.welcome_message,
        'tone', coalesce(b.agent_tone, 'neutral'),
        'model', b.agent_model,
        'publishedAt', b.published_at,
        'createdAt', b.created_at,
        'updatedAt', b.updated_at
      )
      order by b.version_number desc
    ),
    '[]'::jsonb
  )
  into items
  from (
    select *
    from public.tenant_branding b
    where b.tenant_id = caller.tenant_id
      and b.deleted_at is null
    order by b.version_number desc
    limit 100
  ) as b;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', caller.tenant_id,
    'revisions', items
  );
end;
$$;

-- Restores an earlier version's complete field set as a brand new head
-- (draft or published), never by rewriting the target row. No row this
-- function reads is ever mutated, so the full history survives a rollback
-- and can itself be rolled back from.
create or replace function public.tenant_rollback_agent_configuration(
  target_version integer,
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
  target public.tenant_branding%rowtype;
  written public.tenant_branding%rowtype;
  result jsonb;
  publish_requested boolean := coalesce(requested_publish, false);
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
    or target_version is null or target_version < 1
    or expected_version is null or expected_version < 0
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if caller.identity_role not in ('tenant_owner', 'tenant_admin') then
    perform app_private.agent_configuration_audit(
      caller.tenant_id, caller.identity_role, 'agent.configuration.rollback',
      'deny', 'role_not_allowed', caller.tenant_id::text,
      request_id, trace_id, null::text
    );
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select * into command
  from app_private.onboarding_begin_command(
    caller.tenant_id, 'agent.configuration', idempotency_key,
    encode(
      extensions.digest(
        concat_ws(
          chr(31), caller.tenant_id::text, target_version::text,
          publish_requested::text, expected_version::text
        ),
        'sha256'
      ),
      'hex'
    ),
    'tenant_rollback_agent_configuration'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    perform app_private.agent_configuration_audit(
      caller.tenant_id, caller.identity_role, 'agent.configuration.rollback',
      'deny', 'idempotency_conflict', caller.tenant_id::text,
      request_id, trace_id, null::text
    );
    return jsonb_build_object('ok', false, 'code', 'idempotency_conflict');
  end if;

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
      caller.tenant_id, caller.identity_role, 'agent.configuration.rollback',
      'deny', 'version_conflict', caller.tenant_id::text,
      request_id, trace_id, null::text
    );
    perform app_private.onboarding_complete_command(
      caller.tenant_id, 'agent.configuration', idempotency_key, result
    );
    return result;
  end if;

  select b.* into target
  from public.tenant_branding b
  where b.tenant_id = caller.tenant_id
    and b.deleted_at is null
    and b.version_number = target_version;
  if not found then
    result := jsonb_build_object('ok', false, 'code', 'revision_not_found');
    perform app_private.agent_configuration_audit(
      caller.tenant_id, caller.identity_role, 'agent.configuration.rollback',
      'deny', 'revision_not_found', caller.tenant_id::text,
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
    agent_course_scope, agent_model, agent_temperature, agent_top_p,
    agent_max_output_tokens, extended_instructions, voice_enabled,
    voice_speaking_rate, voice_barge_in_enabled, retrieval_count,
    retrieval_similarity_floor, no_results_message, escalation_enabled,
    escalation_trigger, escalation_message, published_by, published_at,
    idempotency_key
  )
  select
    caller.tenant_id,
    case when publish_requested then 'published' else 'draft' end,
    next_version,
    target.assistant_name,
    target.icon_glyph,
    target.logo_storage_key,
    target.avatar_storage_key,
    target.primary_color,
    target.accent_color,
    target.surface_color,
    target.text_color,
    target.launcher,
    target.welcome_message,
    target.voice_configuration,
    target.privacy_copy,
    target.persona_instructions,
    target.agent_tone,
    target.agent_voice,
    target.agent_course_scope,
    target.agent_model,
    target.agent_temperature,
    target.agent_top_p,
    target.agent_max_output_tokens,
    target.extended_instructions,
    target.voice_enabled,
    target.voice_speaking_rate,
    target.voice_barge_in_enabled,
    target.retrieval_count,
    target.retrieval_similarity_floor,
    target.no_results_message,
    target.escalation_enabled,
    target.escalation_trigger,
    target.escalation_message,
    case when publish_requested then auth.uid() else null end,
    case when publish_requested then clock_timestamp() else null end,
    'agent-configuration-rollback:' ||
      encode(
        extensions.digest(
          caller.tenant_id::text || chr(31) ||
          tenant_rollback_agent_configuration.idempotency_key,
          'sha256'
        ),
        'hex'
      )
  returning * into written;

  result := jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', caller.tenant_id,
    'expectedVersion', written.version_number,
    'restoredFromVersion', target.version_number,
    'configuration', app_private.agent_configuration_json(written)
  );
  perform app_private.agent_configuration_audit(
    caller.tenant_id, caller.identity_role, 'agent.configuration.rollback',
    'allow',
    case when publish_requested then 'published' else 'draft_saved' end,
    written.tenant_branding_id::text, request_id, trace_id,
    'agent-configuration-rollback:' || target.version_number::text
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id, 'agent.configuration', idempotency_key, result
  );
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Server-only directive (extends the existing operation-token-gated read)
-- ---------------------------------------------------------------------------

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
    'extendedInstructions', b.extended_instructions,
    'tone', coalesce(b.agent_tone, 'neutral'),
    'voice', b.agent_voice,
    'courseScope', b.agent_course_scope,
    'model', b.agent_model,
    'temperature', b.agent_temperature,
    'topP', b.agent_top_p,
    'maxOutputTokens', b.agent_max_output_tokens,
    'voiceEnabled', b.voice_enabled,
    'voiceSpeakingRate', b.voice_speaking_rate,
    'voiceBargeInEnabled', b.voice_barge_in_enabled,
    'retrievalCount', b.retrieval_count,
    'retrievalSimilarityFloor', b.retrieval_similarity_floor,
    'noResultsMessage', b.no_results_message,
    'escalationEnabled', b.escalation_enabled,
    'escalationTrigger', b.escalation_trigger,
    'escalationMessage', b.escalation_message,
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
    'extendedInstructions', directive -> 'extendedInstructions',
    'tone', coalesce(directive ->> 'tone', 'neutral'),
    'courseScope', coalesce(directive -> 'courseScope', '"all"'::jsonb),
    'model', directive -> 'model',
    'temperature', directive -> 'temperature',
    'topP', directive -> 'topP',
    'maxOutputTokens', directive -> 'maxOutputTokens',
    'retrievalCount', directive -> 'retrievalCount',
    'retrievalSimilarityFloor', directive -> 'retrievalSimilarityFloor',
    'noResultsMessage', directive -> 'noResultsMessage',
    'escalationEnabled', directive -> 'escalationEnabled',
    'escalationTrigger', directive -> 'escalationTrigger',
    'escalationMessage', directive -> 'escalationMessage'
  );
end;
$$;

revoke execute on function public.tenant_get_agent_configuration()
  from public, anon, service_role;
revoke execute on function public.tenant_update_agent_configuration(
  text, text, text, text, text, text, text, text, text, text, jsonb, text,
  text, text, numeric, numeric, integer, text, boolean, numeric, boolean,
  integer, numeric, text, boolean, text, text, boolean, integer, text, text,
  text
) from public, anon, service_role;
revoke execute on function public.tenant_list_agent_configuration_revisions()
  from public, anon, service_role;
revoke execute on function public.tenant_rollback_agent_configuration(
  integer, boolean, integer, text, text, text
) from public, anon, service_role;
revoke execute on function public.learning_get_agent_directive(text)
  from public, anon, service_role;

grant execute on function public.tenant_get_agent_configuration()
  to authenticated;
grant execute on function public.tenant_update_agent_configuration(
  text, text, text, text, text, text, text, text, text, text, jsonb, text,
  text, text, numeric, numeric, integer, text, boolean, numeric, boolean,
  integer, numeric, text, boolean, text, text, boolean, integer, text, text,
  text
) to authenticated;
grant execute on function public.tenant_list_agent_configuration_revisions()
  to authenticated;
grant execute on function public.tenant_rollback_agent_configuration(
  integer, boolean, integer, text, text, text
) to authenticated;
grant execute on function public.learning_get_agent_directive(text)
  to authenticated;

commit;

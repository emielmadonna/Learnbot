-- LearningBot: 6 unapplied migrations, in order.
-- Generated 2026-07-27T16:57:08Z. Fingerprint of full set: 7e6853fae545b6d0d41dc61cfa0b49daede26857dcd5e91805584296acf56957
--
-- APPLIED 2026-07-27 by hand via the Supabase SQL editor. See
-- infra/supabase/SCHEMA-DRIFT.md for the record. This file is kept as the
-- artifact of what was run; re-running it is a no-op only where the migrations
-- are idempotent, which is NOT true of all of them.
--
-- Verified drift-safe: none of these touch admin_provision_auth_user,
-- admin_list_access_accounts, platform_admin_client_detail, or the provider-credential vault.
--
-- DROP inventory (the earlier claim that every DROP was a policy/trigger was wrong):
--   * many  'alter table ... drop constraint if exists', each re-added immediately;
--   * several 'drop policy if exists' / 'drop trigger if exists' on objects this
--     file creates;
--   * exactly one 'drop function if exists' --
--     public.tenant_update_agent_configuration(18 args), dropped and recreated in
--     the same transaction because its parameter list grows. The live signature was
--     confirmed to match that argument list before applying, so it replaced cleanly
--     rather than leaving a second, ambiguous overload.

-- ============================================================
-- 20260726097000_agent_control_surface.sql
-- ============================================================
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

-- ============================================================
-- 20260726098000_learner_signal_readout.sql
-- ============================================================
-- Per-learner signal readout.
--
-- public.question_labels already carries one row per classified learner
-- question, including subject_user_id, so the per-learner view this file adds
-- is a read, not a new write path. Nothing here writes a new table; it is one
-- new function (plus one small helper and one index) over rows the product
-- already records.
--
-- What this answers, in the buyer's terms (docs/PLAN.md Section 1): which
-- student is worth paying attention to. Four things, all derived in
-- deterministic SQL from public.question_labels, public.messages,
-- public.student_progress and app_private.user_access_accounts:
--
--   * depth        - the share of a learner's classified questions the
--                     classifier rated notable or critical.
--   * escalation   - whether a learner's questions are trending toward more
--                     applied intents (how_to, troubleshooting) versus more
--                     foundational ones (definition, scope_check), comparing
--                     the first half of their classified questions in range
--                     against the second half.
--   * stuck        - the same topic asked repeatedly within one lesson.
--   * readiness    - a heuristic combining recorded course completion with
--                     question volume and importance. It is explicitly a
--                     prioritised list to review, never a certainty.
--
-- Honesty boundary, same envelope as 20260725121000 and 20260726091000
-- (state / value / dataThrough / evidenceRefs / limitations):
--
--   * When nothing in the range has been classified, learnerRows is
--     'unknown' with the reason, not an empty list.
--   * A learner's escalation trend is 'insufficient_data' below a minimum
--     sample size rather than guessed from two or three questions.
--   * Readiness is always reported with its underlying evidence numbers next
--     to the tier, and is 'insufficient_data' whenever no course-progress
--     record exists for the learner at all -- it is never inferred from
--     question activity alone.
--   * Every count here is a direct aggregate over recorded rows. Nothing is
--     sampled, interpolated or modelled.
--
-- Access: app_private.analytics_context(), identical to every sibling
-- analytics function -- tenant-scoped, role-gated (tenant_owner, tenant_admin,
-- creator, teacher), SECURITY DEFINER over forced row level security. A
-- platform administrator who has entered a tenant workspace reads through the
-- same path, because that membership is what analytics_context() resolves; no
-- second privilege path is introduced. Section visibility (hiding this
-- content entirely from a tenant without the entitlement) is the existing
-- "insights" tenant_sections gate the console already applies to this whole
-- panel -- this file does not add a second gating mechanism.

begin;

-- Supports the per-learner, time-ordered scan the escalation and stuck
-- computations both need.
create index question_labels_subject_time_idx
  on public.question_labels (tenant_id, subject_user_id, asked_at)
  where deleted_at is null;

-- A fixed ranking from foundational to applied. This is a taxonomy position,
-- not a linguistic specificity score: troubleshooting names a concrete,
-- applied problem; definition and scope_check name foundational orientation
-- questions. off_topic carries no position and is excluded from every
-- specificity computation.
create or replace function app_private.question_intent_specificity_rank(
  question_intent text
)
returns smallint
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select case question_intent
    when 'definition' then 1
    when 'scope_check' then 1
    when 'clarification' then 2
    when 'how_to' then 3
    when 'troubleshooting' then 4
    else null
  end::smallint;
$$;
revoke execute on function app_private.question_intent_specificity_rank(text)
  from public, anon, authenticated, service_role;

create or replace function public.analytics_learner_signals(
  range_start timestamptz default null,
  range_end timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  win record;
  learner_limit constant integer := 50;
  min_trend_questions constant integer := 4;
  stuck_threshold constant integer := 3;
  escalation_margin constant numeric := 0.75;
  data_through timestamptz;
  totals record;
  learners_json jsonb;
  omitted_learners bigint := 0;
  coverage_state text;
  learner_rows_state text;
  coverage_limitations text[] := '{}'::text[];
  learner_rows_limitations text[] := '{}'::text[];
  unclassified_note text;
  evidence constant jsonb := jsonb_build_array(
    'table:public.question_labels',
    'table:public.messages',
    'table:public.conversations',
    'table:public.student_progress',
    'table:app_private.user_access_accounts'
  );
begin
  select * into caller from app_private.analytics_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  select * into win
  from app_private.analytics_window(range_start, range_end);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_range');
  end if;
  data_through := least(win.window_end, statement_timestamp());

  select
    count(*)::bigint as questions,
    count(ql.question_label_id)::bigint as classified_questions,
    count(*) filter (where ql.question_label_id is null)::bigint
      as unclassified_questions,
    count(distinct conv.subject_user_id)::bigint as learners,
    count(distinct conv.subject_user_id) filter (
      where ql.question_label_id is not null
    )::bigint as classified_learners
  into totals
  from public.messages m
  join public.conversations conv
    on conv.tenant_id = m.tenant_id
   and conv.conversation_id = m.conversation_id
  left join public.question_labels ql
    on ql.tenant_id = m.tenant_id
   and ql.message_id = m.message_id
   and ql.deleted_at is null
  where m.tenant_id = caller.tenant_id
    and m.created_at >= win.window_start
    and m.created_at < win.window_end
    and m.deleted_at is null
    and m.status = 'final'
    and m.actor_type in ('student', 'creator', 'owner')
    and m.modality in ('text', 'voice_transcript')
    and conv.deleted_at is null;

  unclassified_note :=
    coalesce(totals.unclassified_questions, 0)::text ||
    ' question(s) in this range carry no recorded classification and are ' ||
    'excluded from every learner row below. A learner whose questions are ' ||
    'all unclassified is left off the list rather than shown with an ' ||
    'empty profile.';

  -- Honest state. An empty learner list is only truthful when there were no
  -- questions at all; otherwise it would read as "nobody asked anything".
  coverage_state := case
    when coalesce(totals.questions, 0) = 0 then 'known'
    when coalesce(totals.classified_questions, 0) = 0 then 'unknown'
    when coalesce(totals.unclassified_questions, 0) > 0 then 'partial'
    else 'known'
  end;
  if coalesce(totals.unclassified_questions, 0) > 0 then
    coverage_limitations := coverage_limitations || unclassified_note;
  end if;

  learner_rows_state := coverage_state;
  if learner_rows_state = 'unknown' then
    learner_rows_limitations := array[
      'No question in this range carries a recorded classification, so no ' ||
      'learner can be profiled. ' || unclassified_note ||
      ' Classification runs after an answer is recorded and is skipped ' ||
      'whenever the classifier is unavailable or returns output that does ' ||
      'not match the closed schema.'
    ]::text[];
  elsif coalesce(totals.unclassified_questions, 0) > 0 then
    learner_rows_limitations := array[unclassified_note]::text[];
  end if;

  if learner_rows_state <> 'unknown' then
    with labelled as (
      select
        ql.question_label_id,
        ql.subject_user_id,
        ql.topic_key,
        ql.topic_label,
        ql.question_intent,
        ql.importance,
        ql.grounding_outcome,
        ql.course_id,
        ql.lesson_id,
        ql.asked_at,
        app_private.question_intent_specificity_rank(ql.question_intent)
          as specificity_rank
      from public.question_labels ql
      where ql.tenant_id = caller.tenant_id
        and ql.deleted_at is null
        and ql.asked_at >= win.window_start
        and ql.asked_at < win.window_end
    ),
    ordered as (
      select
        l.*,
        ntile(2) over (
          partition by l.subject_user_id
          order by l.asked_at, l.question_label_id
        ) as sequence_half
      from labelled l
    ),
    learner_totals as (
      select
        o.subject_user_id,
        count(*)::bigint as questions,
        count(distinct o.topic_key)::bigint as distinct_topics,
        count(distinct o.lesson_id)::bigint as distinct_lessons,
        count(distinct o.course_id)::bigint as distinct_courses,
        count(*) filter (
          where o.importance in ('notable', 'critical')
        )::bigint as notable_or_critical,
        count(*) filter (where o.importance = 'critical')::bigint
          as critical_questions,
        count(*) filter (
          where o.grounding_outcome = 'ungrounded'
        )::bigint as ungrounded_answers,
        min(o.asked_at) as first_asked_at,
        max(o.asked_at) as last_asked_at
      from ordered o
      group by o.subject_user_id
    ),
    escalation as (
      select
        o.subject_user_id,
        avg(o.specificity_rank) filter (
          where o.sequence_half = 1
        ) as first_half_avg,
        avg(o.specificity_rank) filter (
          where o.sequence_half = 2
        ) as second_half_avg,
        count(*) filter (where o.specificity_rank is not null)::bigint
          as ranked_questions
      from ordered o
      group by o.subject_user_id
    ),
    stuck_clusters as (
      select
        l.subject_user_id,
        l.lesson_id,
        l.course_id,
        l.topic_key,
        max(l.topic_label) as topic_label,
        count(*)::bigint as repeats,
        max(l.asked_at) as last_asked_at
      from labelled l
      where l.lesson_id is not null
      group by l.subject_user_id, l.lesson_id, l.course_id, l.topic_key
      having count(*) >= stuck_threshold
    ),
    stuck_ranked as (
      select
        sc.*,
        row_number() over (
          partition by sc.subject_user_id
          order by sc.repeats desc, sc.last_asked_at desc, sc.topic_key
        ) as cluster_rank
      from stuck_clusters sc
    ),
    stuck_by_learner as (
      select
        sr.subject_user_id,
        jsonb_agg(
          jsonb_build_object(
            'lessonId', sr.lesson_id,
            'lessonTitle', le.title,
            'courseId', sr.course_id,
            'courseTitle', co.title,
            'topicKey', sr.topic_key,
            'topicLabel', sr.topic_label,
            'repeats', sr.repeats,
            'lastAskedAt', sr.last_asked_at
          )
          order by sr.cluster_rank
        ) filter (where sr.cluster_rank <= 5) as clusters,
        count(*)::bigint as cluster_count
      from stuck_ranked sr
      left join public.lessons le
        on le.tenant_id = caller.tenant_id
       and le.lesson_id = sr.lesson_id
      left join public.courses co
        on co.tenant_id = caller.tenant_id
       and co.course_id = sr.course_id
      group by sr.subject_user_id
    ),
    progress as (
      select
        sp.user_id as subject_user_id,
        max(sp.percent_complete) as max_percent_complete,
        bool_or(sp.progress_state = 'completed') as has_completed_course,
        count(*)::bigint as courses_with_progress
      from public.student_progress sp
      where sp.tenant_id = caller.tenant_id
        and sp.deleted_at is null
      group by sp.user_id
    ),
    ranked_learners as (
      select
        lt.*,
        acc.email_normalized,
        coalesce(esc.ranked_questions, 0) as ranked_questions,
        esc.first_half_avg,
        esc.second_half_avg,
        coalesce(sb.clusters, '[]'::jsonb) as stuck_clusters_json,
        coalesce(sb.cluster_count, 0) as stuck_cluster_count,
        pr.max_percent_complete,
        coalesce(pr.has_completed_course, false) as has_completed_course,
        coalesce(pr.courses_with_progress, 0) as courses_with_progress,
        row_number() over (
          order by
            lt.critical_questions desc,
            lt.notable_or_critical desc,
            coalesce(sb.cluster_count, 0) desc,
            lt.questions desc,
            lt.subject_user_id
        ) as learner_rank
      from learner_totals lt
      left join escalation esc on esc.subject_user_id = lt.subject_user_id
      left join stuck_by_learner sb on sb.subject_user_id = lt.subject_user_id
      left join progress pr on pr.subject_user_id = lt.subject_user_id
      left join app_private.user_access_accounts acc
        on acc.tenant_id = caller.tenant_id
       and acc.auth_user_id = lt.subject_user_id
    )
    select
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'subjectUserId', rl.subject_user_id,
            'displayName', rl.email_normalized,
            'questions', rl.questions,
            'distinctTopics', rl.distinct_topics,
            'distinctLessons', rl.distinct_lessons,
            'distinctCourses', rl.distinct_courses,
            'notableOrCriticalQuestions', rl.notable_or_critical,
            'criticalQuestions', rl.critical_questions,
            'ungroundedAnswers', rl.ungrounded_answers,
            'firstAskedAt', rl.first_asked_at,
            'lastAskedAt', rl.last_asked_at,
            'depth', jsonb_build_object(
              'notableOrCriticalShare', case
                when rl.questions = 0 then null
                else round(rl.notable_or_critical::numeric / rl.questions, 4)
              end
            ),
            'escalation', case
              when rl.ranked_questions < min_trend_questions
                or rl.first_half_avg is null
                or rl.second_half_avg is null
              then jsonb_build_object(
                'state', 'insufficient_data',
                'sampleSize', rl.ranked_questions
              )
              else jsonb_build_object(
                'state', case
                  when rl.second_half_avg - rl.first_half_avg
                    >= escalation_margin then 'escalating'
                  when rl.first_half_avg - rl.second_half_avg
                    >= escalation_margin then 'declining'
                  else 'steady'
                end,
                'sampleSize', rl.ranked_questions,
                'firstHalfAvgSpecificity', round(rl.first_half_avg, 2),
                'secondHalfAvgSpecificity', round(rl.second_half_avg, 2)
              )
            end,
            'stuck', jsonb_build_object(
              'clusterCount', rl.stuck_cluster_count,
              'clusters', rl.stuck_clusters_json
            ),
            'readiness', case
              when rl.courses_with_progress = 0 or rl.questions < 2 then
                jsonb_build_object(
                  'tier', 'insufficient_data',
                  'evidence', jsonb_build_object(
                    'maxPercentComplete', rl.max_percent_complete,
                    'hasCompletedCourse', rl.has_completed_course,
                    'questions', rl.questions,
                    'notableOrCriticalQuestions', rl.notable_or_critical
                  )
                )
              else jsonb_build_object(
                'tier', case
                  when (
                      rl.has_completed_course
                      or coalesce(rl.max_percent_complete, 0) >= 80
                    )
                    and rl.questions >= 3
                    and rl.notable_or_critical >= 1
                    then 'likely_ready'
                  when coalesce(rl.max_percent_complete, 0) >= 50
                    and rl.questions >= 1
                    then 'possible'
                  else 'not_yet'
                end,
                'evidence', jsonb_build_object(
                  'maxPercentComplete', rl.max_percent_complete,
                  'hasCompletedCourse', rl.has_completed_course,
                  'questions', rl.questions,
                  'notableOrCriticalQuestions', rl.notable_or_critical
                )
              )
            end
          )
          order by rl.learner_rank
        ) filter (where rl.learner_rank <= learner_limit),
        '[]'::jsonb
      ),
      count(*) filter (where rl.learner_rank > learner_limit)::bigint
    into learners_json, omitted_learners
    from ranked_learners rl;
  end if;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'generatedAt', statement_timestamp(),
    'range', jsonb_build_object(
      'start', win.window_start,
      'end', win.window_end,
      'timeZone', 'UTC',
      'dayCount', win.day_count
    ),
    'limits', jsonb_build_object(
      'learners', learner_limit,
      'truncated', omitted_learners > 0
    ),
    'thresholds', jsonb_build_object(
      'minQuestionsForTrend', min_trend_questions,
      'stuckRepeatThreshold', stuck_threshold,
      'escalationMargin', escalation_margin
    ),
    'specificityTaxonomy', jsonb_build_object(
      'definition', 1,
      'scope_check', 1,
      'clarification', 2,
      'how_to', 3,
      'troubleshooting', 4
    ),
    'definitions', jsonb_build_object(
      'depth',
      'The share of a learner classified questions the classifier rated ' ||
      'notable or critical importance in this range. It is the classifier ' ||
      'own judgement of significance, not a measured comprehension score.',
      'escalation',
      'Compares the average specificity rank of the first half of a ' ||
      'learner classified questions in this range against the second ' ||
      'half, using a fixed foundational-to-applied ranking of intents ' ||
      '(definition/scope_check = 1, clarification = 2, how_to = 3, ' ||
      'troubleshooting = 4). Reported only when at least ' ||
      min_trend_questions::text ||
      ' ranked questions exist; otherwise insufficient_data.',
      'stuck',
      'The same topic asked ' || stuck_threshold::text || ' or more times ' ||
      'within one lesson by one learner in this range. A direct count, not ' ||
      'an inference about confusion.',
      'readiness',
      'A heuristic combining recorded course completion from ' ||
      'public.student_progress with question volume and importance in ' ||
      'this range. It is a prioritised list to review, never a certainty, ' ||
      'and is reported as insufficient_data whenever no progress record ' ||
      'exists for the learner at all.'
    ),
    'metrics', jsonb_build_object(
      'learnerCoverage', app_private.analytics_metric(
        coverage_state,
        jsonb_build_object(
          'questions', coalesce(totals.questions, 0),
          'classifiedQuestions', coalesce(totals.classified_questions, 0),
          'unclassifiedQuestions', coalesce(totals.unclassified_questions, 0),
          'learners', coalesce(totals.learners, 0),
          'classifiedLearners', coalesce(totals.classified_learners, 0)
        ),
        data_through,
        evidence,
        to_jsonb(coverage_limitations)
      ),
      'learnerRows', app_private.analytics_metric(
        learner_rows_state,
        case when learner_rows_state = 'unknown' then null else
          jsonb_build_object(
            'learners', coalesce(learners_json, '[]'::jsonb),
            'omittedLearners', omitted_learners
          )
        end,
        data_through,
        evidence,
        to_jsonb(learner_rows_limitations)
      )
    )
  );
end;
$$;
revoke execute on function public.analytics_learner_signals(
  timestamptz, timestamptz
) from public, anon, service_role;
grant execute on function public.analytics_learner_signals(
  timestamptz, timestamptz
) to authenticated;

commit;

-- ============================================================
-- 20260726099000_operational_debt.sql
-- ============================================================
-- Operational debt, part 1 and 2 of docs/PLAN.md Section 11 Phase 12.
--
--   1. Voice rate limiting was never actually a per-process `Map` problem in
--      the code as it stands today -- migration 20260726096000 already moved
--      the authoritative check into SQL (`learning_reserve_provider_call` /
--      `app_private.provider_call_decision`), reading durable counters in
--      `public.tenant_cost_policies` (per-tenant AND per-subject limits,
--      already admin-configurable via `platform_admin_set_tenant_cost_policy`,
--      never hardcoded) and `public.provider_rate_events`. What survived from
--      the original defect is a real one, just one level deeper: that
--      function reads the last minute/day's rows with a plain `select
--      count(*)`, decides allow/deny, and only afterward inserts this call's
--      own row. Reading and writing are two separate statements with a gap
--      between them, so two concurrent requests can both read the same
--      "count so far" and both pass a limit of one -- exactly the race the
--      durable rewrite was supposed to close. `apps/console/src/app/api/
--      learning/voice/rate-limit.ts` already documents its `Map` as a
--      same-instance burst guard only, deferring to this SQL check as
--      authoritative, so that file needs no change; this migration closes the
--      race in the SQL it defers to, which is also what every other caller of
--      `learning_reserve_provider_call` (conversation answers, classification,
--      the widget) shares.
--
--      The fix: `app_private.provider_rate_counter_increment` performs the
--      read and the write as one statement -- `insert .. on conflict (key) do
--      update .. returning` -- against a new fixed-window counter table,
--      `public.provider_rate_counters`. Postgres resolves a conflicting
--      insert with a row-level lock, so concurrent callers for the same
--      window are serialized and each gets a distinct, race-free count back.
--      `app_private.provider_call_decision` is rewritten to call this once
--      per limit (subject-minute, tenant-minute, tenant-day) instead of
--      counting historical rows, and to compare the 1-indexed result with
--      `>` where it used to compare a 0-indexed prior count with `>=` --
--      same refusal point, race-free arithmetic. Budget checks
--      (`cost_ledger` spend against the daily/monthly budget) are unchanged:
--      they are a soft, already-metered-after-the-fact threshold, not a hard
--      "at most N concurrent" guarantee, and touching them was not needed to
--      close the atomicity gap this task is about.
--      `public.provider_rate_events` keeps recording exactly what it did
--      before (unchanged), because `platform_admin_cost_overview` and the
--      existing OPS-04 test read it directly; only the internal counting
--      this function used to decide "allow" or "deny" moved to the atomic
--      table.
--
--      Fail-open/fail-closed choice: unchanged from the existing design in
--      `cost-metering.ts`'s `reserveProviderCall`, which this migration does
--      not touch. A real decision from this RPC (allow or deny) is always
--      honoured -- fail closed on the decision itself. If the RPC cannot be
--      reached at all (network error, unapplied migration), the TypeScript
--      wrapper fails OPEN and marks the result `degraded`, because refusing
--      every voice and chat request platform-wide over an infrastructure
--      outage in the *limiter* is a worse failure than temporarily running
--      unmetered. That policy is already correct and is left alone here;
--      this migration only makes the *decision*, when it is reachable,
--      actually race-free.
--
--   2. `public.telemetry_outbox` (0007) has had a writer
--      (`learning_record_usage_event`, 0027) and no reader since it shipped.
--      This adds the reader: a lease-based claim/complete/fail contract
--      (mirroring the shape `learning_claim_embedding_work` /
--      `_commit_embedding_work` / `_release_embedding_work` already
--      established for the embedding queue in 20260726095000) plus a
--      configurable retry budget, a terminal `failed` state so a poison row
--      cannot block the queue forever, and a retention purge. All four are
--      gated by a new operation-secret capability, `telemetry.outbox.drain`,
--      the same mechanism the embedding worker uses -- reachable without a
--      session, authorised only by a bearer token, so a scheduler can call it
--      and a signed-in browser cannot reach it at all.
--
-- Boundaries kept: every new function is SECURITY DEFINER with `search_path`
-- fixed to `pg_catalog`; every grant is the narrowest role that has to call
-- it; nothing here reads or stores prompt text, learner messages or audio.

begin;

-- ---------------------------------------------------------------------------
-- 1. Atomic rate-limit counters
-- ---------------------------------------------------------------------------

create table if not exists public.provider_rate_counters (
  counter_key text primary key,
  tenant_id uuid not null references public.tenants(tenant_id),
  scope text not null check (scope in ('tenant_minute', 'tenant_day', 'subject_minute')),
  window_start timestamptz not null,
  request_count integer not null default 0 check (request_count > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists provider_rate_counters_window_idx
  on public.provider_rate_counters (window_start);

alter table public.provider_rate_counters enable row level security;
alter table public.provider_rate_counters force row level security;
revoke all on table public.provider_rate_counters
  from public, anon, authenticated;
drop policy if exists provider_rate_counters_no_direct_access
  on public.provider_rate_counters;
create policy provider_rate_counters_no_direct_access
  on public.provider_rate_counters
  for all
  using (false)
  with check (false);

-- The atomic primitive. One statement does the read-check-write that used to
-- be a `select count(*)` followed by a separate `insert`: the `on conflict ..
-- do update .. returning` is resolved under a row-level lock, so two
-- concurrent callers for the same counter_key are serialized by Postgres
-- itself and each gets back its own distinct, correct position in the
-- window. The caller compares the returned (1-indexed) count against its
-- limit; nothing here decides allow/deny, so it stays reusable for any fixed
-- window a caller wants counted this way.
create or replace function app_private.provider_rate_counter_increment(
  counter_key text,
  target_tenant_id uuid,
  scope text,
  window_start timestamptz
)
returns integer
language sql
volatile
security definer
set search_path = pg_catalog
as $$
  insert into public.provider_rate_counters (
    counter_key, tenant_id, scope, window_start, request_count
  )
  values (counter_key, target_tenant_id, scope, window_start, 1)
  on conflict (counter_key) do update
    set request_count = public.provider_rate_counters.request_count + 1,
        updated_at = clock_timestamp()
  returning request_count;
$$;
revoke execute on function app_private.provider_rate_counter_increment(
  text, uuid, text, timestamptz
) from public, anon, authenticated, service_role;

-- Same signature, same return shape, same capability set as the version in
-- 20260726096000. Internals only: the three call counts are now read from
-- the atomic counter above instead of a `select count(*)` over history.
create or replace function app_private.provider_call_decision(
  target_tenant_id uuid,
  requested_capability text,
  subject_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  cost_policy public.tenant_cost_policies%rowtype;
  tenant_status text;
  subject_digest text;
  now_ts timestamptz := statement_timestamp();
  minute_window timestamptz;
  day_window timestamptz;
  subject_minute integer;
  tenant_minute integer;
  tenant_day integer;
  day_spend bigint;
  month_spend bigint;
  deny_code text := null;
  retry_after integer := 0;
  allowed boolean;
begin
  if target_tenant_id is null then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;
  if requested_capability is null
    or length(btrim(requested_capability)) not between 1 and 100
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select t.status into tenant_status
  from public.tenants t
  where t.tenant_id = target_tenant_id
    and t.deleted_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_not_found');
  end if;

  cost_policy := app_private.tenant_cost_policy(target_tenant_id);
  subject_digest := app_private.provider_rate_subject_hash(
    target_tenant_id,
    subject_key
  );

  -- Opportunistic pruning keeps both counter stores bounded without a
  -- scheduler. Unchanged for provider_rate_events; added for the new table.
  if random() < 0.01 then
    delete from public.provider_rate_events
    where occurred_at < now_ts - interval '2 days';
    delete from public.provider_rate_counters
    where window_start < now_ts - interval '2 days';
  end if;

  select coalesce(sum(c.estimated_cost_micro), 0)::bigint into day_spend
  from public.cost_ledger c
  where c.tenant_id = target_tenant_id
    and c.occurred_at >= date_trunc('day', now_ts);

  select coalesce(sum(c.estimated_cost_micro), 0)::bigint into month_spend
  from public.cost_ledger c
  where c.tenant_id = target_tenant_id
    and c.occurred_at >= date_trunc('month', now_ts);

  -- Fixed windows, aligned to the minute and to the UTC calendar day -- the
  -- latter now matches day_spend above (and the "resets at midnight UTC"
  -- language `cost-metering.ts` already shows learners) rather than the
  -- previous rolling 24h window, which nothing depended on. Each call is
  -- unconditional: it always claims its place in all three windows, exactly
  -- as the previous implementation always *read* all three before deciding.
  -- A call that ends up denied still occupies a slot in a window it will
  -- keep failing against anyway until the window rolls over, which changes
  -- no observable allow/deny outcome; it only avoids a second read.
  minute_window := date_trunc('minute', now_ts);
  day_window := date_trunc('day', now_ts);

  subject_minute := app_private.provider_rate_counter_increment(
    'subject_minute:' || subject_digest || ':' ||
      (extract(epoch from minute_window)::bigint)::text,
    target_tenant_id,
    'subject_minute',
    minute_window
  );
  tenant_minute := app_private.provider_rate_counter_increment(
    'tenant_minute:' || target_tenant_id::text || ':' ||
      (extract(epoch from minute_window)::bigint)::text,
    target_tenant_id,
    'tenant_minute',
    minute_window
  );
  tenant_day := app_private.provider_rate_counter_increment(
    'tenant_day:' || target_tenant_id::text || ':' ||
      (extract(epoch from day_window)::bigint)::text,
    target_tenant_id,
    'tenant_day',
    day_window
  );

  -- A freshly bootstrapped tenant is legitimately still `provisioning`, so only
  -- an explicit suspension or deletion refuses spend here.
  if tenant_status in ('suspended', 'deleted') then
    deny_code := 'tenant_suspended';
  elsif month_spend >= cost_policy.monthly_budget_micro then
    deny_code := 'monthly_budget_exceeded';
  elsif day_spend >= cost_policy.daily_budget_micro then
    deny_code := 'daily_budget_exceeded';
  elsif tenant_day > cost_policy.max_calls_per_day then
    deny_code := 'tenant_daily_call_limit';
  elsif tenant_minute > cost_policy.max_calls_per_minute then
    deny_code := 'tenant_rate_limited';
    retry_after := 60;
  elsif subject_minute > cost_policy.max_subject_calls_per_minute then
    deny_code := 'subject_rate_limited';
    retry_after := 60;
  end if;

  -- `monitor` records what would have been refused without refusing it, so a
  -- new limit can be observed against real traffic before it bites.
  allowed := deny_code is null or cost_policy.enforcement = 'monitor';

  insert into public.provider_rate_events (
    tenant_id, capability, subject_hash, decision, deny_reason
  ) values (
    target_tenant_id,
    btrim(requested_capability),
    subject_digest,
    case when allowed then 'allow' else 'deny' end,
    deny_code
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'allowed', allowed,
    'scope', 'durable-tenant',
    'enforcement', cost_policy.enforcement,
    'code', coalesce(deny_code, 'allowed'),
    'wouldDeny', deny_code is not null,
    'retryAfterSeconds', retry_after,
    'currency', cost_policy.currency,
    'daySpendMicro', day_spend,
    'monthSpendMicro', month_spend,
    'dailyBudgetMicro', cost_policy.daily_budget_micro,
    'monthlyBudgetMicro', cost_policy.monthly_budget_micro,
    'tenantCallsThisMinute', tenant_minute,
    'tenantCallsToday', tenant_day,
    'subjectCallsThisMinute', subject_minute
  );
end;
$$;
revoke execute on function app_private.provider_call_decision(uuid, text, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. telemetry_outbox: a reader
-- ---------------------------------------------------------------------------

-- A terminal state for rows that will never succeed, alongside the pending /
-- processing / delivered states 0007 already declared.
alter table public.telemetry_outbox
  add column if not exists failed_at timestamptz;

-- Both check constraints below were declared inline in 0007 and therefore
-- carry generated names; located by predicate rather than guessed at, so
-- this cannot half-apply and leave the narrower, three-state check in force.
-- ('%status%' matches only these two constraints on this table -- no other
-- column or table-level check on telemetry_outbox mentions "status".)
do $$
declare
  existing_constraint text;
begin
  for existing_constraint in
    select con.conname
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class rel on rel.oid = con.conrelid
    join pg_catalog.pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'telemetry_outbox'
      and con.contype = 'c'
      and pg_catalog.pg_get_constraintdef(con.oid) like '%status%'
  loop
    execute format(
      'alter table public.telemetry_outbox drop constraint %I',
      existing_constraint
    );
  end loop;
end $$;

alter table public.telemetry_outbox
  add constraint telemetry_outbox_status_check
  check (status in ('pending', 'processing', 'delivered', 'failed'));

alter table public.telemetry_outbox
  add constraint telemetry_outbox_state_shape_check
  check (
    (
      status = 'pending'
      and locked_by is null and locked_at is null
      and delivered_at is null and failed_at is null
    )
    or (
      status = 'processing'
      and locked_by is not null and locked_at is not null
      and delivered_at is null and failed_at is null
    )
    or (
      status = 'delivered'
      and locked_by is null and locked_at is null
      and delivered_at is not null and failed_at is null
    )
    or (
      status = 'failed'
      and locked_by is null and locked_at is null
      and delivered_at is null and failed_at is not null
    )
  );

-- `delivered` was already terminal for updates; `failed` joins it. The
-- payload/identity guard is untouched -- this only widens which statuses
-- freeze the row.
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
    or old.status in ('delivered', 'failed')
  then
    raise exception 'telemetry_outbox payload and delivered facts are immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

-- 0007 rejected every delete unconditionally, which was correct when nothing
-- ever finished a row. Retention needs to remove terminal rows, so the
-- blanket rejection is replaced with a narrower guard: only `delivered` or
-- `failed` rows may ever be deleted, so a bug in the purge function's WHERE
-- clause still cannot remove a live (pending/processing) row.
drop trigger if exists telemetry_outbox_reject_delete on public.telemetry_outbox;

create or replace function app_private.telemetry_outbox_guard_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if old.status not in ('delivered', 'failed') then
    raise exception
      'telemetry_outbox rows may only be removed after reaching a terminal state'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger telemetry_outbox_guard_delete
before delete on public.telemetry_outbox
for each row execute function app_private.telemetry_outbox_guard_delete();

-- Configurable retry/lease/retention policy. Global, not per-tenant -- the
-- outbox is an internal delivery queue, not a tenant-facing resource -- but
-- deliberately a table rather than a constant so an operator can change the
-- retention window or the attempt budget without a deploy.
create table if not exists public.telemetry_outbox_policy (
  policy_id boolean primary key default true check (policy_id),
  max_attempts integer not null default 8 check (max_attempts between 1 and 50),
  lease_seconds integer not null default 300 check (lease_seconds between 30 and 3600),
  backoff_base_seconds integer not null default 30
    check (backoff_base_seconds between 1 and 3600),
  backoff_max_seconds integer not null default 3600
    check (backoff_max_seconds between 60 and 86400),
  retention_days integer not null default 14 check (retention_days between 1 and 365),
  updated_by uuid,
  updated_at timestamptz not null default clock_timestamp()
);
insert into public.telemetry_outbox_policy (policy_id) values (true)
  on conflict (policy_id) do nothing;

alter table public.telemetry_outbox_policy enable row level security;
alter table public.telemetry_outbox_policy force row level security;
revoke all on table public.telemetry_outbox_policy from anon, authenticated;
drop policy if exists telemetry_outbox_policy_admin_select
  on public.telemetry_outbox_policy;
create policy telemetry_outbox_policy_admin_select
  on public.telemetry_outbox_policy
  for select to authenticated
  using (public.platform_admin_is_authorized());
grant select on public.telemetry_outbox_policy to authenticated;

create or replace function app_private.current_telemetry_outbox_policy()
returns public.telemetry_outbox_policy
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select * from public.telemetry_outbox_policy where policy_id = true;
$$;
revoke execute on function app_private.current_telemetry_outbox_policy()
  from public, anon, authenticated, service_role;

create or replace function public.platform_admin_set_telemetry_outbox_policy(
  max_attempts integer,
  lease_seconds integer,
  backoff_base_seconds integer,
  backoff_max_seconds integer,
  retention_days integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  updated public.telemetry_outbox_policy%rowtype;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if max_attempts is null or max_attempts not between 1 and 50
    or lease_seconds is null or lease_seconds not between 30 and 3600
    or backoff_base_seconds is null
    or backoff_base_seconds not between 1 and 3600
    or backoff_max_seconds is null
    or backoff_max_seconds not between 60 and 86400
    or backoff_max_seconds < backoff_base_seconds
    or retention_days is null or retention_days not between 1 and 365
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  update public.telemetry_outbox_policy p
  set max_attempts = platform_admin_set_telemetry_outbox_policy.max_attempts,
      lease_seconds = platform_admin_set_telemetry_outbox_policy.lease_seconds,
      backoff_base_seconds =
        platform_admin_set_telemetry_outbox_policy.backoff_base_seconds,
      backoff_max_seconds =
        platform_admin_set_telemetry_outbox_policy.backoff_max_seconds,
      retention_days = platform_admin_set_telemetry_outbox_policy.retention_days,
      updated_by = auth.uid(),
      updated_at = clock_timestamp()
  where p.policy_id = true
  returning * into updated;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'maxAttempts', updated.max_attempts,
    'leaseSeconds', updated.lease_seconds,
    'backoffBaseSeconds', updated.backoff_base_seconds,
    'backoffMaxSeconds', updated.backoff_max_seconds,
    'retentionDays', updated.retention_days
  );
end;
$$;

-- The worker capability joins the two existing ones in the same secret table.
-- Named, not guessed at, since 20260726095000 already gave this constraint a
-- stable name.
alter table app_private.learning_operation_secrets
  drop constraint if exists learning_operation_secrets_capability_allowed;
alter table app_private.learning_operation_secrets
  add constraint learning_operation_secrets_capability_allowed
  check (
    capability in (
      'conversation.answer.record',
      'knowledge.embedding.worker',
      'telemetry.outbox.drain'
    )
  );

create or replace function app_private.learning_operation_capabilities()
returns text[]
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select array[
    'conversation.answer.record',
    'knowledge.embedding.worker',
    'telemetry.outbox.drain'
  ]::text[];
$$;
revoke execute on function app_private.learning_operation_capabilities()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The drain worker's server contract: claim, complete, fail, purge.
--
-- Mirrors the shape 20260726095000 established for the embedding queue.
-- `telemetry_outbox_claim_batch` also reclaims `processing` rows whose lease
-- has expired (a worker that died mid-batch), so a crash never strands rows;
-- it terminally fails, rather than reclaims, a stale row that has already
-- exhausted its attempt budget, so a repeatedly-crashing poison row cannot
-- retry forever even without an explicit failure report. Complete and fail
-- both require the caller's own lease_owner to still hold the row, so a
-- worker whose lease was reclaimed by someone else cannot clobber the new
-- claimant's work with a late, stale completion -- this is also what makes
-- calling complete or fail twice for the same batch safe: the second call's
-- WHERE clause matches nothing once the first has already moved the row out
-- of `processing`.
-- ---------------------------------------------------------------------------

create or replace function public.telemetry_outbox_claim_batch(
  operation_token text,
  batch_limit integer default 50
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  policy public.telemetry_outbox_policy%rowtype;
  bounded_limit integer;
  lease_owner text;
  items jsonb;
  pending_remaining integer;
begin
  if not app_private.learning_operation_token_is_valid(
    'telemetry.outbox.drain',
    operation_token
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  policy := app_private.current_telemetry_outbox_policy();
  bounded_limit := greatest(1, least(coalesce(batch_limit, 50), 500));
  lease_owner := 'outbox-drain:' || gen_random_uuid()::text;

  -- A row whose lease expired and which has already spent its whole attempt
  -- budget has only ever crashed workers, never reported an explicit
  -- failure. Fail it now rather than hand it out again.
  update public.telemetry_outbox
  set status = 'failed',
      failed_at = clock_timestamp(),
      locked_by = null,
      locked_at = null,
      last_error = coalesce(
        last_error,
        'exhausted its retry budget after a stale processing lease'
      )
  where status = 'processing'
    and locked_at < clock_timestamp() - make_interval(secs => policy.lease_seconds)
    and attempt_count >= policy.max_attempts;

  with candidate as (
    select tenant_id, outbox_id
    from public.telemetry_outbox
    where attempt_count < policy.max_attempts
      and (
        (status = 'pending' and available_at <= clock_timestamp())
        or (
          status = 'processing'
          and locked_at < clock_timestamp()
            - make_interval(secs => policy.lease_seconds)
        )
      )
    order by available_at, created_at, tenant_id, outbox_id
    limit bounded_limit
    for update skip locked
  ),
  claimed as (
    update public.telemetry_outbox target
    set status = 'processing',
        locked_by = lease_owner,
        locked_at = clock_timestamp(),
        attempt_count = target.attempt_count + 1
    from candidate
    where target.tenant_id = candidate.tenant_id
      and target.outbox_id = candidate.outbox_id
    returning
      target.tenant_id,
      target.outbox_id,
      target.topic,
      target.payload,
      target.attempt_count,
      target.idempotency_key
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'tenantId', claimed.tenant_id,
        'outboxId', claimed.outbox_id,
        'topic', claimed.topic,
        'payload', claimed.payload,
        'attemptCount', claimed.attempt_count,
        'idempotencyKey', claimed.idempotency_key
      )
      order by claimed.tenant_id, claimed.outbox_id
    ),
    '[]'::jsonb
  )
  into items
  from claimed;

  select count(*)::integer into pending_remaining
  from public.telemetry_outbox
  where status = 'pending' and available_at <= clock_timestamp();

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'leaseOwner', lease_owner,
    'leaseSeconds', policy.lease_seconds,
    'items', items,
    'remainingPending', pending_remaining
  );
end;
$$;

create or replace function public.telemetry_outbox_complete_batch(
  operation_token text,
  lease_owner text,
  items jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  completed integer;
begin
  if not app_private.learning_operation_token_is_valid(
    'telemetry.outbox.drain',
    operation_token
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if lease_owner is null or length(lease_owner) not between 1 and 200 then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) > 500 then
    return jsonb_build_object('ok', false, 'code', 'invalid_batch');
  end if;

  update public.telemetry_outbox t
  set status = 'delivered',
      delivered_at = clock_timestamp(),
      locked_by = null,
      locked_at = null
  from jsonb_to_recordset(items) as supplied(tenant_id uuid, outbox_id text)
  where t.tenant_id = supplied.tenant_id
    and t.outbox_id = supplied.outbox_id
    and t.status = 'processing'
    and t.locked_by = lease_owner;
  get diagnostics completed = row_count;

  return jsonb_build_object('ok', true, 'dataMode', 'durable', 'completed', completed);
end;
$$;

create or replace function public.telemetry_outbox_fail_batch(
  operation_token text,
  lease_owner text,
  items jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  policy public.telemetry_outbox_policy%rowtype;
  retried integer := 0;
  failed integer := 0;
begin
  if not app_private.learning_operation_token_is_valid(
    'telemetry.outbox.drain',
    operation_token
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if lease_owner is null or length(lease_owner) not between 1 and 200 then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) > 500 then
    return jsonb_build_object('ok', false, 'code', 'invalid_batch');
  end if;

  policy := app_private.current_telemetry_outbox_policy();

  -- Still within budget and reported retryable: back to `pending` with
  -- exponential backoff (capped at backoff_max_seconds).
  with supplied as (
    select
      s.tenant_id,
      s.outbox_id,
      coalesce(s.retryable, true) as retryable,
      left(coalesce(s.error_message, ''), 500) as error_message
    from jsonb_to_recordset(items) as s(
      tenant_id uuid, outbox_id text, retryable boolean, error_message text
    )
  )
  update public.telemetry_outbox t
  set status = 'pending',
      locked_by = null,
      locked_at = null,
      last_error = supplied.error_message,
      available_at = clock_timestamp() + make_interval(
        secs => least(
          policy.backoff_max_seconds,
          policy.backoff_base_seconds
            * (1 << least(greatest(t.attempt_count - 1, 0), 16))
        )
      )
  from supplied
  where t.tenant_id = supplied.tenant_id
    and t.outbox_id = supplied.outbox_id
    and t.status = 'processing'
    and t.locked_by = lease_owner
    and supplied.retryable
    and t.attempt_count < policy.max_attempts;
  get diagnostics retried = row_count;

  -- Either the caller reported it non-retryable, or the attempt budget is
  -- gone: terminal, so a poison row stops competing for future batches.
  with supplied as (
    select
      s.tenant_id,
      s.outbox_id,
      coalesce(s.retryable, true) as retryable,
      left(coalesce(s.error_message, ''), 500) as error_message
    from jsonb_to_recordset(items) as s(
      tenant_id uuid, outbox_id text, retryable boolean, error_message text
    )
  )
  update public.telemetry_outbox t
  set status = 'failed',
      failed_at = clock_timestamp(),
      locked_by = null,
      locked_at = null,
      last_error = supplied.error_message
  from supplied
  where t.tenant_id = supplied.tenant_id
    and t.outbox_id = supplied.outbox_id
    and t.status = 'processing'
    and t.locked_by = lease_owner
    and (not supplied.retryable or t.attempt_count >= policy.max_attempts);
  get diagnostics failed = row_count;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'retried', retried,
    'failed', failed
  );
end;
$$;

-- Retention. Only `delivered` or `failed` rows past the configured window are
-- ever candidates, and `telemetry_outbox_guard_delete` (above) refuses to
-- remove anything else regardless of what this WHERE clause does.
create or replace function public.telemetry_outbox_purge_expired(
  operation_token text,
  batch_limit integer default 500
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  policy public.telemetry_outbox_policy%rowtype;
  bounded_limit integer;
  purged integer;
begin
  if not app_private.learning_operation_token_is_valid(
    'telemetry.outbox.drain',
    operation_token
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  policy := app_private.current_telemetry_outbox_policy();
  bounded_limit := greatest(1, least(coalesce(batch_limit, 500), 5000));

  with candidate as (
    select tenant_id, outbox_id
    from public.telemetry_outbox
    where (
        status = 'delivered'
        and delivered_at < clock_timestamp()
          - make_interval(days => policy.retention_days)
      )
      or (
        status = 'failed'
        and failed_at < clock_timestamp()
          - make_interval(days => policy.retention_days)
      )
    order by coalesce(delivered_at, failed_at)
    limit bounded_limit
    for update skip locked
  )
  delete from public.telemetry_outbox t
  using candidate c
  where t.tenant_id = c.tenant_id
    and t.outbox_id = c.outbox_id;
  get diagnostics purged = row_count;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'purged', purged,
    'retentionDays', policy.retention_days
  );
end;
$$;

-- Read-only operational visibility for the platform owner: queue depth by
-- status, the age of the oldest still-pending row, and the effective policy.
create or replace function public.platform_admin_telemetry_outbox_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  now_ts timestamptz := statement_timestamp();
  counts jsonb;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select jsonb_build_object(
    'pending', count(*) filter (where status = 'pending'),
    'processing', count(*) filter (where status = 'processing'),
    'delivered', count(*) filter (where status = 'delivered'),
    'failed', count(*) filter (where status = 'failed'),
    'oldestPendingAgeSeconds', (
      select floor(extract(epoch from now_ts - min(available_at)))::integer
      from public.telemetry_outbox
      where status = 'pending'
    )
  )
  into counts
  from public.telemetry_outbox;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'generatedAt', now_ts,
    'counts', counts,
    'policy', (
      select jsonb_build_object(
        'maxAttempts', p.max_attempts,
        'leaseSeconds', p.lease_seconds,
        'backoffBaseSeconds', p.backoff_base_seconds,
        'backoffMaxSeconds', p.backoff_max_seconds,
        'retentionDays', p.retention_days
      )
      from public.telemetry_outbox_policy p
      where p.policy_id = true
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.platform_admin_set_telemetry_outbox_policy(
  integer, integer, integer, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.platform_admin_set_telemetry_outbox_policy(
  integer, integer, integer, integer, integer
) to authenticated;

revoke all on function public.platform_admin_telemetry_outbox_overview()
  from public, anon, authenticated, service_role;
grant execute on function public.platform_admin_telemetry_outbox_overview()
  to authenticated;

-- The worker entrypoints are reachable without a session and authorised only
-- by the operation secret, so `authenticated` is deliberately not granted: a
-- signed-in browser must never be able to reach the outbox drain at all.
revoke execute on function public.telemetry_outbox_claim_batch(text, integer)
  from public, anon, authenticated, service_role;
revoke execute on function public.telemetry_outbox_complete_batch(
  text, text, jsonb
) from public, anon, authenticated, service_role;
revoke execute on function public.telemetry_outbox_fail_batch(
  text, text, jsonb
) from public, anon, authenticated, service_role;
revoke execute on function public.telemetry_outbox_purge_expired(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.telemetry_outbox_claim_batch(text, integer)
  to anon, service_role;
grant execute on function public.telemetry_outbox_complete_batch(text, text, jsonb)
  to anon, service_role;
grant execute on function public.telemetry_outbox_fail_batch(text, text, jsonb)
  to anon, service_role;
grant execute on function public.telemetry_outbox_purge_expired(text, integer)
  to anon, service_role;

commit;

-- ============================================================
-- 20260726100000_billing_stripe.sql
-- ============================================================
-- Billing, margins and Stripe entitlement (PLAN.md S10).
--
-- Two revenue lines land here:
--
--   A. Subscription -> entitlement. A Stripe subscription state change SETS
--      public.tenant_sections. A platform administrator keeps a manual
--      override (comping an account, debugging a client), and that override
--      is tracked as a distinct `source` on the row -- never silently
--      indistinguishable from a paid entitlement.
--
--   B. Usage -> margin. A per-tenant margin policy (multiplier, fixed
--      markup, floor) turns `public.cost_ledger`'s true provider cost into a
--      billable amount, reported to Stripe as metered usage.
--
-- Non-negotiables enforced here, not just in the UI:
--
--   1. A creator never sees raw provider cost -- only their price. True cost,
--      margin and billed amount live behind platform-admin-gated RPCs only
--      (`platform_admin_*`). `tenant_get_billing_summary` -- the one surface
--      a creator can reach -- returns plan, status and billed total, and
--      nothing else.
--   2. We never touch card data. Nothing here accepts a card number, CVC or
--      expiry. Every Stripe interaction is hosted Checkout, the hosted
--      Billing Portal, or server-to-server webhook/API calls.
--   3. Webhooks are verified and deduped. `billing_webhook_ingest` requires a
--      valid operation token (the same mechanism gating the answer and
--      embedding worker paths) and a unique `public.billing_stripe_events`
--      row per Stripe event id -- a retried delivery is a no-op.
--   4. Usage reporting is idempotent. `public.billing_usage_reports` carries
--      `unique (tenant_id, cost_entry_id)`: a `cost_ledger` row can be
--      reported at most once, ever, enforced by the database, not the
--      caller's care.
--   5. Billing failure never stops learning. `agent`, `course`, `people` and
--      `settings` are the protected "core" sections -- no subscription
--      state, dunning stage or webhook failure ever disables them. Only the
--      premium section (`insights`) is plan-governed.
--   6. Dunning is a sequence: a failed payment opens a grace window
--      (`dunning_stage = 'grace'`, `grace_period_ends_at` set) during which
--      nothing changes but the creator's own billing summary names the
--      deadline; only after the window elapses does the sweep advance the
--      tenant to `dark`, which is the one moment premium sections go dark.
--   7. Tax is Stripe Tax's job. Nothing here computes VAT.

begin;

-- ---------------------------------------------------------------------------
-- 1. A new operation-secret capability for the two trusted-server paths that
--    have no user session: the Stripe webhook, and the scheduled usage
--    report / dunning sweep. Same mechanism as `knowledge.embedding.worker`
--    and `telemetry.outbox.drain` -- a server-held secret, verified inside
--    the definer RPC, never reachable from `authenticated`.
-- ---------------------------------------------------------------------------

alter table app_private.learning_operation_secrets
  drop constraint if exists learning_operation_secrets_capability_allowed;
alter table app_private.learning_operation_secrets
  add constraint learning_operation_secrets_capability_allowed
  check (
    capability in (
      'conversation.answer.record',
      'knowledge.embedding.worker',
      'telemetry.outbox.drain',
      'billing.stripe.webhook',
      'billing.operations'
    )
  );

create or replace function app_private.learning_operation_capabilities()
returns text[]
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select array[
    'conversation.answer.record',
    'knowledge.embedding.worker',
    'telemetry.outbox.drain',
    'billing.stripe.webhook',
    'billing.operations'
  ]::text[];
$$;
revoke execute on function app_private.learning_operation_capabilities()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Per-tenant margin policy. Platform-admin only, in every direction:
--    force RLS, no grants to anon or authenticated, and a deny-all policy so
--    even a future PostgREST exposure cannot read it. The only door in is a
--    SECURITY DEFINER function owned by a role with BYPASSRLS, exactly the
--    pattern `tenant_cost_policies` already established.
-- ---------------------------------------------------------------------------

create table public.tenant_margin_policies (
  tenant_id uuid primary key references public.tenants(tenant_id),
  -- Multiplier applied to true cost. Not floored at 1: an admin comping or
  -- discounting a friendly account below cost is a legitimate business call,
  -- not a bug this constraint should block.
  margin_multiplier numeric(10, 4) not null default 1.5
    check (margin_multiplier >= 0),
  fixed_markup_micro bigint not null default 0
    check (fixed_markup_micro >= 0),
  floor_micro bigint not null default 0
    check (floor_micro >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  updated_by uuid,
  record_version bigint not null default 1 check (record_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tenant_margin_policies enable row level security;
alter table public.tenant_margin_policies force row level security;
revoke all on table public.tenant_margin_policies from anon, authenticated;

-- Deliberately no select policy for `authenticated`, not even the owning
-- tenant's own admin. PLAN.md S10.2 treats margin as a security boundary:
-- true cost, margin and billed amount are platform-admin-only, full stop.
drop policy if exists tenant_margin_policies_deny_all
  on public.tenant_margin_policies;
create policy tenant_margin_policies_deny_all on public.tenant_margin_policies
  for all to anon, authenticated
  using (false)
  with check (false);

create trigger tenant_margin_policies_set_version
before update on public.tenant_margin_policies
for each row execute function app_private.set_updated_at_and_version();

insert into public.tenant_margin_policies (tenant_id)
select t.tenant_id
from public.tenants t
where t.deleted_at is null
on conflict (tenant_id) do nothing;

create or replace function app_private.tenant_margin_policy(
  target_tenant_id uuid
)
returns public.tenant_margin_policies
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  policy public.tenant_margin_policies%rowtype;
begin
  select * into policy
  from public.tenant_margin_policies p
  where p.tenant_id = target_tenant_id;
  if found then
    return policy;
  end if;
  insert into public.tenant_margin_policies (tenant_id)
  values (target_tenant_id)
  on conflict (tenant_id) do nothing;
  select * into policy
  from public.tenant_margin_policies p
  where p.tenant_id = target_tenant_id;
  return policy;
end;
$$;
revoke execute on function app_private.tenant_margin_policy(uuid)
  from public, anon, authenticated, service_role;

-- Billable amount = greatest(cost * multiplier + fixed markup, floor). Plain
-- scalar arguments rather than the row type, on purpose: this is called both
-- from VOLATILE, get-or-create contexts and from STABLE overview reads that
-- must not call anything that could write, and scalars keep it usable from
-- both without a volatility mismatch.
create or replace function app_private.billing_apply_margin(
  cost_micro bigint,
  margin_multiplier numeric,
  fixed_markup_micro bigint,
  floor_micro bigint
)
returns bigint
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select greatest(
    round(
      coalesce(cost_micro, 0) * coalesce(margin_multiplier, 1)
    )::bigint + coalesce(fixed_markup_micro, 0),
    coalesce(floor_micro, 0)
  );
$$;
revoke execute on function app_private.billing_apply_margin(
  bigint, numeric, bigint, bigint
) from public, anon, authenticated, service_role;

-- `cost_ledger` accumulates in micro units (millionths of a major currency
-- unit); Stripe's classic usage-record quantity is reported in whole minor
-- units (cents) against a metered price configured at $0.01/unit. 10,000
-- micro units make one minor unit (1,000,000 micro / 100 minor per major).
create or replace function app_private.billing_micro_to_minor(
  value_micro bigint
)
returns bigint
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select round(coalesce(value_micro, 0) / 10000.0)::bigint;
$$;
revoke execute on function app_private.billing_micro_to_minor(bigint)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Subscription state. Also platform/system only via RPC -- a tenant
--    reads its own plan and status through `tenant_get_billing_summary`
--    below, never this table directly.
-- ---------------------------------------------------------------------------

create table public.tenant_subscriptions (
  tenant_id uuid primary key references public.tenants(tenant_id),
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_price_id text,
  -- The subscription item bound to the metered usage price, captured from
  -- `customer.subscription.*` webhooks. Usage reporting requires this.
  stripe_metered_item_id text,
  plan text not null default 'unconfirmed'
    check (plan in ('unconfirmed', 'starter', 'growth', 'enterprise')),
  -- Mirrors the section-level `source` column below at the subscription
  -- level: 'stripe' means the last write came from a verified webhook,
  -- 'manual' means a platform administrator comped or corrected it by hand.
  plan_source text not null default 'manual'
    check (plan_source in ('manual', 'stripe')),
  subscription_status text not null default 'none'
    check (subscription_status in (
      'none', 'trialing', 'active', 'past_due', 'canceled',
      'incomplete', 'incomplete_expired', 'unpaid', 'paused'
    )),
  -- The dunning sequence: none -> grace (payment failed, window open,
  -- nothing disabled yet) -> dark (window elapsed, premium sections
  -- suppressed). Never touches the core sections at any stage.
  dunning_stage text not null default 'none'
    check (dunning_stage in ('none', 'grace', 'dark')),
  grace_period_days integer not null default 7
    check (grace_period_days between 1 and 60),
  grace_period_ends_at timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  last_stripe_event_id text,
  last_stripe_event_at timestamptz,
  updated_by uuid,
  record_version bigint not null default 1 check (record_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (stripe_customer_id),
  unique (stripe_subscription_id)
);

alter table public.tenant_subscriptions enable row level security;
alter table public.tenant_subscriptions force row level security;
revoke all on table public.tenant_subscriptions from anon, authenticated;
drop policy if exists tenant_subscriptions_deny_all
  on public.tenant_subscriptions;
create policy tenant_subscriptions_deny_all on public.tenant_subscriptions
  for all to anon, authenticated
  using (false)
  with check (false);

create trigger tenant_subscriptions_set_version
before update on public.tenant_subscriptions
for each row execute function app_private.set_updated_at_and_version();

insert into public.tenant_subscriptions (tenant_id)
select t.tenant_id
from public.tenants t
where t.deleted_at is null
on conflict (tenant_id) do nothing;

create or replace function app_private.tenant_subscription_row(
  target_tenant_id uuid
)
returns public.tenant_subscriptions
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  row_data public.tenant_subscriptions%rowtype;
begin
  select * into row_data
  from public.tenant_subscriptions s
  where s.tenant_id = target_tenant_id;
  if found then
    return row_data;
  end if;
  insert into public.tenant_subscriptions (tenant_id)
  values (target_tenant_id)
  on conflict (tenant_id) do nothing;
  select * into row_data
  from public.tenant_subscriptions s
  where s.tenant_id = target_tenant_id;
  return row_data;
end;
$$;
revoke execute on function app_private.tenant_subscription_row(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Section entitlement projection. `agent`, `course`, `people` and
--    `settings` are never touched by billing -- a Stripe outage or an
--    unresolved dunning stage must never cut a student off mid-lesson.
--    `platform` is never touched either: it is the platform-owner console,
--    unrelated to what a client pays for. Only `insights` is plan-governed.
-- ---------------------------------------------------------------------------

create or replace function app_private.billing_core_sections()
returns text[]
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select array['agent', 'course', 'people', 'settings']::text[];
$$;
revoke execute on function app_private.billing_core_sections()
  from public, anon, authenticated, service_role;

create or replace function app_private.billing_premium_sections_for_plan(
  plan_key text
)
returns text[]
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select case lower(btrim(coalesce(plan_key, '')))
    when 'growth' then array['insights']::text[]
    when 'enterprise' then array['insights']::text[]
    else array[]::text[]
  end;
$$;
revoke execute on function app_private.billing_premium_sections_for_plan(text)
  from public, anon, authenticated, service_role;

-- `source` records who is currently steering a section: 'unset' is the
-- programmatic default from initial tenant provisioning (nobody has ever
-- projected a plan or manually toggled it yet); 'subscription' means the
-- last write came from `billing_apply_plan_entitlements`; 'manual_override'
-- means a platform administrator explicitly flipped it and no subscription
-- projection may touch it again until the override is cleared. This is an
-- ADD COLUMN on an existing table, not an edit to the migration that created
-- it -- `platform_admin_set_tenant_section` (20260725123000) is untouched
-- and, because its own INSERT/UPDATE never names this column, its writes
-- fall through to the trigger below exactly as intended.
alter table public.tenant_sections
  add column if not exists source text not null default 'unset';
alter table public.tenant_sections
  drop constraint if exists tenant_sections_source_check;
alter table public.tenant_sections
  add constraint tenant_sections_source_check
  check (source in ('unset', 'subscription', 'manual_override'));

-- Fires on UPDATE only: the seed and provisioning INSERTs (already committed
-- migrations, and `platform_admin_create_tenant`'s per-tenant seed) take the
-- column default and are left alone. Every subsequent UPDATE -- whether from
-- the pre-existing `platform_admin_set_tenant_section` RPC or from a fresh
-- INSERT ... ON CONFLICT DO UPDATE here -- is stamped 'manual_override'
-- unless the writer explicitly marks itself as the subscription projection
-- via a transaction-local flag, which is exactly what
-- `billing_apply_plan_entitlements` and the override-clearing RPC below do.
create or replace function app_private.tenant_sections_stamp_override_source()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if coalesce(
    current_setting('learningbot.billing_entitlement_projection', true),
    ''
  ) = 'true' then
    new.source := 'subscription';
  else
    new.source := 'manual_override';
  end if;
  return new;
end;
$$;

drop trigger if exists tenant_sections_stamp_override_source
  on public.tenant_sections;
create trigger tenant_sections_stamp_override_source
before update on public.tenant_sections
for each row execute function app_private.tenant_sections_stamp_override_source();

-- Projects a plan (core sections always on, premium sections per plan,
-- unless `suppress_premium` -- the "sections go dark" dunning step) onto
-- `tenant_sections`. Rows currently `manual_override` are left untouched:
-- the WHERE clause on the upsert means the trigger above never even fires
-- for them, so an admin's explicit choice survives every future projection.
create or replace function app_private.billing_apply_plan_entitlements(
  target_tenant_id uuid,
  plan_key text,
  suppress_premium boolean default false
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  entitled text[];
  definition record;
  desired boolean;
begin
  entitled := app_private.billing_core_sections();
  if not coalesce(suppress_premium, false) then
    entitled := entitled
      || app_private.billing_premium_sections_for_plan(plan_key);
  end if;

  perform set_config('learningbot.billing_entitlement_projection', 'true', true);

  for definition in
    select d.section_key
    from app_private.tenant_section_definitions() d
    where d.section_key <> 'platform'
  loop
    desired := definition.section_key = any (entitled);
    insert into public.tenant_sections (
      tenant_id, section_key, enabled, source, idempotency_key
    ) values (
      target_tenant_id,
      definition.section_key,
      desired,
      'subscription',
      'tenant-section:' || target_tenant_id::text || ':' || definition.section_key
    )
    on conflict (tenant_id, section_key) do update
      set enabled = excluded.enabled
      where public.tenant_sections.source <> 'manual_override';
  end loop;

  perform set_config('learningbot.billing_entitlement_projection', 'false', true);
end;
$$;
revoke execute on function app_private.billing_apply_plan_entitlements(
  uuid, text, boolean
) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Stripe event dedupe. `stripe_event_id primary key` is the whole
--    guarantee: a retried delivery hits a unique violation and the ingest
--    RPC turns that into a clean "already handled" reply.
-- ---------------------------------------------------------------------------

create table public.billing_stripe_events (
  stripe_event_id text primary key check (length(stripe_event_id) between 1 and 255),
  event_type text not null check (length(event_type) between 1 and 100),
  tenant_id uuid references public.tenants(tenant_id),
  status text not null default 'processed'
    check (status in ('processed', 'ignored', 'failed')),
  detail text,
  processed_at timestamptz not null default now()
);
create index billing_stripe_events_tenant_idx
  on public.billing_stripe_events (tenant_id, processed_at desc);

alter table public.billing_stripe_events enable row level security;
alter table public.billing_stripe_events force row level security;
revoke all on table public.billing_stripe_events from anon, authenticated;
drop policy if exists billing_stripe_events_deny_all
  on public.billing_stripe_events;
create policy billing_stripe_events_deny_all on public.billing_stripe_events
  for all to anon, authenticated
  using (false)
  with check (false);

create trigger billing_stripe_events_reject_update
before update on public.billing_stripe_events
for each row execute function app_private.reject_mutation();
create trigger billing_stripe_events_reject_delete
before delete on public.billing_stripe_events
for each row execute function app_private.reject_mutation();

-- ---------------------------------------------------------------------------
-- 6. Usage-report ledger. `unique (tenant_id, cost_entry_id)` is the
--    idempotency guarantee for non-negotiable #4: a `cost_ledger` row can be
--    committed here at most once, ever, enforced by the database.
-- ---------------------------------------------------------------------------

create table public.billing_usage_reports (
  usage_report_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  cost_entry_id uuid not null,
  stripe_subscription_item_id text not null,
  stripe_usage_record_id text,
  capability text not null,
  provider_key text not null,
  model_key text,
  cost_micro bigint not null check (cost_micro >= 0),
  billed_micro bigint not null check (billed_micro >= 0),
  billed_minor_units bigint not null check (billed_minor_units >= 0),
  margin_multiplier numeric(10, 4) not null,
  fixed_markup_micro bigint not null default 0,
  floor_micro bigint not null default 0,
  reported_at timestamptz not null default now(),
  foreign key (tenant_id, cost_entry_id)
    references public.cost_ledger(tenant_id, cost_entry_id),
  unique (tenant_id, cost_entry_id)
);
create index billing_usage_reports_tenant_idx
  on public.billing_usage_reports (tenant_id, reported_at desc);

alter table public.billing_usage_reports enable row level security;
alter table public.billing_usage_reports force row level security;
revoke all on table public.billing_usage_reports from anon, authenticated;
drop policy if exists billing_usage_reports_deny_all
  on public.billing_usage_reports;
create policy billing_usage_reports_deny_all on public.billing_usage_reports
  for all to anon, authenticated
  using (false)
  with check (false);

create trigger billing_usage_reports_reject_update
before update on public.billing_usage_reports
for each row execute function app_private.reject_mutation();
create trigger billing_usage_reports_reject_delete
before delete on public.billing_usage_reports
for each row execute function app_private.reject_mutation();

-- ---------------------------------------------------------------------------
-- 7. Trusted-server RPCs. No user session reaches these: authority is the
--    `billing.stripe.webhook` / `billing.operations` operation token, the
--    same mechanism gating the embedding worker and telemetry drain. They
--    are granted to `anon` and `service_role` only, below, and revoked from
--    `authenticated` -- a signed-in browser cannot reach them at all.
-- ---------------------------------------------------------------------------

-- Verifies the signature-checked, deduped Stripe event and applies it.
-- Idempotent on `stripe_event_id` (non-negotiable #3): a retried delivery
-- hits the primary key on `billing_stripe_events` and returns `replayed`
-- instead of re-applying anything.
create or replace function public.billing_webhook_ingest(
  operation_token text,
  stripe_event_id text,
  event_type text,
  target_tenant_id uuid default null,
  stripe_customer_id text default null,
  stripe_subscription_id text default null,
  stripe_price_id text default null,
  stripe_metered_item_id text default null,
  plan_key text default null,
  subscription_status text default null,
  current_period_end timestamptz default null,
  cancel_at_period_end boolean default null,
  -- 'payment_failed' | 'payment_succeeded' | null (no dunning signal).
  dunning_signal text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  resolved_tenant_id uuid;
  existing public.tenant_subscriptions%rowtype;
  updated public.tenant_subscriptions%rowtype;
  effective_plan text;
  effective_status text;
begin
  if not app_private.learning_operation_token_is_valid(
    'billing.stripe.webhook', operation_token
  ) then
    return jsonb_build_object(
      'ok', false, 'code', 'operation_secret_unavailable'
    );
  end if;
  if stripe_event_id is null or length(btrim(stripe_event_id)) = 0
    or event_type is null or length(btrim(event_type)) = 0
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  begin
    insert into public.billing_stripe_events (
      stripe_event_id, event_type, tenant_id
    ) values (
      btrim(stripe_event_id), btrim(event_type), target_tenant_id
    );
  exception
    when unique_violation then
      return jsonb_build_object(
        'ok', true, 'dataMode', 'durable', 'replayed', true
      );
  end;

  -- Resolve the tenant: `checkout.session.completed` carries an explicit
  -- `client_reference_id`; every later event for the same customer or
  -- subscription is resolved from what that first event already recorded.
  resolved_tenant_id := target_tenant_id;
  if resolved_tenant_id is null then
    select s.tenant_id into resolved_tenant_id
    from public.tenant_subscriptions s
    where (
        stripe_subscription_id is not null
        and s.stripe_subscription_id = stripe_subscription_id
      )
      or (
        stripe_customer_id is not null
        and s.stripe_customer_id = stripe_customer_id
      )
    limit 1;
  end if;

  if resolved_tenant_id is not null then
    update public.billing_stripe_events
    set tenant_id = resolved_tenant_id
    where stripe_event_id = btrim(stripe_event_id);
  end if;

  if resolved_tenant_id is null then
    update public.billing_stripe_events
    set status = 'ignored', detail = 'tenant_unresolved'
    where stripe_event_id = btrim(stripe_event_id);
    return jsonb_build_object(
      'ok', true, 'dataMode', 'durable', 'ignored', true,
      'reason', 'tenant_unresolved'
    );
  end if;

  if not exists (
    select 1 from public.tenants t
    where t.tenant_id = resolved_tenant_id and t.deleted_at is null
  ) then
    update public.billing_stripe_events
    set status = 'ignored', detail = 'tenant_not_found'
    where stripe_event_id = btrim(stripe_event_id);
    return jsonb_build_object(
      'ok', true, 'dataMode', 'durable', 'ignored', true,
      'reason', 'tenant_not_found'
    );
  end if;

  existing := app_private.tenant_subscription_row(resolved_tenant_id);

  effective_plan := nullif(btrim(coalesce(plan_key, '')), '');
  if effective_plan is null
    or effective_plan not in ('unconfirmed', 'starter', 'growth', 'enterprise')
  then
    effective_plan := existing.plan;
  end if;
  effective_status := nullif(btrim(coalesce(subscription_status, '')), '');
  if effective_status is null
    or effective_status not in (
      'none', 'trialing', 'active', 'past_due', 'canceled',
      'incomplete', 'incomplete_expired', 'unpaid', 'paused'
    )
  then
    effective_status := existing.subscription_status;
  end if;

  update public.tenant_subscriptions s
  set stripe_customer_id =
        coalesce(billing_webhook_ingest.stripe_customer_id, s.stripe_customer_id),
      stripe_subscription_id = coalesce(
        billing_webhook_ingest.stripe_subscription_id, s.stripe_subscription_id
      ),
      stripe_price_id =
        coalesce(billing_webhook_ingest.stripe_price_id, s.stripe_price_id),
      stripe_metered_item_id = coalesce(
        billing_webhook_ingest.stripe_metered_item_id, s.stripe_metered_item_id
      ),
      plan = effective_plan,
      plan_source = 'stripe',
      subscription_status = effective_status,
      current_period_end = coalesce(
        billing_webhook_ingest.current_period_end, s.current_period_end
      ),
      cancel_at_period_end = coalesce(
        billing_webhook_ingest.cancel_at_period_end, s.cancel_at_period_end
      ),
      dunning_stage = case
        when dunning_signal = 'payment_failed' then 'grace'
        when dunning_signal = 'payment_succeeded' then 'none'
        when effective_status = 'active' then 'none'
        else s.dunning_stage
      end,
      grace_period_ends_at = case
        when dunning_signal = 'payment_failed'
          then statement_timestamp() + make_interval(days => s.grace_period_days)
        when dunning_signal = 'payment_succeeded' then null
        when effective_status = 'active' then null
        else s.grace_period_ends_at
      end,
      last_stripe_event_id = btrim(stripe_event_id),
      last_stripe_event_at = statement_timestamp(),
      updated_by = null
  where s.tenant_id = resolved_tenant_id
  returning * into updated;

  -- Core sections are never in play here. Only the premium section follows
  -- the plan, and only a dunning stage that has actually reached `dark`
  -- suppresses it -- a grace period alone changes nothing but the tenant's
  -- own billing summary (non-negotiables #5 and #6).
  perform app_private.billing_apply_plan_entitlements(
    resolved_tenant_id,
    updated.plan,
    updated.dunning_stage = 'dark'
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'replayed', false,
    'tenantId', resolved_tenant_id,
    'plan', updated.plan,
    'subscriptionStatus', updated.subscription_status,
    'dunningStage', updated.dunning_stage
  );
end;
$$;

-- Claims a bounded batch of `cost_ledger` rows that have never been reported
-- (anti-joined against `billing_usage_reports`) for tenants with a metered
-- subscription item on file, and returns the billable amount for each under
-- the tenant's current margin policy. Nothing is marked reported here --
-- only `billing_commit_usage_report`, after the caller's Stripe API call has
-- actually succeeded, writes the row that makes re-claiming it impossible.
create or replace function public.billing_claim_unreported_usage(
  operation_token text,
  batch_limit integer default 200
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  bounded_limit integer := least(greatest(coalesce(batch_limit, 200), 1), 1000);
  items jsonb;
begin
  if not app_private.learning_operation_token_is_valid(
    'billing.operations', operation_token
  ) then
    return jsonb_build_object(
      'ok', false, 'code', 'operation_secret_unavailable'
    );
  end if;

  select coalesce(jsonb_agg(claimed.entry order by claimed.occurred_at), '[]'::jsonb)
  into items
  from (
    select
      jsonb_build_object(
        'tenantId', c.tenant_id,
        'costEntryId', c.cost_entry_id,
        'capability', c.capability,
        'providerKey', c.provider_key,
        'modelKey', c.model_key,
        'costMicro', c.estimated_cost_micro,
        'occurredAt', c.occurred_at,
        'stripeCustomerId', s.stripe_customer_id,
        'stripeSubscriptionItemId', s.stripe_metered_item_id,
        'marginMultiplier', m.margin_multiplier,
        'fixedMarkupMicro', m.fixed_markup_micro,
        'floorMicro', m.floor_micro,
        'billedMicro', app_private.billing_apply_margin(
          c.estimated_cost_micro,
          m.margin_multiplier,
          m.fixed_markup_micro,
          m.floor_micro
        ),
        'billedMinorUnits', app_private.billing_micro_to_minor(
          app_private.billing_apply_margin(
            c.estimated_cost_micro,
            m.margin_multiplier,
            m.fixed_markup_micro,
            m.floor_micro
          )
        )
      ) as entry,
      c.occurred_at
    from public.cost_ledger c
    join public.tenant_subscriptions s on s.tenant_id = c.tenant_id
    cross join lateral (
      select * from app_private.tenant_margin_policy(c.tenant_id)
    ) m
    where s.stripe_metered_item_id is not null
      and s.subscription_status in ('active', 'trialing', 'past_due')
      -- A short settle window: never report a row before it is safely final.
      and c.occurred_at <= statement_timestamp() - interval '5 minutes'
      and not exists (
        select 1
        from public.billing_usage_reports r
        where r.tenant_id = c.tenant_id
          and r.cost_entry_id = c.cost_entry_id
      )
    order by c.occurred_at
    limit bounded_limit
  ) claimed;

  return jsonb_build_object('ok', true, 'dataMode', 'durable', 'items', items);
end;
$$;

-- Commits one successfully reported row. `on conflict (tenant_id,
-- cost_entry_id) do nothing` plus checking whether a row actually inserted
-- is what makes a concurrent or retried commit safe: a duplicate call
-- reports `replayed: true` rather than a spurious failure, and never inserts
-- a second row for the same ledger entry (non-negotiable #4).
create or replace function public.billing_commit_usage_report(
  operation_token text,
  target_tenant_id uuid,
  cost_entry_id uuid,
  stripe_subscription_item_id text,
  stripe_usage_record_id text,
  cost_micro bigint,
  billed_micro bigint,
  billed_minor_units bigint,
  margin_multiplier numeric,
  fixed_markup_micro bigint,
  floor_micro bigint,
  capability text,
  provider_key text,
  model_key text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  inserted public.billing_usage_reports%rowtype;
begin
  if not app_private.learning_operation_token_is_valid(
    'billing.operations', operation_token
  ) then
    return jsonb_build_object(
      'ok', false, 'code', 'operation_secret_unavailable'
    );
  end if;
  if target_tenant_id is null
    or cost_entry_id is null
    or stripe_subscription_item_id is null
    or length(btrim(stripe_subscription_item_id)) = 0
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  insert into public.billing_usage_reports (
    tenant_id, cost_entry_id, stripe_subscription_item_id,
    stripe_usage_record_id, capability, provider_key, model_key,
    cost_micro, billed_micro, billed_minor_units,
    margin_multiplier, fixed_markup_micro, floor_micro
  ) values (
    target_tenant_id, cost_entry_id, btrim(stripe_subscription_item_id),
    nullif(btrim(coalesce(stripe_usage_record_id, '')), ''),
    coalesce(nullif(btrim(coalesce(capability, '')), ''), 'unknown'),
    coalesce(nullif(btrim(coalesce(provider_key, '')), ''), 'stripe'),
    nullif(btrim(coalesce(model_key, '')), ''),
    greatest(coalesce(cost_micro, 0), 0),
    greatest(coalesce(billed_micro, 0), 0),
    greatest(coalesce(billed_minor_units, 0), 0),
    coalesce(margin_multiplier, 1),
    greatest(coalesce(fixed_markup_micro, 0), 0),
    greatest(coalesce(floor_micro, 0), 0)
  )
  on conflict (tenant_id, cost_entry_id) do nothing
  returning * into inserted;

  if inserted.usage_report_id is null then
    return jsonb_build_object(
      'ok', true, 'dataMode', 'durable', 'recorded', false, 'replayed', true
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'recorded', true,
    'replayed', false,
    'usageReportId', inserted.usage_report_id
  );
end;
$$;

-- Advances any subscription whose grace window has elapsed from `grace` to
-- `dark`, suppressing the premium section. This is the one place "sections
-- go dark" actually happens -- never inside the webhook ingest itself, so a
-- failed payment is never a one-step cutoff.
create or replace function public.billing_advance_dunning(
  operation_token text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  advanced_tenant record;
  advanced_count integer := 0;
begin
  if not app_private.learning_operation_token_is_valid(
    'billing.operations', operation_token
  ) then
    return jsonb_build_object(
      'ok', false, 'code', 'operation_secret_unavailable'
    );
  end if;

  for advanced_tenant in
    select s.tenant_id, s.plan
    from public.tenant_subscriptions s
    where s.dunning_stage = 'grace'
      and s.grace_period_ends_at is not null
      and s.grace_period_ends_at <= statement_timestamp()
    for update
  loop
    update public.tenant_subscriptions s
    set dunning_stage = 'dark'
    where s.tenant_id = advanced_tenant.tenant_id;

    perform app_private.billing_apply_plan_entitlements(
      advanced_tenant.tenant_id, advanced_tenant.plan, true
    );

    advanced_count := advanced_count + 1;
  end loop;

  return jsonb_build_object(
    'ok', true, 'dataMode', 'durable', 'advanced', advanced_count
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Platform-administrator RPCs. Every one starts with the same
--    `platform_admin_is_authorized()` check the rest of the platform control
--    plane uses, and every write lands in the target tenant's own audit
--    ledger via `app_private.platform_admin_write_audit`.
-- ---------------------------------------------------------------------------

create or replace function public.platform_admin_set_tenant_margin_policy(
  target_tenant_id uuid,
  margin_multiplier numeric,
  fixed_markup_micro bigint,
  floor_micro bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  updated public.tenant_margin_policies%rowtype;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if target_tenant_id is null
    or margin_multiplier is null
    or margin_multiplier < 0 or margin_multiplier > 100
    or fixed_markup_micro is null or fixed_markup_micro < 0
    or floor_micro is null or floor_micro < 0
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if not exists (
    select 1 from public.tenants t
    where t.tenant_id = target_tenant_id and t.deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'tenant_not_found');
  end if;

  perform app_private.tenant_margin_policy(target_tenant_id);
  update public.tenant_margin_policies p
  set margin_multiplier =
        platform_admin_set_tenant_margin_policy.margin_multiplier,
      fixed_markup_micro =
        platform_admin_set_tenant_margin_policy.fixed_markup_micro,
      floor_micro = platform_admin_set_tenant_margin_policy.floor_micro,
      updated_by = auth.uid()
  where p.tenant_id = target_tenant_id
  returning * into updated;

  perform app_private.platform_admin_write_audit(
    target_tenant_id,
    'platform.tenant.margin_policy_updated',
    'tenant_margin_policy',
    target_tenant_id::text,
    'allow',
    'Platform administrator updated the billing margin policy.',
    'multiplier=' || updated.margin_multiplier::text ||
      ';fixed=' || updated.fixed_markup_micro::text ||
      ';floor=' || updated.floor_micro::text
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', updated.tenant_id,
    'marginMultiplier', updated.margin_multiplier,
    'fixedMarkupMicro', updated.fixed_markup_micro,
    'floorMicro', updated.floor_micro,
    'currency', updated.currency,
    'recordVersion', updated.record_version
  );
end;
$$;

-- The manual comp/debug lever PLAN.md S10.1 requires alongside the Stripe
-- projection. Always restores full plan entitlement (never leaves a tenant
-- mid-dunning): comping an account is never the moment sections go dark.
create or replace function public.platform_admin_set_tenant_subscription(
  target_tenant_id uuid,
  plan text,
  subscription_status text,
  note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  updated public.tenant_subscriptions%rowtype;
  normalized_note text := nullif(btrim(coalesce(note, '')), '');
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if target_tenant_id is null
    or plan is null
    or plan not in ('unconfirmed', 'starter', 'growth', 'enterprise')
    or subscription_status is null
    or subscription_status not in (
      'none', 'trialing', 'active', 'past_due', 'canceled',
      'incomplete', 'incomplete_expired', 'unpaid', 'paused'
    )
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if not exists (
    select 1 from public.tenants t
    where t.tenant_id = target_tenant_id and t.deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'tenant_not_found');
  end if;

  perform app_private.tenant_subscription_row(target_tenant_id);
  update public.tenant_subscriptions s
  set plan = platform_admin_set_tenant_subscription.plan,
      plan_source = 'manual',
      subscription_status =
        platform_admin_set_tenant_subscription.subscription_status,
      dunning_stage = 'none',
      grace_period_ends_at = null,
      updated_by = auth.uid()
  where s.tenant_id = target_tenant_id
  returning * into updated;

  perform app_private.billing_apply_plan_entitlements(
    target_tenant_id, updated.plan, false
  );

  perform app_private.platform_admin_write_audit(
    target_tenant_id,
    'platform.tenant.subscription_set',
    'tenant_subscription',
    target_tenant_id::text,
    'allow',
    coalesce(
      normalized_note,
      'Platform administrator manually set the subscription state.'
    ),
    'plan=' || updated.plan || ';status=' || updated.subscription_status
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', updated.tenant_id,
    'plan', updated.plan,
    'planSource', updated.plan_source,
    'subscriptionStatus', updated.subscription_status,
    'dunningStage', updated.dunning_stage
  );
end;
$$;

-- Returns a single section to plan control. The section's `enabled` value is
-- recomputed from the tenant's current plan (and current dunning stage) at
-- the moment of the call, and the write is stamped 'subscription', not left
-- at whatever a stale plan snapshot would imply.
create or replace function public.platform_admin_clear_tenant_section_override(
  target_tenant_id uuid,
  target_section_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  subscription public.tenant_subscriptions%rowtype;
  entitled text[];
  desired boolean;
  section_record public.tenant_sections%rowtype;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if target_tenant_id is null
    or target_section_key is null
    or target_section_key = 'platform'
    or not exists (
      select 1 from app_private.tenant_section_definitions() d
      where d.section_key = target_section_key
    )
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if not exists (
    select 1 from public.tenants t
    where t.tenant_id = target_tenant_id and t.deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'tenant_not_found');
  end if;

  subscription := app_private.tenant_subscription_row(target_tenant_id);

  entitled := app_private.billing_core_sections();
  if subscription.dunning_stage <> 'dark' then
    entitled := entitled
      || app_private.billing_premium_sections_for_plan(subscription.plan);
  end if;
  desired := target_section_key = any (entitled);

  perform set_config('learningbot.billing_entitlement_projection', 'true', true);
  update public.tenant_sections
  set enabled = desired
  where tenant_id = target_tenant_id
    and section_key = target_section_key
  returning * into section_record;
  perform set_config('learningbot.billing_entitlement_projection', 'false', true);

  if not found then
    return jsonb_build_object('ok', false, 'code', 'section_not_found');
  end if;

  perform app_private.platform_admin_write_audit(
    target_tenant_id,
    'platform.tenant.section_override_cleared',
    'tenant_section',
    target_section_key,
    'allow',
    'Platform administrator returned this section to plan control.',
    section_record.tenant_section_id::text
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', target_tenant_id,
    'section', jsonb_build_object(
      'sectionKey', section_record.section_key,
      'enabled', section_record.enabled,
      'source', section_record.source,
      'updatedAt', section_record.updated_at
    )
  );
end;
$$;

-- Per-account true spend, margin, billed amount, plan, subscription state,
-- budget headroom and model tier -- PLAN.md S10.4, in one bounded read.
-- Deliberately STABLE and side-effect free: it reads `tenant_subscriptions`
-- and `tenant_margin_policies` with LEFT JOIN + COALESCE defaults rather
-- than the get-or-create helpers, so an overview read can never itself write.
create or replace function public.platform_admin_billing_overview(
  window_days integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  bounded_days integer := least(greatest(coalesce(window_days, 30), 1), 180);
  now_ts timestamptz := statement_timestamp();
  window_start timestamptz;
  tenants_summary jsonb;
  totals jsonb;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  window_start := now_ts - make_interval(days => bounded_days);

  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'tenantId', row_data.tenant_id,
          'slug', row_data.slug,
          'displayName', row_data.display_name,
          'status', row_data.status,
          'plan', row_data.plan,
          'planSource', row_data.plan_source,
          'subscriptionStatus', row_data.subscription_status,
          'dunningStage', row_data.dunning_stage,
          'gracePeriodEndsAt', row_data.grace_period_ends_at,
          'modelTier', row_data.model_tier,
          'currency', row_data.currency,
          'windowTrueCostMicro', row_data.window_true_cost,
          'windowBilledMicro', row_data.window_billed,
          'windowUnreportedMicro', row_data.window_unreported,
          'marginMultiplier', row_data.margin_multiplier,
          'fixedMarkupMicro', row_data.fixed_markup_micro,
          'floorMicro', row_data.floor_micro,
          'dailyBudgetMicro', row_data.daily_budget_micro,
          'monthlyBudgetMicro', row_data.monthly_budget_micro,
          'monthSpendMicro', row_data.month_spend,
          'monthBudgetHeadroomMicro', greatest(
            coalesce(row_data.monthly_budget_micro, 0) - row_data.month_spend, 0
          ),
          'hasStripeCustomer', row_data.stripe_customer_id is not null,
          'hasStripeSubscription', row_data.stripe_subscription_id is not null
        )
        order by row_data.window_true_cost desc, row_data.display_name
      ),
      '[]'::jsonb
    ),
    jsonb_build_object(
      'tenants', count(*),
      'windowTrueCostMicro', coalesce(sum(row_data.window_true_cost), 0),
      'windowBilledMicro', coalesce(sum(row_data.window_billed), 0),
      'windowUnreportedMicro', coalesce(sum(row_data.window_unreported), 0)
    )
  into tenants_summary, totals
  from (
    select
      t.tenant_id,
      t.slug,
      t.display_name,
      t.status,
      coalesce(sub.plan, 'unconfirmed') as plan,
      coalesce(sub.plan_source, 'manual') as plan_source,
      coalesce(sub.subscription_status, 'none') as subscription_status,
      coalesce(sub.dunning_stage, 'none') as dunning_stage,
      sub.grace_period_ends_at,
      sub.stripe_customer_id,
      sub.stripe_subscription_id,
      coalesce(mp.margin_multiplier, 1.5) as margin_multiplier,
      coalesce(mp.fixed_markup_micro, 0) as fixed_markup_micro,
      coalesce(mp.floor_micro, 0) as floor_micro,
      coalesce(mp.currency, 'USD') as currency,
      cp.daily_budget_micro,
      cp.monthly_budget_micro,
      coalesce(spend.month_spend, 0)::bigint as month_spend,
      coalesce(spend.window_true_cost, 0)::bigint as window_true_cost,
      coalesce(billed.window_billed, 0)::bigint as window_billed,
      coalesce(unreported.window_unreported, 0)::bigint as window_unreported,
      model_tier.model_tier
    from public.tenants t
    left join public.tenant_cost_policies cp on cp.tenant_id = t.tenant_id
    left join public.tenant_subscriptions sub on sub.tenant_id = t.tenant_id
    left join public.tenant_margin_policies mp on mp.tenant_id = t.tenant_id
    left join lateral (
      select
        sum(c.estimated_cost_micro) filter (
          where c.occurred_at >= date_trunc('month', now_ts)
        ) as month_spend,
        sum(c.estimated_cost_micro) as window_true_cost
      from public.cost_ledger c
      where c.tenant_id = t.tenant_id
        and c.occurred_at >= window_start
    ) spend on true
    left join lateral (
      select sum(r.billed_micro) as window_billed
      from public.billing_usage_reports r
      where r.tenant_id = t.tenant_id
        and r.reported_at >= window_start
    ) billed on true
    left join lateral (
      select sum(
        app_private.billing_apply_margin(
          c.estimated_cost_micro,
          coalesce(mp.margin_multiplier, 1.5),
          coalesce(mp.fixed_markup_micro, 0),
          coalesce(mp.floor_micro, 0)
        )
      ) as window_unreported
      from public.cost_ledger c
      where c.tenant_id = t.tenant_id
        and c.occurred_at >= window_start
        and not exists (
          select 1 from public.billing_usage_reports r
          where r.tenant_id = c.tenant_id and r.cost_entry_id = c.cost_entry_id
        )
    ) unreported on true
    left join lateral (
      select b.agent_model as model_tier
      from public.tenant_branding b
      where b.tenant_id = t.tenant_id
        and b.status = 'published'
        and b.deleted_at is null
      order by b.version_number desc
      limit 1
    ) model_tier on true
    where t.deleted_at is null
  ) row_data;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'windowDays', bounded_days,
    'microUnitsPerMajorUnit', 1000000,
    'generatedAt', now_ts,
    'totals', totals,
    'tenants', tenants_summary
  );
end;
$$;

-- Deep, single-tenant billing detail: true cost, margin, billed amount,
-- subscription identifiers, recent usage reports and section source
-- (subscription vs. manual override). Platform-admin only, same as above.
create or replace function public.platform_admin_tenant_billing_detail(
  target_tenant_id uuid,
  window_days integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  bounded_days integer := least(greatest(coalesce(window_days, 30), 1), 180);
  now_ts timestamptz := statement_timestamp();
  window_start timestamptz;
  tenant_record record;
  sub record;
  mp record;
  cp record;
  spend record;
  sections jsonb;
  recent_reports jsonb;
  model_tier text;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if target_tenant_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  window_start := now_ts - make_interval(days => bounded_days);

  select t.* into tenant_record
  from public.tenants t
  where t.tenant_id = target_tenant_id and t.deleted_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_not_found');
  end if;

  select * into sub
  from public.tenant_subscriptions s
  where s.tenant_id = target_tenant_id;
  select * into mp
  from public.tenant_margin_policies p
  where p.tenant_id = target_tenant_id;
  select * into cp
  from public.tenant_cost_policies c
  where c.tenant_id = target_tenant_id;

  select
    sum(c.estimated_cost_micro) filter (
      where c.occurred_at >= date_trunc('day', now_ts)
    ) as day_spend,
    sum(c.estimated_cost_micro) filter (
      where c.occurred_at >= date_trunc('month', now_ts)
    ) as month_spend,
    sum(c.estimated_cost_micro) as window_true_cost,
    count(*) as window_calls
  into spend
  from public.cost_ledger c
  where c.tenant_id = target_tenant_id
    and c.occurred_at >= window_start;

  select b.agent_model into model_tier
  from public.tenant_branding b
  where b.tenant_id = target_tenant_id
    and b.status = 'published'
    and b.deleted_at is null
  order by b.version_number desc
  limit 1;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'sectionKey', d.section_key,
        'enabled', coalesce(ts.enabled, d.default_enabled),
        'source', coalesce(ts.source, 'unset'),
        'updatedAt', ts.updated_at
      )
      order by d.display_position
    ),
    '[]'::jsonb
  )
  into sections
  from app_private.tenant_section_definitions() d
  left join public.tenant_sections ts
    on ts.tenant_id = target_tenant_id
   and ts.section_key = d.section_key
   and ts.deleted_at is null;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'costEntryId', r.cost_entry_id,
        'capability', r.capability,
        'modelKey', r.model_key,
        'costMicro', r.cost_micro,
        'billedMicro', r.billed_micro,
        'reportedAt', r.reported_at
      )
      order by r.reported_at desc
    ),
    '[]'::jsonb
  )
  into recent_reports
  from (
    select *
    from public.billing_usage_reports br
    where br.tenant_id = target_tenant_id
    order by br.reported_at desc
    limit 20
  ) r;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'generatedAt', now_ts,
    'windowDays', bounded_days,
    'tenant', jsonb_build_object(
      'tenantId', tenant_record.tenant_id,
      'slug', tenant_record.slug,
      'displayName', tenant_record.display_name,
      'status', tenant_record.status
    ),
    'subscription', jsonb_build_object(
      'plan', coalesce(sub.plan, 'unconfirmed'),
      'planSource', coalesce(sub.plan_source, 'manual'),
      'subscriptionStatus', coalesce(sub.subscription_status, 'none'),
      'dunningStage', coalesce(sub.dunning_stage, 'none'),
      'gracePeriodEndsAt', sub.grace_period_ends_at,
      'currentPeriodEnd', sub.current_period_end,
      'cancelAtPeriodEnd', coalesce(sub.cancel_at_period_end, false),
      'stripeCustomerId', sub.stripe_customer_id,
      'stripeSubscriptionId', sub.stripe_subscription_id,
      'stripePriceId', sub.stripe_price_id,
      'hasMeteredItem', sub.stripe_metered_item_id is not null,
      'lastStripeEventAt', sub.last_stripe_event_at
    ),
    'margin', jsonb_build_object(
      'marginMultiplier', coalesce(mp.margin_multiplier, 1.5),
      'fixedMarkupMicro', coalesce(mp.fixed_markup_micro, 0),
      'floorMicro', coalesce(mp.floor_micro, 0),
      'currency', coalesce(mp.currency, 'USD')
    ),
    'budget', jsonb_build_object(
      'dailyBudgetMicro', cp.daily_budget_micro,
      'monthlyBudgetMicro', cp.monthly_budget_micro,
      'daySpendMicro', coalesce(spend.day_spend, 0),
      'monthSpendMicro', coalesce(spend.month_spend, 0)
    ),
    'usage', jsonb_build_object(
      'windowTrueCostMicro', coalesce(spend.window_true_cost, 0),
      'windowCalls', coalesce(spend.window_calls, 0),
      'recentReports', recent_reports
    ),
    'modelTier', model_tier,
    'sections', sections
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. The one surface a creator can reach. Plan, status, dunning stage and
--    their own billed total -- never cost, never margin (non-negotiable #1).
-- ---------------------------------------------------------------------------

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
  billed_window bigint;
  window_start timestamptz := date_trunc('month', statement_timestamp());
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

  select coalesce(sum(r.billed_micro), 0) into billed_window
  from public.billing_usage_reports r
  where r.tenant_id = caller.tenant_id
    and r.reported_at >= window_start;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'plan', coalesce(sub.plan, 'unconfirmed'),
    'subscriptionStatus', coalesce(sub.subscription_status, 'none'),
    'dunningStage', coalesce(sub.dunning_stage, 'none'),
    'gracePeriodEndsAt', sub.grace_period_ends_at,
    'currentPeriodEnd', sub.current_period_end,
    'cancelAtPeriodEnd', coalesce(sub.cancel_at_period_end, false),
    'monthToDateBilledMicro', billed_window,
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

-- ---------------------------------------------------------------------------
-- 10. Least-privilege grants.
-- ---------------------------------------------------------------------------

revoke all on function public.billing_webhook_ingest(
  text, text, text, uuid, text, text, text, text, text, text, timestamptz,
  boolean, text
) from public, anon, authenticated, service_role;
revoke all on function public.billing_claim_unreported_usage(text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.billing_commit_usage_report(
  text, uuid, uuid, text, text, bigint, bigint, bigint, numeric, bigint,
  bigint, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.billing_advance_dunning(text)
  from public, anon, authenticated, service_role;

-- Trusted-server worker paths: the operation token is the authority, not a
-- Supabase session, so these are granted to `anon` (the trusted server calls
-- with the publishable key and no signed-in user) and `service_role`, and
-- never to `authenticated` -- a signed-in browser cannot reach them.
grant execute on function public.billing_webhook_ingest(
  text, text, text, uuid, text, text, text, text, text, text, timestamptz,
  boolean, text
) to anon, service_role;
grant execute on function public.billing_claim_unreported_usage(text, integer)
  to anon, service_role;
grant execute on function public.billing_commit_usage_report(
  text, uuid, uuid, text, text, bigint, bigint, bigint, numeric, bigint,
  bigint, text, text, text
) to anon, service_role;
grant execute on function public.billing_advance_dunning(text)
  to anon, service_role;

revoke all on function public.platform_admin_set_tenant_margin_policy(
  uuid, numeric, bigint, bigint
) from public, anon, authenticated, service_role;
revoke all on function public.platform_admin_set_tenant_subscription(
  uuid, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.platform_admin_clear_tenant_section_override(
  uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.platform_admin_billing_overview(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.platform_admin_tenant_billing_detail(
  uuid, integer
) from public, anon, authenticated, service_role;
revoke all on function public.tenant_get_billing_summary()
  from public, anon, authenticated, service_role;

-- Authorization is checked inside each function, and only a signed-in user
-- can ever be a platform administrator or a tenant admin.
grant execute on function public.platform_admin_set_tenant_margin_policy(
  uuid, numeric, bigint, bigint
) to authenticated;
grant execute on function public.platform_admin_set_tenant_subscription(
  uuid, text, text, text
) to authenticated;
grant execute on function public.platform_admin_clear_tenant_section_override(
  uuid, text
) to authenticated;
grant execute on function public.platform_admin_billing_overview(integer)
  to authenticated;
grant execute on function public.platform_admin_tenant_billing_detail(
  uuid, integer
) to authenticated;
grant execute on function public.tenant_get_billing_summary()
  to authenticated;

commit;

-- ============================================================
-- 20260726101000_character_avatars.sql
-- ============================================================
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

-- ============================================================
-- 20260727090000_knowledge_ingestion_pipeline.sql
-- ============================================================
-- Knowledge pipeline (docs/PLAN.md Section 4). Uploads land in quarantine
-- and stop there permanently today: `upload_intents.status` never leaves
-- 'quarantined' and nothing extracts, cleans, reviews or publishes a file.
-- This migration adds stages 2-5 (extract, clean, review, publish) for the
-- one file type taken end to end in this pass: plain-text and markdown
-- transcript uploads, the case that makes the cleaning module (the reason
-- this phase exists) matter. PDF figure extraction and audio transcription
-- are explicitly out of scope here (Phase 11 and a later upload media type).
--
-- Stage 5 (Publish) projects into the exact same three tables authored
-- content already uses — `knowledge_versions` / `learning_documents` /
-- `learning_chunks` — via a new projector,
-- `app_private.knowledge_project_ingested_course`, that mirrors
-- `app_private.knowledge_project_course` (20260726095000) block for block:
-- same chunking helpers (`knowledge_normalize_text` / `knowledge_split_text`
-- / `knowledge_pack_chunks`), same version/retire/reuse-embedding
-- discipline, same "do not silently clobber the other pipeline's active
-- version" rule (an authored projection defers to imported knowledge unless
-- told to replace it; this one defers to authored knowledge the same way).
-- Stage 6 (Serve) needs no new code: `learning_search_chunks` and the hybrid
-- retrieval RPCs already read `learning_chunks` generically, with no filter
-- on `source_manifest.kind`.
--
-- Security note: extraction reads and stores the uploaded file's raw bytes
-- as text. `0026_authenticated_quarantine_uploads.sql` already states the
-- rule this respects: "no file is promoted or parsed before a malware
-- worker clears it." `learning_ingestion_record_extraction` below enforces
-- that the `security` / `malware_scan` checkpoint is `succeeded` before it
-- will store anything — this repository ships no scanner, so that gate
-- stays closed until one exists, exactly matching the honest "no ingestion
-- worker is running" state the console already reports.

begin;

-- ---------------------------------------------------------------------------
-- Stage 2 (Extract) durable output.
-- ---------------------------------------------------------------------------

create table public.ingestion_extractions (
  extraction_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  course_id uuid not null,
  source_id uuid not null,
  ingestion_job_id uuid not null,
  extractor text not null check (extractor in ('plain_text_transcript_v1')),
  extractor_version integer not null default 1 check (extractor_version > 0),
  media_type text not null check (media_type in ('text/plain', 'text/markdown')),
  raw_text text not null check (length(raw_text) between 1 and 4000000),
  -- Each element: {"offset": int, "kind": "heading"|"timestamp"|"speaker",
  -- "value": text, "line": int}. Offsets are into raw_text and never change
  -- once written — cleaning revisions carry their own map back to them.
  source_locations jsonb not null default '[]'::jsonb
    check (jsonb_typeof(source_locations) = 'array'),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, course_id)
    references public.courses(tenant_id, course_id),
  foreign key (tenant_id, source_id, course_id)
    references public.learning_sources(tenant_id, source_id, course_id),
  foreign key (tenant_id, ingestion_job_id)
    references public.ingestion_jobs(tenant_id, ingestion_job_id),
  unique (tenant_id, extraction_id),
  -- One extraction per job: re-running extraction on the same job refreshes
  -- this row in place (resumable, not a new fork) since the underlying
  -- object is fixed once uploaded.
  unique (tenant_id, ingestion_job_id),
  unique (tenant_id, idempotency_key),
  check (deleted_at is null)
);
create index ingestion_extractions_course_idx
  on public.ingestion_extractions (tenant_id, course_id, source_id);

create or replace function app_private.protect_ingestion_extraction_update()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.tenant_id is distinct from old.tenant_id
    or new.extraction_id is distinct from old.extraction_id
    or new.course_id is distinct from old.course_id
    or new.source_id is distinct from old.source_id
    or new.ingestion_job_id is distinct from old.ingestion_job_id
    or new.created_at is distinct from old.created_at
    or new.idempotency_key is distinct from old.idempotency_key
    or new.record_version <> old.record_version + 1
    or new.updated_at < old.updated_at
  then
    raise exception 'ingestion extraction identity is immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger ingestion_extractions_protect_update
before update on public.ingestion_extractions
for each row execute function app_private.protect_ingestion_extraction_update();
create trigger ingestion_extractions_reject_delete
before delete on public.ingestion_extractions
for each row execute function app_private.reject_mutation();

alter table public.ingestion_extractions enable row level security;
alter table public.ingestion_extractions force row level security;
create policy ingestion_extractions_deny_authenticated
  on public.ingestion_extractions for all to authenticated
  using (false) with check (false);
revoke all on table public.ingestion_extractions from anon, authenticated, service_role;
revoke execute on function app_private.protect_ingestion_extraction_update()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Stage 3 (Clean) durable output. NON-DESTRUCTIVE: a cleaning run always
-- inserts a new revision_number rather than rewriting cleaned_text on an
-- existing row, so the original (ingestion_extractions.raw_text) is always
-- recoverable and every prior attempt stays inspectable.
-- ---------------------------------------------------------------------------

create table public.ingestion_cleaning_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  extraction_id uuid not null,
  ingestion_job_id uuid not null,
  revision_number integer not null check (revision_number > 0),
  cleaner_version integer not null default 1 check (cleaner_version > 0),
  cleaned_text text not null check (length(cleaned_text) <= 4000000),
  -- Ordered log a creator can read: [{"step": "disfluencies", "removals":
  -- [{"rawStart","rawEnd","originalText","replacementText","reason"}, ...]}, ...]
  steps jsonb not null default '[]'::jsonb check (jsonb_typeof(steps) = 'array'),
  -- Raw-vs-cleaned diff for the review UI: [{"op","rawText","cleanedText"}, ...]
  diff jsonb not null default '[]'::jsonb check (jsonb_typeof(diff) = 'array'),
  -- Cleaned-text offset -> raw-text offset breakpoints: [{"at","rawAt"}, ...].
  -- This is what lets a citation survive every cleaning step back to a real
  -- offset in the uploaded file.
  offset_map jsonb not null default '[]'::jsonb check (jsonb_typeof(offset_map) = 'array'),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending_review'
    check (status in ('pending_review', 'approved', 'edited_approved', 'superseded')),
  edited_text text check (edited_text is null or length(edited_text) between 1 and 4000000),
  approved_by uuid,
  approved_at timestamptz,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, extraction_id)
    references public.ingestion_extractions(tenant_id, extraction_id),
  foreign key (tenant_id, ingestion_job_id)
    references public.ingestion_jobs(tenant_id, ingestion_job_id),
  unique (tenant_id, revision_id),
  unique (tenant_id, ingestion_job_id, revision_number),
  unique (tenant_id, idempotency_key),
  check (deleted_at is null),
  -- Nothing reaches students unreviewed: approval facts are only set
  -- together, and only once, by the same transition.
  check (
    (
      status = 'edited_approved'
      and edited_text is not null and approved_by is not null and approved_at is not null
    )
    or (
      status = 'approved'
      and edited_text is null and approved_by is not null and approved_at is not null
    )
    or (
      status in ('pending_review', 'superseded')
      and approved_by is null and approved_at is null
    )
  )
);
create index ingestion_cleaning_revisions_job_idx
  on public.ingestion_cleaning_revisions (tenant_id, ingestion_job_id, revision_number desc);
create index ingestion_cleaning_revisions_pending_idx
  on public.ingestion_cleaning_revisions (tenant_id, status, created_at desc)
  where status = 'pending_review';

create or replace function app_private.protect_ingestion_cleaning_revision_update()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.tenant_id is distinct from old.tenant_id
    or new.revision_id is distinct from old.revision_id
    or new.extraction_id is distinct from old.extraction_id
    or new.ingestion_job_id is distinct from old.ingestion_job_id
    or new.revision_number is distinct from old.revision_number
    or new.cleaner_version is distinct from old.cleaner_version
    or new.cleaned_text is distinct from old.cleaned_text
    or new.steps is distinct from old.steps
    or new.diff is distinct from old.diff
    or new.offset_map is distinct from old.offset_map
    or new.content_hash is distinct from old.content_hash
    or new.created_at is distinct from old.created_at
    or new.idempotency_key is distinct from old.idempotency_key
    or new.record_version <> old.record_version + 1
    or new.updated_at < old.updated_at
    or (old.status <> 'pending_review' and new.status is distinct from old.status)
    or (
      old.status = 'pending_review'
      and new.status not in ('pending_review', 'approved', 'edited_approved', 'superseded')
    )
  then
    raise exception 'cleaning revision identity and approved facts are immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger ingestion_cleaning_revisions_protect_update
before update on public.ingestion_cleaning_revisions
for each row execute function app_private.protect_ingestion_cleaning_revision_update();
create trigger ingestion_cleaning_revisions_reject_delete
before delete on public.ingestion_cleaning_revisions
for each row execute function app_private.reject_mutation();

alter table public.ingestion_cleaning_revisions enable row level security;
alter table public.ingestion_cleaning_revisions force row level security;
create policy ingestion_cleaning_revisions_deny_authenticated
  on public.ingestion_cleaning_revisions for all to authenticated
  using (false) with check (false);
revoke all on table public.ingestion_cleaning_revisions from anon, authenticated, service_role;
revoke execute on function app_private.protect_ingestion_cleaning_revision_update()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Boilerplate memory: cross-upload repetition counts scoped to one creator's
-- own library (`actor_id` is always `auth.uid()`, enforced only in the RPCs
-- below — never a client-supplied value). This is the entire mechanism
-- behind "detected by repetition ... not a hardcoded list": a paragraph
-- only becomes removable once it has been seen this many times before, for
-- this creator, verbatim.
-- ---------------------------------------------------------------------------

create table public.ingestion_boilerplate_shingles (
  tenant_id uuid not null references public.tenants(tenant_id),
  actor_id text not null check (length(actor_id) between 1 and 512),
  shingle_hash text not null check (shingle_hash ~ '^[0-9a-f]{64}$'),
  occurrence_count integer not null default 1 check (occurrence_count > 0),
  distinct_extraction_count integer not null default 1 check (distinct_extraction_count > 0),
  sample_text text check (sample_text is null or length(sample_text) <= 400),
  first_seen_extraction_id uuid,
  last_seen_extraction_id uuid,
  record_version bigint not null default 1 check (record_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, actor_id, shingle_hash)
);

alter table public.ingestion_boilerplate_shingles enable row level security;
alter table public.ingestion_boilerplate_shingles force row level security;
create policy ingestion_boilerplate_shingles_deny_authenticated
  on public.ingestion_boilerplate_shingles for all to authenticated
  using (false) with check (false);
revoke all on table public.ingestion_boilerplate_shingles from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Provenance helpers used only by the publish-stage projector below. Owned
-- by the same role as every other app_private helper, so — exactly like
-- app_private.knowledge_split_text and friends in 20260726095000 — the
-- revokes below block direct calls from any role without blocking the
-- projector, which runs SECURITY DEFINER as that same owning role.
-- ---------------------------------------------------------------------------

-- Raw-text offset for `cleaned_offset`, walking the same breakpoint shape
-- `apps/console/src/lib/ingestion/text-edits.ts` (`mapToRaw`) produces:
-- the last breakpoint at or before the position, plus the identity delta.
create or replace function app_private.knowledge_map_offset(
  offset_map jsonb,
  cleaned_offset integer
)
returns integer
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select coalesce(
    (
      select (bp.value ->> 'rawAt')::integer
        + greatest(cleaned_offset - (bp.value ->> 'at')::integer, 0)
      from jsonb_array_elements(coalesce(offset_map, '[]'::jsonb)) as bp(value)
      where jsonb_typeof(bp.value -> 'at') = 'number'
        and jsonb_typeof(bp.value -> 'rawAt') = 'number'
        and (bp.value ->> 'at')::integer <= cleaned_offset
      order by (bp.value ->> 'at')::integer desc
      limit 1
    ),
    cleaned_offset
  );
$$;

-- The most recent heading/timestamp/speaker anchor at or before raw_offset.
create or replace function app_private.knowledge_nearest_source_location(
  source_locations jsonb,
  raw_offset integer
)
returns jsonb
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select loc.value
  from jsonb_array_elements(coalesce(source_locations, '[]'::jsonb)) as loc(value)
  where jsonb_typeof(loc.value -> 'offset') = 'number'
    and (loc.value ->> 'offset')::integer <= raw_offset
  order by (loc.value ->> 'offset')::integer desc
  limit 1;
$$;

revoke execute on function app_private.knowledge_map_offset(jsonb, integer)
  from public, anon, authenticated, service_role;
revoke execute on function app_private.knowledge_nearest_source_location(jsonb, integer)
  from public, anon, authenticated, service_role;

-- Append-only ingestion-pipeline audit trail, mirroring
-- app_private.authoring_append_audit's shape with resource_type
-- 'ingestion_job' instead of 'course'.
create or replace function app_private.ingestion_append_audit(
  target_tenant_id uuid,
  caller_identity_role text,
  audit_action text,
  target_resource_id text,
  change_ref text
)
returns void
language sql
security definer
set search_path = pg_catalog
as $$
  insert into public.audit_ledger (
    tenant_id, actor_id, actor_type, actor_role, action, resource_type,
    resource_id, policy_decision, decision_reason, change_ref, request_id,
    trace_id, idempotency_key, retain_until
  ) values (
    target_tenant_id,
    auth.uid(),
    case
      when caller_identity_role in ('tenant_owner', 'tenant_admin') then 'owner'
      else 'creator'
    end,
    caller_identity_role,
    audit_action,
    'ingestion_job',
    target_resource_id,
    'allow',
    'authenticated_ingestion_pipeline',
    change_ref,
    'ingestion:' || target_resource_id || ':' || audit_action,
    'ingestion:' || target_resource_id || ':' || audit_action,
    'ingestion-audit:' || gen_random_uuid()::text,
    now() + interval '2555 days'
  );
$$;

revoke execute on function app_private.ingestion_append_audit(uuid, text, text, text, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Stage 2 (Extract) RPC. Called by the console after downloading the
-- quarantined object with the creator's own authenticated storage session
-- and running the extractor client-side of the database
-- (apps/console/src/lib/ingestion/extract.ts) — this RPC only persists the
-- result and advances the checkpoint.
-- ---------------------------------------------------------------------------

create or replace function public.learning_ingestion_record_extraction(
  target_job_id uuid,
  requested_extractor text,
  requested_extractor_version integer,
  requested_media_type text,
  requested_raw_text text,
  requested_source_locations jsonb,
  requested_content_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  job record;
  extraction_id uuid;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in ('tenant_owner', 'tenant_admin', 'creator', 'teacher')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  if requested_extractor <> 'plain_text_transcript_v1'
    or requested_extractor_version is null or requested_extractor_version < 1
    or requested_media_type not in ('text/plain', 'text/markdown')
    or length(coalesce(requested_raw_text, '')) not between 1 and 4000000
    or jsonb_typeof(coalesce(requested_source_locations, 'null'::jsonb)) <> 'array'
    or requested_content_hash !~ '^[0-9a-f]{64}$'
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select
    ij.tenant_id, ij.course_id, ij.source_id,
    ui.actor_id,
    ic.status as scan_status
  into job
  from public.ingestion_jobs ij
  join public.learning_sources ls
    on ls.tenant_id = ij.tenant_id and ls.source_id = ij.source_id
  left join public.upload_intents ui
    on ui.tenant_id = ij.tenant_id and ui.object_key = ls.external_ref
   and ls.source_type = 'upload'
  left join public.ingestion_checkpoints ic
    on ic.tenant_id = ij.tenant_id and ic.ingestion_job_id = ij.ingestion_job_id
   and ic.stage = 'security' and ic.checkpoint_key = 'malware_scan'
  where ij.tenant_id = caller.tenant_id
    and ij.ingestion_job_id = target_job_id
    and ij.deleted_at is null;

  if not found
    or job.actor_id is null
    or (
      job.actor_id <> auth.uid()::text
      and caller.identity_role not in ('tenant_owner', 'tenant_admin')
    )
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  -- 0026_authenticated_quarantine_uploads.sql: "no file is promoted or
  -- parsed before a malware worker clears it." Extraction reads and stores
  -- the file's content, so it is gated exactly like promotion is.
  if coalesce(job.scan_status, 'pending') <> 'succeeded' then
    return jsonb_build_object('ok', false, 'code', 'security_scan_pending');
  end if;

  insert into public.ingestion_extractions (
    tenant_id, course_id, source_id, ingestion_job_id, extractor,
    extractor_version, media_type, raw_text, source_locations, content_hash,
    idempotency_key
  ) values (
    caller.tenant_id, job.course_id, job.source_id, target_job_id,
    requested_extractor, requested_extractor_version, requested_media_type,
    requested_raw_text, requested_source_locations, requested_content_hash,
    'ingestion-extraction:' || target_job_id::text
  )
  on conflict (tenant_id, ingestion_job_id) do update set
    raw_text = excluded.raw_text,
    source_locations = excluded.source_locations,
    content_hash = excluded.content_hash,
    media_type = excluded.media_type,
    extractor_version = excluded.extractor_version,
    updated_at = now(),
    record_version = public.ingestion_extractions.record_version + 1
  returning ingestion_extractions.extraction_id into extraction_id;

  insert into public.ingestion_checkpoints (
    tenant_id, ingestion_job_id, stage, checkpoint_key, status,
    input_hash, output_hash, started_at, finished_at, idempotency_key
  ) values (
    caller.tenant_id, target_job_id, 'extract', 'raw_text', 'succeeded',
    requested_content_hash, requested_content_hash, now(), now(),
    'ingestion-extract-checkpoint:' || target_job_id::text
  )
  on conflict (tenant_id, ingestion_job_id, checkpoint_key) do update set
    status = 'succeeded',
    output_hash = excluded.output_hash,
    input_hash = excluded.input_hash,
    finished_at = now(),
    updated_at = now(),
    record_version = public.ingestion_checkpoints.record_version + 1;

  update public.ingestion_jobs
  set status = 'running',
      started_at = coalesce(started_at, now()),
      updated_at = now(),
      record_version = record_version + 1
  where tenant_id = caller.tenant_id
    and ingestion_job_id = target_job_id
    and status in ('queued', 'waiting');

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'jobId', target_job_id,
    'extractionId', extraction_id,
    'contentHash', requested_content_hash,
    'sourceLocationCount', jsonb_array_length(requested_source_locations)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Reads the calling creator's own boilerplate memory for a batch of
-- candidate paragraph hashes. Always scoped to auth.uid(): a client cannot
-- ask for another creator's counts by passing a different actor id, because
-- there is no actor-id parameter to pass.
-- ---------------------------------------------------------------------------

create or replace function public.learning_ingestion_boilerplate_shingles(
  candidate_hashes text[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  counts jsonb;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in ('tenant_owner', 'tenant_admin', 'creator', 'teacher')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  if candidate_hashes is null
    or array_length(candidate_hashes, 1) is null
    or array_length(candidate_hashes, 1) > 500
  then
    return jsonb_build_object('ok', true, 'dataMode', 'durable', 'counts', '{}'::jsonb);
  end if;

  select coalesce(jsonb_object_agg(s.shingle_hash, s.occurrence_count), '{}'::jsonb)
  into counts
  from public.ingestion_boilerplate_shingles s
  where s.tenant_id = caller.tenant_id
    and s.actor_id = auth.uid()::text
    and s.shingle_hash = any(candidate_hashes);

  return jsonb_build_object('ok', true, 'dataMode', 'durable', 'counts', counts);
end;
$$;

-- ---------------------------------------------------------------------------
-- Stage 3 (Clean) RPC. Always inserts a new revision — never updates an
-- existing one's text — so the raw text and every earlier cleaning attempt
-- stay recoverable.
-- ---------------------------------------------------------------------------

create or replace function public.learning_ingestion_record_cleaning(
  target_job_id uuid,
  requested_cleaner_version integer,
  requested_cleaned_text text,
  requested_steps jsonb,
  requested_diff jsonb,
  requested_offset_map jsonb,
  requested_content_hash text,
  requested_shingle_updates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  extraction record;
  next_revision integer;
  new_revision_id uuid;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in ('tenant_owner', 'tenant_admin', 'creator', 'teacher')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  if requested_cleaner_version is null or requested_cleaner_version < 1
    or requested_cleaned_text is null or length(requested_cleaned_text) > 4000000
    or jsonb_typeof(coalesce(requested_steps, 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(requested_diff, 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(requested_offset_map, 'null'::jsonb)) <> 'array'
    or requested_content_hash !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(coalesce(requested_shingle_updates, 'null'::jsonb)) <> 'array'
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select ie.extraction_id, ie.content_hash
  into extraction
  from public.ingestion_extractions ie
  join public.ingestion_jobs ij
    on ij.tenant_id = ie.tenant_id and ij.ingestion_job_id = ie.ingestion_job_id
  join public.learning_sources ls
    on ls.tenant_id = ij.tenant_id and ls.source_id = ij.source_id
  left join public.upload_intents ui
    on ui.tenant_id = ij.tenant_id and ui.object_key = ls.external_ref
   and ls.source_type = 'upload'
  where ie.tenant_id = caller.tenant_id
    and ie.ingestion_job_id = target_job_id
    and (
      ui.actor_id = auth.uid()::text
      or caller.identity_role in ('tenant_owner', 'tenant_admin')
    );
  if not found then
    return jsonb_build_object('ok', false, 'code', 'extraction_not_found');
  end if;

  select coalesce(max(r.revision_number), 0) + 1
  into next_revision
  from public.ingestion_cleaning_revisions r
  where r.tenant_id = caller.tenant_id and r.ingestion_job_id = target_job_id;

  update public.ingestion_cleaning_revisions
  set status = 'superseded', updated_at = now(), record_version = record_version + 1
  where tenant_id = caller.tenant_id
    and ingestion_job_id = target_job_id
    and status = 'pending_review';

  insert into public.ingestion_cleaning_revisions (
    tenant_id, extraction_id, ingestion_job_id, revision_number,
    cleaner_version, cleaned_text, steps, diff, offset_map, content_hash,
    status, idempotency_key
  ) values (
    caller.tenant_id, extraction.extraction_id, target_job_id, next_revision,
    requested_cleaner_version, requested_cleaned_text, requested_steps,
    requested_diff, requested_offset_map, requested_content_hash,
    'pending_review',
    'ingestion-cleaning:' || target_job_id::text || ':' || next_revision::text
  )
  returning ingestion_cleaning_revisions.revision_id into new_revision_id;

  -- Grow this creator's boilerplate memory with every candidate paragraph
  -- this document contributed, whether or not any of them crossed the
  -- removal threshold this time.
  insert into public.ingestion_boilerplate_shingles (
    tenant_id, actor_id, shingle_hash, occurrence_count,
    distinct_extraction_count, sample_text, first_seen_extraction_id,
    last_seen_extraction_id
  )
  select
    caller.tenant_id,
    auth.uid()::text,
    candidate."shingleHash",
    1,
    1,
    left(coalesce(candidate."sampleText", ''), 400),
    extraction.extraction_id,
    extraction.extraction_id
  from jsonb_to_recordset(requested_shingle_updates)
    as candidate("shingleHash" text, "sampleText" text)
  where candidate."shingleHash" ~ '^[0-9a-f]{64}$'
  on conflict (tenant_id, actor_id, shingle_hash) do update set
    occurrence_count = public.ingestion_boilerplate_shingles.occurrence_count + 1,
    distinct_extraction_count = case
      when public.ingestion_boilerplate_shingles.last_seen_extraction_id
        is distinct from excluded.last_seen_extraction_id
      then public.ingestion_boilerplate_shingles.distinct_extraction_count + 1
      else public.ingestion_boilerplate_shingles.distinct_extraction_count
    end,
    last_seen_extraction_id = excluded.last_seen_extraction_id,
    updated_at = now(),
    record_version = public.ingestion_boilerplate_shingles.record_version + 1;

  insert into public.ingestion_checkpoints (
    tenant_id, ingestion_job_id, stage, checkpoint_key, status,
    input_hash, output_hash, started_at, finished_at, idempotency_key
  ) values (
    caller.tenant_id, target_job_id, 'clean', 'cleaning_revision', 'succeeded',
    extraction.content_hash, requested_content_hash, now(), now(),
    'ingestion-clean-checkpoint:' || target_job_id::text
  )
  on conflict (tenant_id, ingestion_job_id, checkpoint_key) do update set
    status = 'succeeded',
    output_hash = excluded.output_hash,
    input_hash = excluded.input_hash,
    finished_at = now(),
    updated_at = now(),
    record_version = public.ingestion_checkpoints.record_version + 1;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'jobId', target_job_id,
    'revisionId', new_revision_id,
    'revisionNumber', next_revision,
    'status', 'pending_review'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Stage 4 (Review) RPCs.
-- ---------------------------------------------------------------------------

create or replace function public.learning_ingestion_review_queue()
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
  if not found
    or caller.identity_role not in ('tenant_owner', 'tenant_admin', 'creator', 'teacher')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'jobId', ij.ingestion_job_id,
        'courseId', ij.course_id,
        'sourceId', ij.source_id,
        'filename', ui.filename,
        'mediaType', ui.media_type,
        'revisionId', rev.revision_id,
        'revisionNumber', rev.revision_number,
        'status', rev.status,
        'stepCount', jsonb_array_length(rev.steps),
        'createdAt', rev.created_at
      )
      order by rev.created_at desc
    ),
    '[]'::jsonb
  ) into items
  from public.ingestion_cleaning_revisions rev
  join public.ingestion_jobs ij
    on ij.tenant_id = rev.tenant_id and ij.ingestion_job_id = rev.ingestion_job_id
  join public.learning_sources ls
    on ls.tenant_id = ij.tenant_id and ls.source_id = ij.source_id
  left join public.upload_intents ui
    on ui.tenant_id = ij.tenant_id and ui.object_key = ls.external_ref
   and ls.source_type = 'upload'
  where rev.tenant_id = caller.tenant_id
    and rev.status = 'pending_review'
    and rev.deleted_at is null
    and (
      ui.actor_id = auth.uid()::text
      or caller.identity_role in ('tenant_owner', 'tenant_admin')
    );

  return jsonb_build_object('ok', true, 'dataMode', 'durable', 'items', items);
end;
$$;

create or replace function public.learning_ingestion_get_revision(
  target_job_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  extraction record;
  revision record;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in ('tenant_owner', 'tenant_admin', 'creator', 'teacher')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select ie.extraction_id, ie.raw_text, ie.source_locations
  into extraction
  from public.ingestion_extractions ie
  join public.ingestion_jobs ij
    on ij.tenant_id = ie.tenant_id and ij.ingestion_job_id = ie.ingestion_job_id
  join public.learning_sources ls
    on ls.tenant_id = ij.tenant_id and ls.source_id = ij.source_id
  left join public.upload_intents ui
    on ui.tenant_id = ij.tenant_id and ui.object_key = ls.external_ref
   and ls.source_type = 'upload'
  where ie.tenant_id = caller.tenant_id
    and ie.ingestion_job_id = target_job_id
    and (
      ui.actor_id = auth.uid()::text
      or caller.identity_role in ('tenant_owner', 'tenant_admin')
    );
  if not found then
    return jsonb_build_object('ok', false, 'code', 'extraction_not_found');
  end if;

  select r.revision_id, r.revision_number, r.cleaned_text, r.steps, r.diff,
    r.status, r.edited_text, r.approved_at
  into revision
  from public.ingestion_cleaning_revisions r
  where r.tenant_id = caller.tenant_id
    and r.ingestion_job_id = target_job_id
    and r.deleted_at is null
  order by r.revision_number desc
  limit 1;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'jobId', target_job_id,
    'extractionId', extraction.extraction_id,
    'rawText', extraction.raw_text,
    'sourceLocations', extraction.source_locations,
    'revision', case when revision.revision_id is null then null else jsonb_build_object(
      'revisionId', revision.revision_id,
      'revisionNumber', revision.revision_number,
      'cleanedText', revision.cleaned_text,
      'steps', revision.steps,
      'diff', revision.diff,
      'status', revision.status,
      'editedText', revision.edited_text,
      'approvedAt', revision.approved_at
    ) end
  );
end;
$$;

-- The creator sees cleaned beside original with removals highlighted
-- (`revision.diff` / `revision.steps` above) and approves or edits here.
-- Nothing reaches students until this call succeeds.
create or replace function public.learning_ingestion_approve_revision(
  target_job_id uuid,
  target_revision_id uuid,
  requested_edited_text text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  owns_job boolean;
  new_status text;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in ('tenant_owner', 'tenant_admin', 'creator', 'teacher')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  if requested_edited_text is not null
    and length(requested_edited_text) not between 1 and 4000000
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select exists (
    select 1
    from public.ingestion_jobs ij
    join public.learning_sources ls
      on ls.tenant_id = ij.tenant_id and ls.source_id = ij.source_id
    left join public.upload_intents ui
      on ui.tenant_id = ij.tenant_id and ui.object_key = ls.external_ref
     and ls.source_type = 'upload'
    where ij.tenant_id = caller.tenant_id
      and ij.ingestion_job_id = target_job_id
      and (
        ui.actor_id = auth.uid()::text
        or caller.identity_role in ('tenant_owner', 'tenant_admin')
      )
  ) into owns_job;
  if not owns_job then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  new_status := case when requested_edited_text is null then 'approved' else 'edited_approved' end;

  update public.ingestion_cleaning_revisions
  set
    status = new_status,
    edited_text = requested_edited_text,
    approved_by = auth.uid(),
    approved_at = now(),
    updated_at = now(),
    record_version = record_version + 1
  where tenant_id = caller.tenant_id
    and ingestion_job_id = target_job_id
    and revision_id = target_revision_id
    and status = 'pending_review';
  if not found then
    return jsonb_build_object('ok', false, 'code', 'revision_not_pending');
  end if;

  perform app_private.ingestion_append_audit(
    caller.tenant_id,
    caller.identity_role,
    case when new_status = 'approved'
      then 'learning.ingestion.review.approve'
      else 'learning.ingestion.review.approve_edited'
    end,
    target_job_id::text,
    target_revision_id::text
  );

  insert into public.ingestion_checkpoints (
    tenant_id, ingestion_job_id, stage, checkpoint_key, status,
    input_hash, output_hash, started_at, finished_at, idempotency_key
  )
  select
    caller.tenant_id, target_job_id, 'review', 'creator_approval', 'succeeded',
    r.content_hash, r.content_hash, now(), now(),
    'ingestion-review-checkpoint:' || target_job_id::text
  from public.ingestion_cleaning_revisions r
  where r.tenant_id = caller.tenant_id and r.revision_id = target_revision_id
  on conflict (tenant_id, ingestion_job_id, checkpoint_key) do update set
    status = 'succeeded',
    output_hash = excluded.output_hash,
    input_hash = excluded.input_hash,
    finished_at = now(),
    updated_at = now(),
    record_version = public.ingestion_checkpoints.record_version + 1;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'jobId', target_job_id,
    'revisionId', target_revision_id,
    'status', new_status
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Stage 5 (Publish) projector. Reuses the authored path's chunker
-- (app_private.knowledge_split_text / knowledge_pack_chunks /
-- knowledge_normalize_text, unmodified) and its knowledge_versions /
-- learning_documents / learning_chunks lifecycle: build 'building', fill,
-- promote to 'published', then activate — all inside one transaction, so a
-- failure never leaves a course pointed at a half-built version.
-- ---------------------------------------------------------------------------

create or replace function app_private.knowledge_ingested_projection_hash(
  target_tenant_id uuid,
  target_course_id uuid
)
returns text
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select encode(
    extensions.digest(
      'ingested_cleaned_text:v1' || chr(29) ||
      coalesce(
        (
          select string_agg(f.fingerprint, chr(31) order by f.fingerprint)
          from (
            select
              ij.ingestion_job_id::text || chr(30) ||
              r.revision_id::text || chr(30) ||
              r.content_hash || chr(30) ||
              (r.edited_text is not null)::text as fingerprint
            from public.ingestion_jobs ij
            join public.ingestion_extractions ie
              on ie.tenant_id = ij.tenant_id
             and ie.ingestion_job_id = ij.ingestion_job_id
            join lateral (
              select r2.*
              from public.ingestion_cleaning_revisions r2
              where r2.tenant_id = ij.tenant_id
                and r2.ingestion_job_id = ij.ingestion_job_id
                and r2.status in ('approved', 'edited_approved')
                and r2.deleted_at is null
              order by r2.revision_number desc
              limit 1
            ) r on true
            where ij.tenant_id = target_tenant_id
              and ij.course_id = target_course_id
              and ij.deleted_at is null
          ) f
        ),
        ''
      ),
      'sha256'
    ),
    'hex'
  );
$$;

revoke execute on function app_private.knowledge_ingested_projection_hash(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function app_private.knowledge_project_ingested_course(
  target_tenant_id uuid,
  target_course_id uuid,
  caller_identity_role text,
  command_id text,
  replace_authored_knowledge boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  chunk_target constant integer := 1200;
  chunk_max constant integer := 1800;
  course record;
  active_version record;
  job_row record;
  prior_chunk record;
  projection_hash text;
  resolved_source_id uuid;
  new_version_id uuid;
  new_version_number integer;
  new_document_id uuid;
  effective_text text;
  expanded_parts text[];
  packed_chunks text[];
  chunk_body text;
  chunk_hash text;
  chunk_ordinal integer;
  chunk_cleaned_offset integer;
  chunk_raw_offset integer;
  chunk_provenance jsonb;
  context_header text;
  document_count integer := 0;
  chunk_count integer := 0;
  reused_count integer := 0;
  pending_count integer := 0;
  active_is_authored boolean := false;
  should_activate boolean := true;
begin
  select
    c.course_id, c.tenant_id, c.title, c.external_id, c.status,
    c.active_knowledge_version_id
  into course
  from public.courses c
  where c.tenant_id = target_tenant_id
    and c.course_id = target_course_id
    and c.deleted_at is null
  for update;
  if not found then
    raise no_data_found using message = 'Course was not found in this tenant';
  end if;

  projection_hash := app_private.knowledge_ingested_projection_hash(
    target_tenant_id, target_course_id
  );

  select
    kv.knowledge_version_id, kv.version_number, kv.status, kv.content_hash,
    kv.source_manifest, kv.published_at
  into active_version
  from public.knowledge_versions kv
  where kv.tenant_id = target_tenant_id
    and kv.course_id = target_course_id
    and kv.knowledge_version_id = course.active_knowledge_version_id;

  -- Nothing changed since the last publish: re-chunking would produce the
  -- same rows and re-embedding them would be paid for twice.
  if found
    and active_version.status = 'published'
    and active_version.content_hash = projection_hash
    and active_version.source_manifest @> '[{"kind": "ingested_cleaned_text"}]'::jsonb
  then
    select
      count(*)::integer,
      count(*) filter (where ch.embedding is null)::integer
    into chunk_count, pending_count
    from public.learning_chunks ch
    where ch.tenant_id = target_tenant_id
      and ch.course_id = target_course_id
      and ch.knowledge_version_id = active_version.knowledge_version_id
      and ch.deleted_at is null;

    return jsonb_build_object(
      'ok', true, 'dataMode', 'durable', 'changed', false, 'activated', true,
      'knowledgeVersionId', active_version.knowledge_version_id,
      'versionNumber', active_version.version_number,
      'contentHash', projection_hash,
      'documentCount', (
        select count(*)::integer from public.learning_documents d
        where d.tenant_id = target_tenant_id
          and d.knowledge_version_id = active_version.knowledge_version_id
          and d.deleted_at is null
      ),
      'chunkCount', chunk_count,
      'reusedEmbeddingCount', chunk_count - pending_count,
      'pendingEmbeddingCount', pending_count,
      'retrievable', chunk_count > 0
    );
  end if;

  -- Symmetric to the authored projector's "never silently discard an
  -- imported knowledge version" rule: an ingested publish must not silently
  -- discard an active AUTHORED version either, since a creator's typed
  -- lessons are usually the primary content and uploads a supplement.
  active_is_authored := course.active_knowledge_version_id is not null
    and active_version.knowledge_version_id is not null
    and active_version.source_manifest @> '[{"kind": "authored_content_blocks"}]'::jsonb;
  should_activate := (not active_is_authored) or replace_authored_knowledge;

  insert into public.learning_sources (
    tenant_id, course_id, source_type, name, status, external_ref,
    configuration, last_synced_at, idempotency_key
  ) values (
    target_tenant_id, target_course_id, 'api',
    left(coalesce(course.title, 'Course'), 160) || ' ingested uploads',
    'ready', 'ingested:' || target_course_id::text,
    jsonb_build_object('projector', 'ingested_cleaned_text', 'projectorVersion', 1),
    now(), 'ingested-source:' || target_course_id::text
  )
  on conflict (tenant_id, course_id, source_type, external_ref) do update
    set status = 'ready', last_synced_at = now()
  returning learning_sources.source_id into resolved_source_id;

  select coalesce(max(kv.version_number), 0) + 1
  into new_version_number
  from public.knowledge_versions kv
  where kv.tenant_id = target_tenant_id and kv.course_id = target_course_id;

  insert into public.knowledge_versions (
    tenant_id, course_id, version_number, status, source_manifest,
    content_hash, embedding_provider_key, embedding_model_key,
    embedding_dimensions, built_by, supersedes_version_id, idempotency_key
  ) values (
    target_tenant_id, target_course_id, new_version_number, 'building',
    jsonb_build_array(jsonb_build_object(
      'source', 'ingested:' || target_course_id::text,
      'kind', 'ingested_cleaned_text',
      'sourceId', resolved_source_id
    )),
    projection_hash, 'openai', 'text-embedding-3-small', 384,
    auth.uid(), course.active_knowledge_version_id,
    'ingested-knowledge:' || target_course_id::text || ':' || new_version_number::text
  )
  returning knowledge_versions.knowledge_version_id into new_version_id;

  for job_row in
    select
      ij.ingestion_job_id, ij.source_id,
      ie.extraction_id, ie.source_locations,
      r.revision_id, r.revision_number, r.cleaned_text, r.edited_text,
      r.offset_map,
      ls.name as source_name
    from public.ingestion_jobs ij
    join public.ingestion_extractions ie
      on ie.tenant_id = ij.tenant_id and ie.ingestion_job_id = ij.ingestion_job_id
    join lateral (
      select r2.*
      from public.ingestion_cleaning_revisions r2
      where r2.tenant_id = ij.tenant_id
        and r2.ingestion_job_id = ij.ingestion_job_id
        and r2.status in ('approved', 'edited_approved')
        and r2.deleted_at is null
      order by r2.revision_number desc
      limit 1
    ) r on true
    join public.learning_sources ls
      on ls.tenant_id = ij.tenant_id and ls.source_id = ij.source_id
    where ij.tenant_id = target_tenant_id
      and ij.course_id = target_course_id
      and ij.deleted_at is null
    order by ij.ingestion_job_id
  loop
    effective_text := coalesce(job_row.edited_text, job_row.cleaned_text);
    if btrim(coalesce(effective_text, '')) = '' then
      continue;
    end if;

    expanded_parts := app_private.knowledge_split_text(effective_text, chunk_max);
    packed_chunks := app_private.knowledge_pack_chunks(expanded_parts, chunk_target, chunk_max);
    if array_length(packed_chunks, 1) is null then
      continue;
    end if;

    insert into public.learning_documents (
      tenant_id, course_id, source_id, knowledge_version_id, external_id,
      title, media_type, language, content_hash, status, metadata,
      idempotency_key
    ) values (
      target_tenant_id, target_course_id, job_row.source_id, new_version_id,
      job_row.ingestion_job_id::text,
      left(coalesce(job_row.source_name, 'Upload'), 500),
      'text/plain', 'en',
      encode(extensions.digest(effective_text, 'sha256'), 'hex'),
      'ready',
      jsonb_build_object(
        'projector', 'ingested_cleaned_text',
        'ingestionJobId', job_row.ingestion_job_id,
        'extractionId', job_row.extraction_id,
        'revisionId', job_row.revision_id,
        'revisionNumber', job_row.revision_number,
        'editedByCreator', job_row.edited_text is not null,
        'chunkCount', array_length(packed_chunks, 1)
      ),
      'ingested-doc:' || new_version_id::text || ':' || job_row.ingestion_job_id::text
    )
    returning learning_documents.document_id into new_document_id;
    document_count := document_count + 1;

    context_header := concat_ws(
      ' · ',
      nullif(btrim(coalesce(course.title, '')), ''),
      nullif(btrim(coalesce(job_row.source_name, '')), '')
    );

    for chunk_ordinal in 1..array_length(packed_chunks, 1) loop
      chunk_body := case
        when context_header is null or context_header = '' then packed_chunks[chunk_ordinal]
        else context_header || E'\n\n' || packed_chunks[chunk_ordinal]
      end;
      chunk_hash := encode(extensions.digest(chunk_body, 'sha256'), 'hex');

      -- Best-effort provenance: locate this chunk's start inside the
      -- (unmodified) effective text, map it back to the raw upload through
      -- the cleaning revision's offset map, then find the nearest heading /
      -- timestamp / speaker anchor at or before it.
      chunk_cleaned_offset := greatest(
        position(packed_chunks[chunk_ordinal] in effective_text) - 1, 0
      );
      chunk_raw_offset := app_private.knowledge_map_offset(
        job_row.offset_map, chunk_cleaned_offset
      );
      chunk_provenance := app_private.knowledge_nearest_source_location(
        job_row.source_locations, chunk_raw_offset
      );

      select ch.embedding, ch.embedding_provider_key, ch.embedding_model_key,
        ch.embedding_dimensions
      into prior_chunk
      from public.learning_chunks ch
      where ch.tenant_id = target_tenant_id
        and ch.course_id = target_course_id
        and ch.content_hash = chunk_hash
        and ch.embedding is not null
      order by ch.updated_at desc, ch.chunk_id
      limit 1;

      insert into public.learning_chunks (
        tenant_id, course_id, knowledge_version_id, document_id, ordinal,
        body, token_count, content_hash, embedding, embedding_provider_key,
        embedding_model_key, embedding_dimensions, metadata, idempotency_key
      ) values (
        target_tenant_id, target_course_id, new_version_id, new_document_id,
        chunk_ordinal - 1, chunk_body, ceil(length(chunk_body) / 4.0)::integer,
        chunk_hash, prior_chunk.embedding, prior_chunk.embedding_provider_key,
        prior_chunk.embedding_model_key, prior_chunk.embedding_dimensions,
        jsonb_build_object(
          'courseSlug', coalesce(course.external_id, target_course_id::text),
          'courseName', course.title,
          'sectionName', job_row.source_name,
          'ingestionJobId', job_row.ingestion_job_id,
          'extractionId', job_row.extraction_id,
          'revisionId', job_row.revision_id,
          'projector', 'ingested_cleaned_text',
          'projectorVersion', 1,
          'provenance', jsonb_build_object(
            'rawOffset', chunk_raw_offset,
            'sourceLocation', chunk_provenance,
            'editedByCreator', job_row.edited_text is not null
          )
        ),
        'ingested-chunk:' || new_version_id::text || ':' ||
          job_row.ingestion_job_id::text || ':' || (chunk_ordinal - 1)::text
      );

      chunk_count := chunk_count + 1;
      if prior_chunk.embedding is null then
        pending_count := pending_count + 1;
      else
        reused_count := reused_count + 1;
      end if;
    end loop;
  end loop;

  update public.knowledge_versions
  set status = 'published', published_at = now()
  where tenant_id = target_tenant_id and knowledge_version_id = new_version_id;

  if should_activate then
    update public.courses
    set active_knowledge_version_id = new_version_id
    where tenant_id = target_tenant_id and course_id = target_course_id;
  end if;

  update public.knowledge_versions kv
  set status = 'retired'
  where kv.tenant_id = target_tenant_id
    and kv.course_id = target_course_id
    and kv.knowledge_version_id <> new_version_id
    and kv.status <> 'retired'
    and kv.source_manifest @> '[{"kind": "ingested_cleaned_text"}]'::jsonb;

  update public.learning_chunks ch
  set deleted_at = now()
  where ch.tenant_id = target_tenant_id
    and ch.course_id = target_course_id
    and ch.knowledge_version_id <> new_version_id
    and ch.deleted_at is null
    and exists (
      select 1 from public.knowledge_versions kv
      where kv.tenant_id = ch.tenant_id
        and kv.knowledge_version_id = ch.knowledge_version_id
        and kv.source_manifest @> '[{"kind": "ingested_cleaned_text"}]'::jsonb
    );

  update public.learning_documents d
  set deleted_at = now(), status = 'deleted'
  where d.tenant_id = target_tenant_id
    and d.course_id = target_course_id
    and d.knowledge_version_id <> new_version_id
    and d.deleted_at is null
    and exists (
      select 1 from public.knowledge_versions kv
      where kv.tenant_id = d.tenant_id
        and kv.knowledge_version_id = d.knowledge_version_id
        and kv.source_manifest @> '[{"kind": "ingested_cleaned_text"}]'::jsonb
    );

  delete from public.learning_chunks ch
  using public.knowledge_versions kv
  where kv.tenant_id = ch.tenant_id
    and kv.knowledge_version_id = ch.knowledge_version_id
    and kv.tenant_id = target_tenant_id
    and kv.course_id = target_course_id
    and kv.version_number < new_version_number - 1
    and kv.source_manifest @> '[{"kind": "ingested_cleaned_text"}]'::jsonb;

  delete from public.learning_documents d
  using public.knowledge_versions kv
  where kv.tenant_id = d.tenant_id
    and kv.knowledge_version_id = d.knowledge_version_id
    and kv.tenant_id = target_tenant_id
    and kv.course_id = target_course_id
    and kv.version_number < new_version_number - 1
    and kv.source_manifest @> '[{"kind": "ingested_cleaned_text"}]'::jsonb;

  update public.ingestion_jobs ij
  set status = 'succeeded', finished_at = now(), updated_at = now(),
      record_version = record_version + 1
  where ij.tenant_id = target_tenant_id
    and ij.course_id = target_course_id
    and ij.deleted_at is null
    and ij.status not in ('succeeded', 'cancelled', 'dead_letter')
    and exists (
      select 1
      from public.ingestion_cleaning_revisions r
      where r.tenant_id = ij.tenant_id
        and r.ingestion_job_id = ij.ingestion_job_id
        and r.status in ('approved', 'edited_approved')
        and r.deleted_at is null
    );

  perform app_private.ingestion_append_audit(
    target_tenant_id, coalesce(caller_identity_role, 'creator'),
    'learning.ingestion.publish', target_course_id::text, new_version_id::text
  );

  return jsonb_build_object(
    'ok', true, 'dataMode', 'durable', 'changed', true,
    'activated', should_activate,
    'knowledgeVersionId', new_version_id,
    'versionNumber', new_version_number,
    'contentHash', projection_hash,
    'documentCount', document_count,
    'chunkCount', chunk_count,
    'reusedEmbeddingCount', reused_count,
    'pendingEmbeddingCount', pending_count,
    'retrievable', should_activate and chunk_count > 0,
    'activationBlockedReason',
      case when should_activate then null else 'authored_knowledge_version_active' end
  );
end;
$$;

revoke execute on function app_private.knowledge_project_ingested_course(
  uuid, uuid, text, text, boolean
) from public, anon, authenticated, service_role;

create or replace function public.learning_ingestion_publish(
  target_course_id uuid,
  requested_idempotency_key text,
  replace_authored_knowledge boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  projection jsonb;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in ('tenant_owner', 'tenant_admin', 'creator', 'teacher')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if target_course_id is null
    or requested_idempotency_key is null
    or length(requested_idempotency_key) not between 8 and 200
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if not exists (
    select 1 from public.courses c
    where c.tenant_id = caller.tenant_id
      and c.course_id = target_course_id
      and c.deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'course_not_found');
  end if;

  projection := app_private.knowledge_project_ingested_course(
    caller.tenant_id,
    target_course_id,
    caller.identity_role,
    requested_idempotency_key,
    coalesce(replace_authored_knowledge, false)
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'courseId', target_course_id,
    'knowledge', projection
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Job/status detail, used by the review UI to show a quarantine upload's
-- real pipeline state (extraction / cleaning / review / publish), and by the
-- extract route to resolve the object key it needs to download.
-- ---------------------------------------------------------------------------

create or replace function public.learning_ingestion_job_detail(
  target_job_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  job record;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in ('tenant_owner', 'tenant_admin', 'creator', 'teacher')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select
    ij.ingestion_job_id, ij.course_id, ij.source_id, ij.status as job_status,
    ls.external_ref as object_key,
    ui.filename, ui.media_type, ui.actor_id,
    ic.status as malware_scan_status,
    ie.extraction_id, ie.content_hash as extraction_hash,
    jsonb_array_length(coalesce(ie.source_locations, '[]'::jsonb)) as source_location_count,
    rev.revision_id, rev.revision_number, rev.status as revision_status,
    rev.content_hash as revision_hash
  into job
  from public.ingestion_jobs ij
  join public.learning_sources ls
    on ls.tenant_id = ij.tenant_id and ls.source_id = ij.source_id
  left join public.upload_intents ui
    on ui.tenant_id = ij.tenant_id and ui.object_key = ls.external_ref
   and ls.source_type = 'upload'
  left join public.ingestion_checkpoints ic
    on ic.tenant_id = ij.tenant_id and ic.ingestion_job_id = ij.ingestion_job_id
   and ic.stage = 'security' and ic.checkpoint_key = 'malware_scan'
  left join public.ingestion_extractions ie
    on ie.tenant_id = ij.tenant_id and ie.ingestion_job_id = ij.ingestion_job_id
  left join lateral (
    select r.revision_id, r.revision_number, r.status, r.content_hash
    from public.ingestion_cleaning_revisions r
    where r.tenant_id = ij.tenant_id
      and r.ingestion_job_id = ij.ingestion_job_id
      and r.deleted_at is null
    order by r.revision_number desc
    limit 1
  ) rev on true
  where ij.tenant_id = caller.tenant_id
    and ij.ingestion_job_id = target_job_id
    and ij.deleted_at is null;

  if not found
    or job.actor_id is null
    or (
      job.actor_id <> auth.uid()::text
      and caller.identity_role not in ('tenant_owner', 'tenant_admin')
    )
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'jobId', job.ingestion_job_id,
    'courseId', job.course_id,
    'sourceId', job.source_id,
    'objectKey', job.object_key,
    'filename', job.filename,
    'mediaType', job.media_type,
    'jobStatus', job.job_status,
    'malwareScanStatus', coalesce(job.malware_scan_status, 'pending'),
    'extraction', case when job.extraction_id is null then null else jsonb_build_object(
      'extractionId', job.extraction_id,
      'contentHash', job.extraction_hash,
      'sourceLocationCount', job.source_location_count
    ) end,
    'latestRevision', case when job.revision_id is null then null else jsonb_build_object(
      'revisionId', job.revision_id,
      'revisionNumber', job.revision_number,
      'status', job.revision_status,
      'contentHash', job.revision_hash
    ) end
  );
end;
$$;

revoke execute on function public.learning_ingestion_record_extraction(
  uuid, text, integer, text, text, jsonb, text
) from public, anon, authenticated, service_role;
revoke execute on function public.learning_ingestion_boilerplate_shingles(text[])
  from public, anon, authenticated, service_role;
revoke execute on function public.learning_ingestion_record_cleaning(
  uuid, integer, text, jsonb, jsonb, jsonb, text, jsonb
) from public, anon, authenticated, service_role;
revoke execute on function public.learning_ingestion_review_queue()
  from public, anon, authenticated, service_role;
revoke execute on function public.learning_ingestion_get_revision(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.learning_ingestion_approve_revision(uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke execute on function public.learning_ingestion_publish(uuid, text, boolean)
  from public, anon, authenticated, service_role;
revoke execute on function public.learning_ingestion_job_detail(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.learning_ingestion_record_extraction(
  uuid, text, integer, text, text, jsonb, text
) to authenticated;
grant execute on function public.learning_ingestion_boilerplate_shingles(text[])
  to authenticated;
grant execute on function public.learning_ingestion_record_cleaning(
  uuid, integer, text, jsonb, jsonb, jsonb, text, jsonb
) to authenticated;
grant execute on function public.learning_ingestion_review_queue()
  to authenticated;
grant execute on function public.learning_ingestion_get_revision(uuid)
  to authenticated;
grant execute on function public.learning_ingestion_approve_revision(uuid, uuid, text)
  to authenticated;
grant execute on function public.learning_ingestion_publish(uuid, text, boolean)
  to authenticated;
grant execute on function public.learning_ingestion_job_detail(uuid)
  to authenticated;

commit;


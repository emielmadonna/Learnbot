begin;

-- The appearance contract is stored with the rest of the tenant's launcher
-- settings. Historical rows become complete through the effective-settings
-- merge, without rewriting or publishing a new branding version.
create or replace function app_private.widget_settings_defaults()
returns jsonb
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'enabled', false,
    'presentation', 'launcher',
    'launcherPosition', 'bottom-right',
    'launcherLabel', 'Ask',
    'launcherShape', 'bubble',
    'greeting', 'How can I help you learn today?',
    'greetingBubbleEnabled', true,
    'greetingBubbleDelaySeconds', 20,
    'showPoweredBy', true,
    'appearanceMode', 'auto',
    'allowedOrigins', '[]'::jsonb,
    'anonymousQuestions', false,
    'showCourseList', false,
    'courseScope', '"all"'::jsonb,
    'fontFamily', 'system',
    'voiceEnabled', false,
    'logoObjectPath', null,
    'avatarObjectPath', null,
    'privacyUrl', null,
    'termsUrl', null,
    'supportUrl', null
  );
$$;
revoke execute on function app_private.widget_settings_defaults()
  from public, anon, authenticated, service_role;

create or replace function app_private.widget_settings_effective(
  launcher_settings jsonb
)
returns jsonb
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select app_private.widget_settings_defaults()
    || coalesce(
      case
        when jsonb_typeof(launcher_settings) = 'object' then launcher_settings
        else '{}'::jsonb
      end,
      '{}'::jsonb
    );
$$;
revoke execute on function app_private.widget_settings_effective(jsonb)
  from public, anon, authenticated, service_role;

-- Keep the anonymous bootstrap deliberately narrow. The resolver below is the
-- same origin-checking resolver used by ask/record-answer; appearance cannot be
-- read with a key alone.
create or replace function public.widget_bootstrap(
  widget_key text,
  origin text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  resolved record;
  settings jsonb;
  course_list jsonb := '[]'::jsonb;
begin
  select * into resolved
  from app_private.widget_resolve(widget_key, origin);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'widget_unavailable');
  end if;
  settings := resolved.settings;

  if coalesce((settings ->> 'showCourseList')::boolean, false) then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'courseRef',
            app_private.widget_course_ref(widget_key, listed.course_id),
          'title', listed.title
        )
        order by listed.title, listed.course_id
      ),
      '[]'::jsonb
    )
    into course_list
    from (
      select c.course_id, c.title
      from public.courses c
      where c.tenant_id = resolved.tenant_id
        and c.deleted_at is null
        and c.status = 'published'
        and (
          coalesce(settings -> 'courseScope', '"all"'::jsonb) = '"all"'::jsonb
          or (settings -> 'courseScope') ? c.course_id::text
        )
      order by c.title, c.course_id
      limit 50
    ) listed;
  end if;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'widget', jsonb_build_object(
      'presentation', settings ->> 'presentation',
      'launcherPosition', settings ->> 'launcherPosition',
      'launcherLabel', settings ->> 'launcherLabel',
      'launcherShape', settings ->> 'launcherShape',
      'greeting', settings ->> 'greeting',
      'greetingBubbleEnabled',
        coalesce((settings ->> 'greetingBubbleEnabled')::boolean, true),
      'greetingBubbleDelaySeconds',
        coalesce((settings ->> 'greetingBubbleDelaySeconds')::integer, 20),
      'showPoweredBy',
        coalesce((settings ->> 'showPoweredBy')::boolean, true),
      'appearanceMode', settings ->> 'appearanceMode',
      'anonymousQuestions',
        coalesce((settings ->> 'anonymousQuestions')::boolean, false),
      'courses', course_list
    ),
    'branding', jsonb_build_object(
      'assistantName', resolved.assistant_name,
      'iconGlyph', resolved.icon_glyph,
      'primaryColor', resolved.primary_color,
      'accentColor', resolved.accent_color,
      'surfaceColor', resolved.surface_color,
      'textColor', resolved.text_color,
      'fontFamily', settings ->> 'fontFamily',
      'welcomeCopy',
        coalesce(
          nullif(btrim(coalesce(settings ->> 'greeting', '')), ''),
          resolved.welcome_message
        ),
      'launcherLabel', settings ->> 'launcherLabel',
      'launcherPosition', settings ->> 'launcherPosition',
      'voiceEnabled', coalesce((settings ->> 'voiceEnabled')::boolean, false),
      'logoObjectPath', settings ->> 'logoObjectPath',
      'avatarObjectPath', settings ->> 'avatarObjectPath',
      'privacyUrl', settings ->> 'privacyUrl',
      'termsUrl', settings ->> 'termsUrl',
      'supportUrl', settings ->> 'supportUrl'
    )
  );
end;
$$;

revoke execute on function public.widget_bootstrap(text, text)
  from public, authenticated, service_role;
grant execute on function public.widget_bootstrap(text, text) to anon;

-- Add an extended, named-argument overload so older deployed clients keep
-- working while the appearance-aware console writes one atomic branding
-- version. The established updater remains the authority for origins,
-- anonymous access, role checks, version checks, key rotation and auditing.
create or replace function public.tenant_update_widget_settings(
  requested_enabled boolean,
  requested_presentation text,
  requested_launcher_position text,
  requested_launcher_label text,
  requested_greeting text,
  requested_allowed_origins jsonb,
  requested_anonymous_questions boolean,
  requested_show_course_list boolean,
  requested_course_scope jsonb,
  requested_font_family text,
  requested_voice_enabled boolean,
  requested_logo_object_path text,
  requested_avatar_object_path text,
  requested_privacy_url text,
  requested_terms_url text,
  requested_support_url text,
  requested_launcher_shape text,
  requested_greeting_bubble_enabled boolean,
  requested_greeting_bubble_delay_seconds integer,
  requested_show_powered_by boolean,
  requested_appearance_mode text,
  requested_rotate_key boolean,
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
  base_result jsonb;
  result jsonb;
  updated_settings jsonb;
  request_fingerprint text;
  inner_idempotency_key text;
  normalized_shape text := lower(
    btrim(coalesce(requested_launcher_shape, 'bubble'))
  );
  normalized_appearance text := lower(
    btrim(coalesce(requested_appearance_mode, 'auto'))
  );
  normalized_delay integer := coalesce(
    requested_greeting_bubble_delay_seconds,
    20
  );
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;

  if request_id is null or length(request_id) not between 1 and 200
    or trace_id is null or length(trace_id) not between 1 and 200
    or idempotency_key is null
    or length(idempotency_key) not between 1 and 256
    or normalized_shape not in ('bubble', 'pill', 'tab')
    or normalized_appearance not in ('auto', 'light', 'dark')
    or normalized_delay not between 0 and 120
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  request_fingerprint := encode(
    extensions.digest(
      jsonb_build_object(
        'enabled', coalesce(requested_enabled, false),
        'presentation', requested_presentation,
        'launcherPosition', requested_launcher_position,
        'launcherLabel', requested_launcher_label,
        'greeting', requested_greeting,
        'allowedOrigins', requested_allowed_origins,
        'anonymousQuestions', coalesce(requested_anonymous_questions, false),
        'showCourseList', coalesce(requested_show_course_list, false),
        'courseScope', requested_course_scope,
        'fontFamily', requested_font_family,
        'voiceEnabled', coalesce(requested_voice_enabled, false),
        'logoObjectPath', requested_logo_object_path,
        'avatarObjectPath', requested_avatar_object_path,
        'privacyUrl', requested_privacy_url,
        'termsUrl', requested_terms_url,
        'supportUrl', requested_support_url,
        'launcherShape', normalized_shape,
        'greetingBubbleEnabled',
          coalesce(requested_greeting_bubble_enabled, false),
        'greetingBubbleDelaySeconds', normalized_delay,
        'showPoweredBy', coalesce(requested_show_powered_by, false),
        'appearanceMode', normalized_appearance,
        'rotateKey', coalesce(requested_rotate_key, false),
        'publish', coalesce(requested_publish, false),
        'expectedVersion', expected_version
      )::text,
      'sha256'
    ),
    'hex'
  );

  select * into command
  from app_private.onboarding_begin_command(
    caller.tenant_id,
    'widget.settings.appearance',
    idempotency_key,
    request_fingerprint,
    'tenant_update_widget_settings'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    return jsonb_build_object('ok', false, 'code', 'idempotency_conflict');
  end if;

  inner_idempotency_key := 'widget-v2:' || encode(
    extensions.digest(
      caller.tenant_id::text || chr(31) || idempotency_key,
      'sha256'
    ),
    'hex'
  );

  base_result := public.tenant_update_widget_settings(
    requested_enabled => requested_enabled,
    requested_presentation => requested_presentation,
    requested_launcher_position => requested_launcher_position,
    requested_launcher_label => requested_launcher_label,
    requested_greeting => requested_greeting,
    requested_allowed_origins => requested_allowed_origins,
    requested_anonymous_questions => requested_anonymous_questions,
    requested_show_course_list => requested_show_course_list,
    requested_course_scope => requested_course_scope,
    requested_font_family => requested_font_family,
    requested_voice_enabled => requested_voice_enabled,
    requested_logo_object_path => requested_logo_object_path,
    requested_avatar_object_path => requested_avatar_object_path,
    requested_privacy_url => requested_privacy_url,
    requested_terms_url => requested_terms_url,
    requested_support_url => requested_support_url,
    requested_rotate_key => requested_rotate_key,
    requested_publish => requested_publish,
    expected_version => expected_version,
    idempotency_key => inner_idempotency_key,
    request_id => request_id,
    trace_id => trace_id
  );

  if coalesce((base_result ->> 'ok')::boolean, false) is not true then
    perform app_private.onboarding_complete_command(
      caller.tenant_id,
      'widget.settings.appearance',
      idempotency_key,
      base_result
    );
    return base_result;
  end if;

  update public.tenant_branding b
  set launcher = app_private.widget_settings_effective(b.launcher)
    || jsonb_build_object(
      'launcherShape', normalized_shape,
      'greetingBubbleEnabled',
        coalesce(requested_greeting_bubble_enabled, false),
      'greetingBubbleDelaySeconds', normalized_delay,
      'showPoweredBy', coalesce(requested_show_powered_by, false),
      'appearanceMode', normalized_appearance
    )
  where b.tenant_id = caller.tenant_id
    and b.version_number = (base_result ->> 'expectedVersion')::integer
    and b.deleted_at is null
  returning app_private.widget_settings_effective(b.launcher)
  into updated_settings;

  if updated_settings is null then
    raise exception 'widget appearance write did not resolve its branding row';
  end if;

  result := base_result || jsonb_build_object('settings', updated_settings);
  perform app_private.onboarding_complete_command(
    caller.tenant_id,
    'widget.settings.appearance',
    idempotency_key,
    result
  );
  return result;
end;
$$;

revoke execute on function public.tenant_update_widget_settings(
  boolean, text, text, text, text, jsonb, boolean, boolean, jsonb, text,
  boolean, text, text, text, text, text, text, boolean, integer, boolean,
  text, boolean, boolean, integer, text, text, text
) from public, anon, service_role;
grant execute on function public.tenant_update_widget_settings(
  boolean, text, text, text, text, jsonb, boolean, boolean, jsonb, text,
  boolean, text, text, text, text, text, text, boolean, integer, boolean,
  text, boolean, boolean, integer, text, text, text
) to authenticated;

commit;

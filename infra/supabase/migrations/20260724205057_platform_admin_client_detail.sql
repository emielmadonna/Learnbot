-- Bounded platform-admin detail for one client workspace. This deliberately
-- excludes learner message bodies, source contents, credentials, and audio.

begin;

create or replace function public.platform_admin_client_detail(
  target_tenant_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
#variable_conflict use_variable
declare
  tenant_record record;
  branding_assistant_name text;
  branding_primary_color text;
  branding_accent_color text;
  branding_surface_color text;
  branding_text_color text;
  branding_launcher jsonb;
  branding_voice_configuration jsonb;
  assistant_name text;
  configuration jsonb;
  feature_gates jsonb;
  voice_configuration jsonb;
  provider text;
  model text;
  voice_id text;
  voice_enabled boolean;
  courses jsonb;
  people jsonb;
  counts jsonb;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select
    t.tenant_id,
    t.slug,
    t.display_name,
    t.status,
    t.region,
    t.updated_at,
    t.settings
  into tenant_record
  from public.tenants t
  where t.tenant_id = target_tenant_id
    and t.deleted_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'client_not_found');
  end if;

  select
    b.assistant_name,
    b.primary_color,
    b.accent_color,
    b.surface_color,
    b.text_color,
    b.launcher,
    b.voice_configuration
  into
    branding_assistant_name,
    branding_primary_color,
    branding_accent_color,
    branding_surface_color,
    branding_text_color,
    branding_launcher,
    branding_voice_configuration
  from public.tenant_branding b
  where b.tenant_id = target_tenant_id
    and b.deleted_at is null
  order by
    case b.status when 'published' then 0 else 1 end,
    b.version_number desc
  limit 1;

  assistant_name := coalesce(branding_assistant_name, 'LearningBot');
  configuration := case
    when jsonb_typeof(tenant_record.settings -> 'configuration') = 'object'
      then tenant_record.settings -> 'configuration'
    when jsonb_typeof(tenant_record.settings -> 'learningBot') = 'object'
      then tenant_record.settings -> 'learningBot'
    else '{}'::jsonb
  end;
  feature_gates := case
    when jsonb_typeof(configuration -> 'featureGates') = 'object'
      then configuration -> 'featureGates'
    else '{}'::jsonb
  end;
  provider := case
    when configuration ->> 'provider' in ('openai', 'development-local')
      then configuration ->> 'provider'
    else 'development-local'
  end;
  model := coalesce(
    nullif(configuration ->> 'model', ''),
    case when provider = 'openai' then 'gpt-4o-mini' else 'deterministic-grounded-v1' end
  );
  voice_configuration := case
    when jsonb_typeof(branding_voice_configuration) = 'object'
      then branding_voice_configuration
    else '{}'::jsonb
  end;
  voice_id := case
    when voice_configuration ->> 'voiceId' in ('harbor', 'meadow', 'sol')
      then voice_configuration ->> 'voiceId'
    else 'harbor'
  end;
  voice_enabled := case
    when voice_configuration ->> 'enabled' in ('true', 'false')
      then (voice_configuration ->> 'enabled')::boolean
    else true
  end;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'courseId', c.course_id,
        'title', c.title,
        'status', c.status,
        'updatedAt', c.updated_at,
        'modules', (
          select count(*)::bigint
          from public.modules m
          where m.tenant_id = c.tenant_id
            and m.course_id = c.course_id
            and m.deleted_at is null
        ),
        'lessons', (
          select count(*)::bigint
          from public.lessons l
          where l.tenant_id = c.tenant_id
            and l.course_id = c.course_id
            and l.deleted_at is null
        ),
        'sources', (
          select count(*)::bigint
          from public.learning_sources s
          where s.tenant_id = c.tenant_id
            and s.course_id = c.course_id
            and s.deleted_at is null
        )
      )
      order by c.updated_at desc, c.course_id
    ),
    '[]'::jsonb
  )
  into courses
  from public.courses c
  where c.tenant_id = target_tenant_id
    and c.deleted_at is null;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'personId', coalesce(l.auth_user_id::text, m.principal_id),
        'name', coalesce(nullif(btrim(p.display_name), ''), 'Unnamed learner'),
        'role', m.role,
        'status', m.status,
        'progressState', progress.progress_state,
        'percentComplete', progress.percent_complete,
        'lastActivityAt', progress.last_activity_at,
        'questions', coalesce(question_counts.questions, 0),
        'signal', case
          when progress.percent_complete >= 80 then 'ready_to_advance'
          when coalesce(question_counts.questions, 0) >= 3 then 'deep_inquiry'
          when progress.percent_complete < 25
            and coalesce(question_counts.questions, 0) > 0
            then 'needs_clarity'
          else 'building_momentum'
        end
      )
      order by
        progress.last_activity_at desc nulls last,
        coalesce(nullif(btrim(p.display_name), ''), 'Unnamed learner'),
        m.principal_id
    ),
    '[]'::jsonb
  )
  into people
  from public.identity_memberships m
  left join app_private.supabase_auth_principal_links l
    on l.principal_id = m.principal_id
  left join public.profiles p
    on p.tenant_id = m.tenant_id
   and p.user_id = l.auth_user_id
   and p.deleted_at is null
  left join lateral (
    select
      sp.progress_state,
      sp.percent_complete,
      sp.last_activity_at
    from public.student_progress sp
    where sp.tenant_id = m.tenant_id
      and sp.user_id = l.auth_user_id
      and sp.deleted_at is null
    order by sp.last_activity_at desc nulls last, sp.updated_at desc
    limit 1
  ) progress on true
  left join lateral (
    select count(*)::bigint as questions
    from public.conversations conversation
    join public.messages message
      on message.tenant_id = conversation.tenant_id
     and message.conversation_id = conversation.conversation_id
     and message.actor_type = 'student'
     and message.status = 'final'
     and message.deleted_at is null
    where conversation.tenant_id = m.tenant_id
      and conversation.subject_user_id = l.auth_user_id
      and conversation.status <> 'deleted'
      and conversation.deleted_at is null
  ) question_counts on true
  where m.tenant_id = target_tenant_id
    and m.status = 'active'
    and m.role <> 'service'
    and m.deleted_at is null;

  select jsonb_build_object(
    'courses', (
      select count(*)::bigint
      from public.courses c
      where c.tenant_id = target_tenant_id
        and c.deleted_at is null
    ),
    'publishedCourses', (
      select count(*)::bigint
      from public.courses c
      where c.tenant_id = target_tenant_id
        and c.status = 'published'
        and c.deleted_at is null
    ),
    'modules', (
      select count(*)::bigint
      from public.modules m
      where m.tenant_id = target_tenant_id
        and m.deleted_at is null
    ),
    'lessons', (
      select count(*)::bigint
      from public.lessons l
      where l.tenant_id = target_tenant_id
        and l.deleted_at is null
    ),
    'sources', (
      select count(*)::bigint
      from public.learning_sources s
      where s.tenant_id = target_tenant_id
        and s.deleted_at is null
    ),
    'documents', (
      select count(*)::bigint
      from public.learning_documents d
      where d.tenant_id = target_tenant_id
        and d.deleted_at is null
    ),
    'knowledgeChunks', (
      select count(*)::bigint
      from public.learning_chunks c
      where c.tenant_id = target_tenant_id
        and c.deleted_at is null
    ),
    'people', (
      select count(*)::bigint
      from public.identity_memberships m
      where m.tenant_id = target_tenant_id
        and m.status = 'active'
        and m.role <> 'service'
        and m.deleted_at is null
    ),
    'activePeople', (
      select count(*)::bigint
      from public.identity_memberships m
      where m.tenant_id = target_tenant_id
        and m.status = 'active'
        and m.role <> 'service'
        and m.deleted_at is null
    ),
    'questions', (
      select count(*)::bigint
      from public.conversations conversation
      join public.messages message
        on message.tenant_id = conversation.tenant_id
       and message.conversation_id = conversation.conversation_id
       and message.actor_type = 'student'
       and message.status = 'final'
       and message.deleted_at is null
      where conversation.tenant_id = target_tenant_id
        and conversation.status <> 'deleted'
        and conversation.deleted_at is null
    )
  )
  into counts;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'generatedAt', clock_timestamp(),
    'client', jsonb_build_object(
      'tenantId', tenant_record.tenant_id,
      'slug', tenant_record.slug,
      'displayName', tenant_record.display_name,
      'status', tenant_record.status,
      'region', tenant_record.region,
      'assistantName', assistant_name,
      'updatedAt', tenant_record.updated_at
    ),
    'branding', jsonb_build_object(
      'assistantName', assistant_name,
      'primaryColor', coalesce(branding_primary_color, '#315F50'),
      'accentColor', coalesce(branding_accent_color, '#D8A653'),
      'surfaceColor', coalesce(branding_surface_color, '#FFFDF8'),
      'textColor', coalesce(branding_text_color, '#17211D'),
      'iconKey', coalesce(branding_launcher ->> 'iconKey', 'spark')
    ),
    'providerVoice', jsonb_build_object(
      'provider', provider,
      'model', model,
      'credentials', 'server_side_only',
      'voiceEnabled', voice_enabled,
      'voiceId', voice_id
    ),
    'features', jsonb_build_object(
      'analytics', case
        when feature_gates ->> 'analytics' in ('true', 'false')
          then (feature_gates ->> 'analytics')::boolean
        else true
      end,
      'voice', case
        when feature_gates ->> 'voice' in ('true', 'false')
          then (feature_gates ->> 'voice')::boolean
        else voice_enabled
      end,
      'uploads', case
        when feature_gates ->> 'uploads' in ('true', 'false')
          then (feature_gates ->> 'uploads')::boolean
        else true
      end,
      'contextMapping', case
        when feature_gates ->> 'contextMapping' in ('true', 'false')
          then (feature_gates ->> 'contextMapping')::boolean
        else true
      end
    ),
    'counts', counts,
    'courses', courses,
    'people', people
  );
end;
$$;

revoke execute on function public.platform_admin_client_detail(uuid)
  from public, anon, service_role;
grant execute on function public.platform_admin_client_detail(uuid)
  to authenticated;

commit;

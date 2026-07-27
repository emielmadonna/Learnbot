-- Authoring publish visibility. Two defects made editing look like it worked
-- while learners saw nothing:
--
--   1. public.learning_create_module / public.learning_create_lesson insert
--      children as 'draft', and public.learning_get_workspace only shows a
--      learner published rows. Adding a module to an already published course
--      therefore changed nothing a learner could see, silently and with no
--      course-level way to fix it. public.learning_publish_course is that way,
--      but it published every non-deleted child unconditionally, which also
--      resurrected everything an author had deliberately archived. It is
--      rewritten here to publish exactly the draft children and to report how
--      many of each it published, so the console can promise precisely what
--      going live will do and then be held to it.
--   2. public.learning_get_workspace reported canAuthor = true for 'teacher'
--      while app_private.authoring_rpc_context excludes teachers, so a teacher
--      was shown the full editor and every action failed with 403. The RPC gate
--      is the security boundary and stays exactly as it is; the advertised
--      capability is what was wrong, so it is now read from that same gate and
--      cannot drift from it again.
--
-- Publishing is an authoring action, so public.learning_publish_course now
-- resolves its caller through app_private.authoring_rpc_context() as well. That
-- narrows the role set (teachers can no longer publish) — it never widens it.
--
-- The migration declares no new tables and only replaces functions and grants,
-- so it is idempotent.

begin;

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
      -- Authoring capability, not "is staff". app_private.authoring_rpc_context
      -- is the boundary every authoring RPC actually enforces, so this flag is
      -- read straight out of it: a role that gets `true` here can complete
      -- every editing action the console then offers. Teachers deliberately sit
      -- outside it — they read the outline, record progress and upload sources,
      -- but cannot restructure a course, so they must never be handed an editor
      -- whose every button returns 403.
      'canAuthor', exists (
        select 1 from app_private.authoring_rpc_context()
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

-- Publishing a course is the one action that changes what learners can see, so
-- it has to be exact about what it moves. Only 'draft' children are published:
-- an archived module stays archived, and the counts returned are the counts of
-- rows this call actually made visible, which is what the console shows the
-- author before they press the button.
create or replace function public.learning_publish_course(
  target_course_id uuid,
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
  fingerprint text;
  published_modules integer;
  published_lessons integer;
  result jsonb;
begin
  -- The authoring gate, not the learning gate: a teacher may read and progress
  -- through a course but may not decide what a learner sees.
  select * into caller from app_private.authoring_rpc_context();
  if not found then
    raise insufficient_privilege using message = 'Author access is required';
  end if;
  if target_course_id is null
    or idempotency_key is null
    or length(idempotency_key) not between 8 and 200
  then
    raise invalid_parameter_value using message = 'Invalid publish request';
  end if;
  if not exists (
    select 1
    from public.content_blocks cb
    join public.lessons l
      on l.tenant_id = cb.tenant_id
     and l.lesson_id = cb.lesson_id
    where cb.tenant_id = caller.tenant_id
      and cb.course_id = target_course_id
      and cb.deleted_at is null
      and l.deleted_at is null
  ) then
    raise check_violation using message = 'Course has no publishable content';
  end if;

  fingerprint := encode(
    extensions.digest(target_course_id::text, 'sha256'),
    'hex'
  );
  select * into command
  from app_private.onboarding_begin_command(
    caller.tenant_id,
    'learning.course.publish',
    idempotency_key,
    fingerprint,
    'learning_publish_course'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    raise unique_violation using message = 'Idempotency key conflict';
  end if;

  update public.courses
  set status = 'published', published_at = clock_timestamp()
  where tenant_id = caller.tenant_id
    and course_id = target_course_id
    and deleted_at is null;
  if not found then
    raise no_data_found using message = 'Course was not found';
  end if;

  with promoted as (
    update public.modules
    set status = 'published'
    where tenant_id = caller.tenant_id
      and course_id = target_course_id
      and deleted_at is null
      and status = 'draft'
    returning module_id
  )
  select count(*)::integer into published_modules from promoted;

  with promoted as (
    update public.lessons
    set status = 'published'
    where tenant_id = caller.tenant_id
      and course_id = target_course_id
      and deleted_at is null
      and status = 'draft'
    returning lesson_id
  )
  select count(*)::integer into published_lessons from promoted;

  result := jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'courseId', target_course_id,
    'status', 'published',
    'publishedModules', published_modules,
    'publishedLessons', published_lessons
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id,
    'learning.course.publish',
    idempotency_key,
    result
  );
  return result;
end;
$$;

revoke execute on function public.learning_get_workspace()
  from public, anon, service_role;
revoke execute on function public.learning_publish_course(uuid, text)
  from public, anon, service_role;
grant execute on function public.learning_get_workspace()
  to authenticated;
grant execute on function public.learning_publish_course(uuid, text)
  to authenticated;

commit;

-- Durable authenticated learning workspace. The public RPCs bind every read
-- and mutation to the Supabase Auth user and database-selected tenant.

begin;

create table public.lesson_progress (
  lesson_progress_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  user_id uuid not null,
  course_id uuid not null,
  module_id uuid not null,
  lesson_id uuid not null,
  progress_state text not null default 'not_started'
    check (progress_state in ('not_started', 'in_progress', 'completed')),
  started_at timestamptz,
  completed_at timestamptz,
  last_activity_at timestamptz,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, lesson_id, module_id, course_id)
    references public.lessons(tenant_id, lesson_id, module_id, course_id),
  unique (tenant_id, user_id, lesson_id),
  unique (tenant_id, idempotency_key)
);
create index lesson_progress_user_course_idx
  on public.lesson_progress (
    tenant_id, user_id, course_id, last_activity_at desc
  );
create index lesson_progress_course_lesson_idx
  on public.lesson_progress (tenant_id, course_id, lesson_id);

alter table public.lesson_progress enable row level security;
alter table public.lesson_progress force row level security;
revoke all on table public.lesson_progress from anon, authenticated;

create policy lesson_progress_select on public.lesson_progress
  for select to authenticated
  using (
    app_private.is_tenant_context(tenant_id)
    and (
      app_private.has_any_role(array['owner', 'client_admin', 'system_worker'])
      or user_id = (select auth.uid())
    )
  );
create policy lesson_progress_insert on public.lesson_progress
  for insert to authenticated
  with check (
    app_private.is_tenant_context(tenant_id)
    and (
      app_private.can_manage_tenant(tenant_id)
      or user_id = (select auth.uid())
    )
  );
create policy lesson_progress_update on public.lesson_progress
  for update to authenticated
  using (
    app_private.is_tenant_context(tenant_id)
    and (
      app_private.can_manage_tenant(tenant_id)
      or user_id = (select auth.uid())
    )
  )
  with check (
    app_private.is_tenant_context(tenant_id)
    and (
      app_private.can_manage_tenant(tenant_id)
      or user_id = (select auth.uid())
    )
  );
grant select, insert, update on public.lesson_progress to authenticated;

create trigger lesson_progress_set_version
before update on public.lesson_progress
for each row execute function app_private.set_updated_at_and_version();

create or replace function app_private.learning_rpc_context()
returns table (
  tenant_id uuid,
  principal_id text,
  identity_role text,
  app_role text
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select c.tenant_id, c.principal_id, c.identity_role, c.app_role
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
revoke execute on function app_private.learning_rpc_context()
  from public, anon, authenticated, service_role;

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
    'branding', case when b.tenant_branding_id is null then null else
      jsonb_build_object(
        'assistantName', b.assistant_name,
        'primaryColor', b.primary_color,
        'accentColor', b.accent_color,
        'surfaceColor', b.surface_color,
        'textColor', b.text_color,
        'welcomeMessage', b.welcome_message
      )
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

create or replace function public.learning_mark_lesson_progress(
  target_lesson_id uuid,
  target_state text,
  idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  target record;
  command record;
  fingerprint text;
  completed_count integer;
  total_count integer;
  aggregate_state text;
  aggregate_percent numeric(5,2);
  result jsonb;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    raise insufficient_privilege
      using message = 'A selected authenticated tenant is required';
  end if;
  if target_lesson_id is null
    or target_state not in ('not_started', 'in_progress', 'completed')
    or idempotency_key is null
    or length(idempotency_key) not between 8 and 200
  then
    raise invalid_parameter_value using message = 'Invalid progress request';
  end if;

  select l.lesson_id, l.module_id, l.course_id, l.status
  into target
  from public.lessons l
  join public.modules m
    on m.tenant_id = l.tenant_id
   and m.module_id = l.module_id
  join public.courses c
    on c.tenant_id = l.tenant_id
   and c.course_id = l.course_id
  where l.tenant_id = caller.tenant_id
    and l.lesson_id = target_lesson_id
    and l.deleted_at is null
    and m.deleted_at is null
    and c.deleted_at is null
    and (
      caller.identity_role <> 'student'
      or (
        l.status = 'published'
        and m.status = 'published'
        and c.status = 'published'
      )
    );
  if not found then
    raise insufficient_privilege using message = 'Lesson is not accessible';
  end if;

  fingerprint := encode(
    extensions.digest(
      auth.uid()::text || chr(31) || target_lesson_id::text || chr(31) ||
      target_state,
      'sha256'
    ),
    'hex'
  );
  select * into command
  from app_private.onboarding_begin_command(
    caller.tenant_id,
    'learning.progress',
    idempotency_key,
    fingerprint,
    'learning_mark_lesson_progress'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    raise unique_violation using message = 'Idempotency key conflict';
  end if;

  insert into public.lesson_progress (
    tenant_id, user_id, course_id, module_id, lesson_id, progress_state,
    started_at, completed_at, last_activity_at, idempotency_key
  ) values (
    caller.tenant_id,
    auth.uid(),
    target.course_id,
    target.module_id,
    target.lesson_id,
    target_state,
    case when target_state = 'not_started' then null else clock_timestamp() end,
    case when target_state = 'completed' then clock_timestamp() else null end,
    clock_timestamp(),
    'lesson-progress:' || auth.uid()::text || ':' || target.lesson_id::text
  )
  on conflict (tenant_id, user_id, lesson_id) do update
  set progress_state = excluded.progress_state,
      started_at = coalesce(
        public.lesson_progress.started_at,
        excluded.started_at
      ),
      completed_at = excluded.completed_at,
      last_activity_at = excluded.last_activity_at;

  select
    count(*) filter (where lp.progress_state = 'completed')::integer,
    count(*)::integer
  into completed_count, total_count
  from public.lessons l
  left join public.lesson_progress lp
    on lp.tenant_id = l.tenant_id
   and lp.lesson_id = l.lesson_id
   and lp.user_id = auth.uid()
   and lp.deleted_at is null
  where l.tenant_id = caller.tenant_id
    and l.course_id = target.course_id
    and l.deleted_at is null
    and (
      caller.identity_role <> 'student'
      or l.status = 'published'
    );

  aggregate_percent := case
    when total_count = 0 then 0
    else round((completed_count::numeric / total_count::numeric) * 100, 2)
  end;
  aggregate_state := case
    when total_count > 0 and completed_count = total_count then 'completed'
    when exists (
      select 1
      from public.lesson_progress lp
      where lp.tenant_id = caller.tenant_id
        and lp.user_id = auth.uid()
        and lp.course_id = target.course_id
        and lp.progress_state <> 'not_started'
        and lp.deleted_at is null
    ) then 'in_progress'
    else 'not_started'
  end;

  insert into public.student_progress (
    tenant_id, user_id, course_id, module_id, lesson_id, progress_state,
    lessons_completed, lessons_total, percent_complete, source_event_ref,
    verified_at, last_activity_at, idempotency_key
  ) values (
    caller.tenant_id,
    auth.uid(),
    target.course_id,
    target.module_id,
    target.lesson_id,
    aggregate_state,
    completed_count,
    total_count,
    aggregate_percent,
    'learning-rpc:' || idempotency_key,
    clock_timestamp(),
    clock_timestamp(),
    'student-progress:' || auth.uid()::text || ':' || target.course_id::text
  )
  on conflict (tenant_id, user_id, course_id) do update
  set module_id = excluded.module_id,
      lesson_id = excluded.lesson_id,
      progress_state = excluded.progress_state,
      lessons_completed = excluded.lessons_completed,
      lessons_total = excluded.lessons_total,
      percent_complete = excluded.percent_complete,
      source_event_ref = excluded.source_event_ref,
      verified_at = excluded.verified_at,
      last_activity_at = excluded.last_activity_at;

  result := jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'lessonId', target.lesson_id,
    'state', target_state,
    'courseProgress', jsonb_build_object(
      'state', aggregate_state,
      'lessonsCompleted', completed_count,
      'lessonsTotal', total_count,
      'percentComplete', aggregate_percent
    )
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id,
    'learning.progress',
    idempotency_key,
    result
  );
  return result;
end;
$$;

create or replace function public.learning_create_course_draft(
  requested_title text,
  requested_description text,
  requested_module_title text,
  requested_lesson_title text,
  requested_lesson_content text,
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
  new_course_id uuid := gen_random_uuid();
  new_module_id uuid := gen_random_uuid();
  new_lesson_id uuid := gen_random_uuid();
  result jsonb;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in (
      'tenant_owner', 'tenant_admin', 'creator', 'teacher'
    )
  then
    raise insufficient_privilege using message = 'Author access is required';
  end if;
  if requested_title is null
    or length(btrim(requested_title)) not between 3 and 160
    or requested_description is null
    or length(btrim(requested_description)) not between 3 and 2000
    or requested_module_title is null
    or length(btrim(requested_module_title)) not between 3 and 160
    or requested_lesson_title is null
    or length(btrim(requested_lesson_title)) not between 3 and 160
    or requested_lesson_content is null
    or length(btrim(requested_lesson_content)) not between 20 and 50000
    or idempotency_key is null
    or length(idempotency_key) not between 8 and 200
  then
    raise invalid_parameter_value using message = 'Invalid course draft';
  end if;

  fingerprint := encode(
    extensions.digest(
      requested_title || chr(31) || requested_description || chr(31) ||
      requested_module_title || chr(31) || requested_lesson_title || chr(31) ||
      requested_lesson_content,
      'sha256'
    ),
    'hex'
  );
  select * into command
  from app_private.onboarding_begin_command(
    caller.tenant_id,
    'learning.course.create',
    idempotency_key,
    fingerprint,
    'learning_create_course_draft'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    raise unique_violation using message = 'Idempotency key conflict';
  end if;

  insert into public.courses (
    course_id, tenant_id, title, description, status, metadata,
    idempotency_key
  ) values (
    new_course_id,
    caller.tenant_id,
    btrim(requested_title),
    btrim(requested_description),
    'draft',
    jsonb_build_object('source', 'authenticated_authoring'),
    'course:' || idempotency_key
  );
  insert into public.modules (
    module_id, tenant_id, course_id, title, position, status, metadata,
    idempotency_key
  ) values (
    new_module_id,
    caller.tenant_id,
    new_course_id,
    btrim(requested_module_title),
    0,
    'draft',
    '{}'::jsonb,
    'module:' || idempotency_key
  );
  insert into public.lessons (
    lesson_id, tenant_id, course_id, module_id, title, position, status,
    metadata, idempotency_key
  ) values (
    new_lesson_id,
    caller.tenant_id,
    new_course_id,
    new_module_id,
    btrim(requested_lesson_title),
    0,
    'draft',
    '{}'::jsonb,
    'lesson:' || idempotency_key
  );
  insert into public.content_blocks (
    tenant_id, course_id, lesson_id, block_type, position, content,
    content_hash, idempotency_key
  ) values (
    caller.tenant_id,
    new_course_id,
    new_lesson_id,
    'rich_text',
    0,
    jsonb_build_object(
      'text', btrim(requested_lesson_content),
      'format', 'plain_text'
    ),
    encode(
      extensions.digest(btrim(requested_lesson_content), 'sha256'),
      'hex'
    ),
    'content:' || idempotency_key
  );

  result := jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'courseId', new_course_id,
    'moduleId', new_module_id,
    'lessonId', new_lesson_id,
    'status', 'draft'
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id,
    'learning.course.create',
    idempotency_key,
    result
  );
  return result;
end;
$$;

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
  result jsonb;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in (
      'tenant_owner', 'tenant_admin', 'creator', 'teacher'
    )
  then
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
  update public.modules
  set status = 'published'
  where tenant_id = caller.tenant_id
    and course_id = target_course_id
    and deleted_at is null;
  update public.lessons
  set status = 'published'
  where tenant_id = caller.tenant_id
    and course_id = target_course_id
    and deleted_at is null;

  result := jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'courseId', target_course_id,
    'status', 'published'
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
  from public, anon;
revoke execute on function public.learning_mark_lesson_progress(
  uuid, text, text
) from public, anon;
revoke execute on function public.learning_create_course_draft(
  text, text, text, text, text, text
) from public, anon;
revoke execute on function public.learning_publish_course(uuid, text)
  from public, anon;
grant execute on function public.learning_get_workspace()
  to authenticated;
grant execute on function public.learning_mark_lesson_progress(
  uuid, text, text
) to authenticated;
grant execute on function public.learning_create_course_draft(
  text, text, text, text, text, text
) to authenticated;
grant execute on function public.learning_publish_course(uuid, text)
  to authenticated;

commit;

-- Editable durable courses. Migration 0017 could only create a course draft and
-- publish it once; nothing could be corrected afterwards. These RPCs make the
-- authored hierarchy editable while keeping every existing durability contract:
--   * tenant scope comes from app_private.learning_rpc_context() only,
--   * authoring is limited to creator / tenant_admin / tenant_owner,
--   * `expected_version` is the optimistic-concurrency token and is always the
--     `courses.record_version` of the owning course, so the whole tree has one
--     concurrency token,
--   * every mutation appends an immutable public.course_revisions row through
--     the existing compare-and-swap public.course_revision_heads machinery and
--     an immutable public.audit_ledger entry,
--   * deletes are soft (deleted_at) and cascade downwards so the learner
--     workspace stops resolving the removed subtree,
--   * reordering rewrites positions in two disjoint phases so the existing
--     (tenant_id, course_id, position) / (tenant_id, module_id, position)
--     unique constraints never see a colliding intermediate state.
-- The migration is idempotent: it declares no new tables and only replaces
-- functions and their grants.

begin;

-- Positions are always compacted back into [0, child_count) at the end of a
-- reorder, so this offset can never collide with a live position.
create or replace function app_private.authoring_position_offset()
returns integer
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select 1000000;
$$;

-- Authoring context. Teachers may record progress and upload sources but may
-- not restructure a course, so they are deliberately absent from this gate.
create or replace function app_private.authoring_rpc_context()
returns table (
  tenant_id uuid,
  principal_id text,
  identity_role text,
  actor_type text
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    c.tenant_id,
    c.principal_id,
    c.identity_role,
    case c.identity_role
      when 'tenant_owner' then 'owner'
      when 'tenant_admin' then 'owner'
      when 'creator' then 'creator'
      else 'system'
    end
  from app_private.learning_rpc_context() c
  where c.identity_role in ('tenant_owner', 'tenant_admin', 'creator');
$$;

-- Immutable snapshot of the live authored tree. Soft-deleted rows are excluded
-- so a rollback restores exactly the set of rows that were live at the target
-- revision.
create or replace function app_private.authoring_course_snapshot(
  target_tenant_id uuid,
  target_course_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'courseId', c.course_id,
    'tenantId', c.tenant_id,
    'title', c.title,
    'description', c.description,
    'status', c.status,
    'recordVersion', c.record_version,
    'modules', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'moduleId', m.module_id,
          'title', m.title,
          'status', m.status,
          'position', m.position,
          'lessons', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'lessonId', l.lesson_id,
                'title', l.title,
                'status', l.status,
                'position', l.position,
                'blocks', coalesce((
                  select jsonb_agg(
                    jsonb_build_object(
                      'contentBlockId', cb.content_block_id,
                      'blockType', cb.block_type,
                      'position', cb.position,
                      'content', cb.content,
                      'contentHash', cb.content_hash
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
            where l.tenant_id = m.tenant_id
              and l.module_id = m.module_id
              and l.deleted_at is null
          ), '[]'::jsonb)
        )
        order by m.position, m.module_id
      )
      from public.modules m
      where m.tenant_id = c.tenant_id
        and m.course_id = c.course_id
        and m.deleted_at is null
    ), '[]'::jsonb)
  )
  from public.courses c
  where c.tenant_id = target_tenant_id
    and c.course_id = target_course_id
    and c.deleted_at is null;
$$;

-- Append-only operating evidence for every authoring mutation.
create or replace function app_private.authoring_append_audit(
  target_tenant_id uuid,
  caller_actor_type text,
  caller_actor_role text,
  audit_action text,
  target_resource_id text,
  command_id text,
  before_hash text,
  after_hash text,
  change_ref text
)
returns void
language sql
security definer
set search_path = pg_catalog
as $$
  insert into public.audit_ledger (
    tenant_id, actor_id, actor_type, actor_role, action, resource_type,
    resource_id, policy_decision, decision_reason, before_hash, after_hash,
    change_ref, request_id, trace_id, idempotency_key, retain_until
  )
  select
    target_tenant_id,
    auth.uid(),
    caller_actor_type,
    caller_actor_role,
    audit_action,
    'course',
    target_resource_id,
    'allow',
    'authenticated_course_authoring',
    before_hash,
    after_hash,
    change_ref,
    'authoring:' || command_id,
    'authoring:' || command_id,
    'authoring-audit:' || encode(
      extensions.digest(
        target_tenant_id::text || chr(31) || command_id || chr(31) ||
        audit_action || chr(31) || coalesce(change_ref, ''),
        'sha256'
      ),
      'hex'
    ),
    now() + make_interval(
      days => coalesce(
        nullif(t.settings ->> 'auditRetentionDays', '')::integer,
        2555
      )
    )
  from public.tenants t
  where t.tenant_id = target_tenant_id
  on conflict (tenant_id, idempotency_key) do nothing;
$$;

-- Compare-and-swap append onto public.course_revision_heads. The head row is
-- locked, the new immutable revision is inserted at head + 1 and the head is
-- only advanced when its observed record_version is unchanged.
create or replace function app_private.authoring_commit_revision(
  target_tenant_id uuid,
  target_course_id uuid,
  requested_revision_kind text,
  command_id text,
  requested_audit_note text,
  rollback_target_number bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  head record;
  next_number bigint;
  new_revision_id text;
  course_snapshot jsonb;
  new_hash text;
  prior_hash text;
begin
  course_snapshot := app_private.authoring_course_snapshot(
    target_tenant_id,
    target_course_id
  );
  if course_snapshot is null then
    raise no_data_found using message = 'Course was not found in this tenant';
  end if;
  new_hash := encode(
    extensions.digest(course_snapshot::text, 'sha256'),
    'hex'
  );

  select
    h.current_revision_number as current_revision_number,
    h.current_revision_id as current_revision_id,
    h.record_version as record_version
  into head
  from public.course_revision_heads h
  where h.tenant_id = target_tenant_id
    and h.course_id = target_course_id
  for update;
  if not found then
    insert into public.course_revision_heads (
      tenant_id, course_id, current_revision_number, current_revision_id,
      idempotency_key
    ) values (
      target_tenant_id, target_course_id, 0, null,
      'course-revision-head:' || target_course_id::text
    )
    on conflict (tenant_id, course_id) do nothing;
    select
      h.current_revision_number as current_revision_number,
      h.current_revision_id as current_revision_id,
      h.record_version as record_version
    into head
    from public.course_revision_heads h
    where h.tenant_id = target_tenant_id
      and h.course_id = target_course_id
    for update;
    if not found then
      raise serialization_failure
        using message = 'Course revision head is unavailable';
    end if;
  end if;

  if head.current_revision_id is not null then
    select r.content_hash
    into prior_hash
    from public.course_revisions r
    where r.tenant_id = target_tenant_id
      and r.course_id = target_course_id
      and r.revision_id = head.current_revision_id;
  end if;

  next_number := head.current_revision_number + 1;
  new_revision_id := 'rev-' || encode(
    extensions.digest(
      target_tenant_id::text || chr(31) || target_course_id::text || chr(31) ||
      next_number::text || chr(31) || command_id,
      'sha256'
    ),
    'hex'
  );

  insert into public.course_revisions (
    revision_id, tenant_id, course_id, revision_number, revision_kind,
    command_id, actor_id, audit_note, rollback_target_revision_number,
    content_hash, snapshot, idempotency_key
  ) values (
    new_revision_id,
    target_tenant_id,
    target_course_id,
    next_number,
    requested_revision_kind,
    command_id,
    auth.uid(),
    requested_audit_note,
    rollback_target_number,
    new_hash,
    course_snapshot,
    'course-revision:' || command_id || ':' || next_number::text
  );

  update public.course_revision_heads
  set current_revision_number = next_number,
      current_revision_id = new_revision_id,
      record_version = head.record_version + 1,
      updated_at = clock_timestamp()
  where tenant_id = target_tenant_id
    and course_id = target_course_id
    and record_version = head.record_version;
  if not found then
    raise serialization_failure
      using message = 'Course revision head changed concurrently';
  end if;

  return jsonb_build_object(
    'revisionId', new_revision_id,
    'revisionNumber', next_number,
    'revisionKind', requested_revision_kind,
    'contentHash', new_hash,
    'beforeHash', prior_hash
  );
end;
$$;

-- Locks the owning course row and rejects a stale expected_version. The course
-- record_version is the single optimistic-concurrency token for the whole
-- authored tree, so every child mutation must pass through here first.
create or replace function app_private.authoring_lock_course(
  target_tenant_id uuid,
  target_course_id uuid,
  expected_version bigint
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  observed_version bigint;
begin
  select c.record_version
  into observed_version
  from public.courses c
  where c.tenant_id = target_tenant_id
    and c.course_id = target_course_id
    and c.deleted_at is null
  for update;
  if not found then
    raise no_data_found using message = 'Course was not found in this tenant';
  end if;
  if expected_version is null or observed_version <> expected_version then
    raise serialization_failure
      using message = 'Course was modified by another editor';
  end if;
  return observed_version;
end;
$$;

-- Advances the concurrency token exactly once per accepted mutation. The
-- existing courses_set_version trigger performs the increment.
create or replace function app_private.authoring_bump_course(
  target_tenant_id uuid,
  target_course_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  next_version bigint;
begin
  update public.courses
  set updated_at = clock_timestamp()
  where tenant_id = target_tenant_id
    and course_id = target_course_id
    and deleted_at is null
  returning record_version into next_version;
  if next_version is null then
    raise no_data_found using message = 'Course was not found in this tenant';
  end if;
  return next_version;
end;
$$;

-- Shared shape for every authoring RPC response.
create or replace function app_private.authoring_result(
  new_version bigint,
  revision jsonb,
  extra jsonb
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'recordVersion', new_version,
    'revision', revision
  ) || coalesce(extra, '{}'::jsonb);
$$;

create or replace function app_private.authoring_begin(
  target_tenant_id uuid,
  command_scope text,
  command_idempotency_key text,
  fingerprint_material text,
  command_name text
)
returns table (
  command_state text,
  prior_result jsonb
)
language sql
security definer
set search_path = pg_catalog
as $$
  select c.command_state, c.prior_result
  from app_private.onboarding_begin_command(
    target_tenant_id,
    command_scope,
    command_idempotency_key,
    encode(extensions.digest(fingerprint_material, 'sha256'), 'hex'),
    command_name
  ) c;
$$;

create or replace function app_private.authoring_valid_key(
  candidate text
)
returns boolean
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select candidate is not null and length(candidate) between 8 and 200;
$$;

-- ---------------------------------------------------------------------------
-- Course
-- ---------------------------------------------------------------------------

create or replace function public.learning_update_course(
  target_course_id uuid,
  requested_title text,
  requested_description text,
  expected_version bigint,
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
  next_version bigint;
  revision jsonb;
  result jsonb;
begin
  select * into caller from app_private.authoring_rpc_context();
  if not found then
    raise insufficient_privilege using message = 'Author access is required';
  end if;
  if target_course_id is null
    or not app_private.authoring_valid_key(idempotency_key)
    or (
      requested_title is not null
      and length(btrim(requested_title)) not between 3 and 160
    )
    or (
      requested_description is not null
      and length(btrim(requested_description)) > 2000
    )
  then
    raise invalid_parameter_value using message = 'Invalid course update';
  end if;

  select * into command from app_private.authoring_begin(
    caller.tenant_id,
    'learning.course.update',
    idempotency_key,
    target_course_id::text || chr(31) || coalesce(requested_title, '') ||
      chr(31) || coalesce(requested_description, ''),
    'learning_update_course'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    raise unique_violation using message = 'Idempotency key conflict';
  end if;

  perform app_private.authoring_lock_course(
    caller.tenant_id,
    target_course_id,
    expected_version
  );

  update public.courses
  set title = coalesce(nullif(btrim(requested_title), ''), title),
      description = case
        when requested_description is null then description
        else nullif(btrim(requested_description), '')
      end
  where tenant_id = caller.tenant_id
    and course_id = target_course_id
    and deleted_at is null
  returning record_version into next_version;

  revision := app_private.authoring_commit_revision(
    caller.tenant_id, target_course_id, 'edited', idempotency_key,
    'learning_update_course', null
  );
  perform app_private.authoring_append_audit(
    caller.tenant_id, caller.actor_type, caller.identity_role,
    'learning.course.update', target_course_id::text, idempotency_key,
    revision ->> 'beforeHash', revision ->> 'contentHash',
    revision ->> 'revisionId'
  );

  result := app_private.authoring_result(
    next_version,
    revision,
    jsonb_build_object('courseId', target_course_id)
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id, 'learning.course.update', idempotency_key, result
  );
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Modules
-- ---------------------------------------------------------------------------

create or replace function public.learning_create_module(
  target_course_id uuid,
  requested_title text,
  expected_version bigint,
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
  next_version bigint;
  new_module_id uuid := gen_random_uuid();
  new_position integer;
  revision jsonb;
  result jsonb;
begin
  select * into caller from app_private.authoring_rpc_context();
  if not found then
    raise insufficient_privilege using message = 'Author access is required';
  end if;
  if target_course_id is null
    or requested_title is null
    or length(btrim(requested_title)) not between 3 and 160
    or not app_private.authoring_valid_key(idempotency_key)
  then
    raise invalid_parameter_value using message = 'Invalid module request';
  end if;

  select * into command from app_private.authoring_begin(
    caller.tenant_id,
    'learning.module.create',
    idempotency_key,
    target_course_id::text || chr(31) || btrim(requested_title),
    'learning_create_module'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    raise unique_violation using message = 'Idempotency key conflict';
  end if;

  perform app_private.authoring_lock_course(
    caller.tenant_id, target_course_id, expected_version
  );

  select coalesce(max(m.position), -1) + 1
  into new_position
  from public.modules m
  where m.tenant_id = caller.tenant_id
    and m.course_id = target_course_id;

  insert into public.modules (
    module_id, tenant_id, course_id, title, position, status, metadata,
    idempotency_key
  ) values (
    new_module_id, caller.tenant_id, target_course_id, btrim(requested_title),
    new_position, 'draft',
    jsonb_build_object('source', 'authenticated_authoring'),
    'module:' || idempotency_key
  );

  next_version := app_private.authoring_bump_course(
    caller.tenant_id, target_course_id
  );

  revision := app_private.authoring_commit_revision(
    caller.tenant_id, target_course_id, 'edited', idempotency_key,
    'learning_create_module', null
  );
  perform app_private.authoring_append_audit(
    caller.tenant_id, caller.actor_type, caller.identity_role,
    'learning.module.create', target_course_id::text, idempotency_key,
    revision ->> 'beforeHash', revision ->> 'contentHash',
    revision ->> 'revisionId'
  );

  result := app_private.authoring_result(
    next_version,
    revision,
    jsonb_build_object(
      'courseId', target_course_id,
      'moduleId', new_module_id,
      'position', new_position,
      'status', 'draft'
    )
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id, 'learning.module.create', idempotency_key, result
  );
  return result;
end;
$$;

create or replace function public.learning_update_module(
  target_module_id uuid,
  requested_title text,
  requested_status text,
  expected_version bigint,
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
  resolved_course_id uuid;
  next_version bigint;
  revision jsonb;
  result jsonb;
begin
  select * into caller from app_private.authoring_rpc_context();
  if not found then
    raise insufficient_privilege using message = 'Author access is required';
  end if;
  if target_module_id is null
    or not app_private.authoring_valid_key(idempotency_key)
    or (
      requested_title is not null
      and length(btrim(requested_title)) not between 3 and 160
    )
    or (
      requested_status is not null
      and requested_status not in ('draft', 'published', 'archived')
    )
  then
    raise invalid_parameter_value using message = 'Invalid module update';
  end if;

  select m.course_id
  into resolved_course_id
  from public.modules m
  where m.tenant_id = caller.tenant_id
    and m.module_id = target_module_id
    and m.deleted_at is null;
  if not found then
    raise no_data_found using message = 'Module was not found in this tenant';
  end if;

  select * into command from app_private.authoring_begin(
    caller.tenant_id,
    'learning.module.update',
    idempotency_key,
    target_module_id::text || chr(31) || coalesce(requested_title, '') ||
      chr(31) || coalesce(requested_status, ''),
    'learning_update_module'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    raise unique_violation using message = 'Idempotency key conflict';
  end if;

  perform app_private.authoring_lock_course(
    caller.tenant_id, resolved_course_id, expected_version
  );

  update public.modules
  set title = coalesce(nullif(btrim(requested_title), ''), title),
      status = coalesce(requested_status, status)
  where tenant_id = caller.tenant_id
    and module_id = target_module_id
    and deleted_at is null;

  next_version := app_private.authoring_bump_course(
    caller.tenant_id, resolved_course_id
  );

  revision := app_private.authoring_commit_revision(
    caller.tenant_id, resolved_course_id, 'edited', idempotency_key,
    'learning_update_module', null
  );
  perform app_private.authoring_append_audit(
    caller.tenant_id, caller.actor_type, caller.identity_role,
    'learning.module.update', resolved_course_id::text, idempotency_key,
    revision ->> 'beforeHash', revision ->> 'contentHash',
    revision ->> 'revisionId'
  );

  result := app_private.authoring_result(
    next_version,
    revision,
    jsonb_build_object(
      'courseId', resolved_course_id,
      'moduleId', target_module_id
    )
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id, 'learning.module.update', idempotency_key, result
  );
  return result;
end;
$$;

create or replace function public.learning_delete_module(
  target_module_id uuid,
  expected_version bigint,
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
  resolved_course_id uuid;
  next_version bigint;
  removed_at timestamptz := clock_timestamp();
  revision jsonb;
  result jsonb;
begin
  select * into caller from app_private.authoring_rpc_context();
  if not found then
    raise insufficient_privilege using message = 'Author access is required';
  end if;
  if target_module_id is null
    or not app_private.authoring_valid_key(idempotency_key)
  then
    raise invalid_parameter_value using message = 'Invalid module removal';
  end if;

  select m.course_id
  into resolved_course_id
  from public.modules m
  where m.tenant_id = caller.tenant_id
    and m.module_id = target_module_id
    and m.deleted_at is null;
  if not found then
    raise no_data_found using message = 'Module was not found in this tenant';
  end if;

  select * into command from app_private.authoring_begin(
    caller.tenant_id,
    'learning.module.delete',
    idempotency_key,
    target_module_id::text,
    'learning_delete_module'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    raise unique_violation using message = 'Idempotency key conflict';
  end if;

  perform app_private.authoring_lock_course(
    caller.tenant_id, resolved_course_id, expected_version
  );

  update public.content_blocks
  set deleted_at = removed_at
  where tenant_id = caller.tenant_id
    and deleted_at is null
    and lesson_id in (
      select l.lesson_id
      from public.lessons l
      where l.tenant_id = caller.tenant_id
        and l.module_id = target_module_id
    );
  update public.lessons
  set deleted_at = removed_at
  where tenant_id = caller.tenant_id
    and module_id = target_module_id
    and deleted_at is null;
  update public.modules
  set deleted_at = removed_at
  where tenant_id = caller.tenant_id
    and module_id = target_module_id
    and deleted_at is null;

  next_version := app_private.authoring_bump_course(
    caller.tenant_id, resolved_course_id
  );

  revision := app_private.authoring_commit_revision(
    caller.tenant_id, resolved_course_id, 'edited', idempotency_key,
    'learning_delete_module', null
  );
  perform app_private.authoring_append_audit(
    caller.tenant_id, caller.actor_type, caller.identity_role,
    'learning.module.delete', resolved_course_id::text, idempotency_key,
    revision ->> 'beforeHash', revision ->> 'contentHash',
    revision ->> 'revisionId'
  );

  result := app_private.authoring_result(
    next_version,
    revision,
    jsonb_build_object(
      'courseId', resolved_course_id,
      'moduleId', target_module_id,
      'deleted', true
    )
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id, 'learning.module.delete', idempotency_key, result
  );
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lessons
-- ---------------------------------------------------------------------------

create or replace function public.learning_create_lesson(
  target_module_id uuid,
  requested_title text,
  requested_content text,
  expected_version bigint,
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
  resolved_course_id uuid;
  next_version bigint;
  new_lesson_id uuid := gen_random_uuid();
  new_position integer;
  revision jsonb;
  result jsonb;
begin
  select * into caller from app_private.authoring_rpc_context();
  if not found then
    raise insufficient_privilege using message = 'Author access is required';
  end if;
  if target_module_id is null
    or requested_title is null
    or length(btrim(requested_title)) not between 3 and 160
    or not app_private.authoring_valid_key(idempotency_key)
    or (
      requested_content is not null
      and length(btrim(requested_content)) not between 1 and 50000
    )
  then
    raise invalid_parameter_value using message = 'Invalid lesson request';
  end if;

  select m.course_id
  into resolved_course_id
  from public.modules m
  where m.tenant_id = caller.tenant_id
    and m.module_id = target_module_id
    and m.deleted_at is null;
  if not found then
    raise no_data_found using message = 'Module was not found in this tenant';
  end if;

  select * into command from app_private.authoring_begin(
    caller.tenant_id,
    'learning.lesson.create',
    idempotency_key,
    target_module_id::text || chr(31) || btrim(requested_title) || chr(31) ||
      coalesce(btrim(requested_content), ''),
    'learning_create_lesson'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    raise unique_violation using message = 'Idempotency key conflict';
  end if;

  perform app_private.authoring_lock_course(
    caller.tenant_id, resolved_course_id, expected_version
  );

  select coalesce(max(l.position), -1) + 1
  into new_position
  from public.lessons l
  where l.tenant_id = caller.tenant_id
    and l.module_id = target_module_id;

  insert into public.lessons (
    lesson_id, tenant_id, course_id, module_id, title, position, status,
    metadata, idempotency_key
  ) values (
    new_lesson_id, caller.tenant_id, resolved_course_id, target_module_id,
    btrim(requested_title), new_position, 'draft',
    jsonb_build_object('source', 'authenticated_authoring'),
    'lesson:' || idempotency_key
  );

  if requested_content is not null then
    insert into public.content_blocks (
      tenant_id, course_id, lesson_id, block_type, position, content,
      content_hash, idempotency_key
    ) values (
      caller.tenant_id,
      resolved_course_id,
      new_lesson_id,
      'rich_text',
      0,
      jsonb_build_object(
        'text', btrim(requested_content),
        'format', 'plain_text'
      ),
      encode(
        extensions.digest(btrim(requested_content), 'sha256'),
        'hex'
      ),
      'content:' || idempotency_key
    );
  end if;

  next_version := app_private.authoring_bump_course(
    caller.tenant_id, resolved_course_id
  );

  revision := app_private.authoring_commit_revision(
    caller.tenant_id, resolved_course_id, 'edited', idempotency_key,
    'learning_create_lesson', null
  );
  perform app_private.authoring_append_audit(
    caller.tenant_id, caller.actor_type, caller.identity_role,
    'learning.lesson.create', resolved_course_id::text, idempotency_key,
    revision ->> 'beforeHash', revision ->> 'contentHash',
    revision ->> 'revisionId'
  );

  result := app_private.authoring_result(
    next_version,
    revision,
    jsonb_build_object(
      'courseId', resolved_course_id,
      'moduleId', target_module_id,
      'lessonId', new_lesson_id,
      'position', new_position,
      'status', 'draft'
    )
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id, 'learning.lesson.create', idempotency_key, result
  );
  return result;
end;
$$;

create or replace function public.learning_update_lesson(
  target_lesson_id uuid,
  requested_title text,
  requested_status text,
  expected_version bigint,
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
  resolved_course_id uuid;
  next_version bigint;
  revision jsonb;
  result jsonb;
begin
  select * into caller from app_private.authoring_rpc_context();
  if not found then
    raise insufficient_privilege using message = 'Author access is required';
  end if;
  if target_lesson_id is null
    or not app_private.authoring_valid_key(idempotency_key)
    or (
      requested_title is not null
      and length(btrim(requested_title)) not between 3 and 160
    )
    or (
      requested_status is not null
      and requested_status not in ('draft', 'published', 'archived')
    )
  then
    raise invalid_parameter_value using message = 'Invalid lesson update';
  end if;

  select l.course_id
  into resolved_course_id
  from public.lessons l
  where l.tenant_id = caller.tenant_id
    and l.lesson_id = target_lesson_id
    and l.deleted_at is null;
  if not found then
    raise no_data_found using message = 'Lesson was not found in this tenant';
  end if;

  select * into command from app_private.authoring_begin(
    caller.tenant_id,
    'learning.lesson.update',
    idempotency_key,
    target_lesson_id::text || chr(31) || coalesce(requested_title, '') ||
      chr(31) || coalesce(requested_status, ''),
    'learning_update_lesson'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    raise unique_violation using message = 'Idempotency key conflict';
  end if;

  perform app_private.authoring_lock_course(
    caller.tenant_id, resolved_course_id, expected_version
  );

  update public.lessons
  set title = coalesce(nullif(btrim(requested_title), ''), title),
      status = coalesce(requested_status, status)
  where tenant_id = caller.tenant_id
    and lesson_id = target_lesson_id
    and deleted_at is null;

  next_version := app_private.authoring_bump_course(
    caller.tenant_id, resolved_course_id
  );

  revision := app_private.authoring_commit_revision(
    caller.tenant_id, resolved_course_id, 'edited', idempotency_key,
    'learning_update_lesson', null
  );
  perform app_private.authoring_append_audit(
    caller.tenant_id, caller.actor_type, caller.identity_role,
    'learning.lesson.update', resolved_course_id::text, idempotency_key,
    revision ->> 'beforeHash', revision ->> 'contentHash',
    revision ->> 'revisionId'
  );

  result := app_private.authoring_result(
    next_version,
    revision,
    jsonb_build_object(
      'courseId', resolved_course_id,
      'lessonId', target_lesson_id
    )
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id, 'learning.lesson.update', idempotency_key, result
  );
  return result;
end;
$$;

create or replace function public.learning_delete_lesson(
  target_lesson_id uuid,
  expected_version bigint,
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
  resolved_course_id uuid;
  next_version bigint;
  removed_at timestamptz := clock_timestamp();
  revision jsonb;
  result jsonb;
begin
  select * into caller from app_private.authoring_rpc_context();
  if not found then
    raise insufficient_privilege using message = 'Author access is required';
  end if;
  if target_lesson_id is null
    or not app_private.authoring_valid_key(idempotency_key)
  then
    raise invalid_parameter_value using message = 'Invalid lesson removal';
  end if;

  select l.course_id
  into resolved_course_id
  from public.lessons l
  where l.tenant_id = caller.tenant_id
    and l.lesson_id = target_lesson_id
    and l.deleted_at is null;
  if not found then
    raise no_data_found using message = 'Lesson was not found in this tenant';
  end if;

  select * into command from app_private.authoring_begin(
    caller.tenant_id,
    'learning.lesson.delete',
    idempotency_key,
    target_lesson_id::text,
    'learning_delete_lesson'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    raise unique_violation using message = 'Idempotency key conflict';
  end if;

  perform app_private.authoring_lock_course(
    caller.tenant_id, resolved_course_id, expected_version
  );

  update public.content_blocks
  set deleted_at = removed_at
  where tenant_id = caller.tenant_id
    and lesson_id = target_lesson_id
    and deleted_at is null;
  update public.lessons
  set deleted_at = removed_at
  where tenant_id = caller.tenant_id
    and lesson_id = target_lesson_id
    and deleted_at is null;

  next_version := app_private.authoring_bump_course(
    caller.tenant_id, resolved_course_id
  );

  revision := app_private.authoring_commit_revision(
    caller.tenant_id, resolved_course_id, 'edited', idempotency_key,
    'learning_delete_lesson', null
  );
  perform app_private.authoring_append_audit(
    caller.tenant_id, caller.actor_type, caller.identity_role,
    'learning.lesson.delete', resolved_course_id::text, idempotency_key,
    revision ->> 'beforeHash', revision ->> 'contentHash',
    revision ->> 'revisionId'
  );

  result := app_private.authoring_result(
    next_version,
    revision,
    jsonb_build_object(
      'courseId', resolved_course_id,
      'lessonId', target_lesson_id,
      'deleted', true
    )
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id, 'learning.lesson.delete', idempotency_key, result
  );
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Content blocks
-- ---------------------------------------------------------------------------

create or replace function app_private.authoring_valid_block(
  requested_block_type text,
  requested_content jsonb
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select requested_block_type in (
      'rich_text', 'heading', 'callout', 'code', 'quote', 'list', 'divider'
    )
    and jsonb_typeof(requested_content) = 'object'
    and length(requested_content::text) <= 100000
    and (
      requested_block_type <> 'rich_text'
      or (
        jsonb_typeof(requested_content -> 'text') = 'string'
        and length(btrim(requested_content ->> 'text')) between 1 and 50000
      )
    );
$$;

create or replace function public.learning_create_content_block(
  target_lesson_id uuid,
  requested_block_type text,
  requested_content jsonb,
  expected_version bigint,
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
  resolved_course_id uuid;
  next_version bigint;
  new_block_id uuid := gen_random_uuid();
  new_position integer;
  revision jsonb;
  result jsonb;
begin
  select * into caller from app_private.authoring_rpc_context();
  if not found then
    raise insufficient_privilege using message = 'Author access is required';
  end if;
  if target_lesson_id is null
    or not app_private.authoring_valid_key(idempotency_key)
    or not app_private.authoring_valid_block(
      requested_block_type, requested_content
    )
  then
    raise invalid_parameter_value using message = 'Invalid content block';
  end if;

  select l.course_id
  into resolved_course_id
  from public.lessons l
  where l.tenant_id = caller.tenant_id
    and l.lesson_id = target_lesson_id
    and l.deleted_at is null;
  if not found then
    raise no_data_found using message = 'Lesson was not found in this tenant';
  end if;

  select * into command from app_private.authoring_begin(
    caller.tenant_id,
    'learning.block.create',
    idempotency_key,
    target_lesson_id::text || chr(31) || requested_block_type || chr(31) ||
      requested_content::text,
    'learning_create_content_block'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    raise unique_violation using message = 'Idempotency key conflict';
  end if;

  perform app_private.authoring_lock_course(
    caller.tenant_id, resolved_course_id, expected_version
  );

  select coalesce(max(cb.position), -1) + 1
  into new_position
  from public.content_blocks cb
  where cb.tenant_id = caller.tenant_id
    and cb.lesson_id = target_lesson_id;

  insert into public.content_blocks (
    content_block_id, tenant_id, course_id, lesson_id, block_type, position,
    content, content_hash, idempotency_key
  ) values (
    new_block_id,
    caller.tenant_id,
    resolved_course_id,
    target_lesson_id,
    requested_block_type,
    new_position,
    requested_content,
    encode(extensions.digest(requested_content::text, 'sha256'), 'hex'),
    'block:' || idempotency_key
  );

  next_version := app_private.authoring_bump_course(
    caller.tenant_id, resolved_course_id
  );

  revision := app_private.authoring_commit_revision(
    caller.tenant_id, resolved_course_id, 'edited', idempotency_key,
    'learning_create_content_block', null
  );
  perform app_private.authoring_append_audit(
    caller.tenant_id, caller.actor_type, caller.identity_role,
    'learning.block.create', resolved_course_id::text, idempotency_key,
    revision ->> 'beforeHash', revision ->> 'contentHash',
    revision ->> 'revisionId'
  );

  result := app_private.authoring_result(
    next_version,
    revision,
    jsonb_build_object(
      'courseId', resolved_course_id,
      'lessonId', target_lesson_id,
      'contentBlockId', new_block_id,
      'position', new_position
    )
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id, 'learning.block.create', idempotency_key, result
  );
  return result;
end;
$$;

create or replace function public.learning_update_content_block(
  target_content_block_id uuid,
  requested_block_type text,
  requested_content jsonb,
  expected_version bigint,
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
  block record;
  next_version bigint;
  revision jsonb;
  result jsonb;
begin
  select * into caller from app_private.authoring_rpc_context();
  if not found then
    raise insufficient_privilege using message = 'Author access is required';
  end if;
  if target_content_block_id is null
    or not app_private.authoring_valid_key(idempotency_key)
    or not app_private.authoring_valid_block(
      requested_block_type, requested_content
    )
  then
    raise invalid_parameter_value using message = 'Invalid content block';
  end if;

  select cb.course_id as course_id, cb.lesson_id as lesson_id
  into block
  from public.content_blocks cb
  where cb.tenant_id = caller.tenant_id
    and cb.content_block_id = target_content_block_id
    and cb.deleted_at is null;
  if not found then
    raise no_data_found using message = 'Content block was not found';
  end if;

  select * into command from app_private.authoring_begin(
    caller.tenant_id,
    'learning.block.update',
    idempotency_key,
    target_content_block_id::text || chr(31) || requested_block_type ||
      chr(31) || requested_content::text,
    'learning_update_content_block'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    raise unique_violation using message = 'Idempotency key conflict';
  end if;

  perform app_private.authoring_lock_course(
    caller.tenant_id, block.course_id, expected_version
  );

  update public.content_blocks
  set block_type = requested_block_type,
      content = requested_content,
      content_hash = encode(
        extensions.digest(requested_content::text, 'sha256'),
        'hex'
      )
  where tenant_id = caller.tenant_id
    and content_block_id = target_content_block_id
    and deleted_at is null;

  next_version := app_private.authoring_bump_course(
    caller.tenant_id, block.course_id
  );

  revision := app_private.authoring_commit_revision(
    caller.tenant_id, block.course_id, 'edited', idempotency_key,
    'learning_update_content_block', null
  );
  perform app_private.authoring_append_audit(
    caller.tenant_id, caller.actor_type, caller.identity_role,
    'learning.block.update', block.course_id::text, idempotency_key,
    revision ->> 'beforeHash', revision ->> 'contentHash',
    revision ->> 'revisionId'
  );

  result := app_private.authoring_result(
    next_version,
    revision,
    jsonb_build_object(
      'courseId', block.course_id,
      'lessonId', block.lesson_id,
      'contentBlockId', target_content_block_id
    )
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id, 'learning.block.update', idempotency_key, result
  );
  return result;
end;
$$;

create or replace function public.learning_delete_content_block(
  target_content_block_id uuid,
  expected_version bigint,
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
  block record;
  next_version bigint;
  revision jsonb;
  result jsonb;
begin
  select * into caller from app_private.authoring_rpc_context();
  if not found then
    raise insufficient_privilege using message = 'Author access is required';
  end if;
  if target_content_block_id is null
    or not app_private.authoring_valid_key(idempotency_key)
  then
    raise invalid_parameter_value using message = 'Invalid block removal';
  end if;

  select cb.course_id as course_id, cb.lesson_id as lesson_id
  into block
  from public.content_blocks cb
  where cb.tenant_id = caller.tenant_id
    and cb.content_block_id = target_content_block_id
    and cb.deleted_at is null;
  if not found then
    raise no_data_found using message = 'Content block was not found';
  end if;

  select * into command from app_private.authoring_begin(
    caller.tenant_id,
    'learning.block.delete',
    idempotency_key,
    target_content_block_id::text,
    'learning_delete_content_block'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    raise unique_violation using message = 'Idempotency key conflict';
  end if;

  perform app_private.authoring_lock_course(
    caller.tenant_id, block.course_id, expected_version
  );

  update public.content_blocks
  set deleted_at = clock_timestamp()
  where tenant_id = caller.tenant_id
    and content_block_id = target_content_block_id
    and deleted_at is null;

  next_version := app_private.authoring_bump_course(
    caller.tenant_id, block.course_id
  );

  revision := app_private.authoring_commit_revision(
    caller.tenant_id, block.course_id, 'edited', idempotency_key,
    'learning_delete_content_block', null
  );
  perform app_private.authoring_append_audit(
    caller.tenant_id, caller.actor_type, caller.identity_role,
    'learning.block.delete', block.course_id::text, idempotency_key,
    revision ->> 'beforeHash', revision ->> 'contentHash',
    revision ->> 'revisionId'
  );

  result := app_private.authoring_result(
    next_version,
    revision,
    jsonb_build_object(
      'courseId', block.course_id,
      'lessonId', block.lesson_id,
      'contentBlockId', target_content_block_id,
      'deleted', true
    )
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id, 'learning.block.delete', idempotency_key, result
  );
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reorder
-- ---------------------------------------------------------------------------

-- One entrypoint for module order inside a course and lesson order inside a
-- module. Positions are rewritten in two disjoint phases inside a single
-- statement pair so `(tenant_id, course_id, position)` and
-- `(tenant_id, module_id, position)` never observe a duplicate. Soft-deleted
-- siblings keep unique positions immediately after the live ones.
create or replace function public.learning_reorder(
  parent_kind text,
  target_parent_id uuid,
  ordered_ids uuid[],
  expected_version bigint,
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
  resolved_course_id uuid;
  next_version bigint;
  offset_step integer := app_private.authoring_position_offset();
  live_count integer;
  requested_count integer;
  distinct_count integer;
  max_position integer;
  revision jsonb;
  result jsonb;
begin
  select * into caller from app_private.authoring_rpc_context();
  if not found then
    raise insufficient_privilege using message = 'Author access is required';
  end if;
  if parent_kind is null
    or parent_kind not in ('course', 'module')
    or target_parent_id is null
    or ordered_ids is null
    or array_length(ordered_ids, 1) is null
    or array_length(ordered_ids, 1) > 1000
    or not app_private.authoring_valid_key(idempotency_key)
  then
    raise invalid_parameter_value using message = 'Invalid reorder request';
  end if;

  requested_count := array_length(ordered_ids, 1);
  select count(distinct requested.child_id)::integer
  into distinct_count
  from unnest(ordered_ids) as requested(child_id);
  if distinct_count <> requested_count then
    raise invalid_parameter_value
      using message = 'Reorder contains duplicate identifiers';
  end if;

  if parent_kind = 'course' then
    select c.course_id
    into resolved_course_id
    from public.courses c
    where c.tenant_id = caller.tenant_id
      and c.course_id = target_parent_id
      and c.deleted_at is null;
    if not found then
      raise no_data_found using message = 'Course was not found in this tenant';
    end if;
    select
      (count(*) filter (where m.deleted_at is null))::integer,
      coalesce(max(m.position), 0)
    into live_count, max_position
    from public.modules m
    where m.tenant_id = caller.tenant_id
      and m.course_id = target_parent_id;
    if live_count <> requested_count
      or exists (
        select 1
        from unnest(ordered_ids) as requested(child_id)
        where not exists (
          select 1
          from public.modules m
          where m.tenant_id = caller.tenant_id
            and m.course_id = target_parent_id
            and m.module_id = requested.child_id
            and m.deleted_at is null
        )
      )
    then
      raise invalid_parameter_value
        using message = 'Reorder must list every live module exactly once';
    end if;
  else
    select m.course_id
    into resolved_course_id
    from public.modules m
    where m.tenant_id = caller.tenant_id
      and m.module_id = target_parent_id
      and m.deleted_at is null;
    if not found then
      raise no_data_found using message = 'Module was not found in this tenant';
    end if;
    select
      (count(*) filter (where l.deleted_at is null))::integer,
      coalesce(max(l.position), 0)
    into live_count, max_position
    from public.lessons l
    where l.tenant_id = caller.tenant_id
      and l.module_id = target_parent_id;
    if live_count <> requested_count
      or exists (
        select 1
        from unnest(ordered_ids) as requested(child_id)
        where not exists (
          select 1
          from public.lessons l
          where l.tenant_id = caller.tenant_id
            and l.module_id = target_parent_id
            and l.lesson_id = requested.child_id
            and l.deleted_at is null
        )
      )
    then
      raise invalid_parameter_value
        using message = 'Reorder must list every live lesson exactly once';
    end if;
  end if;

  if max_position >= offset_step then
    raise check_violation
      using message = 'Position space is exhausted for this parent';
  end if;

  select * into command from app_private.authoring_begin(
    caller.tenant_id,
    'learning.reorder',
    idempotency_key,
    parent_kind || chr(31) || target_parent_id::text || chr(31) ||
      array_to_string(ordered_ids, ','),
    'learning_reorder'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    raise unique_violation using message = 'Idempotency key conflict';
  end if;

  perform app_private.authoring_lock_course(
    caller.tenant_id, resolved_course_id, expected_version
  );

  if parent_kind = 'course' then
    -- Phase one: move every sibling into a disjoint position range.
    update public.modules
    set position = position + offset_step
    where tenant_id = caller.tenant_id
      and course_id = target_parent_id;
    -- Phase two: compact live siblings into the requested order, then the
    -- soft-deleted siblings, back into [0, sibling_count).
    update public.modules m
    set position = ordered.new_position
    from (
      select
        candidate.module_id,
        (
          row_number() over (
            order by
              case when candidate.deleted_at is null then 0 else 1 end,
              coalesce(
                array_position(ordered_ids, candidate.module_id),
                2147483647
              ),
              candidate.position,
              candidate.module_id
          ) - 1
        )::integer as new_position
      from public.modules candidate
      where candidate.tenant_id = caller.tenant_id
        and candidate.course_id = target_parent_id
    ) as ordered
    where m.tenant_id = caller.tenant_id
      and m.module_id = ordered.module_id;
  else
    update public.lessons
    set position = position + offset_step
    where tenant_id = caller.tenant_id
      and module_id = target_parent_id;
    update public.lessons l
    set position = ordered.new_position
    from (
      select
        candidate.lesson_id,
        (
          row_number() over (
            order by
              case when candidate.deleted_at is null then 0 else 1 end,
              coalesce(
                array_position(ordered_ids, candidate.lesson_id),
                2147483647
              ),
              candidate.position,
              candidate.lesson_id
          ) - 1
        )::integer as new_position
      from public.lessons candidate
      where candidate.tenant_id = caller.tenant_id
        and candidate.module_id = target_parent_id
    ) as ordered
    where l.tenant_id = caller.tenant_id
      and l.lesson_id = ordered.lesson_id;
  end if;

  next_version := app_private.authoring_bump_course(
    caller.tenant_id, resolved_course_id
  );

  revision := app_private.authoring_commit_revision(
    caller.tenant_id, resolved_course_id, 'edited', idempotency_key,
    'learning_reorder', null
  );
  perform app_private.authoring_append_audit(
    caller.tenant_id, caller.actor_type, caller.identity_role,
    'learning.reorder', resolved_course_id::text, idempotency_key,
    revision ->> 'beforeHash', revision ->> 'contentHash',
    revision ->> 'revisionId'
  );

  result := app_private.authoring_result(
    next_version,
    revision,
    jsonb_build_object(
      'courseId', resolved_course_id,
      'parentKind', parent_kind,
      'parentId', target_parent_id,
      'orderedIds', to_jsonb(ordered_ids)
    )
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id, 'learning.reorder', idempotency_key, result
  );
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Revision history and rollback
-- ---------------------------------------------------------------------------

create or replace function public.learning_list_course_revisions(
  target_course_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  head record;
  items jsonb;
begin
  select * into caller from app_private.authoring_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if target_course_id is null
    or not exists (
      select 1
      from public.courses c
      where c.tenant_id = caller.tenant_id
        and c.course_id = target_course_id
        and c.deleted_at is null
    )
  then
    return jsonb_build_object('ok', false, 'code', 'course_not_found');
  end if;

  select
    h.current_revision_number as current_revision_number,
    h.current_revision_id as current_revision_id
  into head
  from public.course_revision_heads h
  where h.tenant_id = caller.tenant_id
    and h.course_id = target_course_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'revisionId', r.revision_id,
        'revisionNumber', r.revision_number,
        'revisionKind', r.revision_kind,
        'auditNote', r.audit_note,
        'contentHash', r.content_hash,
        'rollbackTargetRevisionNumber', r.rollback_target_revision_number,
        'createdAt', r.created_at
      )
      order by r.revision_number desc
    ),
    '[]'::jsonb
  )
  into items
  from public.course_revisions r
  where r.tenant_id = caller.tenant_id
    and r.course_id = target_course_id;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'courseId', target_course_id,
    'headRevisionId', head.current_revision_id,
    'headRevisionNumber', coalesce(head.current_revision_number, 0),
    'revisions', items
  );
end;
$$;

-- Restores the authored tree captured by an earlier immutable revision. No row
-- is ever hard deleted, so a rollback only has to restore, soft delete and
-- recompact positions; the restoration itself is appended as a new
-- `rolled_back` revision through the same compare-and-swap head.
create or replace function public.learning_rollback_course(
  target_course_id uuid,
  target_revision_id text,
  expected_version bigint,
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
  target record;
  next_version bigint;
  offset_step integer := app_private.authoring_position_offset();
  removed_at timestamptz := clock_timestamp();
  restored_snapshot jsonb;
  revision jsonb;
  result jsonb;
begin
  select * into caller from app_private.authoring_rpc_context();
  if not found then
    raise insufficient_privilege using message = 'Author access is required';
  end if;
  if target_course_id is null
    or target_revision_id is null
    or length(target_revision_id) not between 1 and 200
    or not app_private.authoring_valid_key(idempotency_key)
  then
    raise invalid_parameter_value using message = 'Invalid rollback request';
  end if;

  select
    r.revision_id as revision_id,
    r.revision_number as revision_number,
    r.snapshot as snapshot
  into target
  from public.course_revisions r
  where r.tenant_id = caller.tenant_id
    and r.course_id = target_course_id
    and r.revision_id = target_revision_id;
  if not found then
    raise no_data_found
      using message = 'Rollback target revision was not found';
  end if;

  select * into command from app_private.authoring_begin(
    caller.tenant_id,
    'learning.course.rollback',
    idempotency_key,
    target_course_id::text || chr(31) || target_revision_id,
    'learning_rollback_course'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    raise unique_violation using message = 'Idempotency key conflict';
  end if;

  perform app_private.authoring_lock_course(
    caller.tenant_id, target_course_id, expected_version
  );
  restored_snapshot := target.snapshot;

  update public.courses
  set title = restored_snapshot ->> 'title',
      description = restored_snapshot ->> 'description',
      status = restored_snapshot ->> 'status'
  where tenant_id = caller.tenant_id
    and course_id = target_course_id
    and deleted_at is null;

  -- Move every position of the course into a disjoint range first.
  update public.modules
  set position = position + offset_step
  where tenant_id = caller.tenant_id
    and course_id = target_course_id
    and position < offset_step;
  update public.lessons
  set position = position + offset_step
  where tenant_id = caller.tenant_id
    and course_id = target_course_id
    and position < offset_step;
  update public.content_blocks
  set position = position + offset_step
  where tenant_id = caller.tenant_id
    and course_id = target_course_id
    and position < offset_step;

  -- Restore everything the target revision held live.
  update public.modules m
  set title = snapshot_module.title,
      status = snapshot_module.status,
      position = snapshot_module.position,
      deleted_at = null
  from (
    select
      (module_value ->> 'moduleId')::uuid as module_id,
      module_value ->> 'title' as title,
      module_value ->> 'status' as status,
      (module_value ->> 'position')::integer as position
    from jsonb_array_elements(restored_snapshot -> 'modules') as module_value
  ) as snapshot_module
  where m.tenant_id = caller.tenant_id
    and m.course_id = target_course_id
    and m.module_id = snapshot_module.module_id;

  update public.lessons l
  set title = snapshot_lesson.title,
      status = snapshot_lesson.status,
      position = snapshot_lesson.position,
      deleted_at = null
  from (
    select
      (lesson_value ->> 'lessonId')::uuid as lesson_id,
      lesson_value ->> 'title' as title,
      lesson_value ->> 'status' as status,
      (lesson_value ->> 'position')::integer as position
    from jsonb_array_elements(restored_snapshot -> 'modules') as module_value
    cross join lateral jsonb_array_elements(
      module_value -> 'lessons'
    ) as lesson_value
  ) as snapshot_lesson
  where l.tenant_id = caller.tenant_id
    and l.course_id = target_course_id
    and l.lesson_id = snapshot_lesson.lesson_id;

  update public.content_blocks cb
  set block_type = snapshot_block.block_type,
      content = snapshot_block.content,
      content_hash = snapshot_block.content_hash,
      position = snapshot_block.position,
      deleted_at = null
  from (
    select
      (block_value ->> 'contentBlockId')::uuid as content_block_id,
      block_value ->> 'blockType' as block_type,
      block_value -> 'content' as content,
      block_value ->> 'contentHash' as content_hash,
      (block_value ->> 'position')::integer as position
    from jsonb_array_elements(restored_snapshot -> 'modules') as module_value
    cross join lateral jsonb_array_elements(
      module_value -> 'lessons'
    ) as lesson_value
    cross join lateral jsonb_array_elements(
      lesson_value -> 'blocks'
    ) as block_value
  ) as snapshot_block
  where cb.tenant_id = caller.tenant_id
    and cb.course_id = target_course_id
    and cb.content_block_id = snapshot_block.content_block_id;

  -- Anything the target revision did not hold live is removed again.
  update public.content_blocks
  set deleted_at = removed_at
  where tenant_id = caller.tenant_id
    and course_id = target_course_id
    and deleted_at is null
    and position >= offset_step;
  update public.lessons
  set deleted_at = removed_at
  where tenant_id = caller.tenant_id
    and course_id = target_course_id
    and deleted_at is null
    and position >= offset_step;
  update public.modules
  set deleted_at = removed_at
  where tenant_id = caller.tenant_id
    and course_id = target_course_id
    and deleted_at is null
    and position >= offset_step;

  -- Compact the removed siblings back behind the restored ones.
  update public.modules m
  set position = compacted.new_position
  from (
    select
      candidate.module_id,
      (
        (
          select count(*)
          from public.modules live
          where live.tenant_id = caller.tenant_id
            and live.course_id = target_course_id
            and live.position < offset_step
        )
        + row_number() over (
          order by candidate.position, candidate.module_id
        ) - 1
      )::integer as new_position
    from public.modules candidate
    where candidate.tenant_id = caller.tenant_id
      and candidate.course_id = target_course_id
      and candidate.position >= offset_step
  ) as compacted
  where m.tenant_id = caller.tenant_id
    and m.module_id = compacted.module_id;

  update public.lessons l
  set position = compacted.new_position
  from (
    select
      candidate.lesson_id,
      (
        (
          select count(*)
          from public.lessons live
          where live.tenant_id = caller.tenant_id
            and live.module_id = candidate.module_id
            and live.position < offset_step
        )
        + row_number() over (
          partition by candidate.module_id
          order by candidate.position, candidate.lesson_id
        ) - 1
      )::integer as new_position
    from public.lessons candidate
    where candidate.tenant_id = caller.tenant_id
      and candidate.course_id = target_course_id
      and candidate.position >= offset_step
  ) as compacted
  where l.tenant_id = caller.tenant_id
    and l.lesson_id = compacted.lesson_id;

  update public.content_blocks cb
  set position = compacted.new_position
  from (
    select
      candidate.content_block_id,
      (
        (
          select count(*)
          from public.content_blocks live
          where live.tenant_id = caller.tenant_id
            and live.lesson_id = candidate.lesson_id
            and live.position < offset_step
        )
        + row_number() over (
          partition by candidate.lesson_id
          order by candidate.position, candidate.content_block_id
        ) - 1
      )::integer as new_position
    from public.content_blocks candidate
    where candidate.tenant_id = caller.tenant_id
      and candidate.course_id = target_course_id
      and candidate.position >= offset_step
  ) as compacted
  where cb.tenant_id = caller.tenant_id
    and cb.content_block_id = compacted.content_block_id;

  select c.record_version into next_version
  from public.courses c
  where c.tenant_id = caller.tenant_id
    and c.course_id = target_course_id;

  revision := app_private.authoring_commit_revision(
    caller.tenant_id, target_course_id, 'rolled_back', idempotency_key,
    'learning_rollback_course', target.revision_number
  );
  perform app_private.authoring_append_audit(
    caller.tenant_id, caller.actor_type, caller.identity_role,
    'learning.course.rollback', target_course_id::text, idempotency_key,
    revision ->> 'beforeHash', revision ->> 'contentHash',
    revision ->> 'revisionId'
  );

  result := app_private.authoring_result(
    next_version,
    revision,
    jsonb_build_object(
      'courseId', target_course_id,
      'restoredRevisionId', target.revision_id,
      'restoredRevisionNumber', target.revision_number
    )
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id, 'learning.course.rollback', idempotency_key, result
  );
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Execution boundary. Private helpers stay server-only; the hosted service_role
-- inherits PUBLIC through its role graph, so it is revoked explicitly and only
-- an end-user authenticated connection may edit a course.
-- ---------------------------------------------------------------------------

revoke execute on function app_private.authoring_position_offset()
  from public, anon, authenticated, service_role;
revoke execute on function app_private.authoring_rpc_context()
  from public, anon, authenticated, service_role;
revoke execute on function app_private.authoring_course_snapshot(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke execute on function app_private.authoring_append_audit(
  uuid, text, text, text, text, text, text, text, text
) from public, anon, authenticated, service_role;
revoke execute on function app_private.authoring_commit_revision(
  uuid, uuid, text, text, text, bigint
) from public, anon, authenticated, service_role;
revoke execute on function app_private.authoring_lock_course(uuid, uuid, bigint)
  from public, anon, authenticated, service_role;
revoke execute on function app_private.authoring_bump_course(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke execute on function app_private.authoring_result(bigint, jsonb, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function app_private.authoring_begin(
  uuid, text, text, text, text
) from public, anon, authenticated, service_role;
revoke execute on function app_private.authoring_valid_key(text)
  from public, anon, authenticated, service_role;
revoke execute on function app_private.authoring_valid_block(text, jsonb)
  from public, anon, authenticated, service_role;

revoke execute on function public.learning_update_course(
  uuid, text, text, bigint, text
) from public, anon, service_role;
revoke execute on function public.learning_create_module(
  uuid, text, bigint, text
) from public, anon, service_role;
revoke execute on function public.learning_update_module(
  uuid, text, text, bigint, text
) from public, anon, service_role;
revoke execute on function public.learning_delete_module(uuid, bigint, text)
  from public, anon, service_role;
revoke execute on function public.learning_create_lesson(
  uuid, text, text, bigint, text
) from public, anon, service_role;
revoke execute on function public.learning_update_lesson(
  uuid, text, text, bigint, text
) from public, anon, service_role;
revoke execute on function public.learning_delete_lesson(uuid, bigint, text)
  from public, anon, service_role;
revoke execute on function public.learning_create_content_block(
  uuid, text, jsonb, bigint, text
) from public, anon, service_role;
revoke execute on function public.learning_update_content_block(
  uuid, text, jsonb, bigint, text
) from public, anon, service_role;
revoke execute on function public.learning_delete_content_block(
  uuid, bigint, text
) from public, anon, service_role;
revoke execute on function public.learning_reorder(
  text, uuid, uuid[], bigint, text
) from public, anon, service_role;
revoke execute on function public.learning_list_course_revisions(uuid)
  from public, anon, service_role;
revoke execute on function public.learning_rollback_course(
  uuid, text, bigint, text
) from public, anon, service_role;

grant execute on function public.learning_update_course(
  uuid, text, text, bigint, text
) to authenticated;
grant execute on function public.learning_create_module(
  uuid, text, bigint, text
) to authenticated;
grant execute on function public.learning_update_module(
  uuid, text, text, bigint, text
) to authenticated;
grant execute on function public.learning_delete_module(uuid, bigint, text)
  to authenticated;
grant execute on function public.learning_create_lesson(
  uuid, text, text, bigint, text
) to authenticated;
grant execute on function public.learning_update_lesson(
  uuid, text, text, bigint, text
) to authenticated;
grant execute on function public.learning_delete_lesson(uuid, bigint, text)
  to authenticated;
grant execute on function public.learning_create_content_block(
  uuid, text, jsonb, bigint, text
) to authenticated;
grant execute on function public.learning_update_content_block(
  uuid, text, jsonb, bigint, text
) to authenticated;
grant execute on function public.learning_delete_content_block(
  uuid, bigint, text
) to authenticated;
grant execute on function public.learning_reorder(
  text, uuid, uuid[], bigint, text
) to authenticated;
grant execute on function public.learning_list_course_revisions(uuid)
  to authenticated;
grant execute on function public.learning_rollback_course(
  uuid, text, bigint, text
) to authenticated;

commit;

-- RLS is intentionally deny-by-default. JWT tenant_id, sub and app_role must
-- be minted by a trusted server after membership verification.

begin;

create or replace function app_private.can_access_conversation(
  target_tenant_id uuid,
  target_conversation_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select app_private.is_tenant_context(target_tenant_id)
    and exists (
      select 1
      from public.conversations c
      where c.tenant_id = target_tenant_id
        and c.conversation_id = target_conversation_id
        and c.deleted_at is null
        and (
          app_private.has_any_role(array['owner', 'client_admin', 'system_worker'])
          or c.subject_user_id = app_private.current_actor_id()
        )
    );
$$;
revoke all on function app_private.can_access_conversation(uuid, uuid) from public;
grant execute on function app_private.can_access_conversation(uuid, uuid)
  to authenticated;

create or replace function app_private.can_read_lifecycle_record(
  target_tenant_id uuid,
  lifecycle_status text,
  lifecycle_deleted_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select app_private.is_tenant_context(target_tenant_id)
    and (
      app_private.has_any_role(array[
        'owner', 'client_admin', 'system_worker'
      ])
      or (
        lifecycle_deleted_at is null
        and app_private.has_any_role(array['client_viewer'])
      )
      or (
        lifecycle_deleted_at is null
        and lifecycle_status = 'published'
        and app_private.has_any_role(array['student'])
      )
    );
$$;
revoke all on function app_private.can_read_lifecycle_record(
  uuid, text, timestamptz
) from public;
grant execute on function app_private.can_read_lifecycle_record(
  uuid, text, timestamptz
) to authenticated;

-- Enable and force RLS on every application tenant table. FORCE also protects
-- table owners in ordinary sessions; PostgreSQL BYPASSRLS roles still bypass
-- RLS and therefore must remain server-only with explicit tenant predicates.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'tenants', 'roles', 'profiles', 'memberships', 'courses', 'modules', 'lessons',
    'content_blocks', 'learning_sources', 'ingestion_jobs',
    'ingestion_checkpoints', 'ingestion_issues', 'knowledge_versions',
    'learning_documents', 'learning_chunks', 'tenant_branding',
    'learning_context_mappings', 'student_progress', 'conversations',
    'messages', 'attachments', 'audit_ledger', 'cost_ledger',
    'mcp_grants', 'mcp_invocations'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
    execute format('revoke all on table public.%I from anon', table_name);
    execute format('revoke all on table public.%I from authenticated', table_name);
  end loop;
end $$;

-- Tenant and membership facts.
create policy tenants_select on public.tenants
  for select to authenticated
  using (app_private.can_read_tenant(tenant_id));
create policy tenants_update on public.tenants
  for update to authenticated
  using (app_private.is_tenant_admin(tenant_id))
  with check (app_private.is_tenant_admin(tenant_id));

create policy roles_select on public.roles
  for select to authenticated
  using (app_private.can_read_tenant(tenant_id));
create policy roles_manage on public.roles
  for all to authenticated
  using (app_private.is_system_worker(tenant_id))
  with check (app_private.is_system_worker(tenant_id));

create policy profiles_select on public.profiles
  for select to authenticated
  using (
    app_private.is_tenant_context(tenant_id)
    and (
      app_private.has_any_role(array['owner', 'client_admin', 'system_worker'])
      or user_id = app_private.current_actor_id()
    )
  );
create policy profiles_manage on public.profiles
  for all to authenticated
  using (app_private.can_manage_tenant(tenant_id))
  with check (app_private.can_manage_tenant(tenant_id));

create policy memberships_select on public.memberships
  for select to authenticated
  using (
    app_private.is_tenant_context(tenant_id)
    and (
      app_private.has_any_role(array['owner', 'client_admin', 'system_worker'])
      or user_id = app_private.current_actor_id()
    )
  );
create policy memberships_manage on public.memberships
  for all to authenticated
  using (
    app_private.is_tenant_context(tenant_id)
    and (
      app_private.has_any_role(array['owner'])
      or (
        app_private.has_any_role(array['client_admin'])
        and role_key not in ('owner', 'system_worker')
      )
    )
  )
  with check (
    app_private.is_tenant_context(tenant_id)
    and (
      app_private.has_any_role(array['owner'])
      or (
        app_private.has_any_role(array['client_admin'])
        and role_key not in ('owner', 'system_worker')
      )
    )
  );

-- Students see only published, non-deleted learning. Read-only tenant viewers
-- see non-deleted drafts; management roles can inspect lifecycle history.
create policy courses_select on public.courses
  for select to authenticated
  using (
    app_private.can_read_lifecycle_record(tenant_id, status, deleted_at)
  );
create policy modules_select on public.modules
  for select to authenticated
  using (
    app_private.can_read_lifecycle_record(tenant_id, status, deleted_at)
  );
create policy lessons_select on public.lessons
  for select to authenticated
  using (
    app_private.can_read_lifecycle_record(tenant_id, status, deleted_at)
  );
create policy content_blocks_select on public.content_blocks
  for select to authenticated
  using (
    app_private.can_manage_tenant(tenant_id)
    or (
      app_private.is_tenant_context(tenant_id)
      and deleted_at is null
      and app_private.has_any_role(array['client_viewer'])
    )
    or (
      app_private.is_tenant_context(tenant_id)
      and deleted_at is null
      and app_private.has_any_role(array['student'])
      and exists (
        select 1
        from public.lessons l
        where l.tenant_id = content_blocks.tenant_id
          and l.lesson_id = content_blocks.lesson_id
          and l.status = 'published'
          and l.deleted_at is null
      )
    )
  );

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'courses', 'modules', 'lessons', 'content_blocks'
  ]
  loop
    execute format(
      'create policy %I on public.%I for all to authenticated using (app_private.can_manage_tenant(tenant_id)) with check (app_private.can_manage_tenant(tenant_id))',
      table_name || '_manage', table_name
    );
  end loop;
end $$;

-- Ingestion and knowledge internals never become student-readable directly.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'learning_sources', 'ingestion_jobs', 'ingestion_checkpoints',
    'ingestion_issues', 'knowledge_versions', 'learning_documents',
    'learning_chunks'
  ]
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (app_private.can_manage_tenant(tenant_id))',
      table_name || '_select', table_name
    );
    execute format(
      'create policy %I on public.%I for all to authenticated using (app_private.can_manage_tenant(tenant_id)) with check (app_private.can_manage_tenant(tenant_id))',
      table_name || '_manage', table_name
    );
  end loop;
end $$;

create policy tenant_branding_select on public.tenant_branding
  for select to authenticated
  using (
    app_private.can_read_lifecycle_record(tenant_id, status, deleted_at)
  );
create policy tenant_branding_manage on public.tenant_branding
  for all to authenticated
  using (app_private.can_manage_tenant(tenant_id))
  with check (app_private.can_manage_tenant(tenant_id));

create policy context_mappings_select on public.learning_context_mappings
  for select to authenticated
  using (
    app_private.can_manage_tenant(tenant_id)
    or (
      app_private.is_tenant_context(tenant_id)
      and deleted_at is null
      and status = 'active'
      and app_private.has_any_role(array['client_viewer', 'student'])
    )
  );
create policy context_mappings_manage on public.learning_context_mappings
  for all to authenticated
  using (app_private.can_manage_tenant(tenant_id))
  with check (app_private.can_manage_tenant(tenant_id));

create policy student_progress_select on public.student_progress
  for select to authenticated
  using (
    app_private.is_tenant_context(tenant_id)
    and (
      app_private.has_any_role(array['owner', 'client_admin', 'system_worker'])
      or user_id = app_private.current_actor_id()
    )
  );
create policy student_progress_manage on public.student_progress
  for all to authenticated
  using (app_private.can_manage_tenant(tenant_id))
  with check (app_private.can_manage_tenant(tenant_id));

create policy conversations_select on public.conversations
  for select to authenticated
  using (
    app_private.is_tenant_context(tenant_id)
    and (
      app_private.has_any_role(array['owner', 'client_admin', 'system_worker'])
      or subject_user_id = app_private.current_actor_id()
    )
  );
create policy conversations_insert on public.conversations
  for insert to authenticated
  with check (
    app_private.is_tenant_context(tenant_id)
    and (
      app_private.can_manage_tenant(tenant_id)
      or subject_user_id = app_private.current_actor_id()
    )
  );
create policy conversations_update on public.conversations
  for update to authenticated
  using (
    app_private.is_tenant_context(tenant_id)
    and (
      app_private.can_manage_tenant(tenant_id)
      or subject_user_id = app_private.current_actor_id()
    )
  )
  with check (
    app_private.is_tenant_context(tenant_id)
    and (
      app_private.can_manage_tenant(tenant_id)
      or subject_user_id = app_private.current_actor_id()
    )
  );

create policy messages_select on public.messages
  for select to authenticated
  using (app_private.can_access_conversation(tenant_id, conversation_id));
create policy messages_insert on public.messages
  for insert to authenticated
  with check (
    app_private.can_access_conversation(tenant_id, conversation_id)
    and (
      app_private.can_manage_tenant(tenant_id)
      or (actor_id = app_private.current_actor_id() and actor_type = 'student')
    )
  );
create policy messages_manage on public.messages
  for update to authenticated
  using (app_private.can_manage_tenant(tenant_id))
  with check (app_private.can_manage_tenant(tenant_id));

create policy attachments_select on public.attachments
  for select to authenticated
  using (app_private.can_access_conversation(tenant_id, conversation_id));
create policy attachments_insert on public.attachments
  for insert to authenticated
  with check (
    app_private.can_access_conversation(tenant_id, conversation_id)
    and (
      app_private.can_manage_tenant(tenant_id)
      or uploaded_by = app_private.current_actor_id()
    )
  );
create policy attachments_update on public.attachments
  for update to authenticated
  using (
    app_private.can_manage_tenant(tenant_id)
    or (
      app_private.can_access_conversation(tenant_id, conversation_id)
      and uploaded_by = app_private.current_actor_id()
    )
  )
  with check (
    app_private.can_manage_tenant(tenant_id)
    or (
      app_private.can_access_conversation(tenant_id, conversation_id)
      and uploaded_by = app_private.current_actor_id()
    )
  );

-- Ledgers and tool grants are not generally user-readable.
create policy audit_ledger_select on public.audit_ledger
  for select to authenticated
  using (app_private.is_tenant_admin(tenant_id));
create policy audit_ledger_insert on public.audit_ledger
  for insert to authenticated
  with check (app_private.is_system_worker(tenant_id));

create policy cost_ledger_select on public.cost_ledger
  for select to authenticated
  using (app_private.is_tenant_admin(tenant_id));
create policy cost_ledger_insert on public.cost_ledger
  for insert to authenticated
  with check (app_private.is_system_worker(tenant_id));

create policy mcp_grants_select on public.mcp_grants
  for select to authenticated
  using (
    app_private.is_tenant_admin(tenant_id)
    or (
      app_private.is_tenant_context(tenant_id)
      and actor_id = app_private.current_actor_id()
    )
  );
create policy mcp_grants_manage on public.mcp_grants
  for all to authenticated
  using (app_private.is_tenant_admin(tenant_id))
  with check (app_private.is_tenant_admin(tenant_id));

create policy mcp_invocations_select on public.mcp_invocations
  for select to authenticated
  using (
    app_private.is_tenant_admin(tenant_id)
    or (
      app_private.is_tenant_context(tenant_id)
      and actor_id = app_private.current_actor_id()
    )
  );
create policy mcp_invocations_insert on public.mcp_invocations
  for insert to authenticated
  with check (app_private.is_system_worker(tenant_id));
create policy mcp_invocations_update on public.mcp_invocations
  for update to authenticated
  using (app_private.is_system_worker(tenant_id))
  with check (app_private.is_system_worker(tenant_id));

-- Grant only the operations for which an RLS policy exists.
grant select, update on public.tenants to authenticated;
grant select, insert, update, delete on
  public.roles, public.profiles, public.memberships, public.courses, public.modules,
  public.lessons, public.content_blocks, public.learning_sources,
  public.ingestion_jobs, public.ingestion_checkpoints,
  public.ingestion_issues, public.knowledge_versions,
  public.learning_documents, public.learning_chunks,
  public.tenant_branding, public.learning_context_mappings,
  public.student_progress, public.conversations, public.messages,
  public.attachments, public.mcp_grants, public.mcp_invocations
to authenticated;
grant select, insert on public.audit_ledger, public.cost_ledger to authenticated;

-- Concurrency tokens are incremented server-side. Callers must still use
-- `... where record_version = :expected` to reject stale writes.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'tenants', 'roles', 'profiles', 'memberships', 'courses', 'modules', 'lessons',
    'content_blocks', 'learning_sources', 'ingestion_jobs',
    'ingestion_checkpoints', 'ingestion_issues', 'knowledge_versions',
    'learning_documents', 'learning_chunks', 'tenant_branding',
    'learning_context_mappings', 'student_progress', 'conversations',
    'messages', 'attachments', 'mcp_grants', 'mcp_invocations'
  ]
  loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function app_private.set_updated_at_and_version()',
      table_name || '_set_version', table_name
    );
  end loop;
end $$;

-- ATT-02 storage policy. Create this bucket privately through Supabase
-- configuration before applying the policies. Canonical object paths are:
--   <tenant_uuid>/<scope>/<owner_user_uuid>/<object_uuid>/<safe-filename>
-- Direct client access is limited to the matching tenant and owner. Course
-- assets and cross-user reads must use short-lived signed URLs issued only
-- after application-level object authorization.
insert into storage.buckets (id, name, public, file_size_limit)
values ('tenant-private', 'tenant-private', false, 52428800)
on conflict (id) do update
set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists tenant_private_owner_select on storage.objects;
create policy tenant_private_owner_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'tenant-private'
    and (storage.foldername(name))[1] = app_private.current_tenant_id()::text
    and (
      app_private.has_any_role(array['owner', 'client_admin'])
      or (storage.foldername(name))[3] = app_private.current_actor_id()::text
    )
  );

drop policy if exists tenant_private_owner_insert on storage.objects;
create policy tenant_private_owner_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'tenant-private'
    and (storage.foldername(name))[1] = app_private.current_tenant_id()::text
    and (storage.foldername(name))[3] = app_private.current_actor_id()::text
  );

drop policy if exists tenant_private_owner_delete on storage.objects;
create policy tenant_private_owner_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'tenant-private'
    and (storage.foldername(name))[1] = app_private.current_tenant_id()::text
    and (
      app_private.has_any_role(array['owner', 'client_admin'])
      or (storage.foldername(name))[3] = app_private.current_actor_id()::text
    )
  );

commit;

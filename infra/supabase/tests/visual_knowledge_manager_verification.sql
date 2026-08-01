-- Run after visual_knowledge_manager.sql.

begin;

do $$
declare
  table_acl text;
  read_policy text;
  project_definition text;
begin
  -- VKM-01: metadata is tenant-bound, forced-RLS and unavailable through the
  -- Data API even if a caller attempts to bypass the application RPCs.
  if not exists (
    select 1
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'visual_knowledge_assets'
      and relation.relrowsecurity
      and relation.relforcerowsecurity
  ) then
    raise exception 'VKM-01 visual metadata is not forced-RLS';
  end if;
  select coalesce(array_to_string(relation.relacl, ','), '')
    into table_acl
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relname = 'visual_knowledge_assets';
  if table_acl like '%authenticated=%'
    or table_acl like '%anon=%'
    or table_acl like '%service_role=%'
  then
    raise exception 'VKM-01 direct visual table privileges are present: %',
      table_acl;
  end if;

  -- VKM-02: private-storage reads are metadata-gated; students require an
  -- active, answer-enabled visual in a published course.
  select policy.qual into read_policy
  from pg_policies policy
  where policy.schemaname = 'storage'
    and policy.tablename = 'objects'
    and policy.policyname = 'tenant_private_visual_select';
  if read_policy not like '%visual_storage_read_allowed%'
    or read_policy not like '%tenant-private%'
  then
    raise exception 'VKM-02 storage read policy is incomplete';
  end if;
  if pg_get_functiondef(
    'app_private.visual_storage_read_allowed(text)'::regprocedure
  ) not like '%course.status = ''published''%'
    or pg_get_functiondef(
      'app_private.visual_storage_read_allowed(text)'::regprocedure
    ) not like '%visual.show_in_answers%'
  then
    raise exception 'VKM-02 student read requirements are incomplete';
  end if;

  -- VKM-03: answer-enabled metadata is projected through the ordinary course
  -- document/chunk path in an atomic successor version. Function-body casing
  -- is authored text in pg_get_functiondef(), so compare its normalized form.
  select lower(pg_get_functiondef(
    'app_private.visual_rebuild_course(uuid,uuid,text,text,text)'::regprocedure
  )) into project_definition;
  if project_definition not like '%insert into public.learning_documents%'
    or project_definition not like '%insert into public.learning_chunks%'
    or project_definition not like '%status = ''published''%'
    or project_definition not like '%active_knowledge_version_id = next_version_id%'
    or project_definition not like '%authoring_append_audit%'
  then
    raise exception 'VKM-03 atomic retrieval projection is incomplete';
  end if;
  if not exists (
    select 1
    from pg_trigger trigger
    join pg_class relation on relation.oid = trigger.tgrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'courses'
      and trigger.tgname = 'courses_reproject_visual_knowledge'
      and trigger.tgdeferrable
      and trigger.tginitdeferred
  )
  then
    raise exception 'VKM-03 publish reprojection is not deferred';
  end if;
  if to_regprocedure(
    'app_private.visual_deactivate_projection(uuid,uuid)'
  ) is not null then
    raise exception 'VKM-03 in-place deactivation helper still exists';
  end if;

  -- VKM-04: only authenticated callers get lifecycle RPCs, and usage counting
  -- requires the same durable operation-token check as response recording.
  if has_function_privilege(
    'anon',
    'public.learning_create_visual_asset(uuid,uuid,text,text,text,boolean,text,text,bigint,text,timestamptz,text)',
    'execute'
  ) then
    raise exception 'VKM-04 anonymous visual creation is executable';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.learning_list_visual_assets(uuid,boolean)',
    'execute'
  ) then
    raise exception 'VKM-04 authenticated visual listing is unavailable';
  end if;
  if pg_get_functiondef(
    'public.learning_record_visual_usage(uuid[],text)'::regprocedure
  ) not like '%learning_operation_token_is_valid%'
  then
    raise exception 'VKM-04 visual usage is not operation-token gated';
  end if;

  -- VKM-05: activation requires a server validation receipt and the generic
  -- private-bucket owner policies cannot be used to replace validated bytes.
  if has_function_privilege(
    'authenticated',
    'public.learning_finalize_visual_asset(uuid)',
    'execute'
  ) then
    raise exception 'VKM-05 legacy client finalization is executable';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.learning_finalize_validated_visual_asset(uuid,text,text)',
    'execute'
  ) then
    raise exception 'VKM-05 validated finalization is unavailable';
  end if;
  if pg_get_functiondef(
    'public.learning_finalize_validated_visual_asset(uuid,text,text)'
      ::regprocedure
  ) not like '%learning.visual.finalize%'
    or pg_get_functiondef(
      'public.learning_finalize_validated_visual_asset(uuid,text,text)'
        ::regprocedure
    ) not like '%validated_sha256%'
  then
    raise exception 'VKM-05 validated receipt gate is incomplete';
  end if;
  if not exists (
    select 1
    from pg_policies policy
    where policy.schemaname = 'storage'
      and policy.tablename = 'objects'
      and policy.policyname = 'tenant_private_visual_insert_guard'
      and policy.permissive = 'RESTRICTIVE'
      and policy.cmd = 'INSERT'
      and policy.with_check like '%visual_storage_insert_allowed%'
  ) then
    raise exception 'VKM-05 pending-only visual insert guard is missing';
  end if;
  if not exists (
    select 1
    from pg_policies policy
    where policy.schemaname = 'storage'
      and policy.tablename = 'objects'
      and policy.policyname = 'tenant_private_visual_delete_guard'
      and policy.permissive = 'RESTRICTIVE'
      and policy.cmd = 'DELETE'
      and policy.qual like '%visuals%'
  ) then
    raise exception 'VKM-05 immutable visual delete guard is missing';
  end if;
end
$$;

rollback;

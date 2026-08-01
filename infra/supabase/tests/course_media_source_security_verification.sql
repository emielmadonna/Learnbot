-- Catalog and pure-function verification for secure course media and sources.
-- Run after migrations. The transaction leaves no durable test state.

begin;

do $$
declare
  source_course_function text;
  connector_sync_function text;
  media_validator_function text;
  connector_rls boolean;
  connector_forced boolean;
begin
  select pg_catalog.pg_get_functiondef(
    'public.learning_create_source_course(text,text,text,text)'::regprocedure
  ) into source_course_function;

  if position(
    'app_private.authoring_rpc_context()' in source_course_function
  ) = 0
    or position('teacher' in lower(source_course_function)) > 0
  then
    raise exception
      'source-course creation must use the authoring gate and exclude teachers';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.learning_create_source_course(text,text,text,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.learning_create_source_course(text,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'source-course creation grants are not least-privilege';
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.learning_source_connector_sync(uuid,uuid,uuid,text,text,text,jsonb,jsonb,text,boolean,text,text)'::regprocedure
  ) into connector_sync_function;

  if position(
    'connection.tenant_id = target_tenant_id' in connector_sync_function
  ) = 0
    or position(
      '''vault://'' || connection.vault_secret_id::text'
      in connector_sync_function
    ) = 0
    or position(
      'connection.status = ''active''' in connector_sync_function
    ) = 0
  then
    raise exception 'Circle Vault reference is not tenant-bound';
  end if;

  if not has_function_privilege(
    'service_role',
    'public.learning_source_connector_sync(uuid,uuid,uuid,text,text,text,jsonb,jsonb,text,boolean,text,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.learning_source_connector_sync(uuid,uuid,uuid,text,text,text,jsonb,jsonb,text,boolean,text,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.learning_source_connector_sync(uuid,uuid,uuid,text,text,text,jsonb,jsonb,text,boolean,text,text)',
    'EXECUTE'
  ) then
    raise exception 'source connector sync grants are not service-only';
  end if;

  select c.relrowsecurity, c.relforcerowsecurity
  into connector_rls, connector_forced
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app_private'
    and c.relname = 'learning_source_connections';

  if coalesce(connector_rls, false) is not true
    or coalesce(connector_forced, false) is not true
  then
    raise exception 'source connections must enable and force RLS';
  end if;

  select pg_catalog.pg_get_functiondef(
    'app_private.authoring_valid_block(text,jsonb)'::regprocedure
  ) into media_validator_function;

  if position('when ''image''' in media_validator_function) = 0
    or position('when ''video''' in media_validator_function) = 0
    or position('when ''link''' in media_validator_function) = 0
    or position(
      'app_private.authoring_safe_https_url' in media_validator_function
    ) = 0
  then
    raise exception 'course media validation contract is incomplete';
  end if;

  if app_private.authoring_safe_https_url(
    'https://localhost/lesson.png'
  ) or app_private.authoring_safe_https_url(
    'https://192.168.1.5/lesson.png'
  ) or not app_private.authoring_safe_https_url(
    'https://cdn.example.com/lesson.png'
  ) then
    raise exception 'course media public HTTPS boundary regressed';
  end if;

  if not app_private.authoring_valid_block(
    'image',
    jsonb_build_object(
      'url', 'https://cdn.example.com/lesson.png',
      'altText', 'A useful lesson diagram',
      'caption', ''
    )
  ) or app_private.authoring_valid_block(
    'image',
    jsonb_build_object(
      'url', 'https://10.0.0.8/lesson.png',
      'altText', 'A private network request',
      'caption', ''
    )
  ) then
    raise exception 'image block validator regressed';
  end if;

  if lower(
    source_course_function || connector_sync_function ||
    media_validator_function
  ) ~ '(estie|estiestarr|pricing lab|038ed2b4|hello@estiestarr)'
  then
    raise exception 'tenant-specific defaults leaked into source/media RPCs';
  end if;
end;
$$;

rollback;

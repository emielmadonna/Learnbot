-- Course AI Platform: foundational extensions, JWT helpers and concurrency.
-- Apply as a migration owner. Application roles receive no access to
-- app_private; only SECURITY DEFINER helper functions are executable.

begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;

create schema if not exists app_private;
revoke all on schema app_private from public;

create or replace function app_private.jwt_claims()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
$$;

create or replace function app_private.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select case
    when app_private.jwt_claims() ->> 'tenant_id'
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (app_private.jwt_claims() ->> 'tenant_id')::uuid
    else null
  end;
$$;

create or replace function app_private.current_actor_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select case
    when app_private.jwt_claims() ->> 'sub'
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (app_private.jwt_claims() ->> 'sub')::uuid
    else null
  end;
$$;

create or replace function app_private.current_app_role()
returns text
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select coalesce(app_private.jwt_claims() ->> 'app_role', '');
$$;

create or replace function app_private.is_tenant_context(target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select target_tenant_id is not null
    and target_tenant_id = app_private.current_tenant_id();
$$;

create or replace function app_private.has_any_role(allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select app_private.current_app_role() = any(allowed_roles);
$$;

create or replace function app_private.can_read_tenant(target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select app_private.is_tenant_context(target_tenant_id)
    and app_private.has_any_role(
      array['owner', 'client_admin', 'client_viewer', 'student', 'system_worker']
    );
$$;

create or replace function app_private.can_manage_tenant(target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select app_private.is_tenant_context(target_tenant_id)
    and app_private.has_any_role(
      array['owner', 'client_admin', 'system_worker']
    );
$$;

create or replace function app_private.is_tenant_admin(target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select app_private.is_tenant_context(target_tenant_id)
    and app_private.has_any_role(array['owner', 'client_admin']);
$$;

create or replace function app_private.is_system_worker(target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select app_private.is_tenant_context(target_tenant_id)
    and app_private.has_any_role(array['system_worker']);
$$;

create or replace function app_private.set_updated_at_and_version()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  new.updated_at := clock_timestamp();
  new.record_version := old.record_version + 1;
  return new;
end;
$$;

create or replace function app_private.reject_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  raise exception '% is append-only; corrections must be appended', tg_table_name
    using errcode = '55000';
end;
$$;

revoke all on all functions in schema app_private from public;
grant usage on schema app_private to authenticated;
grant execute on function app_private.current_tenant_id() to authenticated;
grant execute on function app_private.current_actor_id() to authenticated;
grant execute on function app_private.current_app_role() to authenticated;
grant execute on function app_private.is_tenant_context(uuid) to authenticated;
grant execute on function app_private.has_any_role(text[]) to authenticated;
grant execute on function app_private.can_read_tenant(uuid) to authenticated;
grant execute on function app_private.can_manage_tenant(uuid) to authenticated;
grant execute on function app_private.is_tenant_admin(uuid) to authenticated;
grant execute on function app_private.is_system_worker(uuid) to authenticated;

commit;

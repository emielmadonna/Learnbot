-- Separate LearningBot platform administration from tenant administration.
-- Platform administrators can inspect bounded tenant readiness summaries but
-- cannot use this surface to read learner messages, source contents, or audio.

begin;

create table app_private.platform_administrators (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'active'
    check (status in ('active', 'revoked')),
  reason text not null check (length(btrim(reason)) between 1 and 500),
  created_by_auth_user_id uuid references auth.users(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  check (
    (status = 'active' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  )
);

alter table app_private.platform_administrators enable row level security;
revoke all on table app_private.platform_administrators
  from public, anon, authenticated;
grant select, insert, update, delete
  on table app_private.platform_administrators
  to service_role;

create index platform_administrators_active_idx
  on app_private.platform_administrators (auth_user_id)
  where status = 'active';

create or replace function public.platform_admin_is_authorized()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from auth.users u
      join app_private.platform_administrators a
        on a.auth_user_id = u.id
       and a.status = 'active'
      where u.id = auth.uid()
        and u.deleted_at is null
        and coalesce(u.email_confirmed_at, u.phone_confirmed_at) is not null
    );
$$;

revoke execute on function public.platform_admin_is_authorized()
  from public, anon, service_role;
grant execute on function public.platform_admin_is_authorized()
  to authenticated;

create or replace function public.platform_admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  tenants_summary jsonb;
  totals jsonb;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'tenantId', t.tenant_id,
        'slug', t.slug,
        'displayName', t.display_name,
        'status', t.status,
        'region', t.region,
        'assistantName', coalesce(b.assistant_name, 'LearningBot'),
        'courses', coalesce(course_counts.total, 0),
        'publishedCourses', coalesce(course_counts.published, 0),
        'members', coalesce(member_counts.total, 0),
        'sources', coalesce(source_counts.total, 0),
        'knowledgeChunks', coalesce(chunk_counts.total, 0),
        'updatedAt', t.updated_at
      )
      order by t.created_at, t.tenant_id
    ),
    '[]'::jsonb
  )
  into tenants_summary
  from public.tenants t
  left join lateral (
    select
      count(*)::bigint as total,
      count(*) filter (where c.status = 'published')::bigint as published
    from public.courses c
    where c.tenant_id = t.tenant_id
      and c.deleted_at is null
  ) course_counts on true
  left join lateral (
    select count(*)::bigint as total
    from public.identity_memberships m
    where m.tenant_id = t.tenant_id
      and m.status = 'active'
      and m.deleted_at is null
  ) member_counts on true
  left join lateral (
    select count(*)::bigint as total
    from public.learning_sources s
    where s.tenant_id = t.tenant_id
      and s.deleted_at is null
  ) source_counts on true
  left join lateral (
    select count(*)::bigint as total
    from public.learning_chunks c
    where c.tenant_id = t.tenant_id
      and c.deleted_at is null
  ) chunk_counts on true
  left join lateral (
    select tb.assistant_name
    from public.tenant_branding tb
    where tb.tenant_id = t.tenant_id
      and tb.status = 'published'
      and tb.deleted_at is null
    order by tb.version_number desc
    limit 1
  ) b on true
  where t.deleted_at is null;

  select jsonb_build_object(
    'tenants', count(*)::bigint,
    'activeTenants', count(*) filter (where status = 'active')::bigint,
    'courses', (
      select count(*)::bigint
      from public.courses c
      where c.deleted_at is null
    ),
    'members', (
      select count(*)::bigint
      from public.identity_memberships m
      where m.status = 'active'
        and m.deleted_at is null
    ),
    'sources', (
      select count(*)::bigint
      from public.learning_sources s
      where s.deleted_at is null
    ),
    'knowledgeChunks', (
      select count(*)::bigint
      from public.learning_chunks c
      where c.deleted_at is null
    )
  )
  into totals
  from public.tenants
  where deleted_at is null;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'generatedAt', clock_timestamp(),
    'totals', totals,
    'tenants', tenants_summary
  );
end;
$$;

revoke execute on function public.platform_admin_overview()
  from public, anon, service_role;
grant execute on function public.platform_admin_overview()
  to authenticated;

commit;

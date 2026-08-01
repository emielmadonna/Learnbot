-- Platform-controlled provider-key management and the authenticated learner
-- read path for a reviewed/published character avatar.

begin;

create or replace function app_private.tenant_capability_definitions()
returns table (
  capability_key text,
  default_enabled boolean,
  display_position integer
)
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select *
  from (values
    ('bot_identity'::text, true, 1),
    ('welcome_message'::text, true, 2),
    ('voice_answer_length'::text, true, 3),
    ('model_choice'::text, false, 4),
    ('invite_members'::text, true, 5),
    ('provider_api_key'::text, false, 6)
  ) as definitions(capability_key, default_enabled, display_position);
$$;
revoke execute on function app_private.tenant_capability_definitions()
  from public, anon, authenticated, service_role;

do $$
declare
  existing_constraint text;
begin
  for existing_constraint in
    select c.conname
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.tenant_capability_grants'::pg_catalog.regclass
      and c.contype = 'c'
      and pg_catalog.pg_get_constraintdef(c.oid) like '%capability_key%'
  loop
    execute pg_catalog.format(
      'alter table public.tenant_capability_grants drop constraint %I',
      existing_constraint
    );
  end loop;
end;
$$;

alter table public.tenant_capability_grants
  add constraint tenant_capability_grants_capability_key_check
  check (capability_key in (
    'bot_identity', 'welcome_message', 'voice_answer_length',
    'model_choice', 'invite_members', 'provider_api_key'
  ));

insert into public.tenant_capability_grants (
  tenant_id, capability_key, enabled, idempotency_key
)
select
  t.tenant_id,
  'provider_api_key',
  false,
  'tenant-capability-seed:' || t.tenant_id::text || ':provider_api_key'
from public.tenants t
where t.deleted_at is null
on conflict (tenant_id, capability_key) do nothing;

-- Learners only receive the latest explicitly published pose set. Source
-- photos, consent evidence, provider metadata and rejected drafts never cross
-- this read boundary.
create or replace function public.learning_get_published_avatar()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  avatar_record public.agent_avatar_sets%rowtype;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;

  select * into avatar_record
  from public.agent_avatar_sets s
  where s.tenant_id = caller.tenant_id
    and s.status = 'published'
  order by s.version_number desc
  limit 1;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', caller.tenant_id,
    'avatar', case
      when avatar_record.avatar_set_id is null then null
      else jsonb_build_object(
        'avatarSetId', avatar_record.avatar_set_id,
        'versionNumber', avatar_record.version_number,
        'poses', avatar_record.poses,
        'publishedAt', avatar_record.published_at
      )
    end
  );
end;
$$;

revoke execute on function public.learning_get_published_avatar()
  from public, anon, service_role;
grant execute on function public.learning_get_published_avatar()
  to authenticated;

commit;

-- Align the tenant model catalogue with the production GPT-5.6 API model
-- family. The previous `luna-mini` and `luna-pro` slugs were prototype labels,
-- not provider model IDs. Existing selections are migrated by their displayed
-- intent: balanced -> Terra, low-cost -> Luna, quality-first -> Sol.

begin;

alter table public.tenant_branding
  drop constraint if exists tenant_branding_agent_model_check;

update public.tenant_branding
set agent_model = case agent_model
  when 'gpt-5.6-luna' then 'gpt-5.6-terra'
  when 'gpt-5.6-luna-mini' then 'gpt-5.6-luna'
  when 'gpt-5.6-luna-pro' then 'gpt-5.6-sol'
  else agent_model
end
where agent_model in (
  'gpt-5.6-luna',
  'gpt-5.6-luna-mini',
  'gpt-5.6-luna-pro'
);

alter table public.tenant_branding
  alter column agent_model set default 'gpt-5.6-terra';

create or replace function app_private.agent_allowed_models()
returns text[]
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select array['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
$$;
revoke execute on function app_private.agent_allowed_models()
  from public, anon, authenticated, service_role;

alter table public.tenant_branding
  add constraint tenant_branding_agent_model_check
  check (agent_model = any (app_private.agent_allowed_models()));

commit;

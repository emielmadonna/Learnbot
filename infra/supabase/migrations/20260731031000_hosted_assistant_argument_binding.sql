-- Bind hosted-assistant inputs positionally so the public `slug` argument can
-- never be confused with the identically named publication column.

begin;

create or replace function public.hosted_assistant_bootstrap(
  slug text,
  origin text,
  operation_token text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  resolved_key text;
  bootstrap jsonb;
  trusted_server boolean;
  slug_reserved boolean;
begin
  trusted_server := app_private.learning_operation_token_is_valid(
    'conversation.answer.record', $3
  );
  if trusted_server then
    select exists (
      select 1
      from public.hosted_assistant_publications p
      where p.slug = lower(btrim(coalesce($1, '')))
        and p.deleted_at is null
    ) into slug_reserved;
  end if;

  select r.widget_key into resolved_key
  from app_private.hosted_assistant_resolve($1, $2) r;
  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'widget_unavailable'
    ) || case
      when trusted_server then jsonb_build_object(
        'slugReserved', coalesce(slug_reserved, false)
      )
      else '{}'::jsonb
    end;
  end if;

  bootstrap := public.widget_bootstrap(resolved_key, $2);
  if coalesce((bootstrap ->> 'ok')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'code', 'widget_unavailable');
  end if;

  return bootstrap || case
    when trusted_server then jsonb_build_object('deliveryKey', resolved_key)
    else '{}'::jsonb
  end;
end;
$$;

revoke execute on function public.hosted_assistant_bootstrap(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.hosted_assistant_bootstrap(text, text, text)
  to anon;

commit;

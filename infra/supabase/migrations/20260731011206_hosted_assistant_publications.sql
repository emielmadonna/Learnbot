-- Durable, friendly hosted-assistant publications.
--
-- `/c/:slug` is public, but a slug is routing identity rather than authority.
-- Every bootstrap still resolves to the tenant's current public widget key and
-- passes through app_private.widget_resolve, so the exact Origin allowlist,
-- widget enabled state, anonymous-question setting, tenant suspension, key
-- revocation and published-branding checks remain authoritative.
--
-- Slugs are permanently reserved once used. A rename supersedes the old
-- publication instead of deleting it, preventing a stale course link from
-- being claimed later by another tenant. The public path has one global slug
-- namespace because it contains no tenant segment; ownership and lifecycle
-- remain tenant-scoped.

begin;

create table public.hosted_assistant_publications (
  hosted_assistant_publication_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  tenant_widget_key_id uuid not null,
  slug text not null
    check (
      slug = lower(slug)
      and slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'
      and slug not in (
        'admin', 'api', 'app', 'auth', 'corso', 'help', 'install',
        'onboarding', 'privacy', 'security', 'status', 'support', 'terms',
        'widget', 'www'
      )
    ),
  status text not null
    check (status in ('published', 'unpublished', 'superseded')),
  published_at timestamptz,
  unpublished_at timestamptz,
  superseded_at timestamptz,
  record_version bigint not null default 1 check (record_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz not null default (now() + interval '7 years'),
  unique (tenant_id, hosted_assistant_publication_id),
  unique (slug),
  foreign key (tenant_id, tenant_widget_key_id)
    references public.tenant_widget_keys(tenant_id, tenant_widget_key_id),
  check (deleted_at is null),
  check (
    (status = 'published'
      and published_at is not null
      and unpublished_at is null
      and superseded_at is null)
    or
    (status = 'unpublished'
      and unpublished_at is not null
      and superseded_at is null)
    or
    (status = 'superseded' and superseded_at is not null)
  )
);

-- One current publication per tenant. Historical slugs remain as superseded
-- reservations, so they cannot be reassigned across tenants.
create unique index hosted_assistant_publications_one_current_uq
  on public.hosted_assistant_publications (tenant_id)
  where status in ('published', 'unpublished') and deleted_at is null;
create index hosted_assistant_publications_tenant_history_idx
  on public.hosted_assistant_publications (
    tenant_id, updated_at desc, hosted_assistant_publication_id
  );

create trigger hosted_assistant_publications_touch
before update on public.hosted_assistant_publications
for each row execute function app_private.set_updated_at_and_version();

alter table public.hosted_assistant_publications enable row level security;
alter table public.hosted_assistant_publications force row level security;

-- The 2026-04 Supabase Data API default change makes grants opt-in. State the
-- complete access surface explicitly: administrators may read their tenant's
-- publication, nobody writes rows directly, and anon cannot enumerate slugs.
revoke all on table public.hosted_assistant_publications
  from public, anon, authenticated, service_role;
grant select on table public.hosted_assistant_publications to authenticated;

create policy hosted_assistant_publications_admin_read
  on public.hosted_assistant_publications
  for select to authenticated
  using (app_private.is_tenant_admin(tenant_id));

create policy hosted_assistant_publications_deny_anon
  on public.hosted_assistant_publications
  as restrictive
  for all to anon
  using (false)
  with check (false);

-- Private resolution returns the leak-tolerant widget key only inside the
-- database/application-server boundary. It deliberately reuses widget_resolve
-- rather than reproducing any origin or publication predicate.
create or replace function app_private.hosted_assistant_resolve(
  candidate_slug text,
  candidate_origin text
)
returns table (
  widget_key text
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select k.widget_key
  from public.hosted_assistant_publications p
  join public.tenant_widget_keys k
    on k.tenant_id = p.tenant_id
   and k.tenant_widget_key_id = p.tenant_widget_key_id
  join lateral app_private.widget_resolve(k.widget_key, candidate_origin)
    resolved on true
  where candidate_slug is not null
    and candidate_slug = lower(btrim(candidate_slug))
    and candidate_slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'
    and p.slug = candidate_slug
    and p.status = 'published'
    and p.deleted_at is null
    -- Key rotation invalidates an old publication until an administrator
    -- republishes it against the new active key.
    and k.status = 'active'
    and k.deleted_at is null
  limit 1;
$$;
revoke execute on function app_private.hosted_assistant_resolve(text, text)
  from public, anon, authenticated, service_role;

-- Public bootstrap is opaque for every failure mode. The application server
-- may receive the delivery key only while holding the same operation token
-- already required to create and record grounded assistant turns. Browsers and
-- direct anon RPC callers receive branding/configuration but never the key.
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
    'conversation.answer.record', operation_token
  );
  if trusted_server then
    select exists (
      select 1
      from public.hosted_assistant_publications p
      where p.slug = lower(btrim(coalesce(slug, '')))
        and p.deleted_at is null
    ) into slug_reserved;
  end if;

  select r.widget_key into resolved_key
  from app_private.hosted_assistant_resolve(slug, origin) r;
  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'widget_unavailable'
    ) || case
      -- Server-only reservation awareness keeps a legacy `?key=` from
      -- bypassing unpublish, rename, revocation or an origin refusal. The flag
      -- is never returned without the operation token and never reaches the
      -- browser.
      when trusted_server then jsonb_build_object(
        'slugReserved', coalesce(slug_reserved, false)
      )
      else '{}'::jsonb
    end;
  end if;

  bootstrap := public.widget_bootstrap(resolved_key, origin);
  if coalesce((bootstrap ->> 'ok')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'code', 'widget_unavailable');
  end if;

  return bootstrap || case
    when trusted_server then jsonb_build_object('deliveryKey', resolved_key)
    else '{}'::jsonb
  end;
end;
$$;

create or replace function public.tenant_get_hosted_assistant_publication()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  current_publication public.hosted_assistant_publications%rowtype;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'tenant_selection_required'
    );
  end if;
  if caller.identity_role not in ('tenant_owner', 'tenant_admin') then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select p.* into current_publication
  from public.hosted_assistant_publications p
  where p.tenant_id = caller.tenant_id
    and p.status in ('published', 'unpublished')
    and p.deleted_at is null
  limit 1;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'expectedVersion', coalesce(current_publication.record_version, 0),
    'publication', case
      when current_publication.hosted_assistant_publication_id is null then null
      else jsonb_build_object(
        'slug', current_publication.slug,
        'status', current_publication.status,
        'hostedPath', '/c/' || current_publication.slug,
        'publishedAt', current_publication.published_at,
        'unpublishedAt', current_publication.unpublished_at,
        'updatedAt', current_publication.updated_at
      )
    end
  );
end;
$$;

create or replace function public.tenant_update_hosted_assistant_publication(
  requested_action text,
  requested_slug text,
  expected_version bigint,
  idempotency_key text,
  request_id text,
  trace_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
#variable_conflict use_variable
declare
  caller record;
  action text := lower(btrim(coalesce(requested_action, '')));
  normalized_slug text := lower(btrim(coalesce(requested_slug, '')));
  current_publication public.hosted_assistant_publications%rowtype;
  target_publication public.hosted_assistant_publications%rowtype;
  written public.hosted_assistant_publications%rowtype;
  active_key public.tenant_widget_keys%rowtype;
  current_version bigint;
  resulting_status text;
  request_fingerprint text;
  command record;
  result jsonb;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'tenant_selection_required'
    );
  end if;
  if caller.identity_role not in ('tenant_owner', 'tenant_admin') then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  if action not in ('publish', 'unpublish', 'change_slug')
    or expected_version is null
    or expected_version < 0
    or idempotency_key is null
    or length(idempotency_key) not between 8 and 160
    or idempotency_key !~ '^[A-Za-z0-9:_-]+$'
    or request_id is null
    or length(request_id) not between 8 and 160
    or request_id !~ '^[A-Za-z0-9:_-]+$'
    or trace_id is null
    or length(trace_id) not between 8 and 160
    or trace_id !~ '^[A-Za-z0-9:_-]+$'
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  if action in ('publish', 'change_slug')
    and (
      length(normalized_slug) not between 3 and 63
      or normalized_slug !~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'
      or normalized_slug in (
        'admin', 'api', 'app', 'auth', 'corso', 'help', 'install',
        'onboarding', 'privacy', 'security', 'status', 'support', 'terms',
        'widget', 'www'
      )
    )
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_slug');
  end if;

  request_fingerprint := encode(
    extensions.digest(
      concat_ws(
        chr(31),
        action,
        normalized_slug,
        expected_version::text
      ),
      'sha256'
    ),
    'hex'
  );
  select * into command
  from app_private.onboarding_begin_command(
    caller.tenant_id,
    'hosted.assistant.publication',
    idempotency_key,
    request_fingerprint,
    'tenant_update_hosted_assistant_publication'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    return jsonb_build_object('ok', false, 'code', 'idempotency_conflict');
  end if;

  -- Tenant serialisation protects the single-current-row invariant and the
  -- per-slug advisory lock makes a cross-tenant claim deterministic rather
  -- than surfacing a unique-constraint exception.
  perform 1
  from public.tenants t
  where t.tenant_id = caller.tenant_id
    and t.deleted_at is null
  for update;
  if not found then
    result := jsonb_build_object('ok', false, 'code', 'tenant_not_found');
    perform app_private.onboarding_complete_command(
      caller.tenant_id, 'hosted.assistant.publication',
      idempotency_key, result
    );
    return result;
  end if;

  select p.* into current_publication
  from public.hosted_assistant_publications p
  where p.tenant_id = caller.tenant_id
    and p.status in ('published', 'unpublished')
    and p.deleted_at is null
  limit 1
  for update;
  current_version := coalesce(current_publication.record_version, 0);

  if current_version <> expected_version then
    result := jsonb_build_object(
      'ok', false,
      'code', 'version_conflict',
      'currentVersion', current_version
    );
    perform app_private.onboarding_complete_command(
      caller.tenant_id, 'hosted.assistant.publication',
      idempotency_key, result
    );
    return result;
  end if;

  if action = 'unpublish' then
    if current_publication.hosted_assistant_publication_id is null then
      result := jsonb_build_object(
        'ok', false, 'code', 'publication_not_found'
      );
    elsif normalized_slug <> ''
      and normalized_slug <> current_publication.slug
    then
      result := jsonb_build_object('ok', false, 'code', 'version_conflict');
    elsif current_publication.status = 'unpublished' then
      result := jsonb_build_object(
        'ok', true,
        'dataMode', 'durable',
        'expectedVersion', current_publication.record_version,
        'publication', jsonb_build_object(
          'slug', current_publication.slug,
          'status', current_publication.status,
          'hostedPath', '/c/' || current_publication.slug,
          'publishedAt', current_publication.published_at,
          'unpublishedAt', current_publication.unpublished_at,
          'updatedAt', current_publication.updated_at
        )
      );
    else
      update public.hosted_assistant_publications
      set status = 'unpublished',
          unpublished_at = statement_timestamp()
      where hosted_assistant_publication_id
        = current_publication.hosted_assistant_publication_id
      returning * into written;
    end if;
  else
    if action = 'publish'
      and current_publication.hosted_assistant_publication_id is not null
      and current_publication.slug <> normalized_slug
    then
      result := jsonb_build_object('ok', false, 'code', 'slug_change_required');
    elsif action = 'change_slug'
      and (
        current_publication.hosted_assistant_publication_id is null
        or current_publication.slug = normalized_slug
      )
    then
      result := jsonb_build_object('ok', false, 'code', 'invalid_slug');
    end if;

    if result is null then
      resulting_status := case
        when action = 'change_slug'
          then current_publication.status
        else 'published'
      end;

      if resulting_status = 'published' then
        select k.* into active_key
        from public.tenant_widget_keys k
        where k.tenant_id = caller.tenant_id
          and k.status = 'active'
          and k.deleted_at is null
        limit 1;
        if active_key.tenant_widget_key_id is null
          or not exists (
            select 1
            from public.tenant_branding b
            where b.tenant_id = caller.tenant_id
              and b.status = 'published'
              and b.deleted_at is null
              and coalesce(
                (
                  app_private.widget_settings_effective(b.launcher)
                    ->> 'enabled'
                )::boolean,
                false
              )
              and coalesce(
                (
                  app_private.widget_settings_effective(b.launcher)
                    ->> 'anonymousQuestions'
                )::boolean,
                false
              )
          )
        then
          result := jsonb_build_object(
            'ok', false, 'code', 'widget_not_ready'
          );
        end if;
      else
        select k.* into active_key
        from public.tenant_widget_keys k
        where k.tenant_widget_key_id
          = current_publication.tenant_widget_key_id;
      end if;
    end if;

    if result is null then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'hosted-assistant-slug:' || normalized_slug,
          0
        )
      );
      select p.* into target_publication
      from public.hosted_assistant_publications p
      where p.slug = normalized_slug
      limit 1
      for update;

      if target_publication.hosted_assistant_publication_id is not null
        and target_publication.tenant_id <> caller.tenant_id
      then
        result := jsonb_build_object(
          'ok', false, 'code', 'slug_unavailable'
        );
      end if;
    end if;

    if result is null then
      if current_publication.hosted_assistant_publication_id is not null
        and (
          target_publication.hosted_assistant_publication_id is null
          or target_publication.hosted_assistant_publication_id
            <> current_publication.hosted_assistant_publication_id
        )
      then
        update public.hosted_assistant_publications
        set status = 'superseded',
            superseded_at = statement_timestamp()
        where hosted_assistant_publication_id
          = current_publication.hosted_assistant_publication_id;
      end if;

      if target_publication.hosted_assistant_publication_id is not null then
        update public.hosted_assistant_publications
        set tenant_widget_key_id = active_key.tenant_widget_key_id,
            status = resulting_status,
            published_at = case
              when resulting_status = 'published'
                then statement_timestamp()
              else published_at
            end,
            unpublished_at = case
              when resulting_status = 'unpublished'
                then coalesce(unpublished_at, statement_timestamp())
              else null
            end,
            superseded_at = null
        where hosted_assistant_publication_id
          = target_publication.hosted_assistant_publication_id
        returning * into written;
      else
        insert into public.hosted_assistant_publications (
          tenant_id,
          tenant_widget_key_id,
          slug,
          status,
          published_at,
          unpublished_at
        ) values (
          caller.tenant_id,
          active_key.tenant_widget_key_id,
          normalized_slug,
          resulting_status,
          case
            when resulting_status = 'published' then statement_timestamp()
            else null
          end,
          case
            when resulting_status = 'unpublished' then statement_timestamp()
            else null
          end
        )
        returning * into written;
      end if;
    end if;
  end if;

  if result is null then
    result := jsonb_build_object(
      'ok', true,
      'dataMode', 'durable',
      'expectedVersion', written.record_version,
      'publication', jsonb_build_object(
        'slug', written.slug,
        'status', written.status,
        'hostedPath', '/c/' || written.slug,
        'publishedAt', written.published_at,
        'unpublishedAt', written.unpublished_at,
        'updatedAt', written.updated_at
      )
    );
  end if;

  perform app_private.widget_audit(
    caller.tenant_id,
    caller.identity_role,
    'widget.hosted_publication.' || action,
    case when coalesce((result ->> 'ok')::boolean, false)
      then 'allow' else 'deny' end,
    coalesce(result ->> 'code', action),
    coalesce(
      written.hosted_assistant_publication_id,
      current_publication.hosted_assistant_publication_id
    )::text,
    request_id,
    trace_id,
    idempotency_key
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id,
    'hosted.assistant.publication',
    idempotency_key,
    result
  );
  return result;
end;
$$;

-- Function EXECUTE is public by default in Postgres. Revoke first, then grant
-- the minimum Data API roles explicitly.
revoke execute on function public.hosted_assistant_bootstrap(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.hosted_assistant_bootstrap(text, text, text)
  to anon;

revoke execute on function public.tenant_get_hosted_assistant_publication()
  from public, anon, authenticated, service_role;
grant execute on function public.tenant_get_hosted_assistant_publication()
  to authenticated;

revoke execute on function public.tenant_update_hosted_assistant_publication(
  text, text, bigint, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.tenant_update_hosted_assistant_publication(
  text, text, bigint, text, text, text
) to authenticated;

commit;

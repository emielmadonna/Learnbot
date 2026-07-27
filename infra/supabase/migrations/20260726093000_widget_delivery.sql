-- Embeddable widget delivery. These are the platform's first database
-- entrypoints reachable WITHOUT a Supabase session, so the whole file is
-- written against a hostile caller.
--
-- ---------------------------------------------------------------- THREAT MODEL
--
-- Asset:            one tenant's published course knowledge, its brand
--                   presentation, and its learners' recorded conversations.
-- Trust boundary:   the public widget key. It is pasted into a customer's
--                   public web page, so ASSUME IT IS LEAKED. Nothing in this
--                   file may treat possession of the key as authorisation for
--                   anything a visitor to that page could not already do.
--
-- Adversaries and the control that stops each one:
--
--   A1. Key scraper embeds a leaked widget key on their own site to resell the
--       tenant's assistant.
--       -> public.widget_bootstrap and public.widget_ask both require an
--          EXACT, normalised origin match against the tenant's allowlist.
--          Scheme, host and port must all match. A wildcard entry
--          ('https://*.example.com') is honoured only when the tenant wrote
--          that entry themselves; there is no implicit subdomain wildcard, no
--          suffix matching, and no path or query is ever considered.
--          A request with no Origin header (curl, server-to-server) is refused
--          the same way, because a browser always sends one cross-origin.
--
--   A2. Tenant enumeration / correlation. An attacker with one key wants to
--       learn who the tenant is, find other tenants, or join two embeds.
--       -> No response from any anon-granted function in this file contains a
--          tenant UUID, tenant slug, branding row id, course UUID, lesson UUID,
--          message UUID, conversation UUID, user id or membership data.
--          Course identity is disclosed only as a courseRef, a SHA-256 digest
--          salted with the widget key, so the same course under two keys is
--          two unrelated strings and no ref can be replayed against another
--          widget. The widget key itself is 40 hex characters of CSPRNG output
--          and is NOT derived from the tenant id.
--
--   A3. Probing for valid keys. An attacker wants an oracle that says "this
--       key exists but the origin is wrong" or "this tenant disabled the
--       widget".
--       -> Every failure to resolve returns the single opaque result
--          {"ok": false, "code": "widget_unavailable"}. Unknown key, revoked
--          key, deleted tenant, suspended tenant, unpublished branding,
--          disabled widget and disallowed origin are indistinguishable.
--
--   A4. Prompt extraction. The persona instructions are the tenant's own
--       authored asset and are exactly the text an attacker needs to design
--       around the assistant.
--       -> The persona is NEVER part of a widget payload. public.widget_ask
--          returns it only when the caller also presents the server-held
--          'conversation.answer.record' operation token, which lives solely in
--          the application server environment and is never shipped to a
--          browser. This is the same gate public.learning_get_agent_directive
--          already uses.
--
--   A5. Conversation theft. conversation_ref is chosen by an untrusted client,
--       so a guessed or leaked ref must not become a read capability.
--       -> No function in this file EVER returns a stored message. The widget
--          renders only the turns of the live session it produced. A guessed
--          ref can therefore append to a stranger's transcript at worst (and
--          the rate limiter bounds even that); it can never read one. The
--          console's authenticated surfaces remain the only read path, and
--          they are still bound to auth.uid() by RLS.
--
--   A6. Cost and abuse. An anonymous endpoint is a free amplifier for model
--       spend and storage.
--       -> Rate limiting happens INSIDE SQL, before any write and before any
--          retrieval, on two independent dimensions: per widget key and per
--          conversation, each over a rolling minute and a rolling hour. The
--          counters live in app_private and are pruned in the same statement.
--          Anonymous asking is additionally opt-in per tenant.
--
--   A7. Forged assistant turns. A visitor could try to write a fabricated
--       "assistant said X" into the durable transcript.
--       -> public.widget_record_answer requires the operation token, exactly
--          like public.learning_record_assistant_message. Without it the
--          function refuses, and the underlying tables grant anon nothing.
--
--   A8. Cross-tenant reads. One widget must never observe another tenant.
--       -> Every read is filtered by the tenant id resolved from the widget
--          key inside app_private.widget_resolve. Retrieval reuses the SAME
--          ranking implementation as the authenticated path
--          (app_private.learning_chunk_matches, which
--          public.learning_search_chunks_hybrid_v1 now delegates to), so the
--          published/active-knowledge-version filters cannot drift apart
--          between the two callers.
--
-- Grants. public.widget_bootstrap, public.widget_ask and
-- public.widget_record_answer are granted to anon because a visitor to a
-- customer's page has no Supabase session and there is no other way to serve
-- them. NOTHING ELSE in this file, and nothing else in the schema, is granted
-- to anon: the tables added here carry restrictive anon denials, every helper
-- stays private, and the two administrative RPCs are authenticated-only.
--
-- Deliberately NOT attempted here, so the gap is visible rather than implied:
--   * semantic retrieval for the widget. The embedding worker is reached with
--     a user JWT, which an anonymous visitor does not have, so widget_ask runs
--     the lexical half of the shared ranking and reports
--     retrievalMode = 'lexical_degraded' instead of pretending otherwise.
--   * transcript resume. See A5.
--   * attachments and voice. Both need an authenticated upload/session path.

begin;

-- ------------------------------------------------------------------- key store

-- The public widget key. Deliberately its own table rather than a column on
-- tenant_branding: the key must survive every branding version, must be
-- rotatable without rewriting presentation, and must carry its own unique
-- index for the single-row lookup that every public request performs.
create table public.tenant_widget_keys (
  tenant_widget_key_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  -- 'wk_' plus 40 hex characters of CSPRNG output. Not derived from, and not
  -- reversible to, the tenant id.
  widget_key text not null check (widget_key ~ '^wk_[0-9a-f]{40}$'),
  status text not null default 'active'
    check (status in ('active', 'revoked')),
  revoked_at timestamptz,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  unique (tenant_id, tenant_widget_key_id),
  unique (tenant_id, idempotency_key),
  check (revoked_at is null or status = 'revoked')
);
create unique index tenant_widget_keys_widget_key_uq
  on public.tenant_widget_keys (widget_key);
create unique index tenant_widget_keys_one_active_uq
  on public.tenant_widget_keys (tenant_id)
  where status = 'active' and deleted_at is null;

create trigger tenant_widget_keys_touch
before update on public.tenant_widget_keys
for each row execute function app_private.set_updated_at_and_version();

alter table public.tenant_widget_keys enable row level security;
alter table public.tenant_widget_keys force row level security;
-- Supabase grants every new public table to anon and authenticated by default.
-- Take that back before any policy is written: the key store is reachable only
-- through the SECURITY DEFINER functions below and the single admin read
-- policy that follows.
revoke all on table public.tenant_widget_keys from anon, authenticated;
grant select on table public.tenant_widget_keys to authenticated;

-- Administrators may read their own key so the console can show the embed
-- snippet. Nobody writes this table directly; rotation goes through the
-- audited RPC below.
create policy tenant_widget_keys_admin_read on public.tenant_widget_keys
  for select to authenticated
  using (app_private.is_tenant_admin(tenant_id));

-- anon resolves keys only through the SECURITY DEFINER functions in this file,
-- never by reading the table, so a leaked publishable key cannot enumerate the
-- key space.
create policy tenant_widget_keys_deny_anon on public.tenant_widget_keys
  as restrictive
  for all to anon
  using (false)
  with check (false);

-- --------------------------------------------------------------- rate counters

-- One row per accepted question. Private, unindexed by tenant on purpose: the
-- only lookups are "recent activity for this key" and "recent activity for this
-- conversation", both of which are what the limiter needs and neither of which
-- exposes anything to a caller.
create table app_private.widget_ask_events (
  widget_ask_event_id uuid primary key default gen_random_uuid(),
  tenant_widget_key_id uuid not null
    references public.tenant_widget_keys(tenant_widget_key_id),
  conversation_hash text not null check (conversation_hash ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz not null default now()
);
create index widget_ask_events_key_time_idx
  on app_private.widget_ask_events (tenant_widget_key_id, occurred_at desc);
create index widget_ask_events_conversation_time_idx
  on app_private.widget_ask_events (conversation_hash, occurred_at desc);
revoke all on table app_private.widget_ask_events
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------------ public bucket

-- Brand assets a widget must render on a third-party page cannot live in
-- tenant-private: an anonymous visitor has no session to sign a read with, and
-- granting anon SELECT on tenant-private would let anyone holding the
-- publishable key LIST the bucket and harvest tenant UUIDs from object paths.
--
-- So widget assets get their own public bucket whose object layout is keyed by
-- the WIDGET KEY, never the tenant id:
--   widget-public/<widget_key>/<asset_uuid>/<logo|avatar>.<ext>
-- Listing that bucket therefore discloses only strings that are already public
-- by construction. Only tenant owners and administrators may write, and only
-- under their own tenant's active widget key.
insert into storage.buckets (id, name, public, file_size_limit)
values ('widget-public', 'widget-public', true, 2097152)
on conflict (id) do nothing;

-- ------------------------------------------------------------------- helpers

create or replace function app_private.widget_generate_key()
returns text
language sql
volatile
security definer
set search_path = pg_catalog
as $$
  select 'wk_' || encode(extensions.gen_random_bytes(20), 'hex');
$$;
revoke execute on function app_private.widget_generate_key()
  from public, anon, authenticated, service_role;

create or replace function app_private.tenant_active_widget_key(
  target_tenant_id uuid
)
returns text
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select k.widget_key
  from public.tenant_widget_keys k
  where k.tenant_id = target_tenant_id
    and k.status = 'active'
    and k.deleted_at is null
  limit 1;
$$;
revoke execute on function app_private.tenant_active_widget_key(uuid)
  from public, anon, authenticated, service_role;

-- The storage policies below run as the calling role, so they need a callable
-- helper. It takes NO tenant parameter on purpose: a parameterised version
-- granted to authenticated would hand any signed-in user any tenant's widget
-- key just by passing a different uuid.
create or replace function app_private.current_tenant_widget_key()
returns text
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select app_private.tenant_active_widget_key(app_private.current_tenant_id());
$$;
revoke execute on function app_private.current_tenant_widget_key()
  from public, anon, service_role;
grant execute on function app_private.current_tenant_widget_key()
  to authenticated;

drop policy if exists widget_public_asset_write on storage.objects;
create policy widget_public_asset_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'widget-public'
    and app_private.has_any_role(array['owner', 'client_admin'])
    and (storage.foldername(name))[1]
      = app_private.current_tenant_widget_key()
  );

drop policy if exists widget_public_asset_delete on storage.objects;
create policy widget_public_asset_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'widget-public'
    and app_private.has_any_role(array['owner', 'client_admin'])
    and (storage.foldername(name))[1]
      = app_private.current_tenant_widget_key()
  );

-- Origin normalisation. Returns scheme://host[:port] lowercased, or null when
-- the candidate is anything else at all. Everything after the authority is
-- discarded rather than tolerated, so 'https://good.example.com.evil.test' and
-- 'https://good.example.com/../evil' can never normalise to an allowed value.
create or replace function app_private.widget_normalize_origin(
  candidate text
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog
as $$
declare
  trimmed text := lower(btrim(coalesce(candidate, '')));
  scheme text;
  authority text;
begin
  if trimmed = '' or length(trimmed) > 255 then
    return null;
  end if;
  if trimmed ~ '^https://' then
    scheme := 'https';
    authority := substring(trimmed from 9);
  elsif trimmed ~ '^http://' then
    scheme := 'http';
    authority := substring(trimmed from 8);
  else
    return null;
  end if;
  -- No path, query, fragment, credentials or whitespace may survive.
  if authority = '' or authority ~ '[/?#@[:space:]\\]' then
    return null;
  end if;
  -- host[:port], where host is a dotted DNS name, 'localhost' or 127.0.0.1.
  if authority !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:[0-9]{1,5})?$' then
    return null;
  end if;
  -- Plain http is only ever a local development affordance.
  if scheme = 'http'
    and split_part(authority, ':', 1) not in ('localhost', '127.0.0.1')
  then
    return null;
  end if;
  return scheme || '://' || authority;
end;
$$;
revoke execute on function app_private.widget_normalize_origin(text)
  from public, anon, authenticated, service_role;

-- An allowlist entry is either an exact normalised origin, or a wildcard the
-- tenant wrote themselves in the form 'https://*.example.com'. A wildcard
-- matches exactly the subdomains of that suffix and never the bare apex, never
-- a different scheme or port, and never a two-label public suffix such as
-- 'https://*.com' (which is refused when the setting is written and refused
-- again here).
create or replace function app_private.widget_origin_allowed(
  allowed_origins jsonb,
  candidate text
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  normalized text := app_private.widget_normalize_origin(candidate);
  entry text;
  entry_scheme text;
  entry_suffix text;
  candidate_scheme text;
  candidate_authority text;
begin
  if normalized is null
    or allowed_origins is null
    or jsonb_typeof(allowed_origins) <> 'array'
    or jsonb_array_length(allowed_origins) = 0
  then
    return false;
  end if;

  candidate_scheme := split_part(normalized, '://', 1);
  candidate_authority := split_part(normalized, '://', 2);

  for entry in
    select lower(btrim(value)) from jsonb_array_elements_text(allowed_origins)
  loop
    if entry is null or entry = '' then
      continue;
    end if;
    if position('*' in entry) = 0 then
      if entry = normalized then
        return true;
      end if;
      continue;
    end if;
    -- Wildcard form: <scheme>://*.<suffix with at least two labels>
    if entry !~ '^https://\*\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' then
      continue;
    end if;
    entry_scheme := 'https';
    entry_suffix := substring(entry from 11);
    if candidate_scheme = entry_scheme
      and candidate_authority <> entry_suffix
      and candidate_authority like ('%.' || entry_suffix)
      -- The wildcard covers hosts only: a port makes it a different origin.
      and position(':' in candidate_authority) = 0
    then
      return true;
    end if;
  end loop;

  return false;
end;
$$;
revoke execute on function app_private.widget_origin_allowed(jsonb, text)
  from public, anon, authenticated, service_role;

create or replace function app_private.widget_settings_defaults()
returns jsonb
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'enabled', false,
    'presentation', 'launcher',
    'launcherPosition', 'bottom-right',
    'launcherLabel', 'Ask',
    'greeting', 'How can I help you learn today?',
    'allowedOrigins', '[]'::jsonb,
    'anonymousQuestions', false,
    'showCourseList', false,
    'courseScope', '"all"'::jsonb,
    'fontFamily', 'system',
    'voiceEnabled', false,
    'logoObjectPath', null,
    'avatarObjectPath', null,
    'privacyUrl', null,
    'termsUrl', null,
    'supportUrl', null
  );
$$;
revoke execute on function app_private.widget_settings_defaults()
  from public, anon, authenticated, service_role;

-- tenant_branding.launcher has existed since migration 0004 and defaults to
-- '{}'. Merging over the defaults means every historical branding row already
-- has a complete, disabled-by-default widget configuration.
create or replace function app_private.widget_settings_effective(
  launcher_settings jsonb
)
returns jsonb
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select app_private.widget_settings_defaults()
    || coalesce(
      case
        when jsonb_typeof(launcher_settings) = 'object' then launcher_settings
        else '{}'::jsonb
      end,
      '{}'::jsonb
    );
$$;
revoke execute on function app_private.widget_settings_effective(jsonb)
  from public, anon, authenticated, service_role;

-- Opaque, widget-key-salted course identity. Two different widgets referring to
-- the same course produce two unrelated refs, and a ref lifted from one page
-- resolves to nothing on another.
create or replace function app_private.widget_course_ref(
  candidate_key text,
  target_course_id uuid
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select left(
    encode(
      extensions.digest(
        'widget-course' || chr(31) || candidate_key || chr(31)
          || target_course_id::text,
        'sha256'
      ),
      'hex'
    ),
    32
  );
$$;
revoke execute on function app_private.widget_course_ref(text, uuid)
  from public, anon, authenticated, service_role;

create or replace function app_private.widget_conversation_hash(
  candidate_key text,
  conversation_ref text
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select encode(
    extensions.digest(
      'widget-conversation' || chr(31) || candidate_key || chr(31)
        || conversation_ref,
      'sha256'
    ),
    'hex'
  );
$$;
revoke execute on function app_private.widget_conversation_hash(text, text)
  from public, anon, authenticated, service_role;

-- public.conversations.subject_user_id is NOT NULL and carries no foreign key
-- to auth.users. An anonymous visitor therefore gets a stable synthetic
-- subject derived from the same salted hash, which keeps one visitor's turns
-- together without ever inventing an auth identity for them. RLS on
-- public.conversations compares subject_user_id to auth.uid(), and this value
-- can never equal a real auth.uid() that a signed-in learner holds.
create or replace function app_private.widget_visitor_id(
  conversation_hash text
)
returns uuid
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select (
    substr(conversation_hash, 1, 8) || '-' ||
    substr(conversation_hash, 9, 4) || '-' ||
    substr(conversation_hash, 13, 4) || '-' ||
    substr(conversation_hash, 17, 4) || '-' ||
    substr(conversation_hash, 21, 12)
  )::uuid;
$$;
revoke execute on function app_private.widget_visitor_id(text)
  from public, anon, authenticated, service_role;

-- One resolution point for every public entrypoint. Returns zero rows for an
-- unknown key, a revoked key, a deleted or suspended tenant, an unpublished
-- branding chain, a disabled widget or a disallowed origin, so no caller can
-- tell those cases apart.
create or replace function app_private.widget_resolve(
  candidate_key text,
  candidate_origin text
)
returns table (
  tenant_id uuid,
  tenant_widget_key_id uuid,
  branding_id uuid,
  settings jsonb,
  assistant_name text,
  icon_glyph text,
  primary_color text,
  accent_color text,
  surface_color text,
  text_color text,
  welcome_message text,
  persona_instructions text,
  agent_tone text,
  agent_course_scope jsonb
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    k.tenant_id,
    k.tenant_widget_key_id,
    b.tenant_branding_id,
    app_private.widget_settings_effective(b.launcher),
    b.assistant_name,
    b.icon_glyph,
    b.primary_color,
    b.accent_color,
    b.surface_color,
    b.text_color,
    b.welcome_message,
    b.persona_instructions,
    coalesce(b.agent_tone, 'neutral'),
    coalesce(b.agent_course_scope, '"all"'::jsonb)
  from public.tenant_widget_keys k
  -- Suspension and deletion stop delivery immediately. 'provisioning' still
  -- serves, because a tenant that has explicitly enabled AND published a
  -- widget has made a deliberate choice that onboarding completion does not
  -- change.
  join public.tenants t
    on t.tenant_id = k.tenant_id
   and t.deleted_at is null
   and t.status not in ('suspended', 'deleted')
  join public.tenant_branding b
    on b.tenant_id = k.tenant_id
   and b.deleted_at is null
   and b.status = 'published'
  where candidate_key is not null
    and candidate_key ~ '^wk_[0-9a-f]{40}$'
    and k.widget_key = candidate_key
    and k.status = 'active'
    and k.deleted_at is null
    and coalesce(
      (app_private.widget_settings_effective(b.launcher) ->> 'enabled')
        ::boolean,
      false
    )
    and app_private.widget_origin_allowed(
      app_private.widget_settings_effective(b.launcher) -> 'allowedOrigins',
      candidate_origin
    )
  limit 1;
$$;
revoke execute on function app_private.widget_resolve(text, text)
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------- retrieval reuse

-- The hybrid ranking, extracted verbatim from migration 0023 so the widget and
-- the authenticated learner surface cannot drift apart. Two differences, both
-- deliberate:
--   * the tenant is a parameter instead of app_private.learning_rpc_context(),
--     because an anonymous caller has no session to derive it from;
--   * a null embedding degrades to the lexical half instead of failing, which
--     is the widget's real retrieval mode.
-- The publication filters (published course, active knowledge version,
-- published knowledge version, ready document) are unchanged.
create or replace function app_private.learning_chunk_matches(
  target_tenant_id uuid,
  search_query text,
  query_embedding extensions.vector(384),
  target_course_id uuid,
  match_limit integer,
  course_allowlist jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
#variable_conflict use_variable
declare
  normalized_query text;
  parsed_query tsquery;
  bounded_limit integer;
  scope jsonb := coalesce(course_allowlist, '"all"'::jsonb);
  matches jsonb;
  embedded_match_count integer;
begin
  if target_tenant_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_search_query');
  end if;

  normalized_query := regexp_replace(
    btrim(coalesce(search_query, '')),
    '[[:space:]]+',
    ' ',
    'g'
  );
  if length(normalized_query) < 2 or length(normalized_query) > 512 then
    return jsonb_build_object('ok', false, 'code', 'invalid_search_query');
  end if;
  if query_embedding is not null
    and extensions.vector_dims(query_embedding) <> 384 then
    return jsonb_build_object('ok', false, 'code', 'invalid_query_embedding');
  end if;

  bounded_limit := greatest(1, least(coalesce(match_limit, 6), 12));
  parsed_query := websearch_to_tsquery('english', normalized_query);

  with eligible as materialized (
    select
      ch.chunk_id,
      ch.course_id,
      c.title as course_title,
      ch.knowledge_version_id,
      ch.document_id,
      d.title as document_title,
      ch.ordinal,
      ch.body,
      ch.content_hash,
      ch.metadata,
      ch.embedding
    from public.learning_chunks ch
    join public.courses c
      on c.tenant_id = ch.tenant_id
     and c.course_id = ch.course_id
    join public.knowledge_versions kv
      on kv.tenant_id = ch.tenant_id
     and kv.knowledge_version_id = ch.knowledge_version_id
     and kv.course_id = ch.course_id
    join public.learning_documents d
      on d.tenant_id = ch.tenant_id
     and d.document_id = ch.document_id
     and d.course_id = ch.course_id
     and d.knowledge_version_id = ch.knowledge_version_id
    where ch.tenant_id = target_tenant_id
      and ch.deleted_at is null
      and c.deleted_at is null
      and c.status = 'published'
      and c.active_knowledge_version_id = ch.knowledge_version_id
      and kv.deleted_at is null
      and kv.status = 'published'
      and d.deleted_at is null
      and d.status = 'ready'
      and (target_course_id is null or ch.course_id = target_course_id)
      and (
        scope = '"all"'::jsonb
        or (
          jsonb_typeof(scope) = 'array'
          and scope ? ch.course_id::text
        )
      )
  ),
  lexical as (
    select
      e.chunk_id,
      row_number() over (
        order by
          ts_rank_cd(to_tsvector('english', e.body), parsed_query, 32) desc,
          e.chunk_id
      ) as lexical_rank
    from eligible e
    where numnode(parsed_query) > 0
      and querytree(parsed_query) not in ('', 'T')
      and to_tsvector('english', e.body) @@ parsed_query
    order by lexical_rank
    limit 50
  ),
  semantic as (
    select
      e.chunk_id,
      row_number() over (
        order by e.embedding <#> query_embedding, e.chunk_id
      ) as semantic_rank,
      -(e.embedding <#> query_embedding) as semantic_similarity
    from eligible e
    where query_embedding is not null
      and e.embedding is not null
    order by e.embedding <#> query_embedding, e.chunk_id
    limit 50
  ),
  fused as (
    select
      coalesce(l.chunk_id, s.chunk_id) as chunk_id,
      l.lexical_rank,
      s.semantic_rank,
      s.semantic_similarity,
      coalesce(1.0 / (60 + l.lexical_rank), 0.0)
        + coalesce(1.0 / (60 + s.semantic_rank), 0.0) as relevance
    from lexical l
    full join semantic s on s.chunk_id = l.chunk_id
  ),
  ranked_matches as (
    select
      e.*,
      f.relevance,
      f.lexical_rank,
      f.semantic_rank,
      f.semantic_similarity,
      case
        when f.lexical_rank is not null then ts_headline(
          'english',
          e.body,
          parsed_query,
          'MaxFragments=2,MaxWords=80,MinWords=20'
        )
        else left(e.body, 700)
      end as excerpt
    from fused f
    join eligible e on e.chunk_id = f.chunk_id
    order by
      f.relevance desc,
      f.semantic_similarity desc nulls last,
      e.course_id,
      e.document_id,
      e.ordinal,
      e.chunk_id
    limit bounded_limit
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'chunkId', chunk_id,
          'courseId', course_id,
          'courseTitle', course_title,
          'knowledgeVersionId', knowledge_version_id,
          'documentId', document_id,
          'documentTitle', document_title,
          'ordinal', ordinal,
          'contentHash', content_hash,
          'relevance', relevance,
          'lexicalRank', lexical_rank,
          'semanticRank', semantic_rank,
          'semanticSimilarity', semantic_similarity,
          'excerpt', excerpt,
          'source', jsonb_strip_nulls(jsonb_build_object(
            'courseSlug', metadata ->> 'courseSlug',
            'sectionName', metadata ->> 'sectionName',
            'lessonId', metadata ->> 'lessonId',
            'lessonName', metadata ->> 'lessonName',
            'startHms', metadata ->> 'startHms'
          ))
        )
        order by
          relevance desc,
          semantic_similarity desc nulls last,
          course_id,
          document_id,
          ordinal,
          chunk_id
      ),
      '[]'::jsonb
    ),
    count(*) filter (where semantic_rank is not null)
  into matches, embedded_match_count
  from ranked_matches;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'retrievalMode',
      case
        when embedded_match_count > 0 then 'hybrid'
        else 'lexical_degraded'
      end,
    'embeddingProvider', 'supabase',
    'embeddingModel', 'gte-small',
    'embeddingDimensions', 384,
    'query', normalized_query,
    'courseId', target_course_id,
    'matchLimit', bounded_limit,
    'matches', matches
  );
end;
$$;
revoke execute on function app_private.learning_chunk_matches(
  uuid, text, extensions.vector, uuid, integer, jsonb
) from public, anon, authenticated, service_role;

-- The authenticated hybrid search now delegates to the shared ranking instead
-- of carrying its own copy. Its contract is unchanged: it still derives the
-- tenant from the verified session and still refuses a missing embedding.
create or replace function public.learning_search_chunks_hybrid_v1(
  search_query text,
  query_embedding extensions.vector(384),
  target_course_id uuid default null,
  match_limit integer default 6
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;
  if query_embedding is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_query_embedding');
  end if;
  return app_private.learning_chunk_matches(
    caller.tenant_id,
    search_query,
    query_embedding,
    target_course_id,
    match_limit,
    '"all"'::jsonb
  );
end;
$$;
revoke execute on function public.learning_search_chunks_hybrid_v1(
  text, extensions.vector, uuid, integer
) from public, anon, authenticated, service_role;

-- --------------------------------------------------------------- rate limiting

-- Rolling-window limits, enforced before any write and before any retrieval.
-- Returns null when the request may proceed, otherwise the refusal payload.
create or replace function app_private.widget_rate_limit(
  target_key_id uuid,
  conversation_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  key_minute integer;
  key_hour integer;
  conversation_minute integer;
  conversation_hour integer;
  key_minute_cap constant integer := 30;
  key_hour_cap constant integer := 300;
  conversation_minute_cap constant integer := 8;
  conversation_hour_cap constant integer := 60;
begin
  -- Serialise concurrent asks for one key so a burst cannot race the counters.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('widget-rate:' || target_key_id::text, 0)
  );

  -- Bounded opportunistic pruning: the limiter never needs more than an hour
  -- of history, and nothing else reads this table.
  delete from app_private.widget_ask_events e
  where e.widget_ask_event_id in (
    select prune.widget_ask_event_id
    from app_private.widget_ask_events prune
    where prune.occurred_at < now() - interval '2 hours'
    limit 500
  );

  select
    count(*) filter (where e.occurred_at > now() - interval '1 minute'),
    count(*) filter (where e.occurred_at > now() - interval '1 hour')
  into key_minute, key_hour
  from app_private.widget_ask_events e
  where e.tenant_widget_key_id = target_key_id
    and e.occurred_at > now() - interval '1 hour';

  select
    count(*) filter (where e.occurred_at > now() - interval '1 minute'),
    count(*) filter (where e.occurred_at > now() - interval '1 hour')
  into conversation_minute, conversation_hour
  from app_private.widget_ask_events e
  where e.conversation_hash = widget_rate_limit.conversation_hash
    and e.occurred_at > now() - interval '1 hour';

  if conversation_minute >= conversation_minute_cap then
    return jsonb_build_object(
      'ok', false, 'code', 'rate_limited',
      'scope', 'conversation', 'retryAfterSeconds', 60
    );
  end if;
  if conversation_hour >= conversation_hour_cap then
    return jsonb_build_object(
      'ok', false, 'code', 'rate_limited',
      'scope', 'conversation', 'retryAfterSeconds', 3600
    );
  end if;
  if key_minute >= key_minute_cap then
    return jsonb_build_object(
      'ok', false, 'code', 'rate_limited',
      'scope', 'widget', 'retryAfterSeconds', 60
    );
  end if;
  if key_hour >= key_hour_cap then
    return jsonb_build_object(
      'ok', false, 'code', 'rate_limited',
      'scope', 'widget', 'retryAfterSeconds', 3600
    );
  end if;

  insert into app_private.widget_ask_events (
    tenant_widget_key_id, conversation_hash
  ) values (
    target_key_id, widget_rate_limit.conversation_hash
  );
  return null;
end;
$$;
revoke execute on function app_private.widget_rate_limit(uuid, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------- message semantics

-- The same append contract public.learning_record_user_message and
-- public.learning_record_assistant_message implement: idempotency key is
-- authoritative and replays the prior row, the sequence number is allocated
-- under a per-conversation advisory lock, and the conversation's updated_at
-- moves with the write. It exists as a helper because the learning_record_*
-- functions bind the writer to auth.uid(), which an anonymous visitor does not
-- have; the storage shape and the ordering rules are identical.
create or replace function app_private.widget_append_message(
  target_tenant_id uuid,
  target_conversation_id uuid,
  actor_type_value text,
  modality_value text,
  message_body text,
  structured jsonb,
  provider_key text,
  provider_request_ref text,
  trace_id text,
  idempotency_key text
)
returns public.messages
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  existing public.messages%rowtype;
  created public.messages%rowtype;
  next_sequence bigint;
begin
  select *
  into existing
  from public.messages m
  where m.tenant_id = target_tenant_id
    and m.idempotency_key = widget_append_message.idempotency_key;
  if found then
    if existing.conversation_id <> target_conversation_id
      or existing.actor_type <> actor_type_value
      or existing.body is distinct from message_body
    then
      raise unique_violation
        using message = 'The idempotency key has different message input';
    end if;
    return existing;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_conversation_id::text, 0)
  );
  select coalesce(max(m.sequence_number), -1) + 1
  into next_sequence
  from public.messages m
  where m.tenant_id = target_tenant_id
    and m.conversation_id = target_conversation_id;

  insert into public.messages (
    tenant_id, conversation_id, actor_id, actor_type, modality, status, body,
    structured_content, provider_key, provider_request_ref, trace_id,
    sequence_number, idempotency_key
  ) values (
    target_tenant_id,
    target_conversation_id,
    null,
    actor_type_value,
    modality_value,
    'final',
    message_body,
    structured,
    provider_key,
    provider_request_ref,
    trace_id,
    next_sequence,
    idempotency_key
  )
  returning * into created;

  update public.conversations
  set updated_at = statement_timestamp()
  where tenant_id = target_tenant_id
    and conversation_id = target_conversation_id;

  return created;
end;
$$;
revoke execute on function app_private.widget_append_message(
  uuid, uuid, text, text, text, jsonb, text, text, text, text
) from public, anon, authenticated, service_role;

-- Resolve, or create, the durable conversation behind a widget conversation
-- ref. The ref never appears in a payload and is stored only as its salted
-- digest, so the durable row cannot be correlated back to the browser value by
-- anyone reading the table.
create or replace function app_private.widget_conversation(
  target_tenant_id uuid,
  conversation_hash text,
  target_course_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  existing_id uuid;
  created public.conversations%rowtype;
  visitor uuid := app_private.widget_visitor_id(conversation_hash);
begin
  select c.conversation_id
  into existing_id
  from public.conversations c
  where c.tenant_id = target_tenant_id
    and c.idempotency_key = 'widget:' || conversation_hash
    and c.deleted_at is null;
  if found then
    return existing_id;
  end if;

  insert into public.conversations (
    tenant_id, subject_user_id, course_id, channel_state, status, title,
    metadata, idempotency_key
  ) values (
    target_tenant_id,
    visitor,
    target_course_id,
    'text',
    'active',
    'Embedded widget conversation',
    jsonb_build_object(
      'dataMode', 'durable',
      'grounding', 'published_tenant_knowledge',
      'channel', 'widget',
      'identityTier', 'anonymous'
    ),
    'widget:' || conversation_hash
  )
  on conflict (tenant_id, idempotency_key) where idempotency_key is not null
  do nothing
  returning * into created;

  if created.conversation_id is not null then
    return created.conversation_id;
  end if;

  select c.conversation_id
  into existing_id
  from public.conversations c
  where c.tenant_id = target_tenant_id
    and c.idempotency_key = 'widget:' || conversation_hash
    and c.deleted_at is null;
  return existing_id;
end;
$$;
revoke execute on function app_private.widget_conversation(uuid, text, uuid)
  from public, anon, authenticated, service_role;

create or replace function app_private.widget_audit(
  target_tenant_id uuid,
  actor_identity_role text,
  audit_action text,
  audit_decision text,
  audit_reason text,
  target_resource_id text,
  source_request_id text,
  source_trace_id text,
  source_change_ref text
)
returns void
language sql
security definer
set search_path = pg_catalog
as $$
  insert into public.audit_ledger (
    tenant_id, actor_id, actor_type, actor_role, action, resource_type,
    resource_id, policy_decision, decision_reason, change_ref, request_id,
    trace_id, retain_until, idempotency_key
  ) values (
    target_tenant_id,
    auth.uid(),
    case actor_identity_role
      when 'tenant_owner' then 'owner'
      when 'tenant_admin' then 'owner'
      else 'system'
    end,
    actor_identity_role,
    audit_action,
    'tenant_widget',
    target_resource_id,
    audit_decision,
    audit_reason,
    source_change_ref,
    source_request_id,
    source_trace_id,
    now() + interval '7 years',
    'widget-delivery-audit:' ||
      encode(
        extensions.digest(
          target_tenant_id::text || chr(31) || audit_action || chr(31) ||
          audit_decision || chr(31) || coalesce(source_request_id, '') ||
          chr(31) || coalesce(audit_reason, ''),
          'sha256'
        ),
        'hex'
      )
  )
  on conflict (tenant_id, idempotency_key) do nothing;
$$;
revoke execute on function app_private.widget_audit(
  uuid, text, text, text, text, text, text, text, text
) from public, anon, authenticated, service_role;

-- ------------------------------------------------------------ public delivery

-- Everything the runtime needs to paint itself, and nothing else. There is no
-- tenant id, no branding row id, no course id, no persona and no member data
-- anywhere in this payload; see A2 and A4 in the threat model.
create or replace function public.widget_bootstrap(
  widget_key text,
  origin text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  resolved record;
  settings jsonb;
  course_list jsonb := '[]'::jsonb;
begin
  select * into resolved
  from app_private.widget_resolve(widget_key, origin);
  if not found then
    -- One opaque answer for every failure mode. See A3.
    return jsonb_build_object('ok', false, 'code', 'widget_unavailable');
  end if;
  settings := resolved.settings;

  if coalesce((settings ->> 'showCourseList')::boolean, false) then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'courseRef',
            app_private.widget_course_ref(widget_key, listed.course_id),
          'title', listed.title
        )
        order by listed.title, listed.course_id
      ),
      '[]'::jsonb
    )
    into course_list
    from (
      select c.course_id, c.title
      from public.courses c
      where c.tenant_id = resolved.tenant_id
        and c.deleted_at is null
        and c.status = 'published'
        and (
          coalesce(settings -> 'courseScope', '"all"'::jsonb) = '"all"'::jsonb
          or (settings -> 'courseScope') ? c.course_id::text
        )
      order by c.title, c.course_id
      limit 50
    ) listed;
  end if;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'widget', jsonb_build_object(
      'presentation', settings ->> 'presentation',
      'launcherPosition', settings ->> 'launcherPosition',
      'launcherLabel', settings ->> 'launcherLabel',
      'greeting', settings ->> 'greeting',
      'anonymousQuestions',
        coalesce((settings ->> 'anonymousQuestions')::boolean, false),
      'courses', course_list
    ),
    'branding', jsonb_build_object(
      'assistantName', resolved.assistant_name,
      'iconGlyph', resolved.icon_glyph,
      'primaryColor', resolved.primary_color,
      'accentColor', resolved.accent_color,
      'surfaceColor', resolved.surface_color,
      'textColor', resolved.text_color,
      'fontFamily', settings ->> 'fontFamily',
      'welcomeCopy',
        coalesce(
          nullif(btrim(coalesce(settings ->> 'greeting', '')), ''),
          resolved.welcome_message
        ),
      'launcherLabel', settings ->> 'launcherLabel',
      'launcherPosition', settings ->> 'launcherPosition',
      'voiceEnabled', coalesce((settings ->> 'voiceEnabled')::boolean, false),
      'logoObjectPath', settings ->> 'logoObjectPath',
      'avatarObjectPath', settings ->> 'avatarObjectPath',
      'privacyUrl', settings ->> 'privacyUrl',
      'termsUrl', settings ->> 'termsUrl',
      'supportUrl', settings ->> 'supportUrl'
    )
  );
end;
$$;

-- Records the visitor's question and returns the inputs a grounded answer is
-- built from. It does NOT answer: no model runs in the database. It also never
-- returns a stored message, so a guessed conversation_ref is not a read
-- capability (A5).
--
-- operation_token is optional and browser callers never have one. When a valid
-- server-held token is presented, and only then, the tenant's persona and tone
-- are included so the application server can shape the answer (A4).
create or replace function public.widget_ask(
  widget_key text,
  origin text,
  question text,
  conversation_ref text,
  course_ref text,
  idempotency_key text,
  trace_id text,
  operation_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  resolved record;
  settings jsonb;
  conversation_hash text;
  conversation_id uuid;
  scoped_course_id uuid;
  limited jsonb;
  retrieval jsonb;
  recorded public.messages%rowtype;
  normalized_question text := btrim(coalesce(question, ''));
  trusted_server boolean;
begin
  select * into resolved
  from app_private.widget_resolve(widget_key, origin);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'widget_unavailable');
  end if;
  settings := resolved.settings;

  -- Anonymous asking is opt-in per tenant, and the refusal is the same opaque
  -- code so a disabled tenant is not distinguishable from an unknown key.
  if not coalesce((settings ->> 'anonymousQuestions')::boolean, false) then
    return jsonb_build_object('ok', false, 'code', 'widget_unavailable');
  end if;

  if length(normalized_question) not between 2 and 2000
    or conversation_ref is null
    or conversation_ref !~ '^[A-Za-z0-9_-]{32,128}$'
    or idempotency_key is null
    or length(idempotency_key) not between 8 and 200
    or trace_id is null
    or length(trace_id) not between 8 and 200
    or (course_ref is not null and course_ref !~ '^[0-9a-f]{32}$')
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  conversation_hash :=
    app_private.widget_conversation_hash(widget_key, conversation_ref);

  -- Before any write and before any retrieval. See A6.
  limited := app_private.widget_rate_limit(
    resolved.tenant_widget_key_id, conversation_hash
  );
  if limited is not null then
    return limited;
  end if;

  -- A course ref is resolved by re-deriving it, so a ref from another widget
  -- or another tenant simply matches nothing.
  if course_ref is not null then
    select c.course_id
    into scoped_course_id
    from public.courses c
    where c.tenant_id = resolved.tenant_id
      and c.deleted_at is null
      and c.status = 'published'
      and app_private.widget_course_ref(widget_key, c.course_id) = course_ref
    limit 1;
    if scoped_course_id is null then
      return jsonb_build_object('ok', false, 'code', 'invalid_request');
    end if;
  end if;

  conversation_id := app_private.widget_conversation(
    resolved.tenant_id, conversation_hash, scoped_course_id
  );
  if conversation_id is null then
    return jsonb_build_object('ok', false, 'code', 'request_denied');
  end if;

  recorded := app_private.widget_append_message(
    resolved.tenant_id,
    conversation_id,
    'student',
    'text',
    normalized_question,
    jsonb_build_object('channel', 'widget'),
    null,
    null,
    trace_id,
    'widget-user:' || conversation_hash || ':' || idempotency_key
  );

  -- The widget has no embedding worker of its own, so this is the lexical half
  -- of the shared ranking and it says so rather than claiming hybrid recall.
  retrieval := app_private.learning_chunk_matches(
    resolved.tenant_id,
    normalized_question,
    null::extensions.vector(384),
    scoped_course_id,
    6,
    case
      when settings -> 'courseScope' is null then resolved.agent_course_scope
      else settings -> 'courseScope'
    end
  );

  trusted_server := app_private.learning_operation_token_is_valid(
    'conversation.answer.record', operation_token
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'conversationRef', conversation_ref,
    'sequence', recorded.sequence_number,
    'assistantName', resolved.assistant_name,
    'retrievalMode', coalesce(retrieval ->> 'retrievalMode', 'unavailable'),
    'matches', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'sourceRef', match ->> 'contentHash',
            'courseTitle', match ->> 'courseTitle',
            'documentTitle', match ->> 'documentTitle',
            'lessonTitle', match -> 'source' ->> 'lessonName',
            'sectionName', match -> 'source' ->> 'sectionName',
            'excerpt', match ->> 'excerpt',
            'contentHash', match ->> 'contentHash'
          )
        )
        from jsonb_array_elements(coalesce(retrieval -> 'matches', '[]'::jsonb))
          as match
      ),
      '[]'::jsonb
    )
  ) || case
    when trusted_server then jsonb_build_object(
      'directive', jsonb_build_object(
        'personaInstructions', resolved.persona_instructions,
        'tone', resolved.agent_tone
      )
    )
    else '{}'::jsonb
  end;
end;
$$;

-- Durably records the answer the application server produced. Granted to anon
-- only because the server calls it with the publishable key; the actual gate is
-- the operation token, exactly as in
-- public.learning_record_assistant_message. A browser cannot forge a turn (A7).
create or replace function public.widget_record_answer(
  widget_key text,
  origin text,
  conversation_ref text,
  answer_body text,
  sources jsonb,
  provider_key text,
  provider_request_ref text,
  idempotency_key text,
  trace_id text,
  operation_token text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  resolved record;
  conversation_hash text;
  conversation_id uuid;
  recorded public.messages%rowtype;
  normalized_answer text := btrim(coalesce(answer_body, ''));
begin
  if not app_private.learning_operation_token_is_valid(
    'conversation.answer.record', operation_token
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select * into resolved
  from app_private.widget_resolve(widget_key, origin);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'widget_unavailable');
  end if;

  if length(normalized_answer) not between 1 and 16000
    or conversation_ref is null
    or conversation_ref !~ '^[A-Za-z0-9_-]{32,128}$'
    or sources is null
    or jsonb_typeof(sources) <> 'array'
    or jsonb_array_length(sources) > 12
    or provider_key is null
    or length(provider_key) not between 1 and 100
    or provider_request_ref is null
    or length(provider_request_ref) not between 1 and 256
    or idempotency_key is null
    or length(idempotency_key) not between 8 and 200
    or trace_id is null
    or length(trace_id) not between 8 and 200
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  conversation_hash :=
    app_private.widget_conversation_hash(widget_key, conversation_ref);

  select c.conversation_id
  into conversation_id
  from public.conversations c
  where c.tenant_id = resolved.tenant_id
    and c.idempotency_key = 'widget:' || conversation_hash
    and c.deleted_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  recorded := app_private.widget_append_message(
    resolved.tenant_id,
    conversation_id,
    'assistant',
    'text',
    normalized_answer,
    jsonb_build_object(
      'sources', sources,
      'grounding', 'published_tenant_knowledge',
      'channel', 'widget'
    ),
    provider_key,
    provider_request_ref,
    trace_id,
    'widget-assistant:' || conversation_hash || ':' || idempotency_key
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'conversationRef', conversation_ref,
    'sequence', recorded.sequence_number
  );
end;
$$;

-- ---------------------------------------------------------------- administration

create or replace function public.tenant_get_widget_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  head public.tenant_branding%rowtype;
  published_row public.tenant_branding%rowtype;
  active_key text;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;
  if caller.identity_role not in ('tenant_owner', 'tenant_admin') then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select b.* into head
  from public.tenant_branding b
  where b.tenant_id = caller.tenant_id
    and b.deleted_at is null
  order by b.version_number desc
  limit 1;

  select b.* into published_row
  from public.tenant_branding b
  where b.tenant_id = caller.tenant_id
    and b.deleted_at is null
    and b.status = 'published'
  order by b.version_number desc
  limit 1;

  active_key := app_private.tenant_active_widget_key(caller.tenant_id);

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', caller.tenant_id,
    'expectedVersion', coalesce(head.version_number, 0),
    'widgetKey', active_key,
    'assetPrefix', case
      when active_key is null then null else active_key || '/'
    end,
    'assetBucket', 'widget-public',
    'defaults', app_private.widget_settings_defaults(),
    'settings', app_private.widget_settings_effective(head.launcher),
    'publishedSettings', case
      when published_row.tenant_branding_id is null then null
      else app_private.widget_settings_effective(published_row.launcher)
    end,
    'liveStatus', case
      when active_key is null then 'no_key'
      when published_row.tenant_branding_id is null then 'not_published'
      when coalesce(
        (
          app_private.widget_settings_effective(published_row.launcher)
            ->> 'enabled'
        )::boolean,
        false
      ) then 'live'
      else 'disabled'
    end
  );
end;
$$;

create or replace function public.tenant_update_widget_settings(
  requested_enabled boolean,
  requested_presentation text,
  requested_launcher_position text,
  requested_launcher_label text,
  requested_greeting text,
  requested_allowed_origins jsonb,
  requested_anonymous_questions boolean,
  requested_show_course_list boolean,
  requested_course_scope jsonb,
  requested_font_family text,
  requested_voice_enabled boolean,
  requested_logo_object_path text,
  requested_avatar_object_path text,
  requested_privacy_url text,
  requested_terms_url text,
  requested_support_url text,
  requested_rotate_key boolean,
  requested_publish boolean,
  expected_version integer,
  idempotency_key text,
  request_id text,
  trace_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  command record;
  head public.tenant_branding%rowtype;
  written public.tenant_branding%rowtype;
  result jsonb;
  request_fingerprint text;
  settings jsonb;
  normalized_origins jsonb := '[]'::jsonb;
  origin_entry text;
  normalized_entry text;
  active_key text;
  next_version integer;
  unknown_courses integer;
  asset_prefix text;
  normalized_presentation text := lower(
    btrim(coalesce(requested_presentation, 'launcher'))
  );
  normalized_position text := lower(
    btrim(coalesce(requested_launcher_position, 'bottom-right'))
  );
  normalized_font text := lower(
    btrim(coalesce(requested_font_family, 'system'))
  );
  normalized_label text := btrim(coalesce(requested_launcher_label, 'Ask'));
  normalized_greeting text := btrim(coalesce(requested_greeting, ''));
  normalized_scope jsonb := coalesce(requested_course_scope, '"all"'::jsonb);
  normalized_logo text := nullif(
    btrim(coalesce(requested_logo_object_path, '')), ''
  );
  normalized_avatar text := nullif(
    btrim(coalesce(requested_avatar_object_path, '')), ''
  );
  normalized_privacy text := nullif(
    btrim(coalesce(requested_privacy_url, '')), ''
  );
  normalized_terms text := nullif(
    btrim(coalesce(requested_terms_url, '')), ''
  );
  normalized_support text := nullif(
    btrim(coalesce(requested_support_url, '')), ''
  );
  publish_requested boolean := coalesce(requested_publish, false);
  rotate_requested boolean := coalesce(requested_rotate_key, false);
  scope_uuid_pattern constant text :=
    '^\[\s*"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}'
    || '-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"'
    || '(\s*,\s*"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}'
    || '-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")*\s*\]$';
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;
  if request_id is null or length(request_id) not between 1 and 200
    or trace_id is null or length(trace_id) not between 1 and 200
    or idempotency_key is null
    or length(idempotency_key) not between 1 and 256
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if caller.identity_role not in ('tenant_owner', 'tenant_admin') then
    perform app_private.widget_audit(
      caller.tenant_id, caller.identity_role, 'widget.settings.update',
      'deny', 'role_not_allowed', caller.tenant_id::text,
      request_id, trace_id, null::text
    );
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  -- Origins are normalised here, once, so the allowlist stored on the branding
  -- row is already in the exact form the public matcher compares against. An
  -- entry that will not normalise is a refusal, never a silent drop.
  if requested_allowed_origins is not null then
    if jsonb_typeof(requested_allowed_origins) <> 'array'
      or jsonb_array_length(requested_allowed_origins) > 20
    then
      return jsonb_build_object('ok', false, 'code', 'invalid_request');
    end if;
    for origin_entry in
      select value from jsonb_array_elements_text(requested_allowed_origins)
    loop
      if origin_entry ~ '^https://\*\.' then
        -- Wildcards must be written explicitly and must keep at least two
        -- labels after the star, so '*.com' can never be configured.
        if lower(btrim(origin_entry)) !~
          '^https://\*\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
        then
          return jsonb_build_object('ok', false, 'code', 'invalid_origin');
        end if;
        normalized_entry := lower(btrim(origin_entry));
      else
        normalized_entry := app_private.widget_normalize_origin(origin_entry);
        if normalized_entry is null then
          return jsonb_build_object('ok', false, 'code', 'invalid_origin');
        end if;
      end if;
      if not normalized_origins ? normalized_entry then
        normalized_origins := normalized_origins
          || to_jsonb(normalized_entry);
      end if;
    end loop;
  end if;

  if normalized_presentation not in ('launcher', 'panel')
    or normalized_position not in ('bottom-left', 'bottom-right')
    or normalized_font not in ('system', 'rounded', 'serif')
    or length(normalized_label) not between 1 and 40
    or (normalized_greeting <> '' and length(normalized_greeting) > 500)
    or expected_version is null
    or expected_version < 0
    or (
      normalized_scope <> '"all"'::jsonb
      and (
        jsonb_typeof(normalized_scope) <> 'array'
        or jsonb_array_length(normalized_scope) not between 1 and 200
        or normalized_scope::text !~ scope_uuid_pattern
      )
    )
    or (
      normalized_privacy is not null
      and normalized_privacy !~ '^https://[^[:space:]]{3,500}$'
    )
    or (
      normalized_terms is not null
      and normalized_terms !~ '^https://[^[:space:]]{3,500}$'
    )
    or (
      normalized_support is not null
      and normalized_support !~ '^https://[^[:space:]]{3,500}$'
    )
    or (
      coalesce(requested_enabled, false)
      and jsonb_array_length(normalized_origins) = 0
    )
  then
    perform app_private.widget_audit(
      caller.tenant_id, caller.identity_role, 'widget.settings.update',
      'deny', 'invalid_request', caller.tenant_id::text,
      request_id, trace_id, null::text
    );
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  if normalized_scope <> '"all"'::jsonb then
    select count(*)::integer into unknown_courses
    from jsonb_array_elements_text(normalized_scope) as scoped(course_ref)
    where not exists (
      select 1
      from public.courses c
      where c.tenant_id = caller.tenant_id
        and c.course_id = scoped.course_ref::uuid
        and c.deleted_at is null
    );
    if unknown_courses > 0 then
      return jsonb_build_object('ok', false, 'code', 'course_scope_invalid');
    end if;
  end if;

  request_fingerprint := encode(
    extensions.digest(
      concat_ws(
        chr(31),
        coalesce(requested_enabled, false)::text,
        normalized_presentation,
        normalized_position,
        normalized_label,
        normalized_greeting,
        normalized_origins::text,
        coalesce(requested_anonymous_questions, false)::text,
        coalesce(requested_show_course_list, false)::text,
        normalized_scope::text,
        normalized_font,
        coalesce(requested_voice_enabled, false)::text,
        coalesce(normalized_logo, ''),
        coalesce(normalized_avatar, ''),
        coalesce(normalized_privacy, ''),
        coalesce(normalized_terms, ''),
        coalesce(normalized_support, ''),
        rotate_requested::text,
        publish_requested::text,
        expected_version::text
      ),
      'sha256'
    ),
    'hex'
  );
  select * into command
  from app_private.onboarding_begin_command(
    caller.tenant_id, 'widget.settings', idempotency_key,
    request_fingerprint, 'tenant_update_widget_settings'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    perform app_private.widget_audit(
      caller.tenant_id, caller.identity_role, 'widget.settings.update',
      'deny', 'idempotency_conflict', caller.tenant_id::text,
      request_id, trace_id, null::text
    );
    return jsonb_build_object('ok', false, 'code', 'idempotency_conflict');
  end if;

  -- Serialise concurrent edits on the tenant row so neither the branding
  -- version chain nor the single-active-key invariant can fork.
  perform 1
  from public.tenants t
  where t.tenant_id = caller.tenant_id
    and t.deleted_at is null
  for update;
  if not found then
    result := jsonb_build_object('ok', false, 'code', 'tenant_not_found');
    perform app_private.onboarding_complete_command(
      caller.tenant_id, 'widget.settings', idempotency_key, result
    );
    return result;
  end if;

  select b.* into head
  from public.tenant_branding b
  where b.tenant_id = caller.tenant_id
    and b.deleted_at is null
  order by b.version_number desc
  limit 1;

  if head.tenant_branding_id is null then
    result := jsonb_build_object('ok', false, 'code', 'branding_required');
    perform app_private.onboarding_complete_command(
      caller.tenant_id, 'widget.settings', idempotency_key, result
    );
    return result;
  end if;

  if coalesce(head.version_number, 0) <> expected_version then
    result := jsonb_build_object(
      'ok', false,
      'code', 'version_conflict',
      'currentVersion', coalesce(head.version_number, 0)
    );
    perform app_private.widget_audit(
      caller.tenant_id, caller.identity_role, 'widget.settings.update',
      'deny', 'version_conflict', caller.tenant_id::text,
      request_id, trace_id, null::text
    );
    perform app_private.onboarding_complete_command(
      caller.tenant_id, 'widget.settings', idempotency_key, result
    );
    return result;
  end if;

  -- Mint the key on first use, or rotate it on request. Rotation revokes the
  -- previous key in the same transaction, so a leaked key stops working the
  -- moment the tenant replaces it.
  active_key := app_private.tenant_active_widget_key(caller.tenant_id);
  if active_key is null or rotate_requested then
    update public.tenant_widget_keys
    set status = 'revoked', revoked_at = clock_timestamp()
    where tenant_id = caller.tenant_id
      and status = 'active'
      and deleted_at is null;
    insert into public.tenant_widget_keys (
      tenant_id, widget_key, status, idempotency_key
    ) values (
      caller.tenant_id,
      app_private.widget_generate_key(),
      'active',
      'widget-key:' ||
        encode(
          extensions.digest(
            caller.tenant_id::text || chr(31) ||
            tenant_update_widget_settings.idempotency_key,
            'sha256'
          ),
          'hex'
        )
    );
    active_key := app_private.tenant_active_widget_key(caller.tenant_id);
  end if;

  asset_prefix := active_key || '/';
  if (
    normalized_logo is not null
    and (
      normalized_logo not like asset_prefix || '%'
      or normalized_logo like '%..%'
      or length(normalized_logo) > 1024
    )
  ) or (
    normalized_avatar is not null
    and (
      normalized_avatar not like asset_prefix || '%'
      or normalized_avatar like '%..%'
      or length(normalized_avatar) > 1024
    )
  ) then
    result := jsonb_build_object('ok', false, 'code', 'invalid_asset_path');
    perform app_private.onboarding_complete_command(
      caller.tenant_id, 'widget.settings', idempotency_key, result
    );
    return result;
  end if;

  settings := app_private.widget_settings_defaults() || jsonb_build_object(
    'enabled', coalesce(requested_enabled, false),
    'presentation', normalized_presentation,
    'launcherPosition', normalized_position,
    'launcherLabel', normalized_label,
    'greeting', nullif(normalized_greeting, ''),
    'allowedOrigins', normalized_origins,
    'anonymousQuestions', coalesce(requested_anonymous_questions, false),
    'showCourseList', coalesce(requested_show_course_list, false),
    'courseScope', normalized_scope,
    'fontFamily', normalized_font,
    'voiceEnabled', coalesce(requested_voice_enabled, false),
    'logoObjectPath', normalized_logo,
    'avatarObjectPath', normalized_avatar,
    'privacyUrl', normalized_privacy,
    'termsUrl', normalized_terms,
    'supportUrl', normalized_support
  );

  select coalesce(max(b.version_number), 0) + 1
  into next_version
  from public.tenant_branding b
  where b.tenant_id = caller.tenant_id;

  if publish_requested then
    update public.tenant_branding
    set status = 'retired'
    where tenant_id = caller.tenant_id
      and status = 'published';
  end if;

  insert into public.tenant_branding (
    tenant_id, status, version_number, assistant_name, icon_glyph,
    logo_storage_key, avatar_storage_key, primary_color, accent_color,
    surface_color, text_color, launcher, welcome_message, voice_configuration,
    privacy_copy, persona_instructions, agent_tone, agent_voice,
    agent_course_scope, published_by, published_at, idempotency_key
  ) values (
    caller.tenant_id,
    case when publish_requested then 'published' else 'draft' end,
    next_version,
    head.assistant_name,
    head.icon_glyph,
    head.logo_storage_key,
    head.avatar_storage_key,
    head.primary_color,
    head.accent_color,
    head.surface_color,
    head.text_color,
    settings,
    head.welcome_message,
    coalesce(head.voice_configuration, '{}'::jsonb),
    head.privacy_copy,
    head.persona_instructions,
    head.agent_tone,
    head.agent_voice,
    coalesce(head.agent_course_scope, '"all"'::jsonb),
    case when publish_requested then auth.uid() else null end,
    case when publish_requested then clock_timestamp() else null end,
    'widget-settings:' ||
      encode(
        extensions.digest(
          caller.tenant_id::text || chr(31) ||
          tenant_update_widget_settings.idempotency_key,
          'sha256'
        ),
        'hex'
      )
  )
  returning * into written;

  result := jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'tenantId', caller.tenant_id,
    'expectedVersion', written.version_number,
    'status', written.status,
    'widgetKey', active_key,
    'assetPrefix', asset_prefix,
    'assetBucket', 'widget-public',
    'settings', settings
  );
  perform app_private.widget_audit(
    caller.tenant_id, caller.identity_role, 'widget.settings.update',
    'allow',
    case when publish_requested then 'published' else 'draft_saved' end,
    written.tenant_branding_id::text, request_id, trace_id,
    'widget-settings:' || request_fingerprint
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id, 'widget.settings', idempotency_key, result
  );
  return result;
end;
$$;

-- --------------------------------------------------------------------- grants

-- The three public widget functions are the ONLY objects in this schema granted
-- to anon. They are the anonymous-visitor surface and each one re-derives its
-- tenant from the widget key and re-checks the origin on every call. Nothing
-- else here reaches anon: the helpers stay private, the tables carry a
-- restrictive anon denial, and the administrative RPCs are authenticated-only.
revoke execute on function public.widget_bootstrap(text, text)
  from public, authenticated, service_role;
revoke execute on function public.widget_ask(
  text, text, text, text, text, text, text, text
) from public, authenticated, service_role;
revoke execute on function public.widget_record_answer(
  text, text, text, text, jsonb, text, text, text, text, text
) from public, authenticated, service_role;
grant execute on function public.widget_bootstrap(text, text) to anon;
grant execute on function public.widget_ask(
  text, text, text, text, text, text, text, text
) to anon;
grant execute on function public.widget_record_answer(
  text, text, text, text, jsonb, text, text, text, text, text
) to anon;

revoke execute on function public.tenant_get_widget_settings()
  from public, anon, service_role;
revoke execute on function public.tenant_update_widget_settings(
  boolean, text, text, text, text, jsonb, boolean, boolean, jsonb, text,
  boolean, text, text, text, text, text, boolean, boolean, integer, text,
  text, text
) from public, anon, service_role;
grant execute on function public.tenant_get_widget_settings()
  to authenticated;
grant execute on function public.tenant_update_widget_settings(
  boolean, text, text, text, text, jsonb, boolean, boolean, jsonb, text,
  boolean, text, text, text, text, text, boolean, boolean, integer, text,
  text, text
) to authenticated;

commit;

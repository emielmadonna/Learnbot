-- Widget analytics: a surface dimension for every recorded question.
--
-- WHAT WAS MISSING. Nothing in the schema recorded WHERE a question was asked.
-- public.messages.modality is text | voice_transcript | tool | system - how the
-- learner spoke, not where they were standing. public.conversations.channel_state
-- is text | voice_connecting | voice_listening | ... - a voice transport state,
-- not a surface. So the moment the embeddable widget starts answering questions,
-- its traffic is indistinguishable from console traffic and every existing
-- analytic silently blends the two. Worse, the widget admits anonymous visitors
-- while public.analytics_tenant_overview counts active learners as distinct
-- conversation subjects, so an anonymous asker would have been miscounted or
-- dropped with nothing on the surface to say so.
--
-- WHAT 20260726093000 ACTUALLY WRITES, AND HOW THIS READS IT.
-- The widget delivery path opens its conversation through
-- app_private.widget_conversation, which records metadata.channel = 'widget'
-- and, for an unauthenticated visitor, metadata.identityTier = 'anonymous'
-- plus a SYNTHETIC subject_user_id derived from the salted digest of the
-- widget's own conversation reference. It records no host page:
-- public.widget_bootstrap verifies the calling origin but does not persist it,
-- and public.widget_ask carries no page context at all. Three consequences
-- follow, and all three are handled here rather than papered over.
--   * The surface is read from metadata.channel, not duplicated. The explicit
--     public.conversation_surfaces row below is the richer path - it is the
--     only place a host page can come from - and it wins when present.
--   * The synthetic subject means the pre-existing activeLearners figure
--     silently mixes authenticated people with unauthenticated browsers. Its
--     value is left exactly as it was, because changing it would break every
--     caller, but it now carries the caveat and the verified split beside it.
--   * Host page metrics report "(origin not recorded)" for a conversation the
--     delivery path opened without calling
--     public.learning_record_conversation_surface. That is a stated absence,
--     never a guessed page.
--
-- WHAT THIS ADDS.
--   1. public.conversation_surfaces - one row per conversation recording the
--      surface (console | widget | api), the widget key and host page context
--      the widget runtime already models (WidgetPageContext in
--      packages/widget-runtime/src/index.ts), and a pseudonymous key for an
--      anonymous visitor.
--   2. Surface-aware analytics. Every existing metric can be split by surface,
--      plus widget engagement, widget grounding coverage and a deflection list.
--   3. Three widget-aware detectors added to the existing analytics_signals
--      family. They are composed onto app_private.question_signal_detections,
--      not forked from it, so public.analytics_signals and
--      public.analytics_signal_review pick them up with no further change.
--
-- HONESTY BOUNDARY. This file inherits the MetricResult envelope from
-- 20260725121000 (state / value / dataThrough / evidenceRefs / limitations) and
-- adds three rules that the surface dimension specifically needs.
--
--   * BACKFILL IS AN INFERENCE, AND IT SAYS SO. Every conversation that existed
--     before this migration is backfilled to 'console'. That is not a recorded
--     observation - no surface was recorded then. It is true because the console
--     was factually the only surface that existed: public.learning_start_conversation
--     was the only path that could create a conversation, and it is the console
--     path. Those rows carry attribution_source = 'backfilled_console' and every
--     surface metric reports how many of its rows are recorded versus inferred.
--
--   * A PRE-WIDGET RANGE IS UNKNOWN, NOT ZERO. Surface attribution began at the
--     moment this migration was applied (app_private.surface_attribution_epoch()).
--     A widget metric requested for a range that ends before that instant is
--     returned as 'unknown' with the reason, never as a value of zero. Zero would
--     assert "nobody used the widget", which is a different and unfounded claim
--     from "the platform was not recording it yet". A range that straddles the
--     epoch is 'partial' and names the uncovered portion.
--
--   * AN ANONYMOUS VISITOR IS NOT A LEARNER, AND IS NEVER ADDED TO ONE.
--     Anonymous widget askers are counted as their own figure, from a
--     pseudonymous key, and are never merged into the verified-learner count.
--     The key is an HMAC of the widget's own opaque conversation reference under
--     a per-database pepper that no client role can read; no fingerprint, IP,
--     user agent or any other identifying input is involved, the reference
--     itself is never stored, and the key is never emitted by any RPC - only
--     counts of distinct keys are. There is deliberately no path from a number
--     on this surface back to a person.
--
-- BACKWARD COMPATIBILITY. public.analytics_tenant_overview,
-- public.analytics_question_distribution and public.analytics_answer_quality
-- keep their exact two-argument signatures, grants and JSON shape. The surface
-- filter arrives as a THIRD, REQUIRED parameter on a separate overload, so a
-- two-argument call can never become ambiguous and the existing console
-- wrappers in apps/console/src/lib/supabase/analytics-rpc.ts are untouched. The
-- two-argument functions now delegate to the three-argument ones with a null
-- filter, which is exactly their previous behaviour, and every addition to the
-- returned JSON is a new key beside the existing ones.
--
-- NOT ATTEMPTED, AND WHY:
--   * per-question surface. A question inherits the surface of its conversation.
--     The widget records questions through the existing
--     public.learning_record_user_message semantics, which carry no surface
--     argument, so a per-message surface column would be a column nothing writes.
--     A conversation cannot move between surfaces, so nothing is lost.
--   * widget session duration, scroll depth, dwell or bounce. No client
--     telemetry of that kind is persisted anywhere.
--   * de-anonymising an anonymous visitor. Refused by design, not unimplemented.

begin;

-- ------------------------------------------------------- attribution settings

-- One row, created now, holding the two facts every honest surface answer needs:
-- when attribution started, and the pepper the pseudonymous visitor key is
-- derived under. Neither is readable by any client role.
create table app_private.surface_attribution_settings (
  singleton boolean primary key default true check (singleton),
  attribution_started_at timestamptz not null default now(),
  visitor_pepper text not null
    default encode(extensions.gen_random_bytes(32), 'hex'),
  created_at timestamptz not null default now()
);
revoke all on table app_private.surface_attribution_settings
  from public, anon, authenticated, service_role;

insert into app_private.surface_attribution_settings (singleton)
values (true)
on conflict (singleton) do nothing;

-- The instant surface recording became possible. Anything before it is an
-- inference about the past, and every RPC below labels it as one.
create or replace function app_private.surface_attribution_epoch()
returns timestamptz
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select s.attribution_started_at
  from app_private.surface_attribution_settings s
  where s.singleton;
$$;
revoke execute on function app_private.surface_attribution_epoch()
  from public, anon, authenticated, service_role;

-- Pseudonymous visitor key.
--
-- Input is the widget's own conversation reference: an opaque token the widget
-- generated and stored in the visitor's browser. It carries no personal data to
-- begin with, and it is not stored here - only this digest is. The per-database
-- pepper means the digest cannot be recomputed from a guessed reference by
-- anyone without database-superuser access, and no RPC in this file ever emits
-- the digest itself. The result answers "how many distinct visitors" and
-- nothing else.
create or replace function app_private.surface_visitor_key(
  target_tenant_id uuid,
  visitor_ref text
)
returns text
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select encode(
    extensions.hmac(
      target_tenant_id::text || chr(31) || visitor_ref,
      s.visitor_pepper,
      'sha256'
    ),
    'hex'
  )
  from app_private.surface_attribution_settings s
  where s.singleton
    and visitor_ref is not null
    and length(btrim(visitor_ref)) between 8 and 200;
$$;
revoke execute on function app_private.surface_visitor_key(uuid, text)
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------------- storage

-- One row per conversation. The surface is a property of the conversation, not
-- of a turn, because a conversation is opened on exactly one surface.
--
-- host_path holds the PATH ONLY of WidgetPageContext.href. The query string and
-- fragment are dropped by public.learning_record_conversation_surface before
-- they reach this table: a host page's query string routinely carries session
-- tokens, email addresses and campaign identifiers, and analytics has no need
-- of any of them.
create table public.conversation_surfaces (
  surface_record_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  conversation_id uuid not null,
  surface text not null check (surface in ('console', 'widget', 'api')),
  widget_key text check (widget_key is null or length(widget_key) between 1 and 120),
  host_origin text
    check (host_origin is null or host_origin ~ '^https?://[a-z0-9._:\-\[\]]{1,180}$'),
  host_path text
    check (host_path is null or (host_path ~ '^/' and length(host_path) <= 300)),
  host_page_title text
    check (host_page_title is null or length(host_page_title) between 1 and 300),
  visitor_key text check (visitor_key is null or visitor_key ~ '^[0-9a-f]{64}$'),
  visitor_identity text not null default 'verified_learner'
    check (visitor_identity in ('verified_learner', 'anonymous_visitor')),
  attribution_source text not null
    check (attribution_source in ('recorded', 'backfilled_console')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null
    check (length(idempotency_key) between 8 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, conversation_id)
    references public.conversations(tenant_id, conversation_id),
  unique (tenant_id, conversation_id),
  unique (tenant_id, idempotency_key),
  -- Only a widget conversation carries widget or host-page context.
  check (
    surface = 'widget'
    or (
      widget_key is null
      and host_origin is null
      and host_path is null
      and host_page_title is null
    )
  ),
  -- Only the widget admits anonymous visitors, and only an anonymous visitor
  -- has a pseudonymous key: a verified learner is already counted by the
  -- conversation subject and must never acquire a second identity here.
  check (visitor_identity = 'verified_learner' or surface = 'widget'),
  check (visitor_identity = 'anonymous_visitor' or visitor_key is null),
  check (last_seen_at >= first_seen_at)
);
create index conversation_surfaces_surface_idx
  on public.conversation_surfaces (tenant_id, surface, last_seen_at desc)
  where deleted_at is null;
create index conversation_surfaces_page_idx
  on public.conversation_surfaces (tenant_id, host_origin, host_path)
  where deleted_at is null and surface = 'widget';
create index conversation_surfaces_visitor_idx
  on public.conversation_surfaces (tenant_id, visitor_key)
  where deleted_at is null and visitor_key is not null;

create trigger conversation_surfaces_touch
before update on public.conversation_surfaces
for each row execute function app_private.set_updated_at_and_version();

alter table public.conversation_surfaces enable row level security;
alter table public.conversation_surfaces force row level security;

-- No client role reads this table directly, not even a tenant administrator.
-- That is the privacy boundary: visitor_key never leaves the database, and the
-- analytics RPCs below emit only counts of distinct keys. Reading a surface
-- goes through app_private.conversation_surface_view, which the SECURITY
-- DEFINER analytics functions call on the caller's behalf.
create policy conversation_surfaces_no_direct_access
  on public.conversation_surfaces
  as restrictive
  for all to authenticated
  using (false)
  with check (false);

create policy conversation_surfaces_deny_anon on public.conversation_surfaces
  as restrictive
  for all to anon
  using (false)
  with check (false);

revoke all on public.conversation_surfaces
  from public, anon, authenticated, service_role;

-- Backfill. Every conversation that already exists was opened through
-- public.learning_start_conversation, which is the console path and was the
-- only path that existed. attribution_source records that this is a statement
-- about which surfaces existed, not a recorded observation of one.
insert into public.conversation_surfaces (
  tenant_id,
  conversation_id,
  surface,
  visitor_identity,
  attribution_source,
  first_seen_at,
  last_seen_at,
  idempotency_key
)
select
  c.tenant_id,
  c.conversation_id,
  'console',
  'verified_learner',
  'backfilled_console',
  c.started_at,
  greatest(c.updated_at, c.started_at),
  'surface-backfill:' || c.conversation_id::text
from public.conversations c
where c.deleted_at is null
  -- A conversation the widget delivery path already created is excluded: it
  -- carries its own surface on the conversation record and must never be
  -- rewritten as console by a backfill that assumes it predates the widget.
  and coalesce(c.metadata ->> 'channel', '') <> 'widget'
  and coalesce(c.metadata ->> 'surface', '') <> 'widget'
  and coalesce(c.idempotency_key, '') not like 'widget:%'
on conflict (tenant_id, conversation_id) do nothing;

-- ----------------------------------------------------------------- write path

-- Records the surface a conversation was opened on.
--
-- Two callers are legitimate and both are checked here.
--   * The server-side answer path, holding the 'conversation.answer.record'
--     operation token. This is the widget's path: an anonymous visitor has no
--     membership at all, so the token - which lives only in the application
--     server environment and never in a browser - is the boundary. No new
--     capability is minted, because the same server path already holds this one.
--   * The conversation's own subject, through the ordinary tenant context. A
--     learner can only ever describe their own conversation, and the console is
--     the surface they are on.
-- A browser session that is neither of those changes nothing.
create or replace function public.learning_record_conversation_surface(
  target_conversation_id uuid,
  surface_name text,
  widget_key text,
  host_href text,
  host_page_title text,
  visitor_ref text,
  visitor_is_anonymous boolean,
  trace_id text,
  idempotency_key text,
  operation_token text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  conversation_record record;
  caller record;
  token_ok boolean;
  normalized_surface text := lower(btrim(coalesce(surface_name, '')));
  normalized_key text := nullif(btrim(coalesce(widget_key, '')), '');
  normalized_title text := nullif(btrim(coalesce(host_page_title, '')), '');
  resolved_origin text;
  resolved_path text;
  resolved_identity text;
  resolved_visitor_key text;
  href_body text;
  href_authority text;
  href_rest text;
  existing public.conversation_surfaces%rowtype;
  written public.conversation_surfaces%rowtype;
begin
  if target_conversation_id is null
    or normalized_surface not in ('console', 'widget', 'api')
    or trace_id is null
    or length(trace_id) not between 8 and 200
    or idempotency_key is null
    or length(idempotency_key) not between 8 and 200
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select c.tenant_id, c.conversation_id, c.subject_user_id, c.started_at
  into conversation_record
  from public.conversations c
  where c.conversation_id = target_conversation_id
    and c.deleted_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'conversation_not_found');
  end if;

  token_ok := app_private.learning_operation_token_is_valid(
    'conversation.answer.record', operation_token
  );
  if not token_ok then
    select * into caller from app_private.learning_rpc_context();
    if not found
      or caller.tenant_id <> conversation_record.tenant_id
      or conversation_record.subject_user_id is distinct from auth.uid()
    then
      return jsonb_build_object('ok', false, 'code', 'access_denied');
    end if;
    -- A browser session may only ever describe itself as the console.
    if normalized_surface <> 'console' then
      return jsonb_build_object('ok', false, 'code', 'access_denied');
    end if;
  end if;

  if normalized_surface = 'widget' then
    -- Parse WidgetPageContext.href into origin and path only. The query string
    -- and fragment are discarded here and never stored.
    if host_href is not null and host_href ~* '^https?://' then
      href_body := btrim(host_href);
      href_rest := substring(href_body from position('://' in href_body) + 3);
      href_authority := split_part(
        split_part(split_part(href_rest, '#', 1), '?', 1), '/', 1
      );
      resolved_origin := lower(
        split_part(href_body, '://', 1) || '://' || href_authority
      );
      resolved_path := nullif(
        substring(
          split_part(split_part(href_rest, '#', 1), '?', 1)
          from length(href_authority) + 1
        ),
        ''
      );
      if resolved_path is null then
        resolved_path := '/';
      end if;
      if length(resolved_path) > 300 then
        resolved_path := left(resolved_path, 300);
      end if;
      if resolved_origin !~ '^https?://[a-z0-9._:\-\[\]]{1,180}$' then
        resolved_origin := null;
        resolved_path := null;
      end if;
    end if;
    resolved_identity := case
      when coalesce(visitor_is_anonymous, false) then 'anonymous_visitor'
      else 'verified_learner'
    end;
    if resolved_identity = 'anonymous_visitor' then
      resolved_visitor_key := app_private.surface_visitor_key(
        conversation_record.tenant_id, visitor_ref
      );
    end if;
  else
    resolved_identity := 'verified_learner';
  end if;

  select * into existing
  from public.conversation_surfaces s
  where s.tenant_id = conversation_record.tenant_id
    and s.conversation_id = target_conversation_id;

  if found then
    -- A conversation cannot change surface. Re-recording the same surface
    -- refreshes the page context and the last-seen moment; a contradiction is
    -- refused rather than silently rewritten.
    if existing.surface <> normalized_surface then
      return jsonb_build_object('ok', false, 'code', 'surface_conflict');
    end if;
    update public.conversation_surfaces s
    set
      widget_key = coalesce(normalized_key, s.widget_key),
      host_origin = coalesce(resolved_origin, s.host_origin),
      host_path = coalesce(resolved_path, s.host_path),
      host_page_title = coalesce(normalized_title, s.host_page_title),
      visitor_key = coalesce(resolved_visitor_key, s.visitor_key),
      visitor_identity = case
        when s.visitor_identity = 'anonymous_visitor' then s.visitor_identity
        else resolved_identity
      end,
      attribution_source = 'recorded',
      last_seen_at = greatest(s.last_seen_at, now()),
      deleted_at = null
    where s.tenant_id = existing.tenant_id
      and s.conversation_id = existing.conversation_id
    returning * into written;
  else
    insert into public.conversation_surfaces (
      tenant_id,
      conversation_id,
      surface,
      widget_key,
      host_origin,
      host_path,
      host_page_title,
      visitor_key,
      visitor_identity,
      attribution_source,
      first_seen_at,
      last_seen_at,
      idempotency_key
    ) values (
      conversation_record.tenant_id,
      target_conversation_id,
      normalized_surface,
      normalized_key,
      resolved_origin,
      resolved_path,
      normalized_title,
      resolved_visitor_key,
      resolved_identity,
      'recorded',
      least(conversation_record.started_at, now()),
      now(),
      learning_record_conversation_surface.idempotency_key
    )
    returning * into written;
  end if;

  -- The pseudonymous key is deliberately absent from this result. The caller
  -- learns whether a visitor was counted, never which visitor it was.
  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'conversationId', written.conversation_id,
    'surface', written.surface,
    'hostOrigin', written.host_origin,
    'hostPath', written.host_path,
    'visitorIdentity', written.visitor_identity,
    'visitorCounted', written.visitor_key is not null
  );
end;
$$;

-- ------------------------------------------------------------------ resolver

-- The surface of every conversation in a tenant, with the provenance of that
-- answer. Nothing here guesses: a row is either recorded, carried on the
-- conversation metadata, backfilled from the pre-widget era, or inferred from
-- the fact that the console is the only path that creates a conversation
-- without recording a surface. The caller sees which.
--
-- The conversation-metadata branch exists so a surface written by the widget
-- delivery path onto public.conversations.metadata is honoured rather than
-- misread as console. It is only trusted for the enumerated surface values.
create or replace function app_private.conversation_surface_view(
  target_tenant_id uuid
)
returns table (
  conversation_id uuid,
  surface text,
  widget_key text,
  host_origin text,
  host_path text,
  host_page_title text,
  visitor_key text,
  visitor_identity text,
  attribution_source text
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    c.conversation_id,
    coalesce(
      s.surface,
      case
        when c.metadata ->> 'surface' in ('console', 'widget', 'api')
          then c.metadata ->> 'surface'
        -- 20260726093000 writes metadata.channel = 'widget' on every
        -- conversation public.widget_ask opens. That is the durable fact, so
        -- it is read rather than duplicated.
        when c.metadata ->> 'channel' in ('console', 'widget', 'api')
          then c.metadata ->> 'channel'
      end,
      'console'
    ),
    coalesce(s.widget_key, nullif(btrim(coalesce(c.metadata ->> 'widgetKey', '')), '')),
    coalesce(s.host_origin, nullif(lower(btrim(coalesce(c.metadata ->> 'hostOrigin', ''))), '')),
    coalesce(s.host_path, nullif(btrim(coalesce(c.metadata ->> 'hostPath', '')), '')),
    coalesce(s.host_page_title, nullif(btrim(coalesce(c.metadata ->> 'hostPageTitle', '')), '')),
    -- The delivery path stores the widget's conversation reference only as a
    -- salted digest, inside the conversation idempotency key. Re-digesting
    -- that under the analytics pepper yields a stable per-visitor count while
    -- holding neither the browser value nor anything that could reproduce it.
    coalesce(
      s.visitor_key,
      case
        when c.idempotency_key like 'widget:%'
          then app_private.surface_visitor_key(c.tenant_id, c.idempotency_key)
      end
    ),
    coalesce(
      s.visitor_identity,
      case
        when c.metadata ->> 'visitorIdentity'
          in ('verified_learner', 'anonymous_visitor')
          then c.metadata ->> 'visitorIdentity'
        -- 20260726093000 marks an unauthenticated widget visitor with
        -- identityTier = 'anonymous' and gives them a synthetic
        -- subject_user_id. That synthetic subject is exactly why the
        -- pre-existing learner count needs the caveat this file adds: without
        -- it, an anonymous browser would be indistinguishable from a person
        -- the platform authenticated.
        when c.metadata ->> 'identityTier' = 'anonymous'
          then 'anonymous_visitor'
      end,
      'verified_learner'
    ),
    case
      when s.surface_record_id is not null then s.attribution_source
      when c.metadata ->> 'surface' in ('console', 'widget', 'api')
        or c.metadata ->> 'channel' in ('console', 'widget', 'api')
        then 'conversation_metadata'
      when c.started_at < app_private.surface_attribution_epoch()
        then 'backfilled_console'
      else 'inferred_console'
    end
  from public.conversations c
  left join public.conversation_surfaces s
    on s.tenant_id = c.tenant_id
   and s.conversation_id = c.conversation_id
   and s.deleted_at is null
  where c.tenant_id = target_tenant_id
    and c.deleted_at is null;
$$;
revoke execute on function app_private.conversation_surface_view(uuid)
  from public, anon, authenticated, service_role;

-- Scalar form for the surface predicate the pre-existing analytics bodies use.
-- One indexed lookup per conversation, and short-circuited entirely when no
-- filter was requested.
create or replace function app_private.conversation_surface_name(
  target_tenant_id uuid,
  target_conversation_id uuid
)
returns text
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select v.surface
  from app_private.conversation_surface_view(target_tenant_id) v
  where v.conversation_id = target_conversation_id;
$$;
revoke execute on function app_private.conversation_surface_name(uuid, uuid)
  from public, anon, authenticated, service_role;

-- A caller-supplied surface filter is either null (every surface) or exactly
-- one of the recorded surfaces. Anything else returns no row, so the RPC fails
-- closed instead of quietly reporting the unfiltered total under a filter
-- label the caller asked for.
create or replace function app_private.analytics_surface_filter(
  requested_surface text
)
returns table (resolved_surface text, surface_label text)
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select
    n.normalized,
    coalesce(n.normalized, 'all')
  from (
    select nullif(lower(btrim(coalesce(requested_surface, ''))), '') as normalized
  ) n
  where n.normalized is null
     or n.normalized in ('console', 'widget', 'api');
$$;
revoke execute on function app_private.analytics_surface_filter(text)
  from public, anon, authenticated, service_role;

-- How much of a requested range the surface dimension actually covers. This is
-- the function that stops a pre-widget range from being reported as zero widget
-- usage: before the epoch there is no measurement at all, and 'none' means the
-- caller must be told that rather than shown a zero.
create or replace function app_private.surface_window_coverage(
  window_start timestamptz,
  window_end timestamptz
)
returns table (coverage text, coverage_note text)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    case
      when window_end <= e.epoch then 'none'
      when window_start < e.epoch then 'partial'
      else 'full'
    end,
    case
      when window_end <= e.epoch then
        'Surface attribution began at ' || to_char(
          e.epoch at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'
        ) || '. This range ends before that, so no question in it could have ' ||
        'carried a recorded surface. Widget figures are reported as unknown ' ||
        'rather than as zero: nothing here is evidence that the widget was ' ||
        'unused, only that the platform was not recording where questions ' ||
        'were asked.'
      when window_start < e.epoch then
        'Surface attribution began at ' || to_char(
          e.epoch at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'
        ) || '. The part of this range before that instant has no recorded ' ||
        'surface; its conversations are attributed to the console because the ' ||
        'console was the only surface that existed, not because a surface was ' ||
        'observed.'
      else
        'The whole of this range is inside the period in which surfaces are ' ||
        'recorded.'
    end
  from (select app_private.surface_attribution_epoch() as epoch) e;
$$;
revoke execute on function app_private.surface_window_coverage(
  timestamptz, timestamptz
) from public, anon, authenticated, service_role;

-- Per-surface counting facts for a range, shared by every RPC below so the
-- same question is never counted two different ways.
create or replace function app_private.surface_question_totals(
  target_tenant_id uuid,
  window_start timestamptz,
  window_end timestamptz,
  surface_filter text
)
returns table (
  surface text,
  questions bigint,
  conversations bigint,
  verified_learners bigint,
  anonymous_visitors bigint,
  anonymous_questions bigint,
  unkeyed_anonymous_conversations bigint,
  unattributed_questions bigint,
  recorded_attributions bigint,
  inferred_attributions bigint,
  last_question_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    v.surface,
    count(*)::bigint,
    count(distinct m.conversation_id)::bigint,
    count(distinct conv.subject_user_id) filter (
      where v.visitor_identity = 'verified_learner'
    )::bigint,
    count(distinct v.visitor_key)::bigint,
    count(*) filter (where v.visitor_identity = 'anonymous_visitor')::bigint,
    count(distinct m.conversation_id) filter (
      where v.visitor_identity = 'anonymous_visitor' and v.visitor_key is null
    )::bigint,
    count(*) filter (where conv.course_id is null)::bigint,
    count(*) filter (
      where v.attribution_source in ('recorded', 'conversation_metadata')
    )::bigint,
    count(*) filter (
      where v.attribution_source not in ('recorded', 'conversation_metadata')
    )::bigint,
    max(m.created_at)
  from public.messages m
  join public.conversations conv
    on conv.tenant_id = m.tenant_id
   and conv.conversation_id = m.conversation_id
  join app_private.conversation_surface_view(target_tenant_id) v
    on v.conversation_id = m.conversation_id
  where m.tenant_id = target_tenant_id
    and m.created_at >= window_start
    and m.created_at < window_end
    and m.deleted_at is null
    and m.status = 'final'
    and m.actor_type in ('student', 'creator', 'owner')
    and m.modality in ('text', 'voice_transcript')
    and conv.deleted_at is null
    and (surface_filter is null or v.surface = surface_filter)
  group by v.surface;
$$;
revoke execute on function app_private.surface_question_totals(
  uuid, timestamptz, timestamptz, text
) from public, anon, authenticated, service_role;

-- Renders the surface provenance block that every RPC below attaches beside its
-- existing JSON. It is a new top-level key, never a change to an old one.
create or replace function app_private.surface_provenance(
  requested_surface text,
  applied_label text,
  coverage text,
  coverage_note text,
  recorded_rows bigint,
  inferred_rows bigint
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'requested', requested_surface,
    'applied', applied_label,
    'surfaces', jsonb_build_array('console', 'widget', 'api'),
    'attributionStartedAt', app_private.surface_attribution_epoch(),
    'coverage', coverage,
    'coverageNote', coverage_note,
    'recordedAttributions', coalesce(recorded_rows, 0),
    'inferredAttributions', coalesce(inferred_rows, 0),
    'attributionSources', jsonb_build_object(
      'recorded',
      'The surface was written by the path that opened the conversation.',
      'conversation_metadata',
      'The surface was carried on the conversation record itself.',
      'backfilled_console',
      'The conversation predates surface recording. It is console because the ' ||
      'console was the only surface that existed, not because one was observed.',
      'inferred_console',
      'The conversation carries no surface and was opened through the console ' ||
      'conversation path, which is the only path that creates one without ' ||
      'recording a surface.'
    )
  );
$$;
revoke execute on function app_private.surface_provenance(
  text, text, text, text, bigint, bigint
) from public, anon, authenticated, service_role;

-- ------------------------------------------- surface-filtered existing RPCs
--
-- Each of the three functions below is the pre-existing body from
-- 20260725121000 with exactly one predicate added to every query that counts
-- questions or answers, plus one additive key in the returned JSON. The
-- two-argument entrypoints are re-declared underneath as delegates that pass a
-- null filter, which is byte-for-byte the behaviour they had before, so their
-- callers, grants and signatures are untouched.
--
-- The third parameter is REQUIRED, not defaulted. A defaulted third parameter
-- would make analytics_tenant_overview(range_start, range_end) ambiguous
-- between two candidate functions and PostgREST would fail every existing
-- console read with "function is not unique".

create or replace function public.analytics_tenant_overview(
  range_start timestamptz,
  range_end timestamptz,
  surface_filter text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  win record;
  scope record;
  window_coverage record;
  totals record;
  turn_stats record;
  data_through timestamptz;
  buckets jsonb;
  surface_rows jsonb;
  recorded_rows bigint := 0;
  inferred_rows bigint := 0;
  anonymous_subjects bigint := 0;
  verified_subjects bigint := 0;
  volume_limitations text[] := '{}'::text[];
  learner_limitations text[] := '{}'::text[];
  turn_limitations text[] := array[
    'This is the durable interval between the learner message row and the ' ||
    'assistant message row. It includes retrieval, provider and client ' ||
    'time and is not an instrumented answer latency.'
  ];
  surface_limitations text[] := '{}'::text[];
  evidence constant jsonb := jsonb_build_array(
    'table:public.messages',
    'table:public.conversations'
  );
  surface_evidence constant jsonb := jsonb_build_array(
    'table:public.messages',
    'table:public.conversations',
    'table:public.conversation_surfaces'
  );
begin
  select * into caller from app_private.analytics_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  select * into scope
  from app_private.analytics_surface_filter(surface_filter);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_surface');
  end if;
  select * into win
  from app_private.analytics_window(range_start, range_end);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_range');
  end if;
  data_through := least(win.window_end, statement_timestamp());
  select * into window_coverage
  from app_private.surface_window_coverage(win.window_start, win.window_end);

  select
    count(*)::bigint as questions,
    count(*) filter (where m.modality = 'text')::bigint as text_questions,
    count(*) filter (
      where m.modality = 'voice_transcript'
    )::bigint as voice_questions,
    count(*) filter (where m.actor_type = 'student')::bigint
      as student_questions,
    count(*) filter (where m.actor_type <> 'student')::bigint
      as staff_questions,
    count(distinct conv.subject_user_id)::bigint as active_learners,
    count(distinct conv.conversation_id)::bigint as active_conversations,
    count(*) filter (where conv.course_id is null)::bigint
      as unattributed_questions,
    max(m.created_at) as last_question_at
  into totals
  from public.messages m
  join public.conversations conv
    on conv.tenant_id = m.tenant_id
   and conv.conversation_id = m.conversation_id
  where m.tenant_id = caller.tenant_id
    and m.created_at >= win.window_start
    and m.created_at < win.window_end
    and m.deleted_at is null
    and m.status = 'final'
    and m.actor_type in ('student', 'creator', 'owner')
    and m.modality in ('text', 'voice_transcript')
    and conv.deleted_at is null
    and (
      scope.resolved_surface is null
      or app_private.conversation_surface_name(
        caller.tenant_id, conv.conversation_id
      ) = scope.resolved_surface
    );

  with days as (
    select day_bucket.bucket_start
    from generate_series(
      date_trunc('day', win.window_start at time zone 'UTC')
        at time zone 'UTC',
      date_trunc(
        'day',
        (win.window_end - interval '1 microsecond') at time zone 'UTC'
      ) at time zone 'UTC',
      interval '1 day'
    ) as day_bucket(bucket_start)
  ),
  counted as (
    select
      date_trunc('day', m.created_at at time zone 'UTC') at time zone 'UTC'
        as bucket_start,
      count(*)::bigint as questions,
      count(*) filter (where m.modality = 'text')::bigint as text_questions,
      count(*) filter (
        where m.modality = 'voice_transcript'
      )::bigint as voice_questions,
      count(distinct conv.subject_user_id)::bigint as active_learners
    from public.messages m
    join public.conversations conv
      on conv.tenant_id = m.tenant_id
     and conv.conversation_id = m.conversation_id
    where m.tenant_id = caller.tenant_id
      and m.created_at >= win.window_start
      and m.created_at < win.window_end
      and m.deleted_at is null
      and m.status = 'final'
      and m.actor_type in ('student', 'creator', 'owner')
      and m.modality in ('text', 'voice_transcript')
      and conv.deleted_at is null
      and (
        scope.resolved_surface is null
        or app_private.conversation_surface_name(
          caller.tenant_id, conv.conversation_id
        ) = scope.resolved_surface
      )
    group by 1
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'bucketStart', d.bucket_start,
        'questions', coalesce(c.questions, 0),
        'textQuestions', coalesce(c.text_questions, 0),
        'voiceQuestions', coalesce(c.voice_questions, 0),
        'activeLearners', coalesce(c.active_learners, 0)
      )
      order by d.bucket_start
    ),
    '[]'::jsonb
  )
  into buckets
  from days d
  left join counted c on c.bucket_start = d.bucket_start;

  with ordered as (
    select
      m.actor_type,
      m.created_at,
      lag(m.created_at) over (
        partition by m.conversation_id order by m.sequence_number
      ) as previous_at,
      lag(m.actor_type) over (
        partition by m.conversation_id order by m.sequence_number
      ) as previous_actor
    from public.messages m
    join public.conversations conv
      on conv.tenant_id = m.tenant_id
     and conv.conversation_id = m.conversation_id
    where m.tenant_id = caller.tenant_id
      and m.created_at >= win.window_start - interval '1 day'
      and m.created_at < win.window_end
      and m.deleted_at is null
      and m.status = 'final'
      and conv.deleted_at is null
      and (
        scope.resolved_surface is null
        or app_private.conversation_surface_name(
          caller.tenant_id, conv.conversation_id
        ) = scope.resolved_surface
      )
  ),
  measured as (
    select
      (
        extract(epoch from (o.created_at - o.previous_at)) * 1000
      )::double precision as interval_ms
    from ordered o
    where o.actor_type = 'assistant'
      and o.previous_actor in ('student', 'creator', 'owner')
      and o.previous_at is not null
      and o.created_at >= win.window_start
  )
  select
    count(*)::bigint as observations,
    round(avg(interval_ms)::numeric)::bigint as average_ms,
    round(
      (percentile_cont(0.5) within group (order by interval_ms))::numeric
    )::bigint as median_ms,
    round(
      (percentile_cont(0.9) within group (order by interval_ms))::numeric
    )::bigint as p90_ms
  into turn_stats
  from measured;

  -- Additive: the same questions, split by the surface they arrived on.
  -- Verified learners and anonymous visitors are two separate counts and are
  -- never summed into one "people" figure.
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'surface', t.surface,
          'questions', t.questions,
          'conversations', t.conversations,
          'verifiedLearners', t.verified_learners,
          'anonymousVisitors', t.anonymous_visitors,
          'anonymousQuestions', t.anonymous_questions,
          'anonymousConversationsWithoutVisitorKey',
            t.unkeyed_anonymous_conversations,
          'unattributedQuestions', t.unattributed_questions,
          'recordedAttributions', t.recorded_attributions,
          'inferredAttributions', t.inferred_attributions,
          'lastQuestionAt', t.last_question_at
        )
        order by t.questions desc, t.surface
      ),
      '[]'::jsonb
    ),
    coalesce(sum(t.recorded_attributions), 0)::bigint,
    coalesce(sum(t.inferred_attributions), 0)::bigint
  into surface_rows, recorded_rows, inferred_rows
  from app_private.surface_question_totals(
    caller.tenant_id, win.window_start, win.window_end, scope.resolved_surface
  ) t;

  -- The pre-existing activeLearners figure counts distinct conversation
  -- subjects. The widget delivery path gives an anonymous visitor a SYNTHETIC
  -- subject_user_id, so that figure silently mixes authenticated people with
  -- unauthenticated browsers. Its value is left exactly as it was - changing
  -- it would break every caller - but it can no longer be read without the
  -- caveat, and the honest split is stated beside it.
  select
    count(distinct conv.subject_user_id) filter (
      where v.visitor_identity = 'anonymous_visitor'
    )::bigint,
    count(distinct conv.subject_user_id) filter (
      where v.visitor_identity = 'verified_learner'
    )::bigint
  into anonymous_subjects, verified_subjects
  from public.messages m
  join public.conversations conv
    on conv.tenant_id = m.tenant_id
   and conv.conversation_id = m.conversation_id
  join app_private.conversation_surface_view(caller.tenant_id) v
    on v.conversation_id = m.conversation_id
  where m.tenant_id = caller.tenant_id
    and m.created_at >= win.window_start
    and m.created_at < win.window_end
    and m.deleted_at is null
    and m.status = 'final'
    and m.actor_type in ('student', 'creator', 'owner')
    and m.modality in ('text', 'voice_transcript')
    and conv.deleted_at is null
    and (scope.resolved_surface is null or v.surface = scope.resolved_surface);

  if coalesce(anonymous_subjects, 0) > 0 then
    learner_limitations := learner_limitations || (
      'This count is distinct conversation subjects, and ' ||
      anonymous_subjects::text ||
      ' of them are anonymous widget visitors holding a synthetic subject ' ||
      'rather than people the platform authenticated. The verified figure is ' ||
      verified_subjects::text ||
      '. Use metrics.surfaceSplit, which reports the two separately and never ' ||
      'adds them together.'
    );
  end if;

  if coalesce(totals.unattributed_questions, 0) > 0 then
    volume_limitations := volume_limitations || (
      totals.unattributed_questions::text ||
      ' question(s) were asked in a conversation with no course context. ' ||
      'They are counted in the totals but cannot be attributed to a course.'
    );
  end if;
  if coalesce(turn_stats.observations, 0) = 0 then
    turn_limitations := turn_limitations || (
      'No learner-to-assistant message pair was recorded in this range.'
    )::text;
  end if;
  if scope.resolved_surface is not null then
    volume_limitations := volume_limitations || (
      'These figures cover the ' || scope.resolved_surface ||
      ' surface only. They are not the tenant total.'
    );
  end if;
  surface_limitations := surface_limitations || window_coverage.coverage_note;
  if inferred_rows > 0 then
    surface_limitations := surface_limitations || (
      inferred_rows::text || ' of ' ||
      (recorded_rows + inferred_rows)::text ||
      ' question(s) in this range carry an inferred surface rather than a ' ||
      'recorded one. See surface.attributionSources for what each inference ' ||
      'means.'
    );
  end if;
  surface_limitations := surface_limitations || (
    'An anonymous visitor is a distinct widget conversation reference, not a ' ||
    'verified person: one visitor using two browsers counts twice and two ' ||
    'people sharing a browser count once. Anonymous visitors are never added ' ||
    'to the verified-learner figure.'
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'generatedAt', statement_timestamp(),
    'range', jsonb_build_object(
      'start', win.window_start,
      'end', win.window_end,
      'bucket', 'day',
      'timeZone', 'UTC',
      'dayCount', win.day_count
    ),
    'surface', app_private.surface_provenance(
      scope.resolved_surface,
      scope.surface_label,
      window_coverage.coverage,
      window_coverage.coverage_note,
      recorded_rows,
      inferred_rows
    ),
    'definitions', jsonb_build_object(
      'question',
      'A final, non-deleted message authored by a person (actor_type ' ||
      'student, creator or owner) with modality text or voice_transcript, ' ||
      'in a conversation that is not soft-deleted.',
      'activeLearner',
      'A distinct conversation subject_user_id that asked at least one ' ||
      'question inside the range.',
      'channel',
      'Taken from public.messages.modality, recorded per turn when the ' ||
      'message is written.',
      'surface',
      'Where the conversation was opened: console, widget or api. Recorded ' ||
      'per conversation in public.conversation_surfaces, not per turn.',
      'anonymousVisitor',
      'A distinct pseudonymous key derived from the widget conversation ' ||
      'reference of a visitor who was not signed in. It is counted ' ||
      'separately from verified learners and can never be resolved to a ' ||
      'person.'
    ),
    'metrics', jsonb_build_object(
      'questionVolume', app_private.analytics_metric(
        app_private.analytics_metric_state(volume_limitations),
        jsonb_build_object(
          'totalQuestions', coalesce(totals.questions, 0),
          'studentQuestions', coalesce(totals.student_questions, 0),
          'staffQuestions', coalesce(totals.staff_questions, 0),
          'unattributedQuestions',
            coalesce(totals.unattributed_questions, 0),
          'activeConversations', coalesce(totals.active_conversations, 0),
          'lastQuestionAt', totals.last_question_at,
          'buckets', buckets
        ),
        data_through,
        evidence,
        to_jsonb(volume_limitations)
      ),
      'activeLearners', app_private.analytics_metric(
        app_private.analytics_metric_state(learner_limitations),
        jsonb_build_object(
          'learners', coalesce(totals.active_learners, 0)
        ),
        data_through,
        evidence,
        to_jsonb(learner_limitations)
      ),
      'channelSplit', app_private.analytics_metric(
        'known',
        jsonb_build_object(
          'textQuestions', coalesce(totals.text_questions, 0),
          'voiceQuestions', coalesce(totals.voice_questions, 0),
          'voiceShare', case
            when coalesce(totals.questions, 0) = 0 then null
            else round(
              totals.voice_questions::numeric / totals.questions,
              4
            )
          end
        ),
        data_through,
        evidence,
        '[]'::jsonb
      ),
      'answerLatencyMs', app_private.analytics_metric(
        'unknown',
        null,
        null,
        evidence,
        jsonb_build_array(
          'Answer latency is not recorded. public.messages persists no ' ||
          'request-start timestamp for an assistant turn.',
          'The conversation.turn_completed usage event carries ' ||
          'conversationId, modality, intent and sourceCount but no ' ||
          'durationMs, so no elapsed provider time exists to aggregate.'
        )
      ),
      'turnRecordingIntervalMs', app_private.analytics_metric(
        'partial',
        jsonb_build_object(
          'observations', coalesce(turn_stats.observations, 0),
          'averageMs', turn_stats.average_ms,
          'medianMs', turn_stats.median_ms,
          'p90Ms', turn_stats.p90_ms
        ),
        data_through,
        evidence,
        to_jsonb(turn_limitations)
      ),
      -- Additive metric. Unknown, never zero, for a range that predates
      -- surface recording entirely.
      'surfaceSplit', app_private.analytics_metric(
        case
          when window_coverage.coverage = 'none' then 'unknown'
          else 'partial'
        end,
        case
          when window_coverage.coverage = 'none' then null
          else jsonb_build_object(
            'surfaces', surface_rows,
            'recordedAttributions', recorded_rows,
            'inferredAttributions', inferred_rows
          )
        end,
        data_through,
        surface_evidence,
        to_jsonb(surface_limitations)
      )
    )
  );
end;
$$;

-- The pre-existing two-argument entrypoint, unchanged in signature, grants and
-- behaviour: a null filter is every surface, which is what it always counted.
create or replace function public.analytics_tenant_overview(
  range_start timestamptz default null,
  range_end timestamptz default null
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select public.analytics_tenant_overview(range_start, range_end, null::text);
$$;


create or replace function public.analytics_question_distribution(
  range_start timestamptz,
  range_end timestamptz,
  surface_filter text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  win record;
  scope record;
  window_coverage record;
  course_limit constant integer := 50;
  module_limit constant integer := 25;
  lesson_limit constant integer := 25;
  total_questions bigint;
  attributed_questions bigint;
  unattributed_questions bigint;
  unattributed_learners bigint;
  last_question_at timestamptz;
  data_through timestamptz;
  omitted_courses bigint := 0;
  omitted_course_questions bigint := 0;
  courses_json jsonb;
  surface_rows jsonb;
  recorded_rows bigint := 0;
  inferred_rows bigint := 0;
  distribution_limitations text[] := '{}'::text[];
  evidence constant jsonb := jsonb_build_array(
    'table:public.messages',
    'table:public.conversations',
    'table:public.courses',
    'table:public.modules',
    'table:public.lessons'
  );
begin
  select * into caller from app_private.analytics_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  select * into scope
  from app_private.analytics_surface_filter(surface_filter);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_surface');
  end if;
  select * into win
  from app_private.analytics_window(range_start, range_end);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_range');
  end if;
  data_through := least(win.window_end, statement_timestamp());
  select * into window_coverage
  from app_private.surface_window_coverage(win.window_start, win.window_end);

  select
    count(*)::bigint,
    count(*) filter (where conv.course_id is not null)::bigint,
    count(*) filter (where conv.course_id is null)::bigint,
    count(distinct conv.subject_user_id) filter (
      where conv.course_id is null
    )::bigint,
    max(m.created_at)
  into
    total_questions,
    attributed_questions,
    unattributed_questions,
    unattributed_learners,
    last_question_at
  from public.messages m
  join public.conversations conv
    on conv.tenant_id = m.tenant_id
   and conv.conversation_id = m.conversation_id
  where m.tenant_id = caller.tenant_id
    and m.created_at >= win.window_start
    and m.created_at < win.window_end
    and m.deleted_at is null
    and m.status = 'final'
    and m.actor_type in ('student', 'creator', 'owner')
    and m.modality in ('text', 'voice_transcript')
    and conv.deleted_at is null
    and (
      scope.resolved_surface is null
      or app_private.conversation_surface_name(
        caller.tenant_id, conv.conversation_id
      ) = scope.resolved_surface
    );

  with questions as (
    select
      conv.course_id,
      conv.module_id,
      conv.lesson_id,
      conv.subject_user_id,
      m.created_at
    from public.messages m
    join public.conversations conv
      on conv.tenant_id = m.tenant_id
     and conv.conversation_id = m.conversation_id
    where m.tenant_id = caller.tenant_id
      and m.created_at >= win.window_start
      and m.created_at < win.window_end
      and m.deleted_at is null
      and m.status = 'final'
      and m.actor_type in ('student', 'creator', 'owner')
      and m.modality in ('text', 'voice_transcript')
      and conv.deleted_at is null
      and conv.course_id is not null
      and (
        scope.resolved_surface is null
        or app_private.conversation_surface_name(
          caller.tenant_id, conv.conversation_id
        ) = scope.resolved_surface
      )
  ),
  course_totals as (
    select
      q.course_id,
      count(*)::bigint as question_count,
      count(distinct q.subject_user_id)::bigint as learner_count,
      count(*) filter (where q.module_id is null)::bigint as course_only,
      max(q.created_at) as last_at,
      row_number() over (
        order by count(*) desc, q.course_id
      ) as course_rank
    from questions q
    group by q.course_id
  ),
  kept_courses as (
    select * from course_totals where course_rank <= course_limit
  ),
  module_totals as (
    select
      q.course_id,
      q.module_id,
      count(*)::bigint as question_count,
      count(distinct q.subject_user_id)::bigint as learner_count,
      count(*) filter (where q.lesson_id is null)::bigint as module_only,
      max(q.created_at) as last_at,
      row_number() over (
        partition by q.course_id
        order by count(*) desc, q.module_id
      ) as module_rank
    from questions q
    join kept_courses kc on kc.course_id = q.course_id
    where q.module_id is not null
    group by q.course_id, q.module_id
  ),
  kept_modules as (
    select * from module_totals where module_rank <= module_limit
  ),
  lesson_totals as (
    select
      q.course_id,
      q.module_id,
      q.lesson_id,
      count(*)::bigint as question_count,
      count(distinct q.subject_user_id)::bigint as learner_count,
      max(q.created_at) as last_at,
      row_number() over (
        partition by q.course_id, q.module_id
        order by count(*) desc, q.lesson_id
      ) as lesson_rank
    from questions q
    join kept_modules km
      on km.course_id = q.course_id
     and km.module_id = q.module_id
    where q.lesson_id is not null
    group by q.course_id, q.module_id, q.lesson_id
  ),
  lesson_json as (
    select
      lt.course_id,
      lt.module_id,
      jsonb_agg(
        jsonb_build_object(
          'lessonId', lt.lesson_id,
          'lessonTitle', l.title,
          'lessonStatus', l.status,
          'position', l.position,
          'questions', lt.question_count,
          'learners', lt.learner_count,
          'share', case
            when coalesce(total_questions, 0) = 0 then null
            else round(lt.question_count::numeric / total_questions, 4)
          end,
          'lastQuestionAt', lt.last_at
        )
        order by lt.question_count desc, lt.lesson_id
      ) filter (where lt.lesson_rank <= lesson_limit) as lessons,
      count(*) filter (where lt.lesson_rank > lesson_limit)::bigint
        as omitted_lesson_count,
      coalesce(
        sum(lt.question_count) filter (where lt.lesson_rank > lesson_limit),
        0
      )::bigint as omitted_lesson_questions
    from lesson_totals lt
    join public.lessons l
      on l.tenant_id = caller.tenant_id
     and l.lesson_id = lt.lesson_id
    group by lt.course_id, lt.module_id
  ),
  module_json as (
    select
      km.course_id,
      jsonb_agg(
        jsonb_build_object(
          'moduleId', km.module_id,
          'moduleTitle', mo.title,
          'moduleStatus', mo.status,
          'position', mo.position,
          'questions', km.question_count,
          'learners', km.learner_count,
          'share', case
            when coalesce(total_questions, 0) = 0 then null
            else round(km.question_count::numeric / total_questions, 4)
          end,
          'shareOfCourse', case
            when kc.question_count = 0 then null
            else round(
              km.question_count::numeric / kc.question_count,
              4
            )
          end,
          'moduleOnlyQuestions', km.module_only,
          'lastQuestionAt', km.last_at,
          'lessons', coalesce(lj.lessons, '[]'::jsonb),
          'omittedLessons', coalesce(lj.omitted_lesson_count, 0),
          'omittedLessonQuestions',
            coalesce(lj.omitted_lesson_questions, 0)
        )
        order by km.question_count desc, km.module_id
      ) as modules
    from kept_modules km
    join kept_courses kc on kc.course_id = km.course_id
    join public.modules mo
      on mo.tenant_id = caller.tenant_id
     and mo.module_id = km.module_id
    left join lesson_json lj
      on lj.course_id = km.course_id
     and lj.module_id = km.module_id
    group by km.course_id
  ),
  module_omissions as (
    select
      mt.course_id,
      count(*) filter (where mt.module_rank > module_limit)::bigint
        as omitted_module_count,
      coalesce(
        sum(mt.question_count) filter (where mt.module_rank > module_limit),
        0
      )::bigint as omitted_module_questions
    from module_totals mt
    group by mt.course_id
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'courseId', kc.course_id,
          'courseTitle', co.title,
          'courseStatus', co.status,
          'questions', kc.question_count,
          'learners', kc.learner_count,
          'share', case
            when coalesce(total_questions, 0) = 0 then null
            else round(kc.question_count::numeric / total_questions, 4)
          end,
          'courseOnlyQuestions', kc.course_only,
          'lastQuestionAt', kc.last_at,
          'modules', coalesce(mj.modules, '[]'::jsonb),
          'omittedModules', coalesce(mo2.omitted_module_count, 0),
          'omittedModuleQuestions',
            coalesce(mo2.omitted_module_questions, 0)
        )
        order by kc.question_count desc, kc.course_id
      ),
      '[]'::jsonb
    )
  into courses_json
  from kept_courses kc
  join public.courses co
    on co.tenant_id = caller.tenant_id
   and co.course_id = kc.course_id
  left join module_json mj on mj.course_id = kc.course_id
  left join module_omissions mo2 on mo2.course_id = kc.course_id;

  select
    count(*) filter (where ranked.course_rank > course_limit)::bigint,
    coalesce(
      sum(ranked.question_count) filter (
        where ranked.course_rank > course_limit
      ),
      0
    )::bigint
  into omitted_courses, omitted_course_questions
  from (
    select
      count(*)::bigint as question_count,
      row_number() over (
        order by count(*) desc, conv.course_id
      ) as course_rank
    from public.messages m
    join public.conversations conv
      on conv.tenant_id = m.tenant_id
     and conv.conversation_id = m.conversation_id
    where m.tenant_id = caller.tenant_id
      and m.created_at >= win.window_start
      and m.created_at < win.window_end
      and m.deleted_at is null
      and m.status = 'final'
      and m.actor_type in ('student', 'creator', 'owner')
      and m.modality in ('text', 'voice_transcript')
      and conv.deleted_at is null
      and conv.course_id is not null
      and (
        scope.resolved_surface is null
        or app_private.conversation_surface_name(
          caller.tenant_id, conv.conversation_id
        ) = scope.resolved_surface
      )
    group by conv.course_id
  ) ranked;

  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'surface', t.surface,
          'questions', t.questions,
          'conversations', t.conversations,
          'verifiedLearners', t.verified_learners,
          'anonymousVisitors', t.anonymous_visitors,
          'unattributedQuestions', t.unattributed_questions,
          'share', case
            when coalesce(total_questions, 0) = 0 then null
            else round(t.questions::numeric / total_questions, 4)
          end
        )
        order by t.questions desc, t.surface
      ),
      '[]'::jsonb
    ),
    coalesce(sum(t.recorded_attributions), 0)::bigint,
    coalesce(sum(t.inferred_attributions), 0)::bigint
  into surface_rows, recorded_rows, inferred_rows
  from app_private.surface_question_totals(
    caller.tenant_id, win.window_start, win.window_end, scope.resolved_surface
  ) t;

  if coalesce(unattributed_questions, 0) > 0 then
    distribution_limitations := distribution_limitations || (
      unattributed_questions::text ||
      ' question(s) were asked outside any course context and are reported ' ||
      'in the unattributed group instead of a course.'
    );
  end if;
  if omitted_courses > 0 then
    distribution_limitations := distribution_limitations || (
      'Only the top ' || course_limit::text ||
      ' courses by question volume are returned; ' ||
      omitted_courses::text || ' further course(s) holding ' ||
      omitted_course_questions::text || ' question(s) are omitted.'
    );
  end if;
  if scope.resolved_surface is not null then
    distribution_limitations := distribution_limitations || (
      'This distribution covers the ' || scope.resolved_surface ||
      ' surface only. Shares are of the ' || scope.resolved_surface ||
      ' total for the range, not of the tenant total.'
    );
  end if;
  if window_coverage.coverage <> 'full' then
    distribution_limitations :=
      distribution_limitations || window_coverage.coverage_note;
  end if;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'generatedAt', statement_timestamp(),
    'range', jsonb_build_object(
      'start', win.window_start,
      'end', win.window_end,
      'timeZone', 'UTC',
      'dayCount', win.day_count
    ),
    'surface', app_private.surface_provenance(
      scope.resolved_surface,
      scope.surface_label,
      window_coverage.coverage,
      window_coverage.coverage_note,
      recorded_rows,
      inferred_rows
    ),
    'limits', jsonb_build_object(
      'courses', course_limit,
      'modulesPerCourse', module_limit,
      'lessonsPerModule', lesson_limit,
      'truncated', omitted_courses > 0
    ),
    'definitions', jsonb_build_object(
      'attribution',
      'A question inherits the course, module and lesson recorded on its ' ||
      'conversation. A conversation opened without a lesson has no module, ' ||
      'so those questions are reported as courseOnlyQuestions.',
      'share',
      'The group question count divided by the tenant total for the range.',
      'surface',
      'Where the conversation was opened: console, widget or api. Recorded ' ||
      'per conversation in public.conversation_surfaces, not per turn.'
    ),
    'distribution', app_private.analytics_metric(
      app_private.analytics_metric_state(distribution_limitations),
      jsonb_build_object(
        'totalQuestions', coalesce(total_questions, 0),
        'attributedQuestions', coalesce(attributed_questions, 0),
        'lastQuestionAt', last_question_at,
        'courses', coalesce(courses_json, '[]'::jsonb),
        'unattributed', jsonb_build_object(
          'questions', coalesce(unattributed_questions, 0),
          'learners', coalesce(unattributed_learners, 0),
          'share', case
            when coalesce(total_questions, 0) = 0 then null
            else round(
              unattributed_questions::numeric / total_questions,
              4
            )
          end
        ),
        'omittedCourses', omitted_courses,
        'omittedCourseQuestions', omitted_course_questions,
        -- Additive key inside the existing metric value.
        'bySurface', case
          when window_coverage.coverage = 'none' then null
          else surface_rows
        end
      ),
      data_through,
      evidence,
      to_jsonb(distribution_limitations)
    )
  );
end;
$$;

create or replace function public.analytics_question_distribution(
  range_start timestamptz default null,
  range_end timestamptz default null
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select public.analytics_question_distribution(
    range_start, range_end, null::text
  );
$$;

create or replace function public.analytics_answer_quality(
  range_start timestamptz,
  range_end timestamptz,
  surface_filter text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  win record;
  scope record;
  window_coverage record;
  cluster_limit constant integer := 25;
  totals record;
  clusters jsonb;
  data_through timestamptz;
  omitted_clusters bigint := 0;
  surface_rows jsonb;
  coverage_limitations text[] := '{}'::text[];
  cluster_limitations text[] := '{}'::text[];
  surface_limitations text[] := '{}'::text[];
  evidence constant jsonb := jsonb_build_array(
    'table:public.messages',
    'table:public.conversations',
    'column:public.messages.structured_content.sources'
  );
  surface_evidence constant jsonb := jsonb_build_array(
    'table:public.messages',
    'table:public.conversations',
    'table:public.conversation_surfaces',
    'column:public.messages.structured_content.sources'
  );
begin
  select * into caller from app_private.analytics_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  select * into scope
  from app_private.analytics_surface_filter(surface_filter);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_surface');
  end if;
  select * into win
  from app_private.analytics_window(range_start, range_end);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_range');
  end if;
  data_through := least(win.window_end, statement_timestamp());
  select * into window_coverage
  from app_private.surface_window_coverage(win.window_start, win.window_end);

  with answers as (
    select
      case
        when jsonb_typeof(m.structured_content -> 'sources') = 'array'
          then jsonb_array_length(m.structured_content -> 'sources')
        else null
      end as source_count,
      m.created_at
    from public.messages m
    join public.conversations conv
      on conv.tenant_id = m.tenant_id
     and conv.conversation_id = m.conversation_id
    where m.tenant_id = caller.tenant_id
      and m.created_at >= win.window_start
      and m.created_at < win.window_end
      and m.deleted_at is null
      and m.status = 'final'
      and m.actor_type = 'assistant'
      and conv.deleted_at is null
      and (
        scope.resolved_surface is null
        or app_private.conversation_surface_name(
          caller.tenant_id, conv.conversation_id
        ) = scope.resolved_surface
      )
  )
  select
    count(*)::bigint as answer_count,
    count(*) filter (where a.source_count is null)::bigint
      as answers_without_source_record,
    count(*) filter (where a.source_count = 0)::bigint as ungrounded_answers,
    count(*) filter (where a.source_count > 0)::bigint as grounded_answers,
    count(*) filter (where a.source_count between 1 and 2)::bigint
      as sources_one_to_two,
    count(*) filter (where a.source_count between 3 and 5)::bigint
      as sources_three_to_five,
    count(*) filter (where a.source_count >= 6)::bigint as sources_six_plus,
    round(avg(a.source_count) filter (
      where a.source_count is not null
    ), 2) as average_source_count,
    max(a.created_at) as last_answer_at
  into totals
  from answers a;

  with graded as (
    select
      conv.course_id,
      conv.module_id,
      conv.lesson_id,
      case
        when jsonb_typeof(m.structured_content -> 'sources') = 'array'
          then jsonb_array_length(m.structured_content -> 'sources')
        else null
      end as source_count,
      m.created_at
    from public.messages m
    join public.conversations conv
      on conv.tenant_id = m.tenant_id
     and conv.conversation_id = m.conversation_id
    where m.tenant_id = caller.tenant_id
      and m.created_at >= win.window_start
      and m.created_at < win.window_end
      and m.deleted_at is null
      and m.status = 'final'
      and m.actor_type = 'assistant'
      and conv.deleted_at is null
      and (
        scope.resolved_surface is null
        or app_private.conversation_surface_name(
          caller.tenant_id, conv.conversation_id
        ) = scope.resolved_surface
      )
  ),
  grouped as (
    select
      g.course_id,
      g.module_id,
      g.lesson_id,
      count(*) filter (where g.source_count = 0)::bigint
        as ungrounded_answers,
      count(*)::bigint as answer_count,
      max(g.created_at) filter (
        where g.source_count = 0
      ) as last_ungrounded_at
    from graded g
    group by g.course_id, g.module_id, g.lesson_id
  ),
  ranked as (
    select
      gr.*,
      row_number() over (
        order by gr.ungrounded_answers desc, gr.course_id, gr.lesson_id
      ) as cluster_rank
    from grouped gr
    where gr.ungrounded_answers > 0
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'courseId', r.course_id,
          'courseTitle', co.title,
          'moduleId', r.module_id,
          'moduleTitle', mo.title,
          'lessonId', r.lesson_id,
          'lessonTitle', l.title,
          'ungroundedAnswers', r.ungrounded_answers,
          'answers', r.answer_count,
          'ungroundedShare', case
            when r.answer_count = 0 then null
            else round(
              r.ungrounded_answers::numeric / r.answer_count,
              4
            )
          end,
          'lastUngroundedAt', r.last_ungrounded_at
        )
        order by r.cluster_rank
      ) filter (where r.cluster_rank <= cluster_limit),
      '[]'::jsonb
    ),
    count(*) filter (where r.cluster_rank > cluster_limit)::bigint
  into clusters, omitted_clusters
  from ranked r
  left join public.courses co
    on co.tenant_id = caller.tenant_id
   and co.course_id = r.course_id
  left join public.modules mo
    on mo.tenant_id = caller.tenant_id
   and mo.module_id = r.module_id
  left join public.lessons l
    on l.tenant_id = caller.tenant_id
   and l.lesson_id = r.lesson_id;

  -- Additive: grounding coverage per surface, so "are embedded visitors
  -- getting grounded answers?" is answerable without a second query.
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'surface', s.surface,
        'answers', s.answer_count,
        'groundedAnswers', s.grounded_answers,
        'ungroundedAnswers', s.ungrounded_answers,
        'answersWithoutSourceRecord', s.without_record,
        'ungroundedShare', case
          when s.grounded_answers + s.ungrounded_answers = 0 then null
          else round(
            s.ungrounded_answers::numeric
              / (s.grounded_answers + s.ungrounded_answers),
            4
          )
        end,
        'averageSourceCount', s.average_source_count,
        'lastAnswerAt', s.last_answer_at
      )
      order by s.answer_count desc, s.surface
    ),
    '[]'::jsonb
  )
  into surface_rows
  from (
    select
      v.surface,
      count(*)::bigint as answer_count,
      count(*) filter (
        where jsonb_typeof(m.structured_content -> 'sources') <> 'array'
          or m.structured_content -> 'sources' is null
      )::bigint as without_record,
      count(*) filter (
        where jsonb_typeof(m.structured_content -> 'sources') = 'array'
          and jsonb_array_length(m.structured_content -> 'sources') = 0
      )::bigint as ungrounded_answers,
      count(*) filter (
        where jsonb_typeof(m.structured_content -> 'sources') = 'array'
          and jsonb_array_length(m.structured_content -> 'sources') > 0
      )::bigint as grounded_answers,
      round(
        avg(
          case
            when jsonb_typeof(m.structured_content -> 'sources') = 'array'
              then jsonb_array_length(m.structured_content -> 'sources')
          end
        ),
        2
      ) as average_source_count,
      max(m.created_at) as last_answer_at
    from public.messages m
    join public.conversations conv
      on conv.tenant_id = m.tenant_id
     and conv.conversation_id = m.conversation_id
    join app_private.conversation_surface_view(caller.tenant_id) v
      on v.conversation_id = m.conversation_id
    where m.tenant_id = caller.tenant_id
      and m.created_at >= win.window_start
      and m.created_at < win.window_end
      and m.deleted_at is null
      and m.status = 'final'
      and m.actor_type = 'assistant'
      and conv.deleted_at is null
      and (scope.resolved_surface is null or v.surface = scope.resolved_surface)
    group by v.surface
  ) s;

  if coalesce(totals.answers_without_source_record, 0) > 0 then
    coverage_limitations := coverage_limitations || (
      totals.answers_without_source_record::text ||
      ' assistant answer(s) carry no sources array and are counted neither ' ||
      'as grounded nor as ungrounded.'
    );
  end if;
  if scope.resolved_surface is not null then
    coverage_limitations := coverage_limitations || (
      'These figures cover answers given on the ' || scope.resolved_surface ||
      ' surface only.'
    );
  end if;
  if omitted_clusters > 0 then
    cluster_limitations := cluster_limitations || (
      'Only the top ' || cluster_limit::text ||
      ' ungrounded clusters are returned; ' || omitted_clusters::text ||
      ' further cluster(s) are omitted.'
    );
  end if;
  cluster_limitations := cluster_limitations || (
    'An ungrounded answer means zero citations were attached to the ' ||
    'recorded turn. It is a retrieval-coverage signal for human review, ' ||
    'not a judgement about answer correctness.'
  );
  surface_limitations := surface_limitations || window_coverage.coverage_note;
  surface_limitations := surface_limitations || (
    'An answer inherits the surface of its conversation. Grounding is a ' ||
    'property of retrieval, not of the surface, so a difference between ' ||
    'surfaces is a question to investigate, not a finding.'
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'generatedAt', statement_timestamp(),
    'range', jsonb_build_object(
      'start', win.window_start,
      'end', win.window_end,
      'timeZone', 'UTC',
      'dayCount', win.day_count
    ),
    'surface', app_private.surface_provenance(
      scope.resolved_surface,
      scope.surface_label,
      window_coverage.coverage,
      window_coverage.coverage_note,
      null::bigint,
      null::bigint
    ),
    'limits', jsonb_build_object(
      'clusters', cluster_limit,
      'truncated', omitted_clusters > 0
    ),
    'definitions', jsonb_build_object(
      'groundedAnswer',
      'An assistant message whose structured_content.sources array holds at ' ||
      'least one citation.',
      'ungroundedAnswer',
      'An assistant message whose structured_content.sources array is empty.',
      'sourceCountBucket',
      'Distribution of citations per answer, taken from the recorded array ' ||
      'length.',
      'surface',
      'Where the conversation was opened: console, widget or api. Recorded ' ||
      'per conversation in public.conversation_surfaces, not per turn.'
    ),
    'metrics', jsonb_build_object(
      'groundingCoverage', app_private.analytics_metric(
        app_private.analytics_metric_state(coverage_limitations),
        jsonb_build_object(
          'answers', coalesce(totals.answer_count, 0),
          'groundedAnswers', coalesce(totals.grounded_answers, 0),
          'ungroundedAnswers', coalesce(totals.ungrounded_answers, 0),
          'answersWithoutSourceRecord',
            coalesce(totals.answers_without_source_record, 0),
          'ungroundedShare', case
            when coalesce(
              totals.grounded_answers + totals.ungrounded_answers,
              0
            ) = 0 then null
            else round(
              totals.ungrounded_answers::numeric
                / (totals.grounded_answers + totals.ungrounded_answers),
              4
            )
          end,
          'averageSourceCount', totals.average_source_count,
          'lastAnswerAt', totals.last_answer_at,
          'sourceCountBuckets', jsonb_build_array(
            jsonb_build_object(
              'label', '0',
              'minSources', 0,
              'maxSources', 0,
              'answers', coalesce(totals.ungrounded_answers, 0)
            ),
            jsonb_build_object(
              'label', '1-2',
              'minSources', 1,
              'maxSources', 2,
              'answers', coalesce(totals.sources_one_to_two, 0)
            ),
            jsonb_build_object(
              'label', '3-5',
              'minSources', 3,
              'maxSources', 5,
              'answers', coalesce(totals.sources_three_to_five, 0)
            ),
            jsonb_build_object(
              'label', '6+',
              'minSources', 6,
              'maxSources', null,
              'answers', coalesce(totals.sources_six_plus, 0)
            )
          )
        ),
        data_through,
        evidence,
        to_jsonb(coverage_limitations)
      ),
      'retrievalConfidence', app_private.analytics_metric(
        'unknown',
        null,
        null,
        evidence,
        jsonb_build_array(
          'Retrieval confidence is not persisted. The citations written by ' ||
          'public.learning_record_assistant_message hold source identity, ' ||
          'title and excerpt only.',
          'public.learning_search_chunks computes a lexical or hybrid ' ||
          'relevance at query time, but that score is never written to a ' ||
          'durable table, so no confidence distribution can be aggregated.',
          'Grounding coverage is the honest substitute signal until a ' ||
          'retrieval score is recorded per answer.'
        )
      ),
      'contentGapSignals', app_private.analytics_metric(
        'partial',
        jsonb_build_object(
          'clusters', clusters,
          'omittedClusters', omitted_clusters
        ),
        data_through,
        evidence,
        to_jsonb(cluster_limitations)
      ),
      'surfaceGrounding', app_private.analytics_metric(
        case
          when window_coverage.coverage = 'none' then 'unknown'
          else 'partial'
        end,
        case
          when window_coverage.coverage = 'none' then null
          else jsonb_build_object('surfaces', surface_rows)
        end,
        data_through,
        surface_evidence,
        to_jsonb(surface_limitations)
      )
    )
  );
end;
$$;

create or replace function public.analytics_answer_quality(
  range_start timestamptz default null,
  range_end timestamptz default null
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select public.analytics_answer_quality(range_start, range_end, null::text);
$$;

-- ------------------------------------------------------ widget-specific RPCs

-- Questions and askers by surface, over time. This is the "one place" answer:
-- console and widget side by side, with anonymous visitors kept as their own
-- figure rather than folded into learners.
create or replace function public.analytics_surface_breakdown(
  range_start timestamptz default null,
  range_end timestamptz default null,
  surface_filter text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  win record;
  scope record;
  window_coverage record;
  data_through timestamptz;
  surface_rows jsonb;
  buckets jsonb;
  recorded_rows bigint := 0;
  inferred_rows bigint := 0;
  total_questions bigint := 0;
  breakdown_limitations text[] := '{}'::text[];
  evidence constant jsonb := jsonb_build_array(
    'table:public.messages',
    'table:public.conversations',
    'table:public.conversation_surfaces'
  );
begin
  select * into caller from app_private.analytics_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  select * into scope
  from app_private.analytics_surface_filter(surface_filter);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_surface');
  end if;
  select * into win
  from app_private.analytics_window(range_start, range_end);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_range');
  end if;
  data_through := least(win.window_end, statement_timestamp());
  select * into window_coverage
  from app_private.surface_window_coverage(win.window_start, win.window_end);

  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'surface', t.surface,
          'questions', t.questions,
          'conversations', t.conversations,
          'verifiedLearners', t.verified_learners,
          'anonymousVisitors', t.anonymous_visitors,
          'anonymousQuestions', t.anonymous_questions,
          'anonymousConversationsWithoutVisitorKey',
            t.unkeyed_anonymous_conversations,
          'unattributedQuestions', t.unattributed_questions,
          'questionsPerConversation', case
            when t.conversations = 0 then null
            else round(t.questions::numeric / t.conversations, 2)
          end,
          'recordedAttributions', t.recorded_attributions,
          'inferredAttributions', t.inferred_attributions,
          'lastQuestionAt', t.last_question_at
        )
        order by t.questions desc, t.surface
      ),
      '[]'::jsonb
    ),
    coalesce(sum(t.questions), 0)::bigint,
    coalesce(sum(t.recorded_attributions), 0)::bigint,
    coalesce(sum(t.inferred_attributions), 0)::bigint
  into surface_rows, total_questions, recorded_rows, inferred_rows
  from app_private.surface_question_totals(
    caller.tenant_id, win.window_start, win.window_end, scope.resolved_surface
  ) t;

  with days as (
    select day_bucket.bucket_start
    from generate_series(
      date_trunc('day', win.window_start at time zone 'UTC')
        at time zone 'UTC',
      date_trunc(
        'day',
        (win.window_end - interval '1 microsecond') at time zone 'UTC'
      ) at time zone 'UTC',
      interval '1 day'
    ) as day_bucket(bucket_start)
  ),
  counted as (
    select
      date_trunc('day', m.created_at at time zone 'UTC') at time zone 'UTC'
        as bucket_start,
      v.surface,
      count(*)::bigint as questions,
      count(distinct conv.subject_user_id) filter (
        where v.visitor_identity = 'verified_learner'
      )::bigint as verified_learners,
      count(distinct v.visitor_key)::bigint as anonymous_visitors
    from public.messages m
    join public.conversations conv
      on conv.tenant_id = m.tenant_id
     and conv.conversation_id = m.conversation_id
    join app_private.conversation_surface_view(caller.tenant_id) v
      on v.conversation_id = m.conversation_id
    where m.tenant_id = caller.tenant_id
      and m.created_at >= win.window_start
      and m.created_at < win.window_end
      and m.deleted_at is null
      and m.status = 'final'
      and m.actor_type in ('student', 'creator', 'owner')
      and m.modality in ('text', 'voice_transcript')
      and conv.deleted_at is null
      and (scope.resolved_surface is null or v.surface = scope.resolved_surface)
    group by 1, 2
  ),
  per_day as (
    select
      d.bucket_start,
      coalesce(
        jsonb_object_agg(
          c.surface,
          jsonb_build_object(
            'questions', c.questions,
            'verifiedLearners', c.verified_learners,
            'anonymousVisitors', c.anonymous_visitors
          )
        ) filter (where c.surface is not null),
        '{}'::jsonb
      ) as surfaces,
      coalesce(sum(c.questions), 0)::bigint as questions
    from days d
    left join counted c on c.bucket_start = d.bucket_start
    group by d.bucket_start
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'bucketStart', p.bucket_start,
        'questions', p.questions,
        'surfaces', p.surfaces
      )
      order by p.bucket_start
    ),
    '[]'::jsonb
  )
  into buckets
  from per_day p;

  breakdown_limitations :=
    breakdown_limitations || window_coverage.coverage_note;
  if inferred_rows > 0 then
    breakdown_limitations := breakdown_limitations || (
      inferred_rows::text || ' of ' ||
      (recorded_rows + inferred_rows)::text ||
      ' question(s) carry an inferred surface rather than a recorded one.'
    );
  end if;
  breakdown_limitations := breakdown_limitations || (
    'verifiedLearners counts distinct conversation subjects. ' ||
    'anonymousVisitors counts distinct pseudonymous widget references. The ' ||
    'two are different kinds of thing and are never added together: a ' ||
    'verified learner is a person the platform authenticated, an anonymous ' ||
    'visitor is a browser that came back.'
  );
  if scope.resolved_surface is not null then
    breakdown_limitations := breakdown_limitations || (
      'Filtered to the ' || scope.resolved_surface ||
      ' surface. Other surfaces are excluded, not absent.'
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'generatedAt', statement_timestamp(),
    'range', jsonb_build_object(
      'start', win.window_start,
      'end', win.window_end,
      'bucket', 'day',
      'timeZone', 'UTC',
      'dayCount', win.day_count
    ),
    'surface', app_private.surface_provenance(
      scope.resolved_surface,
      scope.surface_label,
      window_coverage.coverage,
      window_coverage.coverage_note,
      recorded_rows,
      inferred_rows
    ),
    'definitions', jsonb_build_object(
      'surface',
      'Where the conversation was opened: console (the signed-in workspace), ' ||
      'widget (the embeddable assistant on a host page) or api.',
      'verifiedLearner',
      'A distinct conversation subject the platform authenticated.',
      'anonymousVisitor',
      'A distinct pseudonymous key derived from the widget conversation ' ||
      'reference of a visitor who was never signed in. It identifies a ' ||
      'returning browser, not a person, and cannot be reversed.'
    ),
    'metrics', jsonb_build_object(
      'surfaceVolume', app_private.analytics_metric(
        case
          when window_coverage.coverage = 'none' then 'unknown'
          else 'partial'
        end,
        case
          when window_coverage.coverage = 'none' then null
          else jsonb_build_object(
            'totalQuestions', total_questions,
            'surfaces', surface_rows,
            'buckets', buckets,
            'recordedAttributions', recorded_rows,
            'inferredAttributions', inferred_rows
          )
        end,
        data_through,
        evidence,
        to_jsonb(breakdown_limitations)
      )
    )
  );
end;
$$;

-- Widget engagement: conversations started, questions per conversation, and
-- which host pages and origins actually drive questions.
create or replace function public.analytics_widget_engagement(
  range_start timestamptz default null,
  range_end timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  win record;
  window_coverage record;
  page_limit constant integer := 25;
  origin_limit constant integer := 10;
  data_through timestamptz;
  totals record;
  pages jsonb;
  origins jsonb;
  omitted_pages bigint := 0;
  engagement_limitations text[] := '{}'::text[];
  page_limitations text[] := '{}'::text[];
  evidence constant jsonb := jsonb_build_array(
    'table:public.messages',
    'table:public.conversations',
    'table:public.conversation_surfaces'
  );
begin
  select * into caller from app_private.analytics_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  select * into win
  from app_private.analytics_window(range_start, range_end);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_range');
  end if;
  data_through := least(win.window_end, statement_timestamp());
  select * into window_coverage
  from app_private.surface_window_coverage(win.window_start, win.window_end);

  select
    count(distinct c.conversation_id)::bigint as conversations_started,
    count(distinct c.conversation_id) filter (
      where v.visitor_identity = 'anonymous_visitor'
    )::bigint as anonymous_conversations,
    count(distinct c.conversation_id) filter (
      where v.visitor_identity = 'verified_learner'
    )::bigint as verified_conversations,
    count(distinct v.visitor_key)::bigint as anonymous_visitors,
    count(distinct c.subject_user_id) filter (
      where v.visitor_identity = 'verified_learner'
    )::bigint as verified_learners,
    count(distinct v.widget_key)::bigint as widget_keys,
    count(distinct v.host_origin)::bigint as host_origins,
    count(distinct c.conversation_id) filter (
      where v.host_origin is null
    )::bigint as conversations_without_origin
  into totals
  from public.conversations c
  join app_private.conversation_surface_view(caller.tenant_id) v
    on v.conversation_id = c.conversation_id
  where c.tenant_id = caller.tenant_id
    and c.deleted_at is null
    and v.surface = 'widget'
    and c.started_at >= win.window_start
    and c.started_at < win.window_end;

  with widget_questions as (
    select
      coalesce(v.host_origin, '(origin not recorded)') as host_origin,
      coalesce(v.host_path, '(path not recorded)') as host_path,
      v.host_page_title,
      v.visitor_identity,
      v.visitor_key,
      m.conversation_id,
      conv.subject_user_id,
      m.created_at
    from public.messages m
    join public.conversations conv
      on conv.tenant_id = m.tenant_id
     and conv.conversation_id = m.conversation_id
    join app_private.conversation_surface_view(caller.tenant_id) v
      on v.conversation_id = m.conversation_id
    where m.tenant_id = caller.tenant_id
      and m.created_at >= win.window_start
      and m.created_at < win.window_end
      and m.deleted_at is null
      and m.status = 'final'
      and m.actor_type in ('student', 'creator', 'owner')
      and m.modality in ('text', 'voice_transcript')
      and conv.deleted_at is null
      and v.surface = 'widget'
  ),
  page_totals as (
    select
      q.host_origin,
      q.host_path,
      min(q.host_page_title) as host_page_title,
      count(*)::bigint as question_count,
      count(distinct q.conversation_id)::bigint as conversation_count,
      count(distinct q.visitor_key)::bigint as anonymous_visitors,
      count(distinct q.subject_user_id) filter (
        where q.visitor_identity = 'verified_learner'
      )::bigint as verified_learners,
      max(q.created_at) as last_question_at,
      row_number() over (
        order by count(*) desc, q.host_origin, q.host_path
      ) as page_rank
    from widget_questions q
    group by q.host_origin, q.host_path
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'hostOrigin', p.host_origin,
          'hostPath', p.host_path,
          'hostPageTitle', p.host_page_title,
          'questions', p.question_count,
          'conversations', p.conversation_count,
          'questionsPerConversation', case
            when p.conversation_count = 0 then null
            else round(
              p.question_count::numeric / p.conversation_count, 2
            )
          end,
          'anonymousVisitors', p.anonymous_visitors,
          'verifiedLearners', p.verified_learners,
          'lastQuestionAt', p.last_question_at
        )
        order by p.page_rank
      ) filter (where p.page_rank <= page_limit),
      '[]'::jsonb
    ),
    count(*) filter (where p.page_rank > page_limit)::bigint
  into pages, omitted_pages
  from page_totals p;

  with widget_questions as (
    select
      coalesce(v.host_origin, '(origin not recorded)') as host_origin,
      coalesce(v.host_path, '(path not recorded)') as host_path,
      v.visitor_key,
      v.visitor_identity,
      m.conversation_id,
      m.created_at
    from public.messages m
    join public.conversations conv
      on conv.tenant_id = m.tenant_id
     and conv.conversation_id = m.conversation_id
    join app_private.conversation_surface_view(caller.tenant_id) v
      on v.conversation_id = m.conversation_id
    where m.tenant_id = caller.tenant_id
      and m.created_at >= win.window_start
      and m.created_at < win.window_end
      and m.deleted_at is null
      and m.status = 'final'
      and m.actor_type in ('student', 'creator', 'owner')
      and m.modality in ('text', 'voice_transcript')
      and conv.deleted_at is null
      and v.surface = 'widget'
  ),
  origin_totals as (
    select
      q.host_origin,
      count(*)::bigint as question_count,
      count(distinct q.conversation_id)::bigint as conversation_count,
      count(distinct q.host_path)::bigint as page_count,
      count(distinct q.visitor_key)::bigint as anonymous_visitors,
      max(q.created_at) as last_question_at,
      row_number() over (
        order by count(*) desc, q.host_origin
      ) as origin_rank
    from widget_questions q
    group by q.host_origin
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'hostOrigin', o.host_origin,
        'questions', o.question_count,
        'conversations', o.conversation_count,
        'pages', o.page_count,
        'anonymousVisitors', o.anonymous_visitors,
        'lastQuestionAt', o.last_question_at
      )
      order by o.origin_rank
    ) filter (where o.origin_rank <= origin_limit),
    '[]'::jsonb
  )
  into origins
  from origin_totals o;

  engagement_limitations :=
    engagement_limitations || window_coverage.coverage_note;
  if coalesce(totals.conversations_without_origin, 0) > 0 then
    engagement_limitations := engagement_limitations || (
      totals.conversations_without_origin::text ||
      ' widget conversation(s) carry no recorded host origin. They are ' ||
      'counted in the totals and grouped under "(origin not recorded)" ' ||
      'rather than assigned to a plausible page.'
    );
  end if;
  engagement_limitations := engagement_limitations || (
    'Only the origin and path of the host page are recorded. The query ' ||
    'string and fragment are discarded before storage because they routinely ' ||
    'carry session tokens and personal identifiers that analytics has no use ' ||
    'for.'
  );
  engagement_limitations := engagement_limitations || (
    'public.widget_bootstrap verifies the calling origin but does not persist ' ||
    'it, and public.widget_ask carries no page context at all, so a widget ' ||
    'conversation has a host page here only when the delivery path also ' ||
    'called public.learning_record_conversation_surface. Conversations ' ||
    'without one are grouped under "(origin not recorded)" and are never ' ||
    'assigned to a plausible page.'
  );
  if omitted_pages > 0 then
    page_limitations := page_limitations || (
      'Only the top ' || page_limit::text ||
      ' host pages by question volume are returned; ' ||
      omitted_pages::text || ' further page(s) are omitted.'
    );
  end if;
  page_limitations := page_limitations || (
    'A host page is grouped by origin and path. Two URLs that differ only in ' ||
    'their query string are one page here.'
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'generatedAt', statement_timestamp(),
    'range', jsonb_build_object(
      'start', win.window_start,
      'end', win.window_end,
      'timeZone', 'UTC',
      'dayCount', win.day_count
    ),
    'surface', app_private.surface_provenance(
      'widget',
      'widget',
      window_coverage.coverage,
      window_coverage.coverage_note,
      null::bigint,
      null::bigint
    ),
    'limits', jsonb_build_object(
      'hostPages', page_limit,
      'hostOrigins', origin_limit,
      'truncated', omitted_pages > 0
    ),
    'definitions', jsonb_build_object(
      'widgetConversation',
      'A conversation whose recorded surface is widget, started inside the ' ||
      'range.',
      'hostPage',
      'The origin and path of the page the widget was embedded on, taken ' ||
      'from the WidgetPageContext the runtime already reports.',
      'anonymousVisitor',
      'A distinct pseudonymous key derived from the widget conversation ' ||
      'reference of a visitor who was never signed in.'
    ),
    'metrics', jsonb_build_object(
      'widgetEngagement', app_private.analytics_metric(
        case
          when window_coverage.coverage = 'none' then 'unknown'
          else 'partial'
        end,
        case
          when window_coverage.coverage = 'none' then null
          else jsonb_build_object(
            'conversationsStarted',
              coalesce(totals.conversations_started, 0),
            'verifiedConversations',
              coalesce(totals.verified_conversations, 0),
            'anonymousConversations',
              coalesce(totals.anonymous_conversations, 0),
            'anonymousVisitors', coalesce(totals.anonymous_visitors, 0),
            'verifiedLearners', coalesce(totals.verified_learners, 0),
            'widgetKeys', coalesce(totals.widget_keys, 0),
            'hostOrigins', coalesce(totals.host_origins, 0),
            'conversationsWithoutOrigin',
              coalesce(totals.conversations_without_origin, 0),
            'origins', origins
          )
        end,
        data_through,
        evidence,
        to_jsonb(engagement_limitations)
      ),
      'hostPageQuestions', app_private.analytics_metric(
        case
          when window_coverage.coverage = 'none' then 'unknown'
          else 'partial'
        end,
        case
          when window_coverage.coverage = 'none' then null
          else jsonb_build_object(
            'pages', pages,
            'omittedPages', omitted_pages
          )
        end,
        data_through,
        evidence,
        to_jsonb(page_limitations)
      )
    )
  );
end;
$$;

-- Are embedded visitors getting grounded answers, and which host pages are
-- generating questions the published material does not answer? The second list
-- is the deflection signal: the content the client should write next.
create or replace function public.analytics_widget_content_gaps(
  range_start timestamptz default null,
  range_end timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  win record;
  window_coverage record;
  cluster_limit constant integer := 25;
  data_through timestamptz;
  grounding record;
  deflection record;
  clusters jsonb;
  omitted_clusters bigint := 0;
  coverage_limitations text[] := '{}'::text[];
  deflection_limitations text[] := '{}'::text[];
  evidence constant jsonb := jsonb_build_array(
    'table:public.messages',
    'table:public.conversations',
    'table:public.conversation_surfaces',
    'column:public.messages.structured_content.sources'
  );
begin
  select * into caller from app_private.analytics_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  select * into win
  from app_private.analytics_window(range_start, range_end);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_range');
  end if;
  data_through := least(win.window_end, statement_timestamp());
  select * into window_coverage
  from app_private.surface_window_coverage(win.window_start, win.window_end);

  select
    count(*)::bigint as answers,
    count(*) filter (
      where jsonb_typeof(m.structured_content -> 'sources') = 'array'
        and jsonb_array_length(m.structured_content -> 'sources') > 0
    )::bigint as grounded_answers,
    count(*) filter (
      where jsonb_typeof(m.structured_content -> 'sources') = 'array'
        and jsonb_array_length(m.structured_content -> 'sources') = 0
    )::bigint as ungrounded_answers,
    count(*) filter (
      where jsonb_typeof(m.structured_content -> 'sources') <> 'array'
        or m.structured_content -> 'sources' is null
    )::bigint as answers_without_source_record,
    round(
      avg(
        case
          when jsonb_typeof(m.structured_content -> 'sources') = 'array'
            then jsonb_array_length(m.structured_content -> 'sources')
        end
      ),
      2
    ) as average_source_count,
    max(m.created_at) as last_answer_at
  into grounding
  from public.messages m
  join public.conversations conv
    on conv.tenant_id = m.tenant_id
   and conv.conversation_id = m.conversation_id
  join app_private.conversation_surface_view(caller.tenant_id) v
    on v.conversation_id = m.conversation_id
  where m.tenant_id = caller.tenant_id
    and m.created_at >= win.window_start
    and m.created_at < win.window_end
    and m.deleted_at is null
    and m.status = 'final'
    and m.actor_type = 'assistant'
    and conv.deleted_at is null
    and v.surface = 'widget';

  -- Deflections. A widget question is a deflection when the answer that
  -- followed it carried no citation, when no answer was recorded at all, or
  -- when the conversation had no course context to answer from. Each of those
  -- is a recorded fact about the turn, not a judgement about the answer.
  with turns as (
    select
      m.message_id,
      m.conversation_id,
      m.actor_type,
      m.modality,
      m.created_at,
      conv.course_id,
      conv.module_id,
      conv.lesson_id,
      conv.subject_user_id,
      coalesce(v.host_origin, '(origin not recorded)') as host_origin,
      coalesce(v.host_path, '(path not recorded)') as host_path,
      v.host_page_title,
      v.visitor_identity,
      v.visitor_key,
      lead(m.actor_type) over (
        partition by m.conversation_id order by m.sequence_number
      ) as next_actor,
      lead(
        case
          when jsonb_typeof(m.structured_content -> 'sources') = 'array'
            then jsonb_array_length(m.structured_content -> 'sources')
        end
      ) over (
        partition by m.conversation_id order by m.sequence_number
      ) as next_source_count
    from public.messages m
    join public.conversations conv
      on conv.tenant_id = m.tenant_id
     and conv.conversation_id = m.conversation_id
    join app_private.conversation_surface_view(caller.tenant_id) v
      on v.conversation_id = m.conversation_id
    where m.tenant_id = caller.tenant_id
      and m.created_at >= win.window_start
      and m.created_at < win.window_end
      and m.deleted_at is null
      and m.status = 'final'
      and conv.deleted_at is null
      and v.surface = 'widget'
  ),
  deflected as (
    select
      t.host_origin,
      t.host_path,
      t.host_page_title,
      t.course_id,
      t.module_id,
      t.lesson_id,
      t.conversation_id,
      t.visitor_key,
      t.visitor_identity,
      t.subject_user_id,
      t.created_at,
      coalesce(
        t.next_actor = 'assistant' and t.next_source_count = 0, false
      ) as ungrounded,
      (t.next_actor is distinct from 'assistant') as unanswered,
      (t.course_id is null) as unattributed
    from turns t
    where t.actor_type in ('student', 'creator', 'owner')
      and t.modality in ('text', 'voice_transcript')
  )
  select
    count(*)::bigint as questions,
    count(*) filter (where d.ungrounded)::bigint as ungrounded_questions,
    count(*) filter (where d.unanswered)::bigint as unanswered_questions,
    count(*) filter (where d.unattributed)::bigint as unattributed_questions,
    count(*) filter (
      where d.ungrounded or d.unanswered or d.unattributed
    )::bigint as deflected_questions,
    count(distinct d.visitor_key)::bigint as anonymous_visitors,
    max(d.created_at) filter (
      where d.ungrounded or d.unanswered or d.unattributed
    ) as last_deflected_at
  into deflection
  from deflected d;

  with turns as (
    select
      m.conversation_id,
      m.actor_type,
      m.modality,
      m.created_at,
      conv.course_id,
      conv.module_id,
      conv.lesson_id,
      conv.subject_user_id,
      coalesce(v.host_origin, '(origin not recorded)') as host_origin,
      coalesce(v.host_path, '(path not recorded)') as host_path,
      v.host_page_title,
      v.visitor_identity,
      v.visitor_key,
      lead(m.actor_type) over (
        partition by m.conversation_id order by m.sequence_number
      ) as next_actor,
      lead(
        case
          when jsonb_typeof(m.structured_content -> 'sources') = 'array'
            then jsonb_array_length(m.structured_content -> 'sources')
        end
      ) over (
        partition by m.conversation_id order by m.sequence_number
      ) as next_source_count
    from public.messages m
    join public.conversations conv
      on conv.tenant_id = m.tenant_id
     and conv.conversation_id = m.conversation_id
    join app_private.conversation_surface_view(caller.tenant_id) v
      on v.conversation_id = m.conversation_id
    where m.tenant_id = caller.tenant_id
      and m.created_at >= win.window_start
      and m.created_at < win.window_end
      and m.deleted_at is null
      and m.status = 'final'
      and conv.deleted_at is null
      and v.surface = 'widget'
  ),
  widget_deflection_turns as (
    select
      t.host_origin,
      t.host_path,
      t.host_page_title,
      t.course_id,
      t.module_id,
      t.lesson_id,
      t.conversation_id,
      t.visitor_key,
      t.visitor_identity,
      t.subject_user_id,
      t.created_at,
      coalesce(
        t.next_actor = 'assistant' and t.next_source_count = 0, false
      ) as ungrounded,
      (t.next_actor is distinct from 'assistant') as unanswered,
      (t.course_id is null) as unattributed
    from turns t
    where t.actor_type in ('student', 'creator', 'owner')
      and t.modality in ('text', 'voice_transcript')
  ),
  grouped as (
    select
      d.host_origin,
      d.host_path,
      min(d.host_page_title) as host_page_title,
      d.course_id,
      d.module_id,
      d.lesson_id,
      count(*)::bigint as questions,
      count(*) filter (where d.ungrounded)::bigint as ungrounded_questions,
      count(*) filter (where d.unanswered)::bigint as unanswered_questions,
      count(*) filter (
        where d.unattributed
      )::bigint as unattributed_questions,
      count(*) filter (
        where d.ungrounded or d.unanswered or d.unattributed
      )::bigint as deflected_questions,
      count(distinct d.conversation_id)::bigint as conversations,
      count(distinct d.visitor_key)::bigint as anonymous_visitors,
      count(distinct d.subject_user_id) filter (
        where d.visitor_identity = 'verified_learner'
      )::bigint as verified_learners,
      max(d.created_at) filter (
        where d.ungrounded or d.unanswered or d.unattributed
      ) as last_deflected_at
    from widget_deflection_turns d
    group by
      d.host_origin, d.host_path, d.course_id, d.module_id, d.lesson_id
  ),
  ranked as (
    select
      g.*,
      row_number() over (
        order by g.deflected_questions desc, g.host_origin, g.host_path
      ) as cluster_rank
    from grouped g
    where g.deflected_questions > 0
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'hostOrigin', r.host_origin,
          'hostPath', r.host_path,
          'hostPageTitle', r.host_page_title,
          'courseId', r.course_id,
          'courseTitle', co.title,
          'moduleId', r.module_id,
          'moduleTitle', mo.title,
          'lessonId', r.lesson_id,
          'lessonTitle', le.title,
          'questions', r.questions,
          'deflectedQuestions', r.deflected_questions,
          'ungroundedQuestions', r.ungrounded_questions,
          'unansweredQuestions', r.unanswered_questions,
          'unattributedQuestions', r.unattributed_questions,
          'conversations', r.conversations,
          'anonymousVisitors', r.anonymous_visitors,
          'verifiedLearners', r.verified_learners,
          'deflectionShare', case
            when r.questions = 0 then null
            else round(
              r.deflected_questions::numeric / r.questions, 4
            )
          end,
          'lastDeflectedAt', r.last_deflected_at
        )
        order by r.cluster_rank
      ) filter (where r.cluster_rank <= cluster_limit),
      '[]'::jsonb
    ),
    count(*) filter (where r.cluster_rank > cluster_limit)::bigint
  into clusters, omitted_clusters
  from ranked r
  left join public.courses co
    on co.tenant_id = caller.tenant_id
   and co.course_id = r.course_id
  left join public.modules mo
    on mo.tenant_id = caller.tenant_id
   and mo.module_id = r.module_id
  left join public.lessons le
    on le.tenant_id = caller.tenant_id
   and le.lesson_id = r.lesson_id;

  coverage_limitations :=
    coverage_limitations || window_coverage.coverage_note;
  if coalesce(grounding.answers_without_source_record, 0) > 0 then
    coverage_limitations := coverage_limitations || (
      grounding.answers_without_source_record::text ||
      ' widget answer(s) carry no sources array and are counted neither as ' ||
      'grounded nor as ungrounded.'
    );
  end if;
  coverage_limitations := coverage_limitations || (
    'Grounding is a retrieval-coverage fact: an ungrounded answer is one ' ||
    'where zero citations were attached to the recorded turn. It is not a ' ||
    'judgement about whether the answer was correct.'
  );

  deflection_limitations :=
    deflection_limitations || window_coverage.coverage_note;
  if omitted_clusters > 0 then
    deflection_limitations := deflection_limitations || (
      'Only the top ' || cluster_limit::text ||
      ' deflection clusters are returned; ' || omitted_clusters::text ||
      ' further cluster(s) are omitted.'
    );
  end if;
  deflection_limitations := deflection_limitations || (
    'A deflection is a widget question whose recorded answer carried no ' ||
    'citation, whose turn has no recorded answer at all, or whose ' ||
    'conversation had no course context. It states what the platform failed ' ||
    'to ground, never what the visitor wanted.'
  );
  deflection_limitations := deflection_limitations || (
    'Topics are not derived here. Classified topics for these questions are ' ||
    'reported by public.analytics_question_labels and are deliberately not ' ||
    'recomputed under a second definition.'
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'generatedAt', statement_timestamp(),
    'range', jsonb_build_object(
      'start', win.window_start,
      'end', win.window_end,
      'timeZone', 'UTC',
      'dayCount', win.day_count
    ),
    'surface', app_private.surface_provenance(
      'widget',
      'widget',
      window_coverage.coverage,
      window_coverage.coverage_note,
      null::bigint,
      null::bigint
    ),
    'limits', jsonb_build_object(
      'clusters', cluster_limit,
      'truncated', omitted_clusters > 0
    ),
    'definitions', jsonb_build_object(
      'widgetAnswer',
      'An assistant message recorded in a conversation whose surface is ' ||
      'widget.',
      'deflection',
      'A widget question whose answer carried no citation, that has no ' ||
      'recorded answer, or that was asked with no course context.'
    ),
    'metrics', jsonb_build_object(
      'widgetGroundingCoverage', app_private.analytics_metric(
        case
          when window_coverage.coverage = 'none' then 'unknown'
          else 'partial'
        end,
        case
          when window_coverage.coverage = 'none' then null
          else jsonb_build_object(
            'answers', coalesce(grounding.answers, 0),
            'groundedAnswers', coalesce(grounding.grounded_answers, 0),
            'ungroundedAnswers', coalesce(grounding.ungrounded_answers, 0),
            'answersWithoutSourceRecord',
              coalesce(grounding.answers_without_source_record, 0),
            'ungroundedShare', case
              when coalesce(
                grounding.grounded_answers + grounding.ungrounded_answers, 0
              ) = 0 then null
              else round(
                grounding.ungrounded_answers::numeric
                  / (grounding.grounded_answers + grounding.ungrounded_answers),
                4
              )
            end,
            'averageSourceCount', grounding.average_source_count,
            'lastAnswerAt', grounding.last_answer_at
          )
        end,
        data_through,
        evidence,
        to_jsonb(coverage_limitations)
      ),
      'widgetDeflections', app_private.analytics_metric(
        case
          when window_coverage.coverage = 'none' then 'unknown'
          else 'partial'
        end,
        case
          when window_coverage.coverage = 'none' then null
          else jsonb_build_object(
            'questions', coalesce(deflection.questions, 0),
            'deflectedQuestions',
              coalesce(deflection.deflected_questions, 0),
            'ungroundedQuestions',
              coalesce(deflection.ungrounded_questions, 0),
            'unansweredQuestions',
              coalesce(deflection.unanswered_questions, 0),
            'unattributedQuestions',
              coalesce(deflection.unattributed_questions, 0),
            'anonymousVisitors', coalesce(deflection.anonymous_visitors, 0),
            'deflectionShare', case
              when coalesce(deflection.questions, 0) = 0 then null
              else round(
                deflection.deflected_questions::numeric
                  / deflection.questions,
                4
              )
            end,
            'lastDeflectedAt', deflection.last_deflected_at,
            'clusters', clusters,
            'omittedClusters', omitted_clusters
          )
        end,
        data_through,
        evidence,
        to_jsonb(deflection_limitations)
      )
    )
  );
end;
$$;

-- ---------------------------------------------------------- widget signals

-- Three new kinds join the existing vocabulary. The constraint is replaced by
-- name discovery so this does not depend on the auto-generated name the
-- original CREATE TABLE produced.
do $$
declare
  existing_constraint text;
begin
  select con.conname
  into existing_constraint
  from pg_catalog.pg_constraint con
  join pg_catalog.pg_class cls on cls.oid = con.conrelid
  join pg_catalog.pg_namespace nsp on nsp.oid = cls.relnamespace
  where nsp.nspname = 'public'
    and cls.relname = 'question_signals'
    and con.contype = 'c'
    and pg_catalog.pg_get_constraintdef(con.oid) like '%signal_kind%'
  limit 1;
  if existing_constraint is not null then
    execute format(
      'alter table public.question_signals drop constraint %I',
      existing_constraint
    );
  end if;
end $$;
alter table public.question_signals
  add constraint question_signals_signal_kind_check
  check (signal_kind in (
    'topic_spike',
    'content_gap',
    'repeated_question_cluster',
    'post_lesson_stall',
    'unattributed_questions',
    'widget_page_ungrounded',
    'widget_anonymous_spike',
    'widget_unpublished_content'
  ));

-- Widget-aware detectors. Same contract, same evidence discipline and the same
-- deterministic threshold comparisons as the five that already exist: every row
-- returned here is a comparison between counts the tenant's own rows hold.
create or replace function app_private.widget_signal_detections(
  window_start timestamptz,
  window_end timestamptz
)
returns table (
  signal_fingerprint text,
  signal_kind text,
  severity text,
  severity_rank smallint,
  headline text,
  detail text,
  course_id uuid,
  module_id uuid,
  lesson_id uuid,
  observed_value numeric,
  comparison_value numeric,
  evidence jsonb,
  evidence_refs jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  prior_start timestamptz;
begin
  select * into caller from app_private.analytics_context();
  if not found then
    return;
  end if;
  -- Before surface attribution existed no conversation can be a widget one, so
  -- these detectors correctly yield nothing rather than a fabricated absence.
  if window_end <= app_private.surface_attribution_epoch() then
    return;
  end if;
  prior_start := window_start - (window_end - window_start);

  -- 1. A host page whose embedded answers keep landing without a citation.
  --    This is the page-level twin of the existing content_gap signal: same
  --    fact, read through the surface the visitor was actually standing on.
  return query
  with widget_answers as (
    select
      coalesce(v.host_origin, '(origin not recorded)') as host_origin,
      coalesce(v.host_path, '(path not recorded)') as host_path,
      v.host_page_title,
      m.message_id,
      m.created_at,
      case
        when jsonb_typeof(m.structured_content -> 'sources') = 'array'
          then jsonb_array_length(m.structured_content -> 'sources')
      end as source_count
    from public.messages m
    join public.conversations conv
      on conv.tenant_id = m.tenant_id
     and conv.conversation_id = m.conversation_id
    join app_private.conversation_surface_view(caller.tenant_id) v
      on v.conversation_id = m.conversation_id
    where m.tenant_id = caller.tenant_id
      and m.created_at >= window_start
      and m.created_at < window_end
      and m.deleted_at is null
      and m.status = 'final'
      and m.actor_type = 'assistant'
      and conv.deleted_at is null
      and v.surface = 'widget'
  ),
  pages as (
    select
      a.host_origin,
      a.host_path,
      min(a.host_page_title) as host_page_title,
      count(*) filter (where a.source_count = 0)::bigint as ungrounded,
      count(*) filter (where a.source_count is not null)::bigint as classified,
      max(a.created_at) filter (
        where a.source_count = 0
      ) as last_ungrounded_at,
      (
        array_agg(a.message_id order by a.created_at desc)
          filter (where a.source_count = 0)
      )[1:5] as sample_ids
    from widget_answers a
    group by a.host_origin, a.host_path
  ),
  graded as (
    select
      p.*,
      round(p.ungrounded::numeric / p.classified, 4) as ungrounded_share,
      case
        when p.ungrounded >= 8
          and p.ungrounded::numeric / p.classified >= 0.7 then 'critical'
        when p.ungrounded >= 5 then 'elevated'
        else 'watch'
      end as page_severity
    from pages p
    where p.classified > 0
      and p.ungrounded >= 3
      and p.ungrounded::numeric / p.classified >= 0.5
  )
  select
    app_private.question_signal_fingerprint(
      caller.tenant_id,
      'widget_page_ungrounded',
      g.host_origin || chr(31) || g.host_path
    ),
    'widget_page_ungrounded'::text,
    g.page_severity::text,
    app_private.question_severity_rank(g.page_severity),
    'The widget on ' || g.host_origin || g.host_path || ' answered ' ||
      g.ungrounded::text || ' question(s) with no citation',
    g.ungrounded::text || ' of ' || g.classified::text ||
      ' answer(s) given to visitors on this host page carried an empty ' ||
      'citation list. The page is where the question was asked, not ' ||
      'necessarily what it was about; this is a retrieval-coverage fact, ' ||
      'not a judgement about whether the answers were correct.',
    null::uuid,
    null::uuid,
    null::uuid,
    g.ungrounded::numeric,
    g.classified::numeric,
    jsonb_build_object(
      'hostOrigin', g.host_origin,
      'hostPath', g.host_path,
      'hostPageTitle', g.host_page_title,
      'ungroundedAnswers', g.ungrounded,
      'classifiedAnswers', g.classified,
      'ungroundedShare', g.ungrounded_share,
      'lastUngroundedAt', g.last_ungrounded_at
    ),
    jsonb_build_array(
      'table:public.conversation_surfaces',
      'column:public.messages.structured_content.sources'
    )
      || coalesce(
        (
          select jsonb_agg('message:' || sampled.message_id::text)
          from unnest(g.sample_ids) as sampled(message_id)
        ),
        '[]'::jsonb
      )
  from graded g;

  -- 2. A spike in anonymous questions on one origin. Anonymous askers are
  --    counted by pseudonymous key and never mixed into the learner counts, so
  --    this says "traffic from unauthenticated browsers on this site rose",
  --    which is exactly and only what the rows support.
  return query
  with anonymous_questions as (
    select
      coalesce(v.host_origin, '(origin not recorded)') as host_origin,
      v.visitor_key,
      v.host_path,
      m.created_at
    from public.messages m
    join public.conversations conv
      on conv.tenant_id = m.tenant_id
     and conv.conversation_id = m.conversation_id
    join app_private.conversation_surface_view(caller.tenant_id) v
      on v.conversation_id = m.conversation_id
    where m.tenant_id = caller.tenant_id
      and m.created_at >= prior_start
      and m.created_at < window_end
      and m.deleted_at is null
      and m.status = 'final'
      and m.actor_type in ('student', 'creator', 'owner')
      and m.modality in ('text', 'voice_transcript')
      and conv.deleted_at is null
      and v.surface = 'widget'
      and v.visitor_identity = 'anonymous_visitor'
  ),
  current_window as (
    select
      a.host_origin,
      count(*)::bigint as question_count,
      count(distinct a.visitor_key)::bigint as visitor_count,
      count(distinct a.host_path)::bigint as page_count,
      max(a.created_at) as last_seen_at
    from anonymous_questions a
    where a.created_at >= window_start
    group by a.host_origin
  ),
  prior_window as (
    select a.host_origin, count(*)::bigint as question_count
    from anonymous_questions a
    where a.created_at < window_start
    group by a.host_origin
  ),
  spikes as (
    select
      c.host_origin,
      c.question_count,
      c.visitor_count,
      c.page_count,
      c.last_seen_at,
      coalesce(p.question_count, 0) as prior_count
    from current_window c
    left join prior_window p on p.host_origin = c.host_origin
    where c.question_count >= 10
      and c.question_count - coalesce(p.question_count, 0) >= 5
      and c.question_count >= 2 * greatest(coalesce(p.question_count, 0), 1)
  )
  select
    app_private.question_signal_fingerprint(
      caller.tenant_id, 'widget_anonymous_spike', s.host_origin
    ),
    'widget_anonymous_spike'::text,
    case
      when s.question_count >= 30
        and s.question_count >= 3 * greatest(s.prior_count, 1)
        then 'critical'
      when s.question_count >= 15 then 'elevated'
      else 'watch'
    end,
    app_private.question_severity_rank(
      case
        when s.question_count >= 30
          and s.question_count >= 3 * greatest(s.prior_count, 1)
          then 'critical'
        when s.question_count >= 15 then 'elevated'
        else 'watch'
      end
    ),
    'Anonymous widget questions on ' || s.host_origin || ' rose to ' ||
      s.question_count::text || ' from ' || s.prior_count::text,
    s.question_count::text || ' question(s) from ' ||
      s.visitor_count::text ||
      ' distinct anonymous visitor reference(s) across ' ||
      s.page_count::text || ' page(s) on this origin, against ' ||
      s.prior_count::text ||
      ' in the immediately preceding window of the same length. An ' ||
      'anonymous visitor reference identifies a returning browser, not a ' ||
      'person, and is never added to the verified-learner count.',
    null::uuid,
    null::uuid,
    null::uuid,
    s.question_count::numeric,
    s.prior_count::numeric,
    jsonb_build_object(
      'hostOrigin', s.host_origin,
      'anonymousQuestionsInRange', s.question_count,
      'anonymousQuestionsInPriorWindow', s.prior_count,
      'anonymousVisitors', s.visitor_count,
      'pages', s.page_count,
      'priorWindowStart', prior_start,
      'priorWindowEnd', window_start,
      'lastSeenAt', s.last_seen_at
    ),
    jsonb_build_array(
      'table:public.conversation_surfaces',
      'table:public.messages',
      'column:public.conversation_surfaces.visitor_key'
    )
  from spikes s;

  -- 3. A widget taking questions about content that is not published. The
  --    learner-facing console refuses to open a conversation on unpublished
  --    material, so this can only be true of an embedded surface, and it means
  --    visitors are being answered from something nobody has released.
  return query
  with widget_questions as (
    select
      conv.course_id,
      conv.module_id,
      conv.lesson_id,
      coalesce(v.host_origin, '(origin not recorded)') as host_origin,
      m.message_id,
      m.created_at,
      conv.conversation_id
    from public.messages m
    join public.conversations conv
      on conv.tenant_id = m.tenant_id
     and conv.conversation_id = m.conversation_id
    join app_private.conversation_surface_view(caller.tenant_id) v
      on v.conversation_id = m.conversation_id
    where m.tenant_id = caller.tenant_id
      and m.created_at >= window_start
      and m.created_at < window_end
      and m.deleted_at is null
      and m.status = 'final'
      and m.actor_type in ('student', 'creator', 'owner')
      and m.modality in ('text', 'voice_transcript')
      and conv.deleted_at is null
      and conv.course_id is not null
      and v.surface = 'widget'
  ),
  unpublished as (
    select
      q.course_id,
      q.module_id,
      q.lesson_id,
      co.title as course_title,
      co.status as course_status,
      mo.title as module_title,
      mo.status as module_status,
      le.title as lesson_title,
      le.status as lesson_status,
      count(*)::bigint as question_count,
      count(distinct q.conversation_id)::bigint as conversation_count,
      count(distinct q.host_origin)::bigint as origin_count,
      max(q.created_at) as last_question_at,
      (array_agg(q.message_id order by q.created_at desc))[1:5] as sample_ids
    from widget_questions q
    join public.courses co
      on co.tenant_id = caller.tenant_id
     and co.course_id = q.course_id
    left join public.modules mo
      on mo.tenant_id = caller.tenant_id
     and mo.module_id = q.module_id
    left join public.lessons le
      on le.tenant_id = caller.tenant_id
     and le.lesson_id = q.lesson_id
    where co.status <> 'published'
       or (mo.module_id is not null and mo.status <> 'published')
       or (le.lesson_id is not null and le.status <> 'published')
    group by
      q.course_id, q.module_id, q.lesson_id,
      co.title, co.status, mo.title, mo.status, le.title, le.status
    having count(*) >= 2
  )
  select
    app_private.question_signal_fingerprint(
      caller.tenant_id,
      'widget_unpublished_content',
      coalesce(u.lesson_id::text, '') || chr(31) ||
      coalesce(u.module_id::text, '') || chr(31) ||
      coalesce(u.course_id::text, '')
    ),
    'widget_unpublished_content'::text,
    case
      when u.question_count >= 10 then 'critical'
      when u.question_count >= 5 then 'elevated'
      else 'watch'
    end,
    app_private.question_severity_rank(
      case
        when u.question_count >= 10 then 'critical'
        when u.question_count >= 5 then 'elevated'
        else 'watch'
      end
    ),
    'The widget took ' || u.question_count::text ||
      ' question(s) about unpublished ' ||
      coalesce(u.lesson_title, u.module_title, u.course_title,
        'course material'),
    'These questions were asked through the embedded widget in a ' ||
      'conversation attributed to material that is not published: course "' ||
      u.course_title || '" is ' || u.course_status ||
      coalesce(', module "' || u.module_title || '" is ' || u.module_status, '') ||
      coalesce(', lesson "' || u.lesson_title || '" is ' || u.lesson_status, '') ||
      '. The signed-in learning surface refuses to open a conversation on ' ||
      'unpublished material, so this is a fact about what the widget is ' ||
      'exposing, not about the learner.',
    u.course_id,
    u.module_id,
    u.lesson_id,
    u.question_count::numeric,
    u.conversation_count::numeric,
    jsonb_build_object(
      'courseId', u.course_id,
      'courseTitle', u.course_title,
      'courseStatus', u.course_status,
      'moduleTitle', u.module_title,
      'moduleStatus', u.module_status,
      'lessonTitle', u.lesson_title,
      'lessonStatus', u.lesson_status,
      'questions', u.question_count,
      'conversations', u.conversation_count,
      'origins', u.origin_count,
      'lastQuestionAt', u.last_question_at
    ),
    jsonb_build_array(
      'table:public.conversation_surfaces',
      'column:public.courses.status',
      'column:public.lessons.status'
    )
      || coalesce(
        (
          select jsonb_agg('message:' || sampled.message_id::text)
          from unnest(u.sample_ids) as sampled(message_id)
        ),
        '[]'::jsonb
      )
  from unpublished u;
end;
$$;
revoke execute on function app_private.widget_signal_detections(
  timestamptz, timestamptz
) from public, anon, authenticated, service_role;

-- Compose, do not fork. The five detectors written in 20260726091000 are
-- preserved byte for byte by renaming their function and calling it, so there
-- is no second copy of them to drift. public.analytics_signals and
-- public.analytics_signal_review both call
-- app_private.question_signal_detections and therefore see, rank, truncate and
-- allow review of the widget signals with no change of their own.
alter function app_private.question_signal_detections(timestamptz, timestamptz)
  rename to question_signal_detections_base;

create or replace function app_private.question_signal_detections(
  window_start timestamptz,
  window_end timestamptz
)
returns table (
  signal_fingerprint text,
  signal_kind text,
  severity text,
  severity_rank smallint,
  headline text,
  detail text,
  course_id uuid,
  module_id uuid,
  lesson_id uuid,
  observed_value numeric,
  comparison_value numeric,
  evidence jsonb,
  evidence_refs jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
begin
  return query
  select * from app_private.question_signal_detections_base(
    window_start, window_end
  );
  return query
  select * from app_private.widget_signal_detections(window_start, window_end);
end;
$$;
revoke execute on function app_private.question_signal_detections_base(
  timestamptz, timestamptz
) from public, anon, authenticated, service_role;
revoke execute on function app_private.question_signal_detections(
  timestamptz, timestamptz
) from public, anon, authenticated, service_role;

-- --------------------------------------------------------------------- grants

revoke all on function public.learning_record_conversation_surface(
  uuid, text, text, text, text, text, boolean, text, text, text
) from public, anon, service_role;
revoke all on function public.analytics_tenant_overview(
  timestamptz, timestamptz, text
) from public, anon, service_role;
revoke all on function public.analytics_question_distribution(
  timestamptz, timestamptz, text
) from public, anon, service_role;
revoke all on function public.analytics_answer_quality(
  timestamptz, timestamptz, text
) from public, anon, service_role;
revoke all on function public.analytics_surface_breakdown(
  timestamptz, timestamptz, text
) from public, anon, service_role;
revoke all on function public.analytics_widget_engagement(
  timestamptz, timestamptz
) from public, anon, service_role;
revoke all on function public.analytics_widget_content_gaps(
  timestamptz, timestamptz
) from public, anon, service_role;

grant execute on function public.learning_record_conversation_surface(
  uuid, text, text, text, text, text, boolean, text, text, text
) to authenticated;
grant execute on function public.analytics_tenant_overview(
  timestamptz, timestamptz, text
) to authenticated;
grant execute on function public.analytics_question_distribution(
  timestamptz, timestamptz, text
) to authenticated;
grant execute on function public.analytics_answer_quality(
  timestamptz, timestamptz, text
) to authenticated;
grant execute on function public.analytics_surface_breakdown(
  timestamptz, timestamptz, text
) to authenticated;
grant execute on function public.analytics_widget_engagement(
  timestamptz, timestamptz
) to authenticated;
grant execute on function public.analytics_widget_content_gaps(
  timestamptz, timestamptz
) to authenticated;

commit;

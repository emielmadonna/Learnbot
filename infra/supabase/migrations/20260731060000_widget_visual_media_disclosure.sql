-- ============================================================
-- 20260731060000_widget_visual_media_disclosure.sql
-- Public and hosted widget visual media: the missing capability.
--
-- THE GAP THIS CLOSES
--
-- Authenticated visual delivery has worked since 20260731045059:
-- `learning_get_visual_asset_for_read` resolves an asset for a signed-in
-- caller and the console streams it from tenant-private storage. The public
-- widget had no counterpart, so inline images and video were simply absent
-- from every anonymous answer. The launch note called this "pending an exact
-- widget-scoped media capability". This is that capability.
--
-- WHY IT COULD NOT JUST REUSE THE AUTHENTICATED RULE
--
-- The authenticated rule ends in "...and the caller is a member of this
-- tenant". A widget visitor is not a member of anything. The widget key is
-- PUBLIC -- it ships in a <script> tag on the customer's page -- so a rule of
-- the form "any active, answerable asset in the tenant whose key this is" is a
-- rule that lets any visitor, on any allowed origin, enumerate and download
-- every visual the tenant owns by walking uuids. That is a data leak wearing a
-- feature's clothes, and it is why this stayed switched off rather than
-- shipping loose.
--
-- THE RULE THIS USES INSTEAD: DISCLOSURE, NOT MEMBERSHIP
--
-- A widget visitor may read exactly the visuals the assistant already showed
-- to THEM, in THEIR conversation, and nothing else. So the grant is not
-- derived from who they are; it is derived from what was already disclosed to
-- them. `visual_answer_disclosures` records, at answer time, that a given
-- visual was surfaced in a given conversation. The read then requires a
-- matching row.
--
-- Concretely, a visitor must present all four of:
--   1. a live widget key,
--   2. an origin that key allows,
--   3. the conversation_ref they already hold (32-128 chars of unguessable
--      client-generated id, salted and hashed exactly as widget_ask does), and
--   4. a visual_asset_id that was actually disclosed in THAT conversation.
-- Walking uuids gains nothing: an asset never surfaced in that conversation
-- has no disclosure row, and the answer is the same opaque `visual_not_found`
-- an unknown id gets. Guessing a conversation_ref is the same work as guessing
-- a session token.
--
-- The asset conditions from the authenticated path are kept ON TOP of that,
-- not replaced by it: still `status = 'active'`, still validated by
-- `server_media_inspection_v1`, still `show_in_answers`, and still on a
-- published course. A creator un-publishing a course or clearing
-- "show in answers" revokes access on the next read even for a visitor who was
-- shown the asset an hour ago, because the disclosure row is a necessary
-- condition and never a sufficient one.
--
-- RETENTION
--
-- Disclosure rows inherit the conversation's own retention: they are deleted
-- with the conversation, and they carry `retain_until` so the existing privacy
-- sweep reaches them. They hold no payload -- three ids and a timestamp -- so
-- they are not themselves a new personal-data surface, but they DO record that
-- a particular anonymous visitor was shown a particular thing, which is why
-- they are covered by retention rather than kept forever.
-- ============================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The disclosure ledger.
-- ---------------------------------------------------------------------------

create table if not exists public.visual_answer_disclosures (
  disclosure_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  conversation_id uuid not null,
  message_id uuid,
  visual_asset_id uuid not null,
  created_at timestamptz not null default now(),
  retain_until timestamptz,
  foreign key (tenant_id, conversation_id)
    references public.conversations(tenant_id, conversation_id)
    on delete cascade,
  foreign key (tenant_id, visual_asset_id)
    references public.visual_knowledge_assets(tenant_id, visual_asset_id)
    on delete cascade,
  -- One row per (conversation, asset). An asset shown in three answers of the
  -- same conversation grants the same access as one; a second row would only
  -- add write amplification.
  unique (tenant_id, conversation_id, visual_asset_id)
);

-- The read path's exact predicate.
create index if not exists visual_answer_disclosures_lookup_idx
  on public.visual_answer_disclosures (
    tenant_id, conversation_id, visual_asset_id
  );

-- The retention sweep's predicate.
create index if not exists visual_answer_disclosures_retain_idx
  on public.visual_answer_disclosures (retain_until)
  where retain_until is not null;

alter table public.visual_answer_disclosures enable row level security;
alter table public.visual_answer_disclosures force row level security;

-- No direct reads or writes by anyone, ever. This table is reachable only
-- through the security-definer functions below, exactly like
-- visual_knowledge_assets itself.
drop policy if exists visual_answer_disclosures_deny_direct
  on public.visual_answer_disclosures;
create policy visual_answer_disclosures_deny_direct
  on public.visual_answer_disclosures
  for all
  using (false)
  with check (false);

revoke all on table public.visual_answer_disclosures
  from public, anon, authenticated, service_role;

comment on table public.visual_answer_disclosures is
  'Records that a visual asset was surfaced in a conversation. Read grants for '
  'anonymous widget visitors are derived from these rows -- what was already '
  'shown to you -- never from tenant membership, because a widget key is public.';

-- ---------------------------------------------------------------------------
-- 2. Recording a disclosure.
--
--    Called by the server that just produced the answer, under the same
--    `conversation.answer.record` capability that already gates writing the
--    assistant turn itself. A browser cannot call this: it holds no operation
--    token, so it cannot grant itself access to an asset it was never shown.
-- ---------------------------------------------------------------------------

create or replace function app_private.visual_record_disclosures(
  target_tenant_id uuid,
  target_conversation_id uuid,
  target_message_id uuid,
  visual_asset_ids uuid[],
  retention timestamptz
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  recorded integer := 0;
begin
  if visual_asset_ids is null or cardinality(visual_asset_ids) = 0 then
    return 0;
  end if;

  -- Only assets that are genuinely disclosable get a row. Recording a
  -- disclosure for an archived or non-answerable asset would mint an access
  -- grant the answer never actually used.
  insert into public.visual_answer_disclosures (
    tenant_id, conversation_id, message_id, visual_asset_id, retain_until
  )
  select
    target_tenant_id,
    target_conversation_id,
    target_message_id,
    visual.visual_asset_id,
    retention
  from public.visual_knowledge_assets visual
  where visual.tenant_id = target_tenant_id
    and visual.visual_asset_id = any(visual_asset_ids)
    and visual.status = 'active'
    and visual.show_in_answers
  on conflict (tenant_id, conversation_id, visual_asset_id) do nothing;

  get diagnostics recorded = row_count;
  return recorded;
end;
$$;

revoke execute on function app_private.visual_record_disclosures(
  uuid, uuid, uuid, uuid[], timestamptz
) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The widget-facing writer.
--
--    Mirrors widget_record_answer's signature style: the (key, origin) pair is
--    re-resolved here rather than trusted from the caller, and the operation
--    token is checked before anything is written.
-- ---------------------------------------------------------------------------

create or replace function public.widget_record_visual_disclosure(
  widget_key text,
  origin text,
  conversation_ref text,
  visual_asset_ids uuid[],
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
  recorded integer;
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

  if conversation_ref is null
    or conversation_ref !~ '^[A-Za-z0-9_-]{32,128}$'
    or visual_asset_ids is null
    or cardinality(visual_asset_ids) > 12
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  conversation_hash :=
    app_private.widget_conversation_hash(widget_key, conversation_ref);

  -- The widget's conversation is keyed exactly as app_private.widget_conversation
  -- creates it: 'widget:' || the salted hash. Re-deriving it here means a ref
  -- from another widget key or another tenant simply matches nothing.
  select c.conversation_id into conversation_id
  from public.conversations c
  where c.tenant_id = resolved.tenant_id
    and c.idempotency_key = 'widget:' || conversation_hash
    and c.deleted_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'conversation_not_found');
  end if;

  recorded := app_private.visual_record_disclosures(
    resolved.tenant_id,
    conversation_id,
    null,
    visual_asset_ids,
    (
      select c.retain_until
      from public.conversations c
      where c.tenant_id = resolved.tenant_id
        and c.conversation_id = conversation_id
    )
  );

  return jsonb_build_object(
    'ok', true, 'dataMode', 'durable', 'recorded', recorded
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The widget-facing reader.
--
--    Returns the private object key for the console to stream, exactly like
--    the authenticated function. It never returns a signed URL: signing stays
--    on the server so the object key and the storage credential never reach a
--    visitor's browser.
-- ---------------------------------------------------------------------------

create or replace function public.widget_get_visual_asset_for_read(
  widget_key text,
  origin text,
  conversation_ref text,
  target_visual_asset_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  resolved record;
  conversation_hash text;
  asset record;
begin
  select * into resolved
  from app_private.widget_resolve(widget_key, origin);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'widget_unavailable');
  end if;

  if conversation_ref is null
    or conversation_ref !~ '^[A-Za-z0-9_-]{32,128}$'
    or target_visual_asset_id is null
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  conversation_hash :=
    app_private.widget_conversation_hash(widget_key, conversation_ref);

  select
    visual.visual_asset_id,
    visual.title,
    visual.alt_text,
    visual.media_type,
    visual.visual_kind,
    visual.size_bytes,
    visual.object_key
  into asset
  from public.visual_answer_disclosures disclosure
  join public.conversations conversation
    on conversation.tenant_id = disclosure.tenant_id
   and conversation.conversation_id = disclosure.conversation_id
   and conversation.deleted_at is null
  join public.visual_knowledge_assets visual
    on visual.tenant_id = disclosure.tenant_id
   and visual.visual_asset_id = disclosure.visual_asset_id
  join public.courses course
    on course.tenant_id = visual.tenant_id
   and course.course_id = visual.course_id
   and course.deleted_at is null
  where disclosure.tenant_id = resolved.tenant_id
    and disclosure.visual_asset_id = target_visual_asset_id
    -- The visitor proves which conversation is theirs by presenting the ref;
    -- the key is re-derived here exactly as widget_conversation writes it.
    and conversation.idempotency_key = 'widget:' || conversation_hash
    -- Everything below is the authenticated path's asset rule, unchanged. A
    -- disclosure row is necessary, never sufficient: revoking answerability or
    -- un-publishing the course cuts access off at the next read.
    and visual.status = 'active'
    and visual.show_in_answers
    and visual.validated_sha256 is not null
    and visual.validated_at is not null
    and visual.validation_profile = 'server_media_inspection_v1'
    and course.status = 'published';

  if not found then
    -- Deliberately the same opaque code an unknown id gets, so a probe cannot
    -- distinguish "exists but not yours" from "does not exist".
    return jsonb_build_object('ok', false, 'code', 'visual_not_found');
  end if;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'visualAssetId', asset.visual_asset_id,
    'title', asset.title,
    'altText', asset.alt_text,
    'mediaType', asset.media_type,
    'visualKind', asset.visual_kind,
    'sizeBytes', asset.size_bytes,
    'privateObjectKey', asset.object_key
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants. Function creation grants PUBLIC execute by default, so close
--    every new surface first and then open only the real caller.
--
--    `anon`, matching widget_ask / widget_record_answer exactly. The console's
--    widget routes hold a sessionless client built on the PUBLISHABLE key
--    (createWidgetSupabaseClient in lib/supabase/widget-rpc.ts), so they call
--    as anon -- there is deliberately no service-role credential on the widget
--    path. That is safe here for the same reason it is safe for widget_ask:
--    the authority is not the database role, it is the (key, origin,
--    conversation_ref) triple re-checked inside the function, plus -- for the
--    writer -- an operation token no browser holds.
-- ---------------------------------------------------------------------------

revoke execute on function public.widget_record_visual_disclosure(
  text, text, text, uuid[], text
) from public, authenticated, service_role;
revoke execute on function public.widget_get_visual_asset_for_read(
  text, text, text, uuid
) from public, authenticated, service_role;

grant execute on function public.widget_record_visual_disclosure(
  text, text, text, uuid[], text
) to anon;
grant execute on function public.widget_get_visual_asset_for_read(
  text, text, text, uuid
) to anon;

commit;

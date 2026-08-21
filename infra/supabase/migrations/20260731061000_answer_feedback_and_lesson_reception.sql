-- ============================================================
-- 20260731061000_answer_feedback_and_lesson_reception.sql
-- "Was that helpful?", and what it lets three surfaces finally say.
--
-- WHAT WAS MISSING
--
-- Three screens in the design ask for a number this platform has never
-- collected:
--   * the widget's "Did that help? Yes / Not really" control under an answer,
--   * Insights' "Rated helpful 84% -- only 38% were rated" card, which today
--     renders the honest placeholder "Not measured", and
--   * the Learning editor's per-lesson "cited in 118 answers / rated helpful
--     44%" rail.
-- The first is the collection point; the other two are readouts of it. None of
-- them could ship without this table, which is why the panels currently say
-- "Not known" rather than inventing a figure.
--
-- ONE RATING PER ANSWER PER RATER
--
-- The unique index is on (tenant, message, rater). A signed-in learner rates
-- as their principal; an anonymous widget visitor rates as their conversation,
-- because that is the only stable identity an anonymous visitor has and it is
-- the same identity the rate limiter already uses. Re-rating UPDATES rather
-- than inserting, so "38% were rated" stays a count of people, not clicks, and
-- a visitor mashing the button cannot skew a tenant's score.
--
-- WHY THE DENOMINATOR IS REPORTED, NOT HIDDEN
--
-- A helpfulness percentage over a self-selected 3% response rate is close to
-- meaningless, and a dashboard that shows the percentage without the response
-- rate invites exactly that mistake. Both readouts below return `ratedCount`
-- and `answerCount` alongside the percentage, and return a null percentage
-- rather than 0 when nothing has been rated -- the same "an unmeasurable
-- metric is 'Not known', never a zero" rule the analytics surface already
-- states about itself.
--
-- LESSON RECEPTION NEEDS NO NEW COLUMN
--
-- "Cited in N answers" looked like it needed a new join table. It does not.
-- `messages.structured_content -> 'sources'` already records every citation on
-- every answer, each carrying `chunkId`, and `learning_chunks.metadata ->>
-- 'lessonId'` already carries lesson identity -- documented as load-bearing in
-- 20260726095000. So citation counts are an aggregate over data that has been
-- accumulating this whole time, and this migration adds a readout, not a
-- write path. `GroundingSource.lessonId` exists in the TypeScript type but is
-- never populated (the widget hard-codes null), so the join deliberately goes
-- through chunkId instead and therefore also covers all history.
-- ============================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Storage.
-- ---------------------------------------------------------------------------

create table if not exists public.answer_feedback (
  answer_feedback_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  conversation_id uuid not null,
  message_id uuid not null,
  -- Exactly one of these is set. A signed-in rater is a principal; an
  -- anonymous widget rater is their own conversation, and carries no principal
  -- because inventing one would fabricate an auth identity for someone who
  -- deliberately has none.
  principal_id text references public.identity_principals(principal_id),
  anonymous_rater boolean not null default false,
  rating text not null check (rating in ('helpful', 'not_helpful')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  retain_until timestamptz,
  foreign key (tenant_id, conversation_id)
    references public.conversations(tenant_id, conversation_id)
    on delete cascade,
  foreign key (tenant_id, message_id)
    references public.messages(tenant_id, message_id)
    on delete cascade,
  constraint answer_feedback_rater_is_exclusive check (
    (principal_id is not null and anonymous_rater = false)
    or (principal_id is null and anonymous_rater = true)
  )
);

-- One rating per signed-in rater per answer.
create unique index if not exists answer_feedback_principal_unique_idx
  on public.answer_feedback (tenant_id, message_id, principal_id)
  where principal_id is not null;

-- One rating per anonymous conversation per answer. The conversation IS the
-- rater, so the conversation id is the identity column here.
create unique index if not exists answer_feedback_anonymous_unique_idx
  on public.answer_feedback (tenant_id, message_id, conversation_id)
  where principal_id is null;

-- The readouts below scan by tenant and time.
create index if not exists answer_feedback_tenant_created_idx
  on public.answer_feedback (tenant_id, created_at desc);

create index if not exists answer_feedback_retain_idx
  on public.answer_feedback (retain_until)
  where retain_until is not null;

alter table public.answer_feedback enable row level security;
alter table public.answer_feedback force row level security;

drop policy if exists answer_feedback_deny_direct on public.answer_feedback;
create policy answer_feedback_deny_direct
  on public.answer_feedback
  for all
  using (false)
  with check (false);

revoke all on table public.answer_feedback
  from public, anon, authenticated, service_role;

comment on table public.answer_feedback is
  'One helpful/not-helpful rating per answer per rater. A signed-in rater is a '
  'principal; an anonymous widget rater is their conversation. Re-rating '
  'updates in place so counts stay per-person, not per-click.';

-- ---------------------------------------------------------------------------
-- 2. Signed-in rating.
--
--    A learner may rate only an answer inside a conversation they can already
--    see, which is enforced by re-deriving the conversation from the message
--    under the caller's own tenant rather than trusting a caller-supplied
--    conversation id.
-- ---------------------------------------------------------------------------

create or replace function public.learning_record_answer_feedback(
  target_message_id uuid,
  requested_rating text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  answer record;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'tenant_selection_required'
    );
  end if;

  if requested_rating is null
    or requested_rating not in ('helpful', 'not_helpful')
    or target_message_id is null
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select m.message_id, m.conversation_id, m.retain_until
  into answer
  from public.messages m
  where m.tenant_id = caller.tenant_id
    and m.message_id = target_message_id
    and m.actor_type = 'assistant'
    and m.status = 'final'
    and m.deleted_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'answer_not_found');
  end if;

  insert into public.answer_feedback (
    tenant_id, conversation_id, message_id, principal_id, anonymous_rater,
    rating, retain_until
  )
  values (
    caller.tenant_id, answer.conversation_id, answer.message_id,
    caller.principal_id, false, requested_rating, answer.retain_until
  )
  on conflict (tenant_id, message_id, principal_id)
    where principal_id is not null
  do update set
    rating = excluded.rating,
    updated_at = now();

  return jsonb_build_object(
    'ok', true, 'dataMode', 'durable', 'rating', requested_rating
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Anonymous widget rating.
--
--    Same (key, origin, conversation_ref) proof the rest of the widget surface
--    uses. No operation token: unlike recording an ANSWER, recording an
--    opinion about an answer is something the visitor is entitled to do
--    directly, and the uniqueness index is what stops it being abused.
-- ---------------------------------------------------------------------------

create or replace function public.widget_record_answer_feedback(
  widget_key text,
  origin text,
  conversation_ref text,
  target_message_id uuid,
  requested_rating text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  resolved record;
  conversation_hash text;
  answer record;
begin
  select * into resolved
  from app_private.widget_resolve(widget_key, origin);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'widget_unavailable');
  end if;

  if conversation_ref is null
    or conversation_ref !~ '^[A-Za-z0-9_-]{32,128}$'
    or target_message_id is null
    or requested_rating is null
    or requested_rating not in ('helpful', 'not_helpful')
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  conversation_hash :=
    app_private.widget_conversation_hash(widget_key, conversation_ref);

  -- The message must belong to the conversation the visitor proved they hold.
  -- A message id from someone else's conversation matches nothing here.
  select m.message_id, m.conversation_id, m.retain_until
  into answer
  from public.messages m
  join public.conversations c
    on c.tenant_id = m.tenant_id
   and c.conversation_id = m.conversation_id
   and c.deleted_at is null
  where m.tenant_id = resolved.tenant_id
    and m.message_id = target_message_id
    and m.actor_type = 'assistant'
    and m.status = 'final'
    and m.deleted_at is null
    and c.idempotency_key = 'widget:' || conversation_hash;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'answer_not_found');
  end if;

  insert into public.answer_feedback (
    tenant_id, conversation_id, message_id, principal_id, anonymous_rater,
    rating, retain_until
  )
  values (
    resolved.tenant_id, answer.conversation_id, answer.message_id,
    null, true, requested_rating, answer.retain_until
  )
  on conflict (tenant_id, message_id, conversation_id)
    where principal_id is null
  do update set
    rating = excluded.rating,
    updated_at = now();

  return jsonb_build_object(
    'ok', true, 'dataMode', 'durable', 'rating', requested_rating
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Tenant-wide readout, for the Insights "Rated helpful" card.
--
--    Returns the response rate beside the score on purpose -- see the header.
-- ---------------------------------------------------------------------------

create or replace function public.learning_answer_feedback_summary(
  window_days integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  window_start timestamptz;
  answer_count bigint;
  rated_count bigint;
  helpful_count bigint;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'tenant_selection_required'
    );
  end if;
  if window_days is null or window_days not between 1 and 366 then
    return jsonb_build_object('ok', false, 'code', 'invalid_range');
  end if;
  window_start := statement_timestamp() - make_interval(days => window_days);

  select count(*) into answer_count
  from public.messages m
  where m.tenant_id = caller.tenant_id
    and m.actor_type = 'assistant'
    and m.status = 'final'
    and m.deleted_at is null
    and m.created_at >= window_start;

  select
    count(*),
    count(*) filter (where f.rating = 'helpful')
  into rated_count, helpful_count
  from public.answer_feedback f
  join public.messages m
    on m.tenant_id = f.tenant_id
   and m.message_id = f.message_id
   and m.deleted_at is null
  where f.tenant_id = caller.tenant_id
    and m.created_at >= window_start;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'answerCount', answer_count,
    'ratedCount', rated_count,
    'helpfulCount', helpful_count,
    -- Null, never zero, when nothing has been rated. A 0% that means "no data"
    -- is the single most misleading number a dashboard can print.
    'helpfulPercent', case
      when rated_count = 0 then null
      else round((helpful_count::numeric / rated_count) * 100, 1)
    end,
    'ratedPercent', case
      when answer_count = 0 then null
      else round((rated_count::numeric / answer_count) * 100, 1)
    end,
    'windowDays', window_days
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Per-lesson reception, for the Learning editor's right rail.
--
--    "Cited in N answers" and "rated helpful N%" for every lesson of one
--    course. Citations are counted by expanding each answer's recorded sources
--    and mapping chunkId -> learning_chunks.metadata->>'lessonId'.
-- ---------------------------------------------------------------------------

create or replace function public.learning_lesson_reception(
  target_course_id uuid,
  window_days integer default 90
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  window_start timestamptz;
  payload jsonb;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'tenant_selection_required'
    );
  end if;
  -- Reception is authoring feedback, not learner-facing data.
  if caller.identity_role not in (
    'tenant_owner', 'tenant_admin', 'creator', 'teacher'
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if window_days is null or window_days not between 1 and 366 then
    return jsonb_build_object('ok', false, 'code', 'invalid_range');
  end if;
  window_start := statement_timestamp() - make_interval(days => window_days);

  if not exists (
    select 1 from public.courses c
    where c.tenant_id = caller.tenant_id
      and c.course_id = target_course_id
      and c.deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'course_not_found');
  end if;

  with cited as (
    select
      m.message_id,
      chunk.metadata ->> 'lessonId' as lesson_id
    from public.messages m
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(m.structured_content -> 'sources') = 'array'
          then m.structured_content -> 'sources'
        else '[]'::jsonb
      end
    ) as source(entry)
    join public.learning_chunks chunk
      on chunk.tenant_id = m.tenant_id
     and chunk.chunk_id = nullif(source.entry ->> 'chunkId', '')::uuid
     and chunk.course_id = target_course_id
     and chunk.deleted_at is null
    where m.tenant_id = caller.tenant_id
      and m.actor_type = 'assistant'
      and m.status = 'final'
      and m.deleted_at is null
      and m.created_at >= window_start
      and chunk.metadata ->> 'lessonId' is not null
  ),
  -- An answer citing a lesson twice is one citation of that lesson.
  distinct_citations as (
    select distinct message_id, lesson_id from cited
  ),
  per_lesson as (
    select
      d.lesson_id,
      count(*) as citation_count,
      count(f.answer_feedback_id) as rated_count,
      count(f.answer_feedback_id)
        filter (where f.rating = 'helpful') as helpful_count
    from distinct_citations d
    left join public.answer_feedback f
      on f.tenant_id = caller.tenant_id
     and f.message_id = d.message_id
    group by d.lesson_id
  )
  select jsonb_object_agg(
    per_lesson.lesson_id,
    jsonb_build_object(
      'citationCount', per_lesson.citation_count,
      'ratedCount', per_lesson.rated_count,
      'helpfulCount', per_lesson.helpful_count,
      'helpfulPercent', case
        when per_lesson.rated_count = 0 then null
        else round(
          (per_lesson.helpful_count::numeric / per_lesson.rated_count) * 100, 0
        )
      end
    )
  )
  into payload
  from per_lesson;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'windowDays', window_days,
    -- Lessons with no citations are simply absent; the caller renders those as
    -- "not cited yet" rather than as a zero it might mistake for a measurement.
    'lessons', coalesce(payload, '{}'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants. Close every new surface first, then open only the real caller.
-- ---------------------------------------------------------------------------

revoke execute on function public.learning_record_answer_feedback(uuid, text)
  from public, anon, authenticated, service_role;
revoke execute on function public.widget_record_answer_feedback(
  text, text, text, uuid, text
) from public, anon, authenticated, service_role;
revoke execute on function public.learning_answer_feedback_summary(integer)
  from public, anon, authenticated, service_role;
revoke execute on function public.learning_lesson_reception(uuid, integer)
  from public, anon, authenticated, service_role;

grant execute on function public.learning_record_answer_feedback(uuid, text)
  to authenticated;
grant execute on function public.widget_record_answer_feedback(
  text, text, text, uuid, text
) to anon;
grant execute on function public.learning_answer_feedback_summary(integer)
  to authenticated;
grant execute on function public.learning_lesson_reception(uuid, integer)
  to authenticated;

commit;

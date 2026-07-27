-- Question intelligence: per-question labels and deterministic signals.
--
-- Two things are added here and they are deliberately different in kind.
--
--   1. A LABEL is produced outside the database by the answer path, after the
--      assistant turn is already recorded, and written back through
--      public.learning_record_question_label. The database stores it, scopes it
--      to the tenant and refuses to accept it from a browser session; it never
--      produces one. There are no model calls in this file.
--
--   2. A SIGNAL is derived here, in deterministic SQL, from rows the product
--      genuinely writes: public.question_labels, public.messages,
--      public.conversations, public.lesson_progress and the ungrounded clusters
--      that public.analytics_answer_quality already computes. Every signal
--      carries the evidence that produced it, so a reviewer can check the
--      claim instead of trusting it.
--
-- Honesty boundary. This file inherits the MetricResult envelope introduced by
-- 20260725121000 (state / value / dataThrough / evidenceRefs / limitations) and
-- applies one further rule that the distribution surfaces do not need:
--
--   * A question with no recorded label is reported as UNCLASSIFIED. It is
--     never folded into a plausible topic, never dropped from the denominator
--     and never allowed to inflate another topic's share.
--   * When no question in the range carries a label at all, the topic and
--     intent distributions are 'unknown' with the reason, not an empty list.
--     An empty list would read as "no questions", which is a different and
--     false claim.
--   * Signal kinds whose inputs are not recorded anywhere are enumerated as
--     unknown rather than approximated from a proxy.
--
-- Signal kinds deliberately NOT attempted, and why:
--   * learner frustration / sentiment - no rating, reaction or sentiment
--     column exists on public.messages or anywhere else in the schema;
--   * answer correctness or hallucination - nothing records whether an answer
--     was right, and grounding coverage is a retrieval fact, not a truth fact;
--   * retrieval-quality regression - public.learning_search_chunks scores at
--     query time and the score is never persisted (see 20260725121000);
--   * abandonment / drop-off - no session end, no course completion timestamp
--     and no client-side dwell time are recorded.

begin;

-- ------------------------------------------------------------------ storage

-- One label row per learner question. The unique (tenant_id, message_id) key
-- is the upsert target: re-classifying a question replaces its label instead of
-- appending a second, contradictory one.
create table public.question_labels (
  question_label_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  message_id uuid not null,
  conversation_id uuid not null,
  subject_user_id uuid not null,
  course_id uuid,
  module_id uuid,
  lesson_id uuid,
  topic_key text not null
    check (topic_key ~ '^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$'),
  topic_label text not null check (length(topic_label) between 1 and 80),
  question_intent text not null check (question_intent in (
    'definition',
    'how_to',
    'troubleshooting',
    'scope_check',
    'clarification',
    'off_topic'
  )),
  importance text not null
    check (importance in ('routine', 'notable', 'critical')),
  importance_rank smallint not null check (importance_rank between 1 and 3),
  grounding_outcome text not null check (grounding_outcome in (
    'grounded',
    'ungrounded',
    'not_recorded',
    'no_answer'
  )),
  classifier_key text not null
    check (length(classifier_key) between 1 and 100),
  classifier_version text not null
    check (length(classifier_version) between 1 and 40),
  asked_at timestamptz not null,
  labelled_at timestamptz not null default now(),
  trace_id text not null check (length(trace_id) between 8 and 200),
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null
    check (length(idempotency_key) between 8 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, message_id)
    references public.messages(tenant_id, message_id),
  foreign key (tenant_id, conversation_id)
    references public.conversations(tenant_id, conversation_id),
  foreign key (tenant_id, course_id)
    references public.courses(tenant_id, course_id),
  foreign key (tenant_id, module_id, course_id)
    references public.modules(tenant_id, module_id, course_id),
  foreign key (tenant_id, lesson_id, module_id, course_id)
    references public.lessons(tenant_id, lesson_id, module_id, course_id),
  unique (tenant_id, message_id),
  unique (tenant_id, idempotency_key),
  check (lesson_id is null or module_id is not null),
  check (
    (importance = 'routine' and importance_rank = 1)
    or (importance = 'notable' and importance_rank = 2)
    or (importance = 'critical' and importance_rank = 3)
  )
);
create index question_labels_topic_time_idx
  on public.question_labels (tenant_id, topic_key, asked_at desc)
  where deleted_at is null;
create index question_labels_intent_time_idx
  on public.question_labels (tenant_id, question_intent, asked_at desc)
  where deleted_at is null;
create index question_labels_importance_idx
  on public.question_labels (tenant_id, importance_rank desc, asked_at desc)
  where deleted_at is null;
create index question_labels_lesson_idx
  on public.question_labels (tenant_id, course_id, lesson_id, asked_at desc)
  where deleted_at is null;

create trigger question_labels_touch
before update on public.question_labels
for each row execute function app_private.set_updated_at_and_version();

alter table public.question_labels enable row level security;
alter table public.question_labels force row level security;

-- Direct reads are a transparency affordance for tenant administrators only.
-- Every product surface goes through the analytics RPCs below, and no role may
-- write a label directly: forging one requires the server-held operation token.
create policy question_labels_admin_read on public.question_labels
  for select to authenticated
  using (app_private.is_tenant_admin(tenant_id));

create policy question_labels_deny_anon on public.question_labels
  as restrictive
  for all to anon
  using (false)
  with check (false);

grant select on public.question_labels to authenticated;
revoke insert, update, delete on public.question_labels
  from public, anon, authenticated;

-- A detected signal that a human has picked up. Detection itself is derived on
-- read (see app_private.question_signal_detections), so this table holds the
-- review lifecycle plus the evidence snapshot taken at review time. A row can
-- only be created by public.analytics_signal_review, which re-runs detection
-- and refuses a fingerprint the deterministic pass did not produce - so a
-- reviewed signal is always an evidence-backed one.
--
-- The status vocabulary mirrors how packages/intelligence-core models an
-- Opportunity: a forward-only lifecycle with terminal dismissal, never an
-- automatic action.
create table public.question_signals (
  question_signal_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  signal_fingerprint text not null
    check (signal_fingerprint ~ '^[0-9a-f]{64}$'),
  signal_kind text not null check (signal_kind in (
    'topic_spike',
    'content_gap',
    'repeated_question_cluster',
    'post_lesson_stall',
    'unattributed_questions'
  )),
  severity text not null check (severity in ('watch', 'elevated', 'critical')),
  severity_rank smallint not null check (severity_rank between 1 and 3),
  headline text not null check (length(headline) between 1 and 200),
  detail text not null check (length(detail) between 1 and 1000),
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence) = 'object'),
  evidence_refs jsonb not null default '[]'::jsonb
    check (
      jsonb_typeof(evidence_refs) = 'array'
      and jsonb_array_length(evidence_refs) <= 50
    ),
  course_id uuid,
  module_id uuid,
  lesson_id uuid,
  observed_value numeric,
  comparison_value numeric,
  detection_window_start timestamptz not null,
  detection_window_end timestamptz not null,
  review_status text not null default 'new'
    check (review_status in ('new', 'acknowledged', 'actioned', 'dismissed')),
  review_note text check (review_note is null or length(review_note) <= 1000),
  reviewed_by uuid,
  reviewed_by_role text,
  reviewed_at timestamptz,
  first_detected_at timestamptz not null default now(),
  last_detected_at timestamptz not null default now(),
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null
    check (length(idempotency_key) between 8 and 256),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, course_id)
    references public.courses(tenant_id, course_id),
  foreign key (tenant_id, module_id, course_id)
    references public.modules(tenant_id, module_id, course_id),
  foreign key (tenant_id, lesson_id, module_id, course_id)
    references public.lessons(tenant_id, lesson_id, module_id, course_id),
  unique (tenant_id, signal_fingerprint),
  unique (tenant_id, idempotency_key),
  check (detection_window_end > detection_window_start),
  check (lesson_id is null or module_id is not null),
  check (
    (severity = 'watch' and severity_rank = 1)
    or (severity = 'elevated' and severity_rank = 2)
    or (severity = 'critical' and severity_rank = 3)
  ),
  check (
    (review_status = 'new' and reviewed_at is null)
    or (review_status <> 'new' and reviewed_at is not null)
  )
);
create index question_signals_review_idx
  on public.question_signals (
    tenant_id, review_status, severity_rank desc, last_detected_at desc
  )
  where deleted_at is null;

create trigger question_signals_touch
before update on public.question_signals
for each row execute function app_private.set_updated_at_and_version();

alter table public.question_signals enable row level security;
alter table public.question_signals force row level security;

create policy question_signals_admin_read on public.question_signals
  for select to authenticated
  using (app_private.is_tenant_admin(tenant_id));

create policy question_signals_deny_anon on public.question_signals
  as restrictive
  for all to anon
  using (false)
  with check (false);

grant select on public.question_signals to authenticated;
revoke insert, update, delete on public.question_signals
  from public, anon, authenticated;

-- --------------------------------------------------------------- constants

create or replace function app_private.question_intent_taxonomy()
returns text[]
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select array[
    'definition',
    'how_to',
    'troubleshooting',
    'scope_check',
    'clarification',
    'off_topic'
  ]::text[];
$$;
revoke execute on function app_private.question_intent_taxonomy()
  from public, anon, authenticated, service_role;

create or replace function app_private.question_importance_rank(
  importance_value text
)
returns smallint
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select case importance_value
    when 'critical' then 3
    when 'notable' then 2
    when 'routine' then 1
    else null
  end::smallint;
$$;
revoke execute on function app_private.question_importance_rank(text)
  from public, anon, authenticated, service_role;

create or replace function app_private.question_severity_rank(
  severity_value text
)
returns smallint
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select case severity_value
    when 'critical' then 3
    when 'elevated' then 2
    when 'watch' then 1
    else null
  end::smallint;
$$;
revoke execute on function app_private.question_severity_rank(text)
  from public, anon, authenticated, service_role;

-- A signal identity that does not depend on the range that surfaced it, so a
-- review recorded while looking at 30 days is still attached to the same
-- observation when the operator narrows to 7.
create or replace function app_private.question_signal_fingerprint(
  target_tenant_id uuid,
  signal_kind text,
  context_key text
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select encode(
    extensions.digest(
      target_tenant_id::text || chr(31) || signal_kind || chr(31) ||
      coalesce(context_key, ''),
      'sha256'
    ),
    'hex'
  );
$$;
revoke execute on function app_private.question_signal_fingerprint(
  uuid, text, text
) from public, anon, authenticated, service_role;

create or replace function app_private.question_intelligence_audit(
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
  -- Parameter names deliberately avoid audit_ledger column names so the
  -- INSERT ... VALUES expressions can never resolve to a column instead.
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
      when 'creator' then 'creator'
      when 'teacher' then 'creator'
      when 'student' then 'student'
      when 'service' then 'system'
      else 'system'
    end,
    actor_identity_role,
    audit_action,
    'question_signal',
    target_resource_id,
    audit_decision,
    audit_reason,
    source_change_ref,
    source_request_id,
    source_trace_id,
    now() + interval '7 years',
    'question-intelligence-audit:' ||
      encode(
        extensions.digest(
          target_tenant_id::text || chr(31) || audit_action || chr(31) ||
          audit_decision || chr(31) || coalesce(target_resource_id, '') ||
          chr(31) || coalesce(source_request_id, '') || chr(31) ||
          coalesce(audit_reason, ''),
          'sha256'
        ),
        'hex'
      )
  )
  on conflict (tenant_id, idempotency_key) do nothing;
$$;
revoke execute on function app_private.question_intelligence_audit(
  uuid, text, text, text, text, text, text, text, text
) from public, anon, authenticated, service_role;

-- ------------------------------------------------------------- write path

-- Records the classification of one learner question. Gated exactly like
-- public.learning_record_assistant_message: the caller must hold a verified
-- tenant membership AND the conversation answer operation token, which lives
-- only in the application server environment. A browser session holds the
-- membership but never the token, so it cannot forge a label.
--
-- The grounding outcome is not supplied by the caller. It is read from the
-- assistant turn that actually followed the question, so a classifier cannot
-- assert that an answer was grounded when the recorded citations say otherwise.
create or replace function public.learning_record_question_label(
  target_message_id uuid,
  topic_key text,
  topic_label text,
  question_intent text,
  importance text,
  classifier_key text,
  classifier_version text,
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
  caller record;
  question record;
  answer_sources jsonb;
  resolved_grounding text;
  normalized_topic_key text := lower(
    btrim(coalesce(learning_record_question_label.topic_key, ''))
  );
  normalized_topic_label text := btrim(
    coalesce(learning_record_question_label.topic_label, '')
  );
  normalized_intent text := lower(
    btrim(coalesce(learning_record_question_label.question_intent, ''))
  );
  normalized_importance text := lower(
    btrim(coalesce(learning_record_question_label.importance, ''))
  );
  written public.question_labels%rowtype;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;
  if not app_private.learning_operation_token_is_valid(
    'conversation.answer.record',
    operation_token
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  if target_message_id is null
    or normalized_topic_key !~ '^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$'
    or length(normalized_topic_label) not between 1 and 80
    or not (normalized_intent = any (app_private.question_intent_taxonomy()))
    or app_private.question_importance_rank(normalized_importance) is null
    or classifier_key is null
    or length(classifier_key) not between 1 and 100
    or classifier_version is null
    or length(classifier_version) not between 1 and 40
    or trace_id is null
    or length(trace_id) not between 8 and 200
    or idempotency_key is null
    or length(idempotency_key) not between 8 and 200
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  -- The question must be a real, final, human-authored message inside a
  -- conversation this tenant owns. Anything else is not classifiable.
  select
    m.message_id,
    m.conversation_id,
    m.created_at,
    m.sequence_number,
    conv.subject_user_id,
    conv.course_id,
    conv.module_id,
    conv.lesson_id
  into question
  from public.messages m
  join public.conversations conv
    on conv.tenant_id = m.tenant_id
   and conv.conversation_id = m.conversation_id
  where m.tenant_id = caller.tenant_id
    and m.message_id = target_message_id
    and m.deleted_at is null
    and m.status = 'final'
    and m.actor_type in ('student', 'creator', 'owner')
    and m.modality in ('text', 'voice_transcript')
    and conv.deleted_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'question_not_found');
  end if;

  -- Grounding is read from the recorded answer, never asserted by the caller.
  select m.structured_content -> 'sources'
  into answer_sources
  from public.messages m
  where m.tenant_id = caller.tenant_id
    and m.conversation_id = question.conversation_id
    and m.sequence_number > question.sequence_number
    and m.actor_type = 'assistant'
    and m.status = 'final'
    and m.deleted_at is null
  order by m.sequence_number
  limit 1;

  -- The null branch comes first on purpose: an answer that carries no sources
  -- array at all is "not recorded", never "grounded". A three-valued
  -- comparison would otherwise fall through to the else branch and claim a
  -- grounding that was never written.
  resolved_grounding := case
    when not found then 'no_answer'
    when answer_sources is null
      or jsonb_typeof(answer_sources) <> 'array' then 'not_recorded'
    when jsonb_array_length(answer_sources) = 0 then 'ungrounded'
    else 'grounded'
  end;

  insert into public.question_labels (
    tenant_id, message_id, conversation_id, subject_user_id, course_id,
    module_id, lesson_id, topic_key, topic_label, question_intent, importance,
    importance_rank, grounding_outcome, classifier_key, classifier_version,
    asked_at, labelled_at, trace_id, idempotency_key
  ) values (
    caller.tenant_id,
    question.message_id,
    question.conversation_id,
    question.subject_user_id,
    question.course_id,
    question.module_id,
    question.lesson_id,
    normalized_topic_key,
    normalized_topic_label,
    normalized_intent,
    normalized_importance,
    app_private.question_importance_rank(normalized_importance),
    resolved_grounding,
    classifier_key,
    classifier_version,
    question.created_at,
    statement_timestamp(),
    learning_record_question_label.trace_id,
    learning_record_question_label.idempotency_key
  )
  on conflict (tenant_id, message_id) do update
  set topic_key = excluded.topic_key,
      topic_label = excluded.topic_label,
      question_intent = excluded.question_intent,
      importance = excluded.importance,
      importance_rank = excluded.importance_rank,
      grounding_outcome = excluded.grounding_outcome,
      classifier_key = excluded.classifier_key,
      classifier_version = excluded.classifier_version,
      labelled_at = excluded.labelled_at,
      trace_id = excluded.trace_id,
      idempotency_key = excluded.idempotency_key,
      deleted_at = null
  returning * into written;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'questionLabelId', written.question_label_id,
    'messageId', written.message_id,
    'topicKey', written.topic_key,
    'intent', written.question_intent,
    'importance', written.importance,
    'groundingOutcome', written.grounding_outcome,
    'recordVersion', written.record_version,
    'replaced', written.record_version > 1
  );
end;
$$;

-- --------------------------------------------------------------- read path

-- Topic and intent distribution over the labelled questions in a range, with
-- the unclassified remainder stated rather than hidden.
create or replace function public.analytics_question_labels(
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
  topic_limit constant integer := 25;
  questions_per_topic constant integer := 5;
  important_limit constant integer := 20;
  totals record;
  data_through timestamptz;
  topics_json jsonb;
  intents_json jsonb;
  important_json jsonb;
  omitted_topics bigint := 0;
  omitted_topic_questions bigint := 0;
  omitted_important bigint := 0;
  distribution_state text;
  coverage_limitations text[] := '{}'::text[];
  topic_limitations text[] := '{}'::text[];
  intent_limitations text[] := '{}'::text[];
  important_limitations text[] := '{}'::text[];
  unclassified_note text;
  evidence constant jsonb := jsonb_build_array(
    'table:public.question_labels',
    'table:public.messages',
    'table:public.conversations'
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

  select
    count(*)::bigint as questions,
    count(ql.question_label_id)::bigint as labelled_questions,
    count(*) filter (where ql.question_label_id is null)::bigint
      as unclassified_questions,
    count(distinct conv.subject_user_id)::bigint as learners,
    max(m.created_at) as last_question_at,
    max(ql.labelled_at) as last_labelled_at
  into totals
  from public.messages m
  join public.conversations conv
    on conv.tenant_id = m.tenant_id
   and conv.conversation_id = m.conversation_id
  left join public.question_labels ql
    on ql.tenant_id = m.tenant_id
   and ql.message_id = m.message_id
   and ql.deleted_at is null
  where m.tenant_id = caller.tenant_id
    and m.created_at >= win.window_start
    and m.created_at < win.window_end
    and m.deleted_at is null
    and m.status = 'final'
    and m.actor_type in ('student', 'creator', 'owner')
    and m.modality in ('text', 'voice_transcript')
    and conv.deleted_at is null;

  unclassified_note :=
    coalesce(totals.unclassified_questions, 0)::text ||
    ' question(s) in this range carry no recorded classification. They are ' ||
    'reported as unclassified and are excluded from every topic and intent ' ||
    'count below; they are never assigned to a plausible topic.';

  -- Honest state. An empty topic list is only truthful when there were no
  -- questions at all; otherwise it would read as "learners asked nothing".
  distribution_state := case
    when coalesce(totals.questions, 0) = 0 then 'known'
    when coalesce(totals.labelled_questions, 0) = 0 then 'unknown'
    when coalesce(totals.unclassified_questions, 0) > 0 then 'partial'
    else 'known'
  end;

  if coalesce(totals.unclassified_questions, 0) > 0 then
    coverage_limitations := coverage_limitations || unclassified_note;
  end if;
  if distribution_state = 'unknown' then
    topic_limitations := array[
      'No question in this range carries a recorded classification, so no ' ||
      'topic distribution exists. ' || unclassified_note ||
      ' Classification runs after an answer is recorded and is skipped ' ||
      'whenever the classifier is unavailable or returns output that does ' ||
      'not match the closed schema.'
    ]::text[];
    intent_limitations := topic_limitations;
    important_limitations := topic_limitations;
  elsif coalesce(totals.unclassified_questions, 0) > 0 then
    topic_limitations := array[unclassified_note]::text[];
    intent_limitations := topic_limitations;
    important_limitations := topic_limitations;
  end if;

  if distribution_state <> 'unknown' then
    with labelled as (
      select
        ql.question_label_id,
        ql.message_id,
        ql.topic_key,
        ql.topic_label,
        ql.question_intent,
        ql.importance,
        ql.importance_rank,
        ql.grounding_outcome,
        ql.subject_user_id,
        ql.course_id,
        ql.lesson_id,
        ql.asked_at,
        m.body
      from public.question_labels ql
      join public.messages m
        on m.tenant_id = ql.tenant_id
       and m.message_id = ql.message_id
      where ql.tenant_id = caller.tenant_id
        and ql.deleted_at is null
        and ql.asked_at >= win.window_start
        and ql.asked_at < win.window_end
        and m.deleted_at is null
    ),
    topic_totals as (
      select
        l.topic_key,
        min(l.topic_label) as topic_label,
        count(*)::bigint as question_count,
        count(distinct l.subject_user_id)::bigint as learner_count,
        count(*) filter (where l.grounding_outcome = 'grounded')::bigint
          as grounded_count,
        count(*) filter (where l.grounding_outcome = 'ungrounded')::bigint
          as ungrounded_count,
        max(l.asked_at) as last_seen_at,
        row_number() over (
          order by count(*) desc, min(l.topic_label), l.topic_key
        ) as topic_rank
      from labelled l
      group by l.topic_key
    ),
    kept_topics as (
      select * from topic_totals where topic_rank <= topic_limit
    ),
    ranked_questions as (
      select
        l.*,
        row_number() over (
          partition by l.topic_key
          order by l.importance_rank desc, l.asked_at desc, l.message_id
        ) as question_rank
      from labelled l
      join kept_topics kt on kt.topic_key = l.topic_key
    ),
    topic_questions as (
      select
        rq.topic_key,
        jsonb_agg(
          jsonb_build_object(
            'messageId', rq.message_id,
            'question', left(coalesce(rq.body, ''), 400),
            'truncatedQuestion', length(coalesce(rq.body, '')) > 400,
            'intent', rq.question_intent,
            'importance', rq.importance,
            'groundingOutcome', rq.grounding_outcome,
            'courseId', rq.course_id,
            'lessonId', rq.lesson_id,
            'askedAt', rq.asked_at
          )
          order by rq.question_rank
        ) filter (where rq.question_rank <= questions_per_topic) as questions,
        count(*) filter (
          where rq.question_rank > questions_per_topic
        )::bigint as omitted_questions
      from ranked_questions rq
      group by rq.topic_key
    ),
    topic_intents as (
      select
        l.topic_key,
        jsonb_agg(
          jsonb_build_object('intent', l.question_intent, 'questions', n)
          order by n desc, l.question_intent
        ) as intents
      from (
        select topic_key, question_intent, count(*)::bigint as n
        from labelled
        group by topic_key, question_intent
      ) l
      group by l.topic_key
    )
    select
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'topicKey', kt.topic_key,
            'topicLabel', kt.topic_label,
            'questions', kt.question_count,
            'learners', kt.learner_count,
            'share', case
              when coalesce(totals.questions, 0) = 0 then null
              else round(kt.question_count::numeric / totals.questions, 4)
            end,
            'shareOfClassified', case
              when coalesce(totals.labelled_questions, 0) = 0 then null
              else round(
                kt.question_count::numeric / totals.labelled_questions,
                4
              )
            end,
            'groundedAnswers', kt.grounded_count,
            'ungroundedAnswers', kt.ungrounded_count,
            'lastSeenAt', kt.last_seen_at,
            'intents', coalesce(ti.intents, '[]'::jsonb),
            'sampleQuestions', coalesce(tq.questions, '[]'::jsonb),
            'omittedQuestions', coalesce(tq.omitted_questions, 0)
          )
          order by kt.topic_rank
        ),
        '[]'::jsonb
      )
    into topics_json
    from kept_topics kt
    left join topic_questions tq on tq.topic_key = kt.topic_key
    left join topic_intents ti on ti.topic_key = kt.topic_key;

    select
      count(*) filter (where t.topic_rank > topic_limit)::bigint,
      coalesce(
        sum(t.question_count) filter (where t.topic_rank > topic_limit),
        0
      )::bigint
    into omitted_topics, omitted_topic_questions
    from (
      select
        count(*)::bigint as question_count,
        row_number() over (
          order by count(*) desc, min(ql.topic_label), ql.topic_key
        ) as topic_rank
      from public.question_labels ql
      where ql.tenant_id = caller.tenant_id
        and ql.deleted_at is null
        and ql.asked_at >= win.window_start
        and ql.asked_at < win.window_end
      group by ql.topic_key
    ) t;

    -- The intent taxonomy is closed, so every member is reported even at zero.
    -- A zero here is a measured zero, not an absence of measurement.
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'intent', taxonomy.intent_name,
          'questions', coalesce(counted.question_count, 0),
          'learners', coalesce(counted.learner_count, 0),
          'share', case
            when coalesce(totals.questions, 0) = 0 then null
            else round(
              coalesce(counted.question_count, 0)::numeric / totals.questions,
              4
            )
          end,
          'shareOfClassified', case
            when coalesce(totals.labelled_questions, 0) = 0 then null
            else round(
              coalesce(counted.question_count, 0)::numeric
                / totals.labelled_questions,
              4
            )
          end,
          'lastSeenAt', counted.last_seen_at
        )
        order by coalesce(counted.question_count, 0) desc, taxonomy.intent_name
      ),
      '[]'::jsonb
    )
    into intents_json
    from unnest(app_private.question_intent_taxonomy())
      as taxonomy(intent_name)
    left join (
      select
        ql.question_intent,
        count(*)::bigint as question_count,
        count(distinct ql.subject_user_id)::bigint as learner_count,
        max(ql.asked_at) as last_seen_at
      from public.question_labels ql
      where ql.tenant_id = caller.tenant_id
        and ql.deleted_at is null
        and ql.asked_at >= win.window_start
        and ql.asked_at < win.window_end
      group by ql.question_intent
    ) counted on counted.question_intent = taxonomy.intent_name;

    -- Important questions: the actual recorded text, how often the same topic
    -- and intent recurred, and whether the answer was grounded.
    with labelled as (
      select
        ql.message_id,
        ql.topic_key,
        ql.topic_label,
        ql.question_intent,
        ql.importance,
        ql.importance_rank,
        ql.grounding_outcome,
        ql.subject_user_id,
        ql.course_id,
        ql.module_id,
        ql.lesson_id,
        ql.asked_at,
        m.body
      from public.question_labels ql
      join public.messages m
        on m.tenant_id = ql.tenant_id
       and m.message_id = ql.message_id
      where ql.tenant_id = caller.tenant_id
        and ql.deleted_at is null
        and ql.asked_at >= win.window_start
        and ql.asked_at < win.window_end
        and m.deleted_at is null
    ),
    -- Recurrence is grouped first: a window aggregate cannot take DISTINCT,
    -- and a window function cannot be nested inside another window's ORDER BY.
    recurrence as (
      select
        b.topic_key,
        b.question_intent,
        count(*)::bigint as recurrence_count,
        count(distinct b.subject_user_id)::bigint as recurrence_learners
      from labelled b
      group by b.topic_key, b.question_intent
    ),
    ranked as (
      select
        b.*,
        r.recurrence_count,
        r.recurrence_learners,
        row_number() over (
          order by
            b.importance_rank desc,
            r.recurrence_count desc,
            b.asked_at desc,
            b.message_id
        ) as importance_position
      from labelled b
      join recurrence r
        on r.topic_key = b.topic_key
       and r.question_intent = b.question_intent
    )
    select
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'messageId', l.message_id,
            'question', left(coalesce(l.body, ''), 400),
            'truncatedQuestion', length(coalesce(l.body, '')) > 400,
            'topicKey', l.topic_key,
            'topicLabel', l.topic_label,
            'intent', l.question_intent,
            'importance', l.importance,
            'recurrence', l.recurrence_count,
            'recurrenceLearners', l.recurrence_learners,
            'groundingOutcome', l.grounding_outcome,
            'courseId', l.course_id,
            'courseTitle', co.title,
            'lessonId', l.lesson_id,
            'lessonTitle', le.title,
            'askedAt', l.asked_at
          )
          order by l.importance_position
        ) filter (where l.importance_position <= important_limit),
        '[]'::jsonb
      ),
      count(*) filter (where l.importance_position > important_limit)::bigint
    into important_json, omitted_important
    from ranked l
    left join public.courses co
      on co.tenant_id = caller.tenant_id
     and co.course_id = l.course_id
    left join public.lessons le
      on le.tenant_id = caller.tenant_id
     and le.lesson_id = l.lesson_id;

    if omitted_topics > 0 then
      topic_limitations := topic_limitations || (
        'Only the top ' || topic_limit::text ||
        ' topics by volume are returned; ' || omitted_topics::text ||
        ' further topic(s) holding ' || omitted_topic_questions::text ||
        ' classified question(s) are omitted.'
      );
    end if;
    if omitted_important > 0 then
      important_limitations := important_limitations || (
        'Only the top ' || important_limit::text ||
        ' questions by importance and recurrence are returned; ' ||
        omitted_important::text || ' further classified question(s) are ' ||
        'omitted.'
      );
    end if;
    important_limitations := important_limitations || (
      'Importance is the classifier''s judgement about the question, not a ' ||
      'measurement. Recurrence and grounding beside it are counted from ' ||
      'recorded rows.'
    );
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
    'limits', jsonb_build_object(
      'topics', topic_limit,
      'questionsPerTopic', questions_per_topic,
      'importantQuestions', important_limit,
      'truncated', omitted_topics > 0 or omitted_important > 0
    ),
    'intentTaxonomy', to_jsonb(app_private.question_intent_taxonomy()),
    'definitions', jsonb_build_object(
      'classifiedQuestion',
      'A learner question that has a row in public.question_labels written ' ||
      'by the answer path after the assistant turn was recorded.',
      'unclassifiedQuestion',
      'A recorded learner question with no label row. It is counted in the ' ||
      'totals and reported as unclassified; it is never placed in a topic.',
      'topic',
      'A short classifier-produced theme key. Topics are free-form and are ' ||
      'not reconciled against the course catalogue.',
      'intent',
      'One member of a closed six-value taxonomy chosen by the classifier.',
      'importance',
      'The classifier''s three-level priority judgement about a ' ||
      'question. It is an opinion, not a measurement.'
    ),
    'metrics', jsonb_build_object(
      'classificationCoverage', app_private.analytics_metric(
        app_private.analytics_metric_state(coverage_limitations),
        jsonb_build_object(
          'questions', coalesce(totals.questions, 0),
          'classifiedQuestions', coalesce(totals.labelled_questions, 0),
          'unclassifiedQuestions', coalesce(totals.unclassified_questions, 0),
          'learners', coalesce(totals.learners, 0),
          'coverageShare', case
            when coalesce(totals.questions, 0) = 0 then null
            else round(
              totals.labelled_questions::numeric / totals.questions,
              4
            )
          end,
          'lastQuestionAt', totals.last_question_at,
          'lastClassifiedAt', totals.last_labelled_at
        ),
        data_through,
        evidence,
        to_jsonb(coverage_limitations)
      ),
      'topicDistribution', app_private.analytics_metric(
        distribution_state,
        case when distribution_state = 'unknown' then null else
          jsonb_build_object(
            'classifiedQuestions', coalesce(totals.labelled_questions, 0),
            'topics', coalesce(topics_json, '[]'::jsonb),
            'omittedTopics', omitted_topics,
            'omittedTopicQuestions', omitted_topic_questions,
            'unclassified', jsonb_build_object(
              'questions', coalesce(totals.unclassified_questions, 0),
              'share', case
                when coalesce(totals.questions, 0) = 0 then null
                else round(
                  totals.unclassified_questions::numeric / totals.questions,
                  4
                )
              end
            )
          )
        end,
        data_through,
        evidence,
        to_jsonb(topic_limitations)
      ),
      'intentDistribution', app_private.analytics_metric(
        distribution_state,
        case when distribution_state = 'unknown' then null else
          jsonb_build_object(
            'classifiedQuestions', coalesce(totals.labelled_questions, 0),
            'intents', coalesce(intents_json, '[]'::jsonb),
            'unclassified', jsonb_build_object(
              'questions', coalesce(totals.unclassified_questions, 0),
              'share', case
                when coalesce(totals.questions, 0) = 0 then null
                else round(
                  totals.unclassified_questions::numeric / totals.questions,
                  4
                )
              end
            )
          )
        end,
        data_through,
        evidence,
        to_jsonb(intent_limitations)
      ),
      'importantQuestions', app_private.analytics_metric(
        distribution_state,
        case when distribution_state = 'unknown' then null else
          jsonb_build_object(
            'questions', coalesce(important_json, '[]'::jsonb),
            'omittedQuestions', omitted_important
          )
        end,
        data_through,
        evidence,
        to_jsonb(important_limitations)
      )
    )
  );
end;
$$;

-- Deterministic signal detection. No model runs here: every row this returns
-- is a comparison between counts that public tables already hold, and it
-- carries the identifiers a reviewer needs to check the claim.
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
declare
  caller record;
  prior_start timestamptz;
  quality jsonb;
  range_questions bigint;
  unattributed_questions bigint;
  unattributed_learners bigint;
begin
  select * into caller from app_private.analytics_context();
  if not found then
    return;
  end if;
  prior_start := window_start - (window_end - window_start);

  -- 1. Topic spike. Needs labels; when none exist the loop simply yields
  --    nothing and public.analytics_signals states that in its limitations.
  return query
  with labelled as (
    select
      ql.topic_key,
      ql.topic_label,
      ql.message_id,
      ql.asked_at,
      ql.subject_user_id
    from public.question_labels ql
    where ql.tenant_id = caller.tenant_id
      and ql.deleted_at is null
      and ql.asked_at >= prior_start
      and ql.asked_at < window_end
  ),
  current_window as (
    select
      l.topic_key,
      min(l.topic_label) as topic_label,
      count(*)::bigint as question_count,
      count(distinct l.subject_user_id)::bigint as learner_count,
      max(l.asked_at) as last_seen_at,
      (array_agg(l.message_id order by l.asked_at desc))[1:5] as sample_ids
    from labelled l
    where l.asked_at >= window_start
    group by l.topic_key
  ),
  prior_window as (
    select l.topic_key, count(*)::bigint as question_count
    from labelled l
    where l.asked_at < window_start
    group by l.topic_key
  ),
  spikes as (
    select
      c.topic_key,
      c.topic_label,
      c.question_count,
      c.learner_count,
      c.last_seen_at,
      c.sample_ids,
      coalesce(p.question_count, 0) as prior_count
    from current_window c
    left join prior_window p on p.topic_key = c.topic_key
    where c.question_count >= 5
      and c.question_count - coalesce(p.question_count, 0) >= 3
      and c.question_count
        >= 2 * greatest(coalesce(p.question_count, 0), 1)
  )
  select
    app_private.question_signal_fingerprint(
      caller.tenant_id, 'topic_spike', s.topic_key
    ),
    'topic_spike'::text,
    case
      when s.question_count >= 10
        and s.question_count >= 3 * greatest(s.prior_count, 1)
        then 'critical'
      when s.question_count >= 5
        and s.question_count >= 2 * greatest(s.prior_count, 1)
        then 'elevated'
      else 'watch'
    end,
    app_private.question_severity_rank(
      case
        when s.question_count >= 10
          and s.question_count >= 3 * greatest(s.prior_count, 1)
          then 'critical'
        when s.question_count >= 5
          and s.question_count >= 2 * greatest(s.prior_count, 1)
          then 'elevated'
        else 'watch'
      end
    ),
    'Questions about "' || s.topic_label || '" rose to ' ||
      s.question_count::text || ' from ' || s.prior_count::text,
    s.question_count::text || ' classified question(s) from ' ||
      s.learner_count::text || ' learner(s) landed on this topic in the ' ||
      'selected range, against ' || s.prior_count::text ||
      ' in the immediately preceding window of the same length.',
    null::uuid,
    null::uuid,
    null::uuid,
    s.question_count::numeric,
    s.prior_count::numeric,
    jsonb_build_object(
      'topicKey', s.topic_key,
      'topicLabel', s.topic_label,
      'questionsInRange', s.question_count,
      'questionsInPriorWindow', s.prior_count,
      'learnersInRange', s.learner_count,
      'priorWindowStart', prior_start,
      'priorWindowEnd', window_start,
      'lastSeenAt', s.last_seen_at
    ),
    jsonb_build_array('table:public.question_labels')
      || coalesce(
        (
          select jsonb_agg('message:' || sampled.message_id::text)
          from unnest(s.sample_ids) as sampled(message_id)
        ),
        '[]'::jsonb
      )
  from spikes s;

  -- 2. Content gap. public.analytics_answer_quality already computes the
  --    ungrounded clusters from the recorded citations; recomputing them here
  --    would be a second, divergent definition of the same fact.
  quality := public.analytics_answer_quality(window_start, window_end);
  if coalesce(quality ->> 'ok', 'false') = 'true'
    and jsonb_typeof(
      quality -> 'metrics' -> 'contentGapSignals' -> 'value' -> 'clusters'
    ) = 'array'
  then
    return query
    with gaps as (
      select
        entry.cluster_value as payload,
        entry.cluster_value ->> 'courseId' as course_ref,
        entry.cluster_value ->> 'moduleId' as module_ref,
        entry.cluster_value ->> 'lessonId' as lesson_ref,
        coalesce(
          entry.cluster_value ->> 'lessonTitle',
          entry.cluster_value ->> 'moduleTitle',
          entry.cluster_value ->> 'courseTitle',
          'Outside any course'
        ) as place_label,
        (entry.cluster_value ->> 'ungroundedAnswers')::bigint as ungrounded,
        (entry.cluster_value ->> 'answers')::bigint as answers,
        coalesce(
          (entry.cluster_value ->> 'ungroundedShare')::numeric,
          0
        ) as ungrounded_share
      from jsonb_array_elements(
        quality -> 'metrics' -> 'contentGapSignals' -> 'value' -> 'clusters'
      ) as entry(cluster_value)
    ),
    graded as (
      select
        g.*,
        case
          when g.ungrounded >= 5 and g.ungrounded_share >= 0.5 then 'critical'
          when g.ungrounded >= 3 then 'elevated'
          else 'watch'
        end as gap_severity
      from gaps g
      where g.ungrounded >= 2
    )
    select
      app_private.question_signal_fingerprint(
        caller.tenant_id,
        'content_gap',
        coalesce(g.lesson_ref, '') || chr(31) ||
        coalesce(g.module_ref, '') || chr(31) ||
        coalesce(g.course_ref, '')
      ),
      'content_gap'::text,
      g.gap_severity::text,
      app_private.question_severity_rank(g.gap_severity),
      g.place_label || ' answered ' || g.ungrounded::text ||
        ' question(s) with no citation',
      g.ungrounded::text || ' of ' || g.answers::text ||
        ' assistant answer(s) here carried an empty citation list. That is ' ||
        'a retrieval-coverage fact about the published material, not a ' ||
        'judgement about whether the answers were correct.',
      g.course_ref::uuid,
      g.module_ref::uuid,
      g.lesson_ref::uuid,
      g.ungrounded::numeric,
      g.answers::numeric,
      g.payload,
      jsonb_build_array(
        'rpc:public.analytics_answer_quality',
        'column:public.messages.structured_content.sources'
      )
    from graded g;
  end if;

  -- 3. Repeated questions clustering on one lesson. Counted from the recorded
  --    messages, so it does not depend on classification having run.
  return query
  with lesson_questions as (
    select
      conv.course_id,
      conv.module_id,
      conv.lesson_id,
      count(*)::bigint as question_count,
      count(distinct conv.subject_user_id)::bigint as learner_count,
      max(m.created_at) as last_question_at,
      (array_agg(m.message_id order by m.created_at desc))[1:5] as sample_ids
    from public.messages m
    join public.conversations conv
      on conv.tenant_id = m.tenant_id
     and conv.conversation_id = m.conversation_id
    where m.tenant_id = caller.tenant_id
      and m.created_at >= window_start
      and m.created_at < window_end
      and m.deleted_at is null
      and m.status = 'final'
      and m.actor_type in ('student', 'creator', 'owner')
      and m.modality in ('text', 'voice_transcript')
      and conv.deleted_at is null
      and conv.lesson_id is not null
    group by conv.course_id, conv.module_id, conv.lesson_id
    having count(*) >= 5 and count(distinct conv.subject_user_id) >= 3
  )
  select
    app_private.question_signal_fingerprint(
      caller.tenant_id,
      'repeated_question_cluster',
      lq.lesson_id::text
    ),
    'repeated_question_cluster'::text,
    case
      when lq.question_count >= 15 and lq.learner_count >= 5 then 'critical'
      when lq.question_count >= 8 then 'elevated'
      else 'watch'
    end,
    app_private.question_severity_rank(
      case
        when lq.question_count >= 15 and lq.learner_count >= 5 then 'critical'
        when lq.question_count >= 8 then 'elevated'
        else 'watch'
      end
    ),
    coalesce(le.title, 'Untitled lesson') || ' drew ' ||
      lq.question_count::text || ' questions from ' ||
      lq.learner_count::text || ' learners',
    'Questions keep landing on this one lesson. This counts recorded ' ||
      'learner messages in conversations opened on the lesson; it does not ' ||
      'establish why they were asked.',
    lq.course_id,
    lq.module_id,
    lq.lesson_id,
    lq.question_count::numeric,
    lq.learner_count::numeric,
    jsonb_build_object(
      'courseId', lq.course_id,
      'courseTitle', co.title,
      'lessonId', lq.lesson_id,
      'lessonTitle', le.title,
      'questions', lq.question_count,
      'learners', lq.learner_count,
      'lastQuestionAt', lq.last_question_at
    ),
    jsonb_build_array(
      'table:public.messages',
      'table:public.conversations',
      'lesson:' || lq.lesson_id::text
    )
      || coalesce(
        (
          select jsonb_agg('message:' || sampled.message_id::text)
          from unnest(lq.sample_ids) as sampled(message_id)
        ),
        '[]'::jsonb
      )
  from lesson_questions lq
  left join public.lessons le
    on le.tenant_id = caller.tenant_id
   and le.lesson_id = lq.lesson_id
  left join public.courses co
    on co.tenant_id = caller.tenant_id
   and co.course_id = lq.course_id;

  -- 4. Learners stalling after a specific lesson. "After" means the most
  --    recently completed lesson in that course; the stall is the absence of
  --    any recorded lesson activity since, which is a recorded fact.
  return query
  with latest_completion as (
    select
      lp.user_id,
      lp.course_id,
      lp.module_id,
      lp.lesson_id,
      lp.completed_at,
      row_number() over (
        partition by lp.user_id, lp.course_id
        order by lp.completed_at desc, lp.lesson_id
      ) as completion_rank
    from public.lesson_progress lp
    where lp.tenant_id = caller.tenant_id
      and lp.deleted_at is null
      and lp.completed_at is not null
      and lp.completed_at < window_end
  ),
  last_activity as (
    select
      lp.user_id,
      lp.course_id,
      max(lp.last_activity_at) as last_activity_at
    from public.lesson_progress lp
    where lp.tenant_id = caller.tenant_id
      and lp.deleted_at is null
      and lp.last_activity_at is not null
    group by lp.user_id, lp.course_id
  ),
  stalled as (
    select
      lc.course_id,
      lc.module_id,
      lc.lesson_id,
      count(*)::bigint as learner_count,
      max(la.last_activity_at) as most_recent_activity_at
    from latest_completion lc
    join last_activity la
      on la.user_id = lc.user_id
     and la.course_id = lc.course_id
    left join public.student_progress sp
      on sp.tenant_id = caller.tenant_id
     and sp.user_id = lc.user_id
     and sp.course_id = lc.course_id
     and sp.deleted_at is null
    where lc.completion_rank = 1
      and coalesce(sp.progress_state, 'in_progress') <> 'completed'
      and la.last_activity_at < window_end - interval '14 days'
    group by lc.course_id, lc.module_id, lc.lesson_id
    having count(*) >= 3
  )
  select
    app_private.question_signal_fingerprint(
      caller.tenant_id, 'post_lesson_stall', s.lesson_id::text
    ),
    'post_lesson_stall'::text,
    case
      when s.learner_count >= 10 then 'critical'
      when s.learner_count >= 5 then 'elevated'
      else 'watch'
    end,
    app_private.question_severity_rank(
      case
        when s.learner_count >= 10 then 'critical'
        when s.learner_count >= 5 then 'elevated'
        else 'watch'
      end
    ),
    s.learner_count::text || ' learners stopped after ' ||
      coalesce(le.title, 'an untitled lesson'),
    'Each of these learners has this lesson as their most recently ' ||
      'completed lesson in the course, has not completed the course, and ' ||
      'has no recorded lesson activity in the last 14 days. Learners with ' ||
      'no recorded activity timestamp at all are never counted here.',
    s.course_id,
    s.module_id,
    s.lesson_id,
    s.learner_count::numeric,
    null::numeric,
    jsonb_build_object(
      'courseId', s.course_id,
      'courseTitle', co.title,
      'lessonId', s.lesson_id,
      'lessonTitle', le.title,
      'stalledLearners', s.learner_count,
      'inactivityThresholdDays', 14,
      'mostRecentActivityAt', s.most_recent_activity_at
    ),
    jsonb_build_array(
      'table:public.lesson_progress',
      'table:public.student_progress',
      'lesson:' || s.lesson_id::text
    )
  from stalled s
  left join public.lessons le
    on le.tenant_id = caller.tenant_id
   and le.lesson_id = s.lesson_id
  left join public.courses co
    on co.tenant_id = caller.tenant_id
   and co.course_id = s.course_id;

  -- 5. Questions with no course context at all. These can never be attributed
  --    to a lesson, so they are invisible to every other signal here.
  select
    count(*)::bigint,
    count(*) filter (where conv.course_id is null)::bigint,
    count(distinct conv.subject_user_id) filter (
      where conv.course_id is null
    )::bigint
  into range_questions, unattributed_questions, unattributed_learners
  from public.messages m
  join public.conversations conv
    on conv.tenant_id = m.tenant_id
   and conv.conversation_id = m.conversation_id
  where m.tenant_id = caller.tenant_id
    and m.created_at >= window_start
    and m.created_at < window_end
    and m.deleted_at is null
    and m.status = 'final'
    and m.actor_type in ('student', 'creator', 'owner')
    and m.modality in ('text', 'voice_transcript')
    and conv.deleted_at is null;

  if coalesce(unattributed_questions, 0) >= 5
    and coalesce(range_questions, 0) > 0
    and unattributed_questions::numeric / range_questions >= 0.1
  then
    return query
    select
      app_private.question_signal_fingerprint(
        caller.tenant_id, 'unattributed_questions', 'tenant'
      ),
      'unattributed_questions'::text,
      case
        when unattributed_questions::numeric / range_questions >= 0.4
          then 'critical'
        when unattributed_questions::numeric / range_questions >= 0.2
          then 'elevated'
        else 'watch'
      end,
      app_private.question_severity_rank(
        case
          when unattributed_questions::numeric / range_questions >= 0.4
            then 'critical'
          when unattributed_questions::numeric / range_questions >= 0.2
            then 'elevated'
          else 'watch'
        end
      ),
      unattributed_questions::text ||
        ' questions were asked outside any course',
      'These conversations carry no course, module or lesson, so nothing ' ||
        'here can attribute the questions to content. They are counted in ' ||
        'the tenant totals and nowhere else.',
      null::uuid,
      null::uuid,
      null::uuid,
      unattributed_questions::numeric,
      range_questions::numeric,
      jsonb_build_object(
        'unattributedQuestions', unattributed_questions,
        'totalQuestions', range_questions,
        'unattributedLearners', unattributed_learners,
        'share', round(
          unattributed_questions::numeric / range_questions, 4
        )
      ),
      jsonb_build_array(
        'table:public.messages',
        'column:public.conversations.course_id'
      );
  end if;
end;
$$;
revoke execute on function app_private.question_signal_detections(
  timestamptz, timestamptz
) from public, anon, authenticated, service_role;

-- Detected signals for a range, ordered by severity, each merged with whatever
-- review a human has already recorded against it.
create or replace function public.analytics_signals(
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
  signal_limit constant integer := 50;
  data_through timestamptz;
  signals_json jsonb;
  severity_counts jsonb;
  detected_count bigint := 0;
  omitted_signals bigint := 0;
  label_count bigint := 0;
  signal_limitations text[] := '{}'::text[];
  evidence constant jsonb := jsonb_build_array(
    'table:public.question_labels',
    'table:public.messages',
    'table:public.conversations',
    'table:public.lesson_progress',
    'rpc:public.analytics_answer_quality'
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

  select count(*)::bigint
  into label_count
  from public.question_labels ql
  where ql.tenant_id = caller.tenant_id
    and ql.deleted_at is null
    and ql.asked_at >= win.window_start
    and ql.asked_at < win.window_end;

  with detected as (
    select
      d.*,
      row_number() over (
        order by d.severity_rank desc, d.signal_kind, d.signal_fingerprint
      ) as signal_position
    from app_private.question_signal_detections(
      win.window_start, win.window_end
    ) d
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'signalFingerprint', d.signal_fingerprint,
          'kind', d.signal_kind,
          'severity', d.severity,
          'severityRank', d.severity_rank,
          'headline', d.headline,
          'detail', d.detail,
          'courseId', d.course_id,
          'moduleId', d.module_id,
          'lessonId', d.lesson_id,
          'observedValue', d.observed_value,
          'comparisonValue', d.comparison_value,
          'evidence', d.evidence,
          'evidenceRefs', d.evidence_refs,
          'review', jsonb_build_object(
            'status', coalesce(qs.review_status, 'new'),
            'note', qs.review_note,
            'reviewedAt', qs.reviewed_at,
            'reviewedByRole', qs.reviewed_by_role,
            'firstDetectedAt', qs.first_detected_at
          )
        )
        order by d.signal_position
      ) filter (where d.signal_position <= signal_limit),
      '[]'::jsonb
    ),
    count(*)::bigint,
    count(*) filter (where d.signal_position > signal_limit)::bigint,
    jsonb_build_object(
      'critical', count(*) filter (where d.severity = 'critical'),
      'elevated', count(*) filter (where d.severity = 'elevated'),
      'watch', count(*) filter (where d.severity = 'watch')
    )
  into signals_json, detected_count, omitted_signals, severity_counts
  from detected d
  left join public.question_signals qs
    on qs.tenant_id = caller.tenant_id
   and qs.signal_fingerprint = d.signal_fingerprint
   and qs.deleted_at is null;

  if label_count = 0 then
    signal_limitations := signal_limitations || (
      'No question in this range carries a recorded classification, so the ' ||
      'topic-spike detector had nothing to compare and produced no signal. ' ||
      'The remaining detectors run on recorded messages and progress rows ' ||
      'and are unaffected.'
    );
  end if;
  if omitted_signals > 0 then
    signal_limitations := signal_limitations || (
      'Only the top ' || signal_limit::text ||
      ' signals by severity are returned; ' || omitted_signals::text ||
      ' further signal(s) are omitted.'
    );
  end if;
  signal_limitations := signal_limitations || (
    'Every signal is a threshold comparison over recorded rows. A signal ' ||
    'states what was counted, never why it happened, and never triggers an ' ||
    'action on its own.'
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
    'limits', jsonb_build_object(
      'signals', signal_limit,
      'truncated', omitted_signals > 0
    ),
    'reviewStatuses', jsonb_build_array(
      'new', 'acknowledged', 'actioned', 'dismissed'
    ),
    'definitions', jsonb_build_object(
      'topic_spike',
      'A classified topic whose question count in the range is at least 5, ' ||
      'at least 3 higher than the immediately preceding window of equal ' ||
      'length, and at least double it.',
      'content_gap',
      'A course, module or lesson where assistant answers were recorded ' ||
      'with an empty citation list, taken from ' ||
      'public.analytics_answer_quality rather than recomputed.',
      'repeated_question_cluster',
      'A lesson that drew at least 5 questions from at least 3 distinct ' ||
      'learners inside the range.',
      'post_lesson_stall',
      'At least 3 learners whose most recently completed lesson in a course ' ||
      'is this one, who have not completed the course, and whose last ' ||
      'recorded lesson activity is more than 14 days before the end of the ' ||
      'range.',
      'unattributed_questions',
      'At least 5 questions, and at least a tenth of the range total, asked ' ||
      'in conversations that carry no course context.'
    ),
    'metrics', jsonb_build_object(
      'detectedSignals', app_private.analytics_metric(
        'partial',
        jsonb_build_object(
          'signals', coalesce(signals_json, '[]'::jsonb),
          'detectedSignals', detected_count,
          'omittedSignals', omitted_signals,
          'bySeverity', coalesce(severity_counts, '{}'::jsonb),
          'classifiedQuestionsInRange', label_count
        ),
        data_through,
        evidence,
        to_jsonb(signal_limitations)
      ),
      -- Enumerated so the absence is a stated absence rather than a silence.
      'undetectableSignals', app_private.analytics_metric(
        'unknown',
        null,
        null,
        evidence,
        jsonb_build_array(
          'Learner frustration or sentiment is not detected. No rating, ' ||
          'reaction or sentiment value is recorded on any message.',
          'Answer correctness is not detected. Nothing records whether an ' ||
          'answer was right, and grounding coverage is a retrieval fact.',
          'Retrieval-quality regression is not detected. ' ||
          'public.learning_search_chunks scores at query time and the score ' ||
          'is never persisted.',
          'Abandonment and drop-off are not detected. No session end, ' ||
          'course completion timestamp or dwell time is recorded.'
        )
      )
    )
  );
end;
$$;

-- Moves one detected signal through its review lifecycle. The signal is
-- re-detected inside this call, so a caller cannot review - and thereby
-- persist - an observation the deterministic pass does not produce.
create or replace function public.analytics_signal_review(
  signal_fingerprint text,
  next_status text,
  review_note text,
  range_start timestamptz,
  range_end timestamptz,
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
  win record;
  command record;
  detection record;
  existing public.question_signals%rowtype;
  written public.question_signals%rowtype;
  result jsonb;
  request_fingerprint text;
  normalized_status text := lower(btrim(coalesce(next_status, '')));
  normalized_note text := nullif(btrim(coalesce(review_note, '')), '');
  current_status text;
  allowed_next text[];
begin
  select * into caller from app_private.analytics_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if signal_fingerprint is null
    or signal_fingerprint !~ '^[0-9a-f]{64}$'
    or normalized_status not in ('acknowledged', 'actioned', 'dismissed')
    or (normalized_note is not null and length(normalized_note) > 1000)
    or idempotency_key is null
    or length(idempotency_key) not between 8 and 200
    or request_id is null
    or length(request_id) not between 1 and 200
    or trace_id is null
    or length(trace_id) not between 8 and 200
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  select * into win
  from app_private.analytics_window(range_start, range_end);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_range');
  end if;

  request_fingerprint := encode(
    extensions.digest(
      concat_ws(
        chr(31),
        analytics_signal_review.signal_fingerprint,
        normalized_status,
        coalesce(normalized_note, '')
      ),
      'sha256'
    ),
    'hex'
  );
  select * into command
  from app_private.onboarding_begin_command(
    caller.tenant_id, 'question.signal.review',
    analytics_signal_review.idempotency_key,
    request_fingerprint, 'analytics_signal_review'
  );
  if command.command_state = 'replayed' then
    return command.prior_result;
  elsif command.command_state <> 'new' then
    perform app_private.question_intelligence_audit(
      caller.tenant_id, caller.identity_role, 'question.signal.review',
      'deny', 'idempotency_conflict',
      analytics_signal_review.signal_fingerprint,
      request_id, trace_id, null::text
    );
    return jsonb_build_object('ok', false, 'code', 'idempotency_conflict');
  end if;

  select d.* into detection
  from app_private.question_signal_detections(
    win.window_start, win.window_end
  ) d
  where d.signal_fingerprint = analytics_signal_review.signal_fingerprint;
  if not found then
    result := jsonb_build_object('ok', false, 'code', 'signal_not_found');
    perform app_private.question_intelligence_audit(
      caller.tenant_id, caller.identity_role, 'question.signal.review',
      'deny', 'signal_not_detected',
      analytics_signal_review.signal_fingerprint,
      request_id, trace_id, null::text
    );
    perform app_private.onboarding_complete_command(
      caller.tenant_id, 'question.signal.review',
      analytics_signal_review.idempotency_key, result
    );
    return result;
  end if;

  select * into existing
  from public.question_signals qs
  where qs.tenant_id = caller.tenant_id
    and qs.signal_fingerprint = analytics_signal_review.signal_fingerprint
  for update;
  current_status := coalesce(existing.review_status, 'new');

  -- Forward-only lifecycle, mirroring the Opportunity transitions in
  -- packages/intelligence-core: dismissal is terminal and nothing reopens.
  allowed_next := case current_status
    when 'new' then array['acknowledged', 'actioned', 'dismissed']
    when 'acknowledged' then array['actioned', 'dismissed']
    when 'actioned' then array['dismissed']
    else array[]::text[]
  end;
  if not (normalized_status = any (allowed_next)) then
    result := jsonb_build_object(
      'ok', false,
      'code', 'invalid_transition',
      'currentStatus', current_status
    );
    perform app_private.question_intelligence_audit(
      caller.tenant_id, caller.identity_role, 'question.signal.review',
      'deny', 'invalid_transition',
      analytics_signal_review.signal_fingerprint,
      request_id, trace_id, null::text
    );
    perform app_private.onboarding_complete_command(
      caller.tenant_id, 'question.signal.review',
      analytics_signal_review.idempotency_key, result
    );
    return result;
  end if;

  insert into public.question_signals (
    tenant_id, signal_fingerprint, signal_kind, severity, severity_rank,
    headline, detail, evidence, evidence_refs, course_id, module_id, lesson_id,
    observed_value, comparison_value, detection_window_start,
    detection_window_end, review_status, review_note, reviewed_by,
    reviewed_by_role, reviewed_at, idempotency_key
  ) values (
    caller.tenant_id,
    detection.signal_fingerprint,
    detection.signal_kind,
    detection.severity,
    detection.severity_rank,
    left(detection.headline, 200),
    left(detection.detail, 1000),
    detection.evidence,
    detection.evidence_refs,
    detection.course_id,
    detection.module_id,
    detection.lesson_id,
    detection.observed_value,
    detection.comparison_value,
    win.window_start,
    win.window_end,
    normalized_status,
    normalized_note,
    auth.uid(),
    caller.identity_role,
    statement_timestamp(),
    'question-signal-review:' ||
      encode(
        extensions.digest(
          caller.tenant_id::text || chr(31) ||
          analytics_signal_review.signal_fingerprint,
          'sha256'
        ),
        'hex'
      )
  )
  on conflict (tenant_id, signal_fingerprint) do update
  set severity = excluded.severity,
      severity_rank = excluded.severity_rank,
      headline = excluded.headline,
      detail = excluded.detail,
      evidence = excluded.evidence,
      evidence_refs = excluded.evidence_refs,
      observed_value = excluded.observed_value,
      comparison_value = excluded.comparison_value,
      detection_window_start = excluded.detection_window_start,
      detection_window_end = excluded.detection_window_end,
      review_status = excluded.review_status,
      review_note = excluded.review_note,
      reviewed_by = excluded.reviewed_by,
      reviewed_by_role = excluded.reviewed_by_role,
      reviewed_at = excluded.reviewed_at,
      last_detected_at = statement_timestamp()
  returning * into written;

  result := jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'signalFingerprint', written.signal_fingerprint,
    'kind', written.signal_kind,
    'severity', written.severity,
    'previousStatus', current_status,
    'reviewStatus', written.review_status,
    'reviewedAt', written.reviewed_at,
    'recordVersion', written.record_version
  );
  perform app_private.question_intelligence_audit(
    caller.tenant_id, caller.identity_role, 'question.signal.review',
    'allow', current_status || '->' || normalized_status,
    written.signal_fingerprint, request_id, trace_id,
    'question-signal-review:' || request_fingerprint
  );
  perform app_private.onboarding_complete_command(
    caller.tenant_id, 'question.signal.review',
    analytics_signal_review.idempotency_key, result
  );
  return result;
end;
$$;

-- ------------------------------------------------------------------ grants

revoke all on function public.learning_record_question_label(
  uuid, text, text, text, text, text, text, text, text, text
) from public, anon, service_role;
revoke all on function public.analytics_question_labels(
  timestamptz, timestamptz
) from public, anon, service_role;
revoke all on function public.analytics_signals(
  timestamptz, timestamptz
) from public, anon, service_role;
revoke all on function public.analytics_signal_review(
  text, text, text, timestamptz, timestamptz, text, text, text
) from public, anon, service_role;

grant execute on function public.learning_record_question_label(
  uuid, text, text, text, text, text, text, text, text, text
) to authenticated;
grant execute on function public.analytics_question_labels(
  timestamptz, timestamptz
) to authenticated;
grant execute on function public.analytics_signals(
  timestamptz, timestamptz
) to authenticated;
grant execute on function public.analytics_signal_review(
  text, text, text, timestamptz, timestamptz, text, text, text
) to authenticated;

commit;

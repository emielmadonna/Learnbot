-- Per-learner signal readout.
--
-- public.question_labels already carries one row per classified learner
-- question, including subject_user_id, so the per-learner view this file adds
-- is a read, not a new write path. Nothing here writes a new table; it is one
-- new function (plus one small helper and one index) over rows the product
-- already records.
--
-- What this answers, in the buyer's terms (docs/PLAN.md Section 1): which
-- student is worth paying attention to. Four things, all derived in
-- deterministic SQL from public.question_labels, public.messages,
-- public.student_progress and app_private.user_access_accounts:
--
--   * depth        - the share of a learner's classified questions the
--                     classifier rated notable or critical.
--   * escalation   - whether a learner's questions are trending toward more
--                     applied intents (how_to, troubleshooting) versus more
--                     foundational ones (definition, scope_check), comparing
--                     the first half of their classified questions in range
--                     against the second half.
--   * stuck        - the same topic asked repeatedly within one lesson.
--   * readiness    - a heuristic combining recorded course completion with
--                     question volume and importance. It is explicitly a
--                     prioritised list to review, never a certainty.
--
-- Honesty boundary, same envelope as 20260725121000 and 20260726091000
-- (state / value / dataThrough / evidenceRefs / limitations):
--
--   * When nothing in the range has been classified, learnerRows is
--     'unknown' with the reason, not an empty list.
--   * A learner's escalation trend is 'insufficient_data' below a minimum
--     sample size rather than guessed from two or three questions.
--   * Readiness is always reported with its underlying evidence numbers next
--     to the tier, and is 'insufficient_data' whenever no course-progress
--     record exists for the learner at all -- it is never inferred from
--     question activity alone.
--   * Every count here is a direct aggregate over recorded rows. Nothing is
--     sampled, interpolated or modelled.
--
-- Access: app_private.analytics_context(), identical to every sibling
-- analytics function -- tenant-scoped, role-gated (tenant_owner, tenant_admin,
-- creator, teacher), SECURITY DEFINER over forced row level security. A
-- platform administrator who has entered a tenant workspace reads through the
-- same path, because that membership is what analytics_context() resolves; no
-- second privilege path is introduced. Section visibility (hiding this
-- content entirely from a tenant without the entitlement) is the existing
-- "insights" tenant_sections gate the console already applies to this whole
-- panel -- this file does not add a second gating mechanism.

begin;

-- Supports the per-learner, time-ordered scan the escalation and stuck
-- computations both need.
create index question_labels_subject_time_idx
  on public.question_labels (tenant_id, subject_user_id, asked_at)
  where deleted_at is null;

-- A fixed ranking from foundational to applied. This is a taxonomy position,
-- not a linguistic specificity score: troubleshooting names a concrete,
-- applied problem; definition and scope_check name foundational orientation
-- questions. off_topic carries no position and is excluded from every
-- specificity computation.
create or replace function app_private.question_intent_specificity_rank(
  question_intent text
)
returns smallint
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select case question_intent
    when 'definition' then 1
    when 'scope_check' then 1
    when 'clarification' then 2
    when 'how_to' then 3
    when 'troubleshooting' then 4
    else null
  end::smallint;
$$;
revoke execute on function app_private.question_intent_specificity_rank(text)
  from public, anon, authenticated, service_role;

create or replace function public.analytics_learner_signals(
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
  learner_limit constant integer := 50;
  min_trend_questions constant integer := 4;
  stuck_threshold constant integer := 3;
  escalation_margin constant numeric := 0.75;
  data_through timestamptz;
  totals record;
  learners_json jsonb;
  omitted_learners bigint := 0;
  coverage_state text;
  learner_rows_state text;
  coverage_limitations text[] := '{}'::text[];
  learner_rows_limitations text[] := '{}'::text[];
  unclassified_note text;
  evidence constant jsonb := jsonb_build_array(
    'table:public.question_labels',
    'table:public.messages',
    'table:public.conversations',
    'table:public.student_progress',
    'table:app_private.user_access_accounts'
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
    count(ql.question_label_id)::bigint as classified_questions,
    count(*) filter (where ql.question_label_id is null)::bigint
      as unclassified_questions,
    count(distinct conv.subject_user_id)::bigint as learners,
    count(distinct conv.subject_user_id) filter (
      where ql.question_label_id is not null
    )::bigint as classified_learners
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
    ' question(s) in this range carry no recorded classification and are ' ||
    'excluded from every learner row below. A learner whose questions are ' ||
    'all unclassified is left off the list rather than shown with an ' ||
    'empty profile.';

  -- Honest state. An empty learner list is only truthful when there were no
  -- questions at all; otherwise it would read as "nobody asked anything".
  coverage_state := case
    when coalesce(totals.questions, 0) = 0 then 'known'
    when coalesce(totals.classified_questions, 0) = 0 then 'unknown'
    when coalesce(totals.unclassified_questions, 0) > 0 then 'partial'
    else 'known'
  end;
  if coalesce(totals.unclassified_questions, 0) > 0 then
    coverage_limitations := coverage_limitations || unclassified_note;
  end if;

  learner_rows_state := coverage_state;
  if learner_rows_state = 'unknown' then
    learner_rows_limitations := array[
      'No question in this range carries a recorded classification, so no ' ||
      'learner can be profiled. ' || unclassified_note ||
      ' Classification runs after an answer is recorded and is skipped ' ||
      'whenever the classifier is unavailable or returns output that does ' ||
      'not match the closed schema.'
    ]::text[];
  elsif coalesce(totals.unclassified_questions, 0) > 0 then
    learner_rows_limitations := array[unclassified_note]::text[];
  end if;

  if learner_rows_state <> 'unknown' then
    with labelled as (
      select
        ql.question_label_id,
        ql.subject_user_id,
        ql.topic_key,
        ql.topic_label,
        ql.question_intent,
        ql.importance,
        ql.grounding_outcome,
        ql.course_id,
        ql.lesson_id,
        ql.asked_at,
        app_private.question_intent_specificity_rank(ql.question_intent)
          as specificity_rank
      from public.question_labels ql
      where ql.tenant_id = caller.tenant_id
        and ql.deleted_at is null
        and ql.asked_at >= win.window_start
        and ql.asked_at < win.window_end
    ),
    ordered as (
      select
        l.*,
        ntile(2) over (
          partition by l.subject_user_id
          order by l.asked_at, l.question_label_id
        ) as sequence_half
      from labelled l
    ),
    learner_totals as (
      select
        o.subject_user_id,
        count(*)::bigint as questions,
        count(distinct o.topic_key)::bigint as distinct_topics,
        count(distinct o.lesson_id)::bigint as distinct_lessons,
        count(distinct o.course_id)::bigint as distinct_courses,
        count(*) filter (
          where o.importance in ('notable', 'critical')
        )::bigint as notable_or_critical,
        count(*) filter (where o.importance = 'critical')::bigint
          as critical_questions,
        count(*) filter (
          where o.grounding_outcome = 'ungrounded'
        )::bigint as ungrounded_answers,
        min(o.asked_at) as first_asked_at,
        max(o.asked_at) as last_asked_at
      from ordered o
      group by o.subject_user_id
    ),
    escalation as (
      select
        o.subject_user_id,
        avg(o.specificity_rank) filter (
          where o.sequence_half = 1
        ) as first_half_avg,
        avg(o.specificity_rank) filter (
          where o.sequence_half = 2
        ) as second_half_avg,
        count(*) filter (where o.specificity_rank is not null)::bigint
          as ranked_questions
      from ordered o
      group by o.subject_user_id
    ),
    stuck_clusters as (
      select
        l.subject_user_id,
        l.lesson_id,
        l.course_id,
        l.topic_key,
        max(l.topic_label) as topic_label,
        count(*)::bigint as repeats,
        max(l.asked_at) as last_asked_at
      from labelled l
      where l.lesson_id is not null
      group by l.subject_user_id, l.lesson_id, l.course_id, l.topic_key
      having count(*) >= stuck_threshold
    ),
    stuck_ranked as (
      select
        sc.*,
        row_number() over (
          partition by sc.subject_user_id
          order by sc.repeats desc, sc.last_asked_at desc, sc.topic_key
        ) as cluster_rank
      from stuck_clusters sc
    ),
    stuck_by_learner as (
      select
        sr.subject_user_id,
        jsonb_agg(
          jsonb_build_object(
            'lessonId', sr.lesson_id,
            'lessonTitle', le.title,
            'courseId', sr.course_id,
            'courseTitle', co.title,
            'topicKey', sr.topic_key,
            'topicLabel', sr.topic_label,
            'repeats', sr.repeats,
            'lastAskedAt', sr.last_asked_at
          )
          order by sr.cluster_rank
        ) filter (where sr.cluster_rank <= 5) as clusters,
        count(*)::bigint as cluster_count
      from stuck_ranked sr
      left join public.lessons le
        on le.tenant_id = caller.tenant_id
       and le.lesson_id = sr.lesson_id
      left join public.courses co
        on co.tenant_id = caller.tenant_id
       and co.course_id = sr.course_id
      group by sr.subject_user_id
    ),
    progress as (
      select
        sp.user_id as subject_user_id,
        max(sp.percent_complete) as max_percent_complete,
        bool_or(sp.progress_state = 'completed') as has_completed_course,
        count(*)::bigint as courses_with_progress
      from public.student_progress sp
      where sp.tenant_id = caller.tenant_id
        and sp.deleted_at is null
      group by sp.user_id
    ),
    ranked_learners as (
      select
        lt.*,
        acc.email_normalized,
        coalesce(esc.ranked_questions, 0) as ranked_questions,
        esc.first_half_avg,
        esc.second_half_avg,
        coalesce(sb.clusters, '[]'::jsonb) as stuck_clusters_json,
        coalesce(sb.cluster_count, 0) as stuck_cluster_count,
        pr.max_percent_complete,
        coalesce(pr.has_completed_course, false) as has_completed_course,
        coalesce(pr.courses_with_progress, 0) as courses_with_progress,
        row_number() over (
          order by
            lt.critical_questions desc,
            lt.notable_or_critical desc,
            coalesce(sb.cluster_count, 0) desc,
            lt.questions desc,
            lt.subject_user_id
        ) as learner_rank
      from learner_totals lt
      left join escalation esc on esc.subject_user_id = lt.subject_user_id
      left join stuck_by_learner sb on sb.subject_user_id = lt.subject_user_id
      left join progress pr on pr.subject_user_id = lt.subject_user_id
      left join app_private.user_access_accounts acc
        on acc.tenant_id = caller.tenant_id
       and acc.auth_user_id = lt.subject_user_id
    )
    select
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'subjectUserId', rl.subject_user_id,
            'displayName', rl.email_normalized,
            'questions', rl.questions,
            'distinctTopics', rl.distinct_topics,
            'distinctLessons', rl.distinct_lessons,
            'distinctCourses', rl.distinct_courses,
            'notableOrCriticalQuestions', rl.notable_or_critical,
            'criticalQuestions', rl.critical_questions,
            'ungroundedAnswers', rl.ungrounded_answers,
            'firstAskedAt', rl.first_asked_at,
            'lastAskedAt', rl.last_asked_at,
            'depth', jsonb_build_object(
              'notableOrCriticalShare', case
                when rl.questions = 0 then null
                else round(rl.notable_or_critical::numeric / rl.questions, 4)
              end
            ),
            'escalation', case
              when rl.ranked_questions < min_trend_questions
                or rl.first_half_avg is null
                or rl.second_half_avg is null
              then jsonb_build_object(
                'state', 'insufficient_data',
                'sampleSize', rl.ranked_questions
              )
              else jsonb_build_object(
                'state', case
                  when rl.second_half_avg - rl.first_half_avg
                    >= escalation_margin then 'escalating'
                  when rl.first_half_avg - rl.second_half_avg
                    >= escalation_margin then 'declining'
                  else 'steady'
                end,
                'sampleSize', rl.ranked_questions,
                'firstHalfAvgSpecificity', round(rl.first_half_avg, 2),
                'secondHalfAvgSpecificity', round(rl.second_half_avg, 2)
              )
            end,
            'stuck', jsonb_build_object(
              'clusterCount', rl.stuck_cluster_count,
              'clusters', rl.stuck_clusters_json
            ),
            'readiness', case
              when rl.courses_with_progress = 0 or rl.questions < 2 then
                jsonb_build_object(
                  'tier', 'insufficient_data',
                  'evidence', jsonb_build_object(
                    'maxPercentComplete', rl.max_percent_complete,
                    'hasCompletedCourse', rl.has_completed_course,
                    'questions', rl.questions,
                    'notableOrCriticalQuestions', rl.notable_or_critical
                  )
                )
              else jsonb_build_object(
                'tier', case
                  when (
                      rl.has_completed_course
                      or coalesce(rl.max_percent_complete, 0) >= 80
                    )
                    and rl.questions >= 3
                    and rl.notable_or_critical >= 1
                    then 'likely_ready'
                  when coalesce(rl.max_percent_complete, 0) >= 50
                    and rl.questions >= 1
                    then 'possible'
                  else 'not_yet'
                end,
                'evidence', jsonb_build_object(
                  'maxPercentComplete', rl.max_percent_complete,
                  'hasCompletedCourse', rl.has_completed_course,
                  'questions', rl.questions,
                  'notableOrCriticalQuestions', rl.notable_or_critical
                )
              )
            end
          )
          order by rl.learner_rank
        ) filter (where rl.learner_rank <= learner_limit),
        '[]'::jsonb
      ),
      count(*) filter (where rl.learner_rank > learner_limit)::bigint
    into learners_json, omitted_learners
    from ranked_learners rl;
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
      'learners', learner_limit,
      'truncated', omitted_learners > 0
    ),
    'thresholds', jsonb_build_object(
      'minQuestionsForTrend', min_trend_questions,
      'stuckRepeatThreshold', stuck_threshold,
      'escalationMargin', escalation_margin
    ),
    'specificityTaxonomy', jsonb_build_object(
      'definition', 1,
      'scope_check', 1,
      'clarification', 2,
      'how_to', 3,
      'troubleshooting', 4
    ),
    'definitions', jsonb_build_object(
      'depth',
      'The share of a learner classified questions the classifier rated ' ||
      'notable or critical importance in this range. It is the classifier ' ||
      'own judgement of significance, not a measured comprehension score.',
      'escalation',
      'Compares the average specificity rank of the first half of a ' ||
      'learner classified questions in this range against the second ' ||
      'half, using a fixed foundational-to-applied ranking of intents ' ||
      '(definition/scope_check = 1, clarification = 2, how_to = 3, ' ||
      'troubleshooting = 4). Reported only when at least ' ||
      min_trend_questions::text ||
      ' ranked questions exist; otherwise insufficient_data.',
      'stuck',
      'The same topic asked ' || stuck_threshold::text || ' or more times ' ||
      'within one lesson by one learner in this range. A direct count, not ' ||
      'an inference about confusion.',
      'readiness',
      'A heuristic combining recorded course completion from ' ||
      'public.student_progress with question volume and importance in ' ||
      'this range. It is a prioritised list to review, never a certainty, ' ||
      'and is reported as insufficient_data whenever no progress record ' ||
      'exists for the learner at all.'
    ),
    'metrics', jsonb_build_object(
      'learnerCoverage', app_private.analytics_metric(
        coverage_state,
        jsonb_build_object(
          'questions', coalesce(totals.questions, 0),
          'classifiedQuestions', coalesce(totals.classified_questions, 0),
          'unclassifiedQuestions', coalesce(totals.unclassified_questions, 0),
          'learners', coalesce(totals.learners, 0),
          'classifiedLearners', coalesce(totals.classified_learners, 0)
        ),
        data_through,
        evidence,
        to_jsonb(coverage_limitations)
      ),
      'learnerRows', app_private.analytics_metric(
        learner_rows_state,
        case when learner_rows_state = 'unknown' then null else
          jsonb_build_object(
            'learners', coalesce(learners_json, '[]'::jsonb),
            'omittedLearners', omitted_learners
          )
        end,
        data_through,
        evidence,
        to_jsonb(learner_rows_limitations)
      )
    )
  );
end;
$$;
revoke execute on function public.analytics_learner_signals(
  timestamptz, timestamptz
) from public, anon, service_role;
grant execute on function public.analytics_learner_signals(
  timestamptz, timestamptz
) to authenticated;

commit;

-- Durable learning analytics. Every number below is aggregated from rows the
-- product already writes: public.messages, public.conversations,
-- public.student_progress, public.lesson_progress and the learning catalog.
-- Nothing is interpolated, sampled or modelled.
--
-- Honesty boundary: a metric that cannot be derived from a recorded column is
-- returned as {"state":"unknown","limitations":[...]} instead of a zero or a
-- plausible estimate. The metric envelope mirrors MetricResult in
-- packages/intelligence-core (state / value / dataThrough / evidenceRefs /
-- limitations) so known, partial and unknown render identically across the
-- fixture and durable surfaces.
--
-- Two metrics are deliberately unknown today:
--   * answer latency - no request-start timestamp is persisted for an
--     assistant turn and conversation.turn_completed carries no durationMs;
--   * retrieval confidence - the citations written by
--     public.learning_record_assistant_message carry identity and excerpt
--     only, never the query-time relevance from public.learning_search_chunks.

begin;

-- Access patterns introduced by the analytics RPCs.
create index messages_analytics_actor_time_idx
  on public.messages (tenant_id, actor_type, created_at desc)
  where deleted_at is null;
create index messages_analytics_conversation_time_idx
  on public.messages (tenant_id, conversation_id, created_at)
  where deleted_at is null;
create index conversations_analytics_context_idx
  on public.conversations (tenant_id, course_id, module_id, lesson_id)
  where deleted_at is null;
create index student_progress_analytics_course_idx
  on public.student_progress (tenant_id, course_id, progress_state)
  where deleted_at is null;
create index lesson_progress_analytics_completed_idx
  on public.lesson_progress (tenant_id, course_id, completed_at desc)
  where deleted_at is null and completed_at is not null;
create index lesson_progress_analytics_activity_idx
  on public.lesson_progress (tenant_id, course_id, last_activity_at desc)
  where deleted_at is null and last_activity_at is not null;

-- Analytics is a tenant-staff surface. Students never read aggregated peer
-- activity, and an unselected or unverified caller resolves to no row at all.
create or replace function app_private.analytics_context()
returns table (
  tenant_id uuid,
  principal_id text,
  identity_role text
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select c.tenant_id, c.principal_id, c.identity_role
  from app_private.learning_rpc_context() c
  where c.identity_role in (
    'tenant_owner', 'tenant_admin', 'creator', 'teacher'
  );
$$;
revoke execute on function app_private.analytics_context()
  from public, anon, authenticated, service_role;

-- A caller-supplied range is normalized to a bounded, half-open UTC window.
-- An invalid or unbounded request returns no row, so the RPC fails closed.
create or replace function app_private.analytics_window(
  requested_start timestamptz,
  requested_end timestamptz
)
returns table (
  window_start timestamptz,
  window_end timestamptz,
  day_count integer
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    w.resolved_start,
    w.resolved_end,
    (
      extract(
        epoch from (
          date_trunc('day', w.resolved_end at time zone 'UTC')
          - date_trunc('day', w.resolved_start at time zone 'UTC')
        )
      ) / 86400
    )::integer + 1
  from (
    select
      coalesce(
        requested_start,
        statement_timestamp() - interval '30 days'
      ) as resolved_start,
      coalesce(requested_end, statement_timestamp()) as resolved_end
  ) w
  where w.resolved_end > w.resolved_start
    and w.resolved_end - w.resolved_start <= interval '366 days'
    and w.resolved_start >= timestamptz '2000-01-01 00:00:00+00'
    and w.resolved_end <= statement_timestamp() + interval '1 day';
$$;
revoke execute on function app_private.analytics_window(
  timestamptz, timestamptz
) from public, anon, authenticated, service_role;

-- MetricResult envelope. 'value' is omitted for an unknown metric so a
-- consumer cannot mistake an absent measurement for a measured zero.
create or replace function app_private.analytics_metric(
  metric_state text,
  metric_value jsonb,
  data_through timestamptz,
  evidence_refs jsonb,
  metric_limitations jsonb
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    jsonb_build_object(
      'state', metric_state,
      'evidenceRefs', coalesce(evidence_refs, '[]'::jsonb),
      'limitations', coalesce(metric_limitations, '[]'::jsonb)
    )
    || case
      when metric_state = 'unknown' or metric_value is null then '{}'::jsonb
      else jsonb_build_object('value', metric_value)
    end
    || case
      when metric_state = 'unknown' or data_through is null then '{}'::jsonb
      else jsonb_build_object('dataThrough', to_jsonb(data_through))
    end
  where metric_state in ('known', 'partial', 'unknown');
$$;
revoke execute on function app_private.analytics_metric(
  text, jsonb, timestamptz, jsonb, jsonb
) from public, anon, authenticated, service_role;

create or replace function app_private.analytics_metric_state(
  metric_limitations text[]
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select case
    when metric_limitations is null
      or array_length(metric_limitations, 1) is null
      then 'known'
    else 'partial'
  end;
$$;
revoke execute on function app_private.analytics_metric_state(text[])
  from public, anon, authenticated, service_role;

-- Question volume over time, reach, channel split, and latency stated as the
-- unknown it currently is.
create or replace function public.analytics_tenant_overview(
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
  totals record;
  turn_stats record;
  data_through timestamptz;
  buckets jsonb;
  volume_limitations text[] := '{}'::text[];
  turn_limitations text[] := array[
    'This is the durable interval between the learner message row and the ' ||
    'assistant message row. It includes retrieval, provider and client ' ||
    'time and is not an instrumented answer latency.'
  ];
  evidence constant jsonb := jsonb_build_array(
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
    and conv.deleted_at is null;

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
      'message is written.'
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
        'known',
        jsonb_build_object(
          'learners', coalesce(totals.active_learners, 0)
        ),
        data_through,
        evidence,
        '[]'::jsonb
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
      )
    )
  );
end;
$$;

-- Headline surface: where learners are actually asking, course to module to
-- lesson, with each group's share of the tenant total for the range.
create or replace function public.analytics_question_distribution(
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
  select * into win
  from app_private.analytics_window(range_start, range_end);
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_range');
  end if;
  data_through := least(win.window_end, statement_timestamp());

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
    and conv.deleted_at is null;

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
    group by conv.course_id
  ) ranked;

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
      'The group question count divided by the tenant total for the range.'
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
        'omittedCourseQuestions', omitted_course_questions
      ),
      data_through,
      evidence,
      to_jsonb(distribution_limitations)
    )
  );
end;
$$;

-- Grounding coverage and the honest content-gap signal. Retrieval confidence
-- is not persisted anywhere, so it is returned as unknown rather than guessed.
create or replace function public.analytics_answer_quality(
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
  cluster_limit constant integer := 25;
  totals record;
  clusters jsonb;
  data_through timestamptz;
  omitted_clusters bigint := 0;
  coverage_limitations text[] := '{}'::text[];
  cluster_limitations text[] := '{}'::text[];
  evidence constant jsonb := jsonb_build_array(
    'table:public.messages',
    'table:public.conversations',
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

  if coalesce(totals.answers_without_source_record, 0) > 0 then
    coverage_limitations := coverage_limitations || (
      totals.answers_without_source_record::text ||
      ' assistant answer(s) carry no sources array and are counted neither ' ||
      'as grounded nor as ungrounded.'
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
      'length.'
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
      )
    )
  );
end;
$$;

-- Completion funnel and stall detection from recorded progress rows only.
create or replace function public.analytics_learner_progress(
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
  course_limit constant integer := 50;
  stalled_threshold_days constant integer := 14;
  courses_json jsonb;
  data_through timestamptz;
  omitted_courses bigint := 0;
  unknown_activity_learners bigint := 0;
  funnel_limitations text[] := array[
    'public.student_progress stores current state without history, so ' ||
    'started, in-progress and completed counts describe the state at query ' ||
    'time rather than the state at the end of the requested range.'
  ];
  evidence constant jsonb := jsonb_build_array(
    'table:public.student_progress',
    'table:public.lesson_progress',
    'table:public.courses'
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
  into unknown_activity_learners
  from public.student_progress sp
  where sp.tenant_id = caller.tenant_id
    and sp.deleted_at is null
    and sp.last_activity_at is null
    and sp.progress_state <> 'completed';

  with progress as (
    select
      sp.course_id,
      sp.progress_state,
      sp.percent_complete,
      sp.last_activity_at
    from public.student_progress sp
    where sp.tenant_id = caller.tenant_id
      and sp.deleted_at is null
  ),
  progress_rollup as (
    select
      p.course_id,
      count(*)::bigint as learners_with_progress,
      count(*) filter (
        where p.progress_state <> 'not_started'
      )::bigint as learners_started,
      count(*) filter (
        where p.progress_state = 'in_progress'
      )::bigint as learners_in_progress,
      count(*) filter (
        where p.progress_state = 'blocked'
      )::bigint as learners_blocked,
      count(*) filter (
        where p.progress_state = 'completed'
      )::bigint as learners_completed,
      count(*) filter (
        where p.progress_state in ('in_progress', 'blocked')
          and p.last_activity_at is not null
          and p.last_activity_at
            < win.window_end - make_interval(days => stalled_threshold_days)
      )::bigint as stalled_learners,
      count(*) filter (
        where p.progress_state <> 'completed'
          and p.last_activity_at is null
      )::bigint as unknown_activity_count,
      round(avg(p.percent_complete), 2) as average_percent_complete,
      max(p.last_activity_at) as last_activity_at
    from progress p
    group by p.course_id
  ),
  range_activity as (
    select
      lp.course_id,
      count(*) filter (
        where lp.completed_at >= win.window_start
          and lp.completed_at < win.window_end
      )::bigint as lessons_completed_in_range,
      count(distinct lp.user_id) filter (
        where lp.last_activity_at >= win.window_start
          and lp.last_activity_at < win.window_end
      )::bigint as active_learners_in_range
    from public.lesson_progress lp
    where lp.tenant_id = caller.tenant_id
      and lp.deleted_at is null
    group by lp.course_id
  ),
  ranked as (
    select
      pr.*,
      row_number() over (
        order by pr.learners_with_progress desc, pr.course_id
      ) as course_rank
    from progress_rollup pr
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'courseId', r.course_id,
          'courseTitle', co.title,
          'courseStatus', co.status,
          'learnersWithProgress', r.learners_with_progress,
          'learnersStarted', r.learners_started,
          'learnersInProgress', r.learners_in_progress,
          'learnersBlocked', r.learners_blocked,
          'learnersCompleted', r.learners_completed,
          'completionRateOfStarted', case
            when r.learners_started = 0 then null
            else round(
              r.learners_completed::numeric / r.learners_started,
              4
            )
          end,
          'averagePercentComplete', r.average_percent_complete,
          'stalledLearners', r.stalled_learners,
          'learnersWithUnknownActivity', r.unknown_activity_count,
          'lessonsCompletedInRange',
            coalesce(ra.lessons_completed_in_range, 0),
          'activeLearnersInRange',
            coalesce(ra.active_learners_in_range, 0),
          'lastActivityAt', r.last_activity_at
        )
        order by r.course_rank
      ) filter (where r.course_rank <= course_limit),
      '[]'::jsonb
    ),
    count(*) filter (where r.course_rank > course_limit)::bigint
  into courses_json, omitted_courses
  from ranked r
  join public.courses co
    on co.tenant_id = caller.tenant_id
   and co.course_id = r.course_id
  left join range_activity ra on ra.course_id = r.course_id;

  if omitted_courses > 0 then
    funnel_limitations := funnel_limitations || (
      'Only the top ' || course_limit::text ||
      ' courses by learners with a progress record are returned; ' ||
      omitted_courses::text || ' further course(s) are omitted.'
    );
  end if;
  if unknown_activity_learners > 0 then
    funnel_limitations := funnel_limitations || (
      unknown_activity_learners::text ||
      ' incomplete progress record(s) have no last activity timestamp, so ' ||
      'they are reported as unknown activity and never counted as stalled.'
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
      'courses', course_limit,
      'truncated', omitted_courses > 0
    ),
    'stalledThresholdDays', stalled_threshold_days,
    'definitions', jsonb_build_object(
      'learnerStarted',
      'A public.student_progress row for the course whose progress_state is ' ||
      'not not_started.',
      'stalledLearner',
      'An in-progress or blocked learner whose recorded last_activity_at is ' ||
      'older than ' || stalled_threshold_days::text ||
      ' days before the end of the range.',
      'lessonsCompletedInRange',
      'public.lesson_progress rows whose completed_at falls inside the range.'
    ),
    'metrics', jsonb_build_object(
      'courseFunnel', app_private.analytics_metric(
        'partial',
        jsonb_build_object(
          'courses', coalesce(courses_json, '[]'::jsonb),
          'omittedCourses', omitted_courses,
          'learnersWithUnknownActivity', unknown_activity_learners
        ),
        data_through,
        evidence,
        to_jsonb(funnel_limitations)
      ),
      'courseCompletionTiming', app_private.analytics_metric(
        'unknown',
        null,
        null,
        evidence,
        jsonb_build_array(
          'public.student_progress records no course completion timestamp, ' ||
          'so completions cannot be attributed to a time bucket.',
          'The learning.course_completed usage event exists in the ' ||
          'taxonomy but is not emitted by the console today, so no durable ' ||
          'completion timeline can be reconstructed.'
        )
      )
    )
  );
end;
$$;

revoke all on function public.analytics_tenant_overview(
  timestamptz, timestamptz
) from public, anon, service_role;
revoke all on function public.analytics_question_distribution(
  timestamptz, timestamptz
) from public, anon, service_role;
revoke all on function public.analytics_answer_quality(
  timestamptz, timestamptz
) from public, anon, service_role;
revoke all on function public.analytics_learner_progress(
  timestamptz, timestamptz
) from public, anon, service_role;

grant execute on function public.analytics_tenant_overview(
  timestamptz, timestamptz
) to authenticated;
grant execute on function public.analytics_question_distribution(
  timestamptz, timestamptz
) to authenticated;
grant execute on function public.analytics_answer_quality(
  timestamptz, timestamptz
) to authenticated;
grant execute on function public.analytics_learner_progress(
  timestamptz, timestamptz
) to authenticated;

commit;

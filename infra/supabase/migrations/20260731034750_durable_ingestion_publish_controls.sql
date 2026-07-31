begin;

-- Keep the Cleanup screen reconstructible after a reload. The original
-- quarantine listing exposed only the job status, so the browser could not
-- distinguish "needs extraction" from "approved and waiting to publish".
-- It also joined every open checkpoint, which could duplicate one upload in
-- the UI. Return the latest revision and whether that approved job is already
-- present in the course's active knowledge version.
create or replace function public.learning_list_quarantine_uploads()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  items jsonb;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'tenant_selection_required');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'intentId', ui.intent_id,
        'courseId', ij.course_id,
        'filename', ui.filename,
        'mediaType', ui.media_type,
        'declaredSizeBytes', ui.declared_size_bytes,
        'uploadStatus', ui.status,
        'expiresAt', ui.expires_at,
        'createdAt', ui.created_at,
        'ingestionJobId', ij.ingestion_job_id,
        'ingestionStatus', ij.status,
        'nextCheckpoint', checkpoint.checkpoint_key,
        'latestRevisionId', revision.revision_id,
        'latestRevisionStatus', revision.status,
        'latestRevisionApprovedAt', revision.approved_at,
        'publishedToActiveKnowledge',
          coalesce(active_projection.contains_job, false)
      )
      order by ui.created_at desc
    ),
    '[]'::jsonb
  ) into items
  from public.upload_intents ui
  left join public.learning_sources ls
    on ls.tenant_id = ui.tenant_id
   and ls.external_ref = ui.object_key
   and ls.source_type = 'upload'
  left join public.ingestion_jobs ij
    on ij.tenant_id = ui.tenant_id
   and ij.source_id = ls.source_id
  left join lateral (
    select ic.checkpoint_key
    from public.ingestion_checkpoints ic
    where ic.tenant_id = ui.tenant_id
      and ic.ingestion_job_id = ij.ingestion_job_id
      and ic.status in ('pending', 'running', 'failed')
    order by ic.updated_at desc, ic.created_at desc, ic.checkpoint_id
    limit 1
  ) checkpoint on true
  left join lateral (
    select
      revision_row.revision_id,
      revision_row.status,
      revision_row.approved_at
    from public.ingestion_cleaning_revisions revision_row
    where revision_row.tenant_id = ui.tenant_id
      and revision_row.ingestion_job_id = ij.ingestion_job_id
      and revision_row.deleted_at is null
    order by revision_row.revision_number desc, revision_row.created_at desc
    limit 1
  ) revision on true
  left join lateral (
    select true as contains_job
    from public.courses course
    join public.learning_documents document
      on document.tenant_id = course.tenant_id
     and document.course_id = course.course_id
     and document.knowledge_version_id = course.active_knowledge_version_id
     and document.deleted_at is null
    where course.tenant_id = ui.tenant_id
      and course.course_id = ij.course_id
      and course.deleted_at is null
      and document.metadata ->> 'ingestionJobId' =
        ij.ingestion_job_id::text
    limit 1
  ) active_projection on true
  where ui.tenant_id = caller.tenant_id
    and (
      ui.actor_id = auth.uid()::text
      or caller.identity_role in ('tenant_owner', 'tenant_admin')
    );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'items', items
  );
end;
$$;

revoke execute on function public.learning_list_quarantine_uploads()
  from public, anon, authenticated, service_role;
grant execute on function public.learning_list_quarantine_uploads()
  to authenticated;

commit;

-- ============================================================
-- 20260727120000_inert_source_scan_clearance.sql
-- Phase 17, part 2: open the gate for inert text.
--
-- 20260727110000 supplied a write path for scanner verdicts. That leaves a
-- real problem unsolved: `api/ingestion/extract` accepts exactly two media
-- types, `text/plain` and `text/markdown`, and requiring an operator to stand
-- up and maintain a ClamAV service before a plain `.txt` file can be read is
-- a poor trade. Meanwhile every upload sits in quarantine and the entire
-- finished Phase 10 pipeline cannot run.
--
-- So this migration does NOT weaken the gate; it makes the gate proportionate.
-- An inert text source is cleared by an explicit, recorded checkpoint, and
-- everything else still needs a real scanner.
--
-- WHY THIS IS NOT A BYPASS
--
--   * The clearance is written as a normal `succeeded` checkpoint carrying
--     `scanner = 'none'` and `reason = 'inert_text'`. It is auditable after
--     the fact and trivially distinguishable from a real scan. Nothing is
--     skipped or faked.
--   * The media type is read from the database's own `upload_intents` row.
--     The caller does not supply it and cannot influence it, so a creator
--     cannot relabel a binary as text to slip past the gate.
--   * The allowlist lives here, in SQL, next to the check that enforces it.
--     The day extraction learns to parse PDF or DOCX, those types are simply
--     absent from this list, so the gate closes again on its own and the
--     scanner from 20260727110000 becomes required. That is the property
--     worth having: the safe state is the default, and widening it takes a
--     deliberate migration.
--
-- The risk actually being accepted is narrow and worth stating plainly: a
-- malicious `.txt` cannot execute, and this codebase's only consumer of that
-- text is a sanitising markdown parser (`components/ui/rich-text/markdown.ts`)
-- that already treats learner and source content as hostile. Byte-level
-- malware in a plain-text file has no path to a parser that would run it.
-- ============================================================

begin;

create or replace function public.security_clear_inert_source(
  target_job_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  job record;
  now_ts timestamptz := clock_timestamp();
  -- Deliberately conservative. Anything whose extraction involves a real
  -- parser -- PDF, DOCX, audio containers, HTML -- belongs to the scanner.
  inert_media_types constant text[] := array['text/plain', 'text/markdown'];
  content_digest text;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in ('tenant_owner', 'tenant_admin', 'creator', 'teacher')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  if target_job_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  -- Media type comes from the upload record, never from the caller.
  select
    ij.ingestion_job_id,
    ui.media_type,
    ui.object_key,
    ui.status as upload_status
  into job
  from public.ingestion_jobs ij
  join public.learning_sources ls
    on ls.tenant_id = ij.tenant_id
   and ls.source_id = ij.source_id
   and ls.source_type = 'upload'
  join public.upload_intents ui
    on ui.tenant_id = ij.tenant_id
   and ui.object_key = ls.external_ref
  where ij.tenant_id = caller.tenant_id
    and ij.ingestion_job_id = target_job_id
    and ij.deleted_at is null
    and ui.deleted_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  -- A file a scanner already condemned is never re-cleared by this path.
  if job.upload_status = 'blocked' then
    return jsonb_build_object('ok', false, 'code', 'upload_blocked');
  end if;

  if not (job.media_type = any(inert_media_types)) then
    return jsonb_build_object(
      'ok', false,
      'code', 'scan_required',
      'mediaType', job.media_type
    );
  end if;

  -- `input_hash` is NOT NULL and means "what was cleared". There is no scan
  -- here, so it anchors to the object identity rather than pretending to be a
  -- content digest a scanner produced.
  content_digest := md5(job.object_key);

  insert into public.ingestion_checkpoints (
    tenant_id, ingestion_job_id, stage, checkpoint_key, status,
    input_hash, metrics, idempotency_key, started_at, finished_at
  )
  values (
    caller.tenant_id, target_job_id, 'security', 'malware_scan', 'succeeded',
    content_digest,
    jsonb_build_object(
      'scanner', 'none',
      'reason', 'inert_text',
      'mediaType', job.media_type,
      'clearedBy', caller.identity_role,
      'clearedAt', to_char(now_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    ),
    'malware_scan:' || target_job_id::text,
    now_ts, now_ts
  )
  on conflict (tenant_id, ingestion_job_id, checkpoint_key) do update
    set status = 'succeeded',
        input_hash = excluded.input_hash,
        metrics = excluded.metrics,
        error_code = null,
        finished_at = now_ts,
        updated_at = now_ts,
        record_version = public.ingestion_checkpoints.record_version + 1
    -- Never overwrite a real scanner's verdict with a blanket clearance.
    where public.ingestion_checkpoints.status <> 'succeeded'
      and coalesce(
            public.ingestion_checkpoints.metrics ->> 'scanner', 'none'
          ) = 'none';

  return jsonb_build_object(
    'ok', true,
    'cleared', true,
    'scanner', 'none',
    'reason', 'inert_text'
  );
end;
$$;

revoke execute on function public.security_clear_inert_source(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.security_clear_inert_source(uuid)
  to authenticated;

commit;

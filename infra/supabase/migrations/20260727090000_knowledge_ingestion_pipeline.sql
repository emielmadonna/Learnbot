-- Knowledge pipeline (docs/PLAN.md Section 4). Uploads land in quarantine
-- and stop there permanently today: `upload_intents.status` never leaves
-- 'quarantined' and nothing extracts, cleans, reviews or publishes a file.
-- This migration adds stages 2-5 (extract, clean, review, publish) for the
-- one file type taken end to end in this pass: plain-text and markdown
-- transcript uploads, the case that makes the cleaning module (the reason
-- this phase exists) matter. PDF figure extraction and audio transcription
-- are explicitly out of scope here (Phase 11 and a later upload media type).
--
-- Stage 5 (Publish) projects into the exact same three tables authored
-- content already uses — `knowledge_versions` / `learning_documents` /
-- `learning_chunks` — via a new projector,
-- `app_private.knowledge_project_ingested_course`, that mirrors
-- `app_private.knowledge_project_course` (20260726095000) block for block:
-- same chunking helpers (`knowledge_normalize_text` / `knowledge_split_text`
-- / `knowledge_pack_chunks`), same version/retire/reuse-embedding
-- discipline, same "do not silently clobber the other pipeline's active
-- version" rule (an authored projection defers to imported knowledge unless
-- told to replace it; this one defers to authored knowledge the same way).
-- Stage 6 (Serve) needs no new code: `learning_search_chunks` and the hybrid
-- retrieval RPCs already read `learning_chunks` generically, with no filter
-- on `source_manifest.kind`.
--
-- Security note: extraction reads and stores the uploaded file's raw bytes
-- as text. `0026_authenticated_quarantine_uploads.sql` already states the
-- rule this respects: "no file is promoted or parsed before a malware
-- worker clears it." `learning_ingestion_record_extraction` below enforces
-- that the `security` / `malware_scan` checkpoint is `succeeded` before it
-- will store anything — this repository ships no scanner, so that gate
-- stays closed until one exists, exactly matching the honest "no ingestion
-- worker is running" state the console already reports.

begin;

-- ---------------------------------------------------------------------------
-- Stage 2 (Extract) durable output.
-- ---------------------------------------------------------------------------

create table public.ingestion_extractions (
  extraction_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  course_id uuid not null,
  source_id uuid not null,
  ingestion_job_id uuid not null,
  extractor text not null check (extractor in ('plain_text_transcript_v1')),
  extractor_version integer not null default 1 check (extractor_version > 0),
  media_type text not null check (media_type in ('text/plain', 'text/markdown')),
  raw_text text not null check (length(raw_text) between 1 and 4000000),
  -- Each element: {"offset": int, "kind": "heading"|"timestamp"|"speaker",
  -- "value": text, "line": int}. Offsets are into raw_text and never change
  -- once written — cleaning revisions carry their own map back to them.
  source_locations jsonb not null default '[]'::jsonb
    check (jsonb_typeof(source_locations) = 'array'),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, course_id)
    references public.courses(tenant_id, course_id),
  foreign key (tenant_id, source_id, course_id)
    references public.learning_sources(tenant_id, source_id, course_id),
  foreign key (tenant_id, ingestion_job_id)
    references public.ingestion_jobs(tenant_id, ingestion_job_id),
  unique (tenant_id, extraction_id),
  -- One extraction per job: re-running extraction on the same job refreshes
  -- this row in place (resumable, not a new fork) since the underlying
  -- object is fixed once uploaded.
  unique (tenant_id, ingestion_job_id),
  unique (tenant_id, idempotency_key),
  check (deleted_at is null)
);
create index ingestion_extractions_course_idx
  on public.ingestion_extractions (tenant_id, course_id, source_id);

create or replace function app_private.protect_ingestion_extraction_update()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.tenant_id is distinct from old.tenant_id
    or new.extraction_id is distinct from old.extraction_id
    or new.course_id is distinct from old.course_id
    or new.source_id is distinct from old.source_id
    or new.ingestion_job_id is distinct from old.ingestion_job_id
    or new.created_at is distinct from old.created_at
    or new.idempotency_key is distinct from old.idempotency_key
    or new.record_version <> old.record_version + 1
    or new.updated_at < old.updated_at
  then
    raise exception 'ingestion extraction identity is immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger ingestion_extractions_protect_update
before update on public.ingestion_extractions
for each row execute function app_private.protect_ingestion_extraction_update();
create trigger ingestion_extractions_reject_delete
before delete on public.ingestion_extractions
for each row execute function app_private.reject_mutation();

alter table public.ingestion_extractions enable row level security;
alter table public.ingestion_extractions force row level security;
create policy ingestion_extractions_deny_authenticated
  on public.ingestion_extractions for all to authenticated
  using (false) with check (false);
revoke all on table public.ingestion_extractions from anon, authenticated, service_role;
revoke execute on function app_private.protect_ingestion_extraction_update()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Stage 3 (Clean) durable output. NON-DESTRUCTIVE: a cleaning run always
-- inserts a new revision_number rather than rewriting cleaned_text on an
-- existing row, so the original (ingestion_extractions.raw_text) is always
-- recoverable and every prior attempt stays inspectable.
-- ---------------------------------------------------------------------------

create table public.ingestion_cleaning_revisions (
  revision_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  extraction_id uuid not null,
  ingestion_job_id uuid not null,
  revision_number integer not null check (revision_number > 0),
  cleaner_version integer not null default 1 check (cleaner_version > 0),
  cleaned_text text not null check (length(cleaned_text) <= 4000000),
  -- Ordered log a creator can read: [{"step": "disfluencies", "removals":
  -- [{"rawStart","rawEnd","originalText","replacementText","reason"}, ...]}, ...]
  steps jsonb not null default '[]'::jsonb check (jsonb_typeof(steps) = 'array'),
  -- Raw-vs-cleaned diff for the review UI: [{"op","rawText","cleanedText"}, ...]
  diff jsonb not null default '[]'::jsonb check (jsonb_typeof(diff) = 'array'),
  -- Cleaned-text offset -> raw-text offset breakpoints: [{"at","rawAt"}, ...].
  -- This is what lets a citation survive every cleaning step back to a real
  -- offset in the uploaded file.
  offset_map jsonb not null default '[]'::jsonb check (jsonb_typeof(offset_map) = 'array'),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending_review'
    check (status in ('pending_review', 'approved', 'edited_approved', 'superseded')),
  edited_text text check (edited_text is null or length(edited_text) between 1 and 4000000),
  approved_by uuid,
  approved_at timestamptz,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, extraction_id)
    references public.ingestion_extractions(tenant_id, extraction_id),
  foreign key (tenant_id, ingestion_job_id)
    references public.ingestion_jobs(tenant_id, ingestion_job_id),
  unique (tenant_id, revision_id),
  unique (tenant_id, ingestion_job_id, revision_number),
  unique (tenant_id, idempotency_key),
  check (deleted_at is null),
  -- Nothing reaches students unreviewed: approval facts are only set
  -- together, and only once, by the same transition.
  check (
    (
      status = 'edited_approved'
      and edited_text is not null and approved_by is not null and approved_at is not null
    )
    or (
      status = 'approved'
      and edited_text is null and approved_by is not null and approved_at is not null
    )
    or (
      status in ('pending_review', 'superseded')
      and approved_by is null and approved_at is null
    )
  )
);
create index ingestion_cleaning_revisions_job_idx
  on public.ingestion_cleaning_revisions (tenant_id, ingestion_job_id, revision_number desc);
create index ingestion_cleaning_revisions_pending_idx
  on public.ingestion_cleaning_revisions (tenant_id, status, created_at desc)
  where status = 'pending_review';

create or replace function app_private.protect_ingestion_cleaning_revision_update()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.tenant_id is distinct from old.tenant_id
    or new.revision_id is distinct from old.revision_id
    or new.extraction_id is distinct from old.extraction_id
    or new.ingestion_job_id is distinct from old.ingestion_job_id
    or new.revision_number is distinct from old.revision_number
    or new.cleaner_version is distinct from old.cleaner_version
    or new.cleaned_text is distinct from old.cleaned_text
    or new.steps is distinct from old.steps
    or new.diff is distinct from old.diff
    or new.offset_map is distinct from old.offset_map
    or new.content_hash is distinct from old.content_hash
    or new.created_at is distinct from old.created_at
    or new.idempotency_key is distinct from old.idempotency_key
    or new.record_version <> old.record_version + 1
    or new.updated_at < old.updated_at
    or (old.status <> 'pending_review' and new.status is distinct from old.status)
    or (
      old.status = 'pending_review'
      and new.status not in ('pending_review', 'approved', 'edited_approved', 'superseded')
    )
  then
    raise exception 'cleaning revision identity and approved facts are immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger ingestion_cleaning_revisions_protect_update
before update on public.ingestion_cleaning_revisions
for each row execute function app_private.protect_ingestion_cleaning_revision_update();
create trigger ingestion_cleaning_revisions_reject_delete
before delete on public.ingestion_cleaning_revisions
for each row execute function app_private.reject_mutation();

alter table public.ingestion_cleaning_revisions enable row level security;
alter table public.ingestion_cleaning_revisions force row level security;
create policy ingestion_cleaning_revisions_deny_authenticated
  on public.ingestion_cleaning_revisions for all to authenticated
  using (false) with check (false);
revoke all on table public.ingestion_cleaning_revisions from anon, authenticated, service_role;
revoke execute on function app_private.protect_ingestion_cleaning_revision_update()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Boilerplate memory: cross-upload repetition counts scoped to one creator's
-- own library (`actor_id` is always `auth.uid()`, enforced only in the RPCs
-- below — never a client-supplied value). This is the entire mechanism
-- behind "detected by repetition ... not a hardcoded list": a paragraph
-- only becomes removable once it has been seen this many times before, for
-- this creator, verbatim.
-- ---------------------------------------------------------------------------

create table public.ingestion_boilerplate_shingles (
  tenant_id uuid not null references public.tenants(tenant_id),
  actor_id text not null check (length(actor_id) between 1 and 512),
  shingle_hash text not null check (shingle_hash ~ '^[0-9a-f]{64}$'),
  occurrence_count integer not null default 1 check (occurrence_count > 0),
  distinct_extraction_count integer not null default 1 check (distinct_extraction_count > 0),
  sample_text text check (sample_text is null or length(sample_text) <= 400),
  first_seen_extraction_id uuid,
  last_seen_extraction_id uuid,
  record_version bigint not null default 1 check (record_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, actor_id, shingle_hash)
);

alter table public.ingestion_boilerplate_shingles enable row level security;
alter table public.ingestion_boilerplate_shingles force row level security;
create policy ingestion_boilerplate_shingles_deny_authenticated
  on public.ingestion_boilerplate_shingles for all to authenticated
  using (false) with check (false);
revoke all on table public.ingestion_boilerplate_shingles from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Provenance helpers used only by the publish-stage projector below. Owned
-- by the same role as every other app_private helper, so — exactly like
-- app_private.knowledge_split_text and friends in 20260726095000 — the
-- revokes below block direct calls from any role without blocking the
-- projector, which runs SECURITY DEFINER as that same owning role.
-- ---------------------------------------------------------------------------

-- Raw-text offset for `cleaned_offset`, walking the same breakpoint shape
-- `apps/console/src/lib/ingestion/text-edits.ts` (`mapToRaw`) produces:
-- the last breakpoint at or before the position, plus the identity delta.
create or replace function app_private.knowledge_map_offset(
  offset_map jsonb,
  cleaned_offset integer
)
returns integer
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select coalesce(
    (
      select (bp.value ->> 'rawAt')::integer
        + greatest(cleaned_offset - (bp.value ->> 'at')::integer, 0)
      from jsonb_array_elements(coalesce(offset_map, '[]'::jsonb)) as bp(value)
      where jsonb_typeof(bp.value -> 'at') = 'number'
        and jsonb_typeof(bp.value -> 'rawAt') = 'number'
        and (bp.value ->> 'at')::integer <= cleaned_offset
      order by (bp.value ->> 'at')::integer desc
      limit 1
    ),
    cleaned_offset
  );
$$;

-- The most recent heading/timestamp/speaker anchor at or before raw_offset.
create or replace function app_private.knowledge_nearest_source_location(
  source_locations jsonb,
  raw_offset integer
)
returns jsonb
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select loc.value
  from jsonb_array_elements(coalesce(source_locations, '[]'::jsonb)) as loc(value)
  where jsonb_typeof(loc.value -> 'offset') = 'number'
    and (loc.value ->> 'offset')::integer <= raw_offset
  order by (loc.value ->> 'offset')::integer desc
  limit 1;
$$;

revoke execute on function app_private.knowledge_map_offset(jsonb, integer)
  from public, anon, authenticated, service_role;
revoke execute on function app_private.knowledge_nearest_source_location(jsonb, integer)
  from public, anon, authenticated, service_role;

-- Append-only ingestion-pipeline audit trail, mirroring
-- app_private.authoring_append_audit's shape with resource_type
-- 'ingestion_job' instead of 'course'.
create or replace function app_private.ingestion_append_audit(
  target_tenant_id uuid,
  caller_identity_role text,
  audit_action text,
  target_resource_id text,
  change_ref text
)
returns void
language sql
security definer
set search_path = pg_catalog
as $$
  insert into public.audit_ledger (
    tenant_id, actor_id, actor_type, actor_role, action, resource_type,
    resource_id, policy_decision, decision_reason, change_ref, request_id,
    trace_id, idempotency_key, retain_until
  ) values (
    target_tenant_id,
    auth.uid(),
    case
      when caller_identity_role in ('tenant_owner', 'tenant_admin') then 'owner'
      else 'creator'
    end,
    caller_identity_role,
    audit_action,
    'ingestion_job',
    target_resource_id,
    'allow',
    'authenticated_ingestion_pipeline',
    change_ref,
    'ingestion:' || target_resource_id || ':' || audit_action,
    'ingestion:' || target_resource_id || ':' || audit_action,
    'ingestion-audit:' || gen_random_uuid()::text,
    now() + interval '2555 days'
  );
$$;

revoke execute on function app_private.ingestion_append_audit(uuid, text, text, text, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Stage 2 (Extract) RPC. Called by the console after downloading the
-- quarantined object with the creator's own authenticated storage session
-- and running the extractor client-side of the database
-- (apps/console/src/lib/ingestion/extract.ts) — this RPC only persists the
-- result and advances the checkpoint.
-- ---------------------------------------------------------------------------

create or replace function public.learning_ingestion_record_extraction(
  target_job_id uuid,
  requested_extractor text,
  requested_extractor_version integer,
  requested_media_type text,
  requested_raw_text text,
  requested_source_locations jsonb,
  requested_content_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  job record;
  extraction_id uuid;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in ('tenant_owner', 'tenant_admin', 'creator', 'teacher')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  if requested_extractor <> 'plain_text_transcript_v1'
    or requested_extractor_version is null or requested_extractor_version < 1
    or requested_media_type not in ('text/plain', 'text/markdown')
    or length(coalesce(requested_raw_text, '')) not between 1 and 4000000
    or jsonb_typeof(coalesce(requested_source_locations, 'null'::jsonb)) <> 'array'
    or requested_content_hash !~ '^[0-9a-f]{64}$'
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select
    ij.tenant_id, ij.course_id, ij.source_id,
    ui.actor_id,
    ic.status as scan_status
  into job
  from public.ingestion_jobs ij
  join public.learning_sources ls
    on ls.tenant_id = ij.tenant_id and ls.source_id = ij.source_id
  left join public.upload_intents ui
    on ui.tenant_id = ij.tenant_id and ui.object_key = ls.external_ref
   and ls.source_type = 'upload'
  left join public.ingestion_checkpoints ic
    on ic.tenant_id = ij.tenant_id and ic.ingestion_job_id = ij.ingestion_job_id
   and ic.stage = 'security' and ic.checkpoint_key = 'malware_scan'
  where ij.tenant_id = caller.tenant_id
    and ij.ingestion_job_id = target_job_id
    and ij.deleted_at is null;

  if not found
    or job.actor_id is null
    or (
      job.actor_id <> auth.uid()::text
      and caller.identity_role not in ('tenant_owner', 'tenant_admin')
    )
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  -- 0026_authenticated_quarantine_uploads.sql: "no file is promoted or
  -- parsed before a malware worker clears it." Extraction reads and stores
  -- the file's content, so it is gated exactly like promotion is.
  if coalesce(job.scan_status, 'pending') <> 'succeeded' then
    return jsonb_build_object('ok', false, 'code', 'security_scan_pending');
  end if;

  insert into public.ingestion_extractions (
    tenant_id, course_id, source_id, ingestion_job_id, extractor,
    extractor_version, media_type, raw_text, source_locations, content_hash,
    idempotency_key
  ) values (
    caller.tenant_id, job.course_id, job.source_id, target_job_id,
    requested_extractor, requested_extractor_version, requested_media_type,
    requested_raw_text, requested_source_locations, requested_content_hash,
    'ingestion-extraction:' || target_job_id::text
  )
  on conflict (tenant_id, ingestion_job_id) do update set
    raw_text = excluded.raw_text,
    source_locations = excluded.source_locations,
    content_hash = excluded.content_hash,
    media_type = excluded.media_type,
    extractor_version = excluded.extractor_version,
    updated_at = now(),
    record_version = public.ingestion_extractions.record_version + 1
  returning ingestion_extractions.extraction_id into extraction_id;

  insert into public.ingestion_checkpoints (
    tenant_id, ingestion_job_id, stage, checkpoint_key, status,
    input_hash, output_hash, started_at, finished_at, idempotency_key
  ) values (
    caller.tenant_id, target_job_id, 'extract', 'raw_text', 'succeeded',
    requested_content_hash, requested_content_hash, now(), now(),
    'ingestion-extract-checkpoint:' || target_job_id::text
  )
  on conflict (tenant_id, ingestion_job_id, checkpoint_key) do update set
    status = 'succeeded',
    output_hash = excluded.output_hash,
    input_hash = excluded.input_hash,
    finished_at = now(),
    updated_at = now(),
    record_version = public.ingestion_checkpoints.record_version + 1;

  update public.ingestion_jobs
  set status = 'running',
      started_at = coalesce(started_at, now()),
      updated_at = now(),
      record_version = record_version + 1
  where tenant_id = caller.tenant_id
    and ingestion_job_id = target_job_id
    and status in ('queued', 'waiting');

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'jobId', target_job_id,
    'extractionId', extraction_id,
    'contentHash', requested_content_hash,
    'sourceLocationCount', jsonb_array_length(requested_source_locations)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Reads the calling creator's own boilerplate memory for a batch of
-- candidate paragraph hashes. Always scoped to auth.uid(): a client cannot
-- ask for another creator's counts by passing a different actor id, because
-- there is no actor-id parameter to pass.
-- ---------------------------------------------------------------------------

create or replace function public.learning_ingestion_boilerplate_shingles(
  candidate_hashes text[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  counts jsonb;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in ('tenant_owner', 'tenant_admin', 'creator', 'teacher')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  if candidate_hashes is null
    or array_length(candidate_hashes, 1) is null
    or array_length(candidate_hashes, 1) > 500
  then
    return jsonb_build_object('ok', true, 'dataMode', 'durable', 'counts', '{}'::jsonb);
  end if;

  select coalesce(jsonb_object_agg(s.shingle_hash, s.occurrence_count), '{}'::jsonb)
  into counts
  from public.ingestion_boilerplate_shingles s
  where s.tenant_id = caller.tenant_id
    and s.actor_id = auth.uid()::text
    and s.shingle_hash = any(candidate_hashes);

  return jsonb_build_object('ok', true, 'dataMode', 'durable', 'counts', counts);
end;
$$;

-- ---------------------------------------------------------------------------
-- Stage 3 (Clean) RPC. Always inserts a new revision — never updates an
-- existing one's text — so the raw text and every earlier cleaning attempt
-- stay recoverable.
-- ---------------------------------------------------------------------------

create or replace function public.learning_ingestion_record_cleaning(
  target_job_id uuid,
  requested_cleaner_version integer,
  requested_cleaned_text text,
  requested_steps jsonb,
  requested_diff jsonb,
  requested_offset_map jsonb,
  requested_content_hash text,
  requested_shingle_updates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  extraction record;
  next_revision integer;
  new_revision_id uuid;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in ('tenant_owner', 'tenant_admin', 'creator', 'teacher')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  if requested_cleaner_version is null or requested_cleaner_version < 1
    or requested_cleaned_text is null or length(requested_cleaned_text) > 4000000
    or jsonb_typeof(coalesce(requested_steps, 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(requested_diff, 'null'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(requested_offset_map, 'null'::jsonb)) <> 'array'
    or requested_content_hash !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(coalesce(requested_shingle_updates, 'null'::jsonb)) <> 'array'
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select ie.extraction_id, ie.content_hash
  into extraction
  from public.ingestion_extractions ie
  join public.ingestion_jobs ij
    on ij.tenant_id = ie.tenant_id and ij.ingestion_job_id = ie.ingestion_job_id
  join public.learning_sources ls
    on ls.tenant_id = ij.tenant_id and ls.source_id = ij.source_id
  left join public.upload_intents ui
    on ui.tenant_id = ij.tenant_id and ui.object_key = ls.external_ref
   and ls.source_type = 'upload'
  where ie.tenant_id = caller.tenant_id
    and ie.ingestion_job_id = target_job_id
    and (
      ui.actor_id = auth.uid()::text
      or caller.identity_role in ('tenant_owner', 'tenant_admin')
    );
  if not found then
    return jsonb_build_object('ok', false, 'code', 'extraction_not_found');
  end if;

  select coalesce(max(r.revision_number), 0) + 1
  into next_revision
  from public.ingestion_cleaning_revisions r
  where r.tenant_id = caller.tenant_id and r.ingestion_job_id = target_job_id;

  update public.ingestion_cleaning_revisions
  set status = 'superseded', updated_at = now(), record_version = record_version + 1
  where tenant_id = caller.tenant_id
    and ingestion_job_id = target_job_id
    and status = 'pending_review';

  insert into public.ingestion_cleaning_revisions (
    tenant_id, extraction_id, ingestion_job_id, revision_number,
    cleaner_version, cleaned_text, steps, diff, offset_map, content_hash,
    status, idempotency_key
  ) values (
    caller.tenant_id, extraction.extraction_id, target_job_id, next_revision,
    requested_cleaner_version, requested_cleaned_text, requested_steps,
    requested_diff, requested_offset_map, requested_content_hash,
    'pending_review',
    'ingestion-cleaning:' || target_job_id::text || ':' || next_revision::text
  )
  returning ingestion_cleaning_revisions.revision_id into new_revision_id;

  -- Grow this creator's boilerplate memory with every candidate paragraph
  -- this document contributed, whether or not any of them crossed the
  -- removal threshold this time.
  insert into public.ingestion_boilerplate_shingles (
    tenant_id, actor_id, shingle_hash, occurrence_count,
    distinct_extraction_count, sample_text, first_seen_extraction_id,
    last_seen_extraction_id
  )
  select
    caller.tenant_id,
    auth.uid()::text,
    candidate."shingleHash",
    1,
    1,
    left(coalesce(candidate."sampleText", ''), 400),
    extraction.extraction_id,
    extraction.extraction_id
  from jsonb_to_recordset(requested_shingle_updates)
    as candidate("shingleHash" text, "sampleText" text)
  where candidate."shingleHash" ~ '^[0-9a-f]{64}$'
  on conflict (tenant_id, actor_id, shingle_hash) do update set
    occurrence_count = public.ingestion_boilerplate_shingles.occurrence_count + 1,
    distinct_extraction_count = case
      when public.ingestion_boilerplate_shingles.last_seen_extraction_id
        is distinct from excluded.last_seen_extraction_id
      then public.ingestion_boilerplate_shingles.distinct_extraction_count + 1
      else public.ingestion_boilerplate_shingles.distinct_extraction_count
    end,
    last_seen_extraction_id = excluded.last_seen_extraction_id,
    updated_at = now(),
    record_version = public.ingestion_boilerplate_shingles.record_version + 1;

  insert into public.ingestion_checkpoints (
    tenant_id, ingestion_job_id, stage, checkpoint_key, status,
    input_hash, output_hash, started_at, finished_at, idempotency_key
  ) values (
    caller.tenant_id, target_job_id, 'clean', 'cleaning_revision', 'succeeded',
    extraction.content_hash, requested_content_hash, now(), now(),
    'ingestion-clean-checkpoint:' || target_job_id::text
  )
  on conflict (tenant_id, ingestion_job_id, checkpoint_key) do update set
    status = 'succeeded',
    output_hash = excluded.output_hash,
    input_hash = excluded.input_hash,
    finished_at = now(),
    updated_at = now(),
    record_version = public.ingestion_checkpoints.record_version + 1;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'jobId', target_job_id,
    'revisionId', new_revision_id,
    'revisionNumber', next_revision,
    'status', 'pending_review'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Stage 4 (Review) RPCs.
-- ---------------------------------------------------------------------------

create or replace function public.learning_ingestion_review_queue()
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
  if not found
    or caller.identity_role not in ('tenant_owner', 'tenant_admin', 'creator', 'teacher')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'jobId', ij.ingestion_job_id,
        'courseId', ij.course_id,
        'sourceId', ij.source_id,
        'filename', ui.filename,
        'mediaType', ui.media_type,
        'revisionId', rev.revision_id,
        'revisionNumber', rev.revision_number,
        'status', rev.status,
        'stepCount', jsonb_array_length(rev.steps),
        'createdAt', rev.created_at
      )
      order by rev.created_at desc
    ),
    '[]'::jsonb
  ) into items
  from public.ingestion_cleaning_revisions rev
  join public.ingestion_jobs ij
    on ij.tenant_id = rev.tenant_id and ij.ingestion_job_id = rev.ingestion_job_id
  join public.learning_sources ls
    on ls.tenant_id = ij.tenant_id and ls.source_id = ij.source_id
  left join public.upload_intents ui
    on ui.tenant_id = ij.tenant_id and ui.object_key = ls.external_ref
   and ls.source_type = 'upload'
  where rev.tenant_id = caller.tenant_id
    and rev.status = 'pending_review'
    and rev.deleted_at is null
    and (
      ui.actor_id = auth.uid()::text
      or caller.identity_role in ('tenant_owner', 'tenant_admin')
    );

  return jsonb_build_object('ok', true, 'dataMode', 'durable', 'items', items);
end;
$$;

create or replace function public.learning_ingestion_get_revision(
  target_job_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  extraction record;
  revision record;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in ('tenant_owner', 'tenant_admin', 'creator', 'teacher')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select ie.extraction_id, ie.raw_text, ie.source_locations
  into extraction
  from public.ingestion_extractions ie
  join public.ingestion_jobs ij
    on ij.tenant_id = ie.tenant_id and ij.ingestion_job_id = ie.ingestion_job_id
  join public.learning_sources ls
    on ls.tenant_id = ij.tenant_id and ls.source_id = ij.source_id
  left join public.upload_intents ui
    on ui.tenant_id = ij.tenant_id and ui.object_key = ls.external_ref
   and ls.source_type = 'upload'
  where ie.tenant_id = caller.tenant_id
    and ie.ingestion_job_id = target_job_id
    and (
      ui.actor_id = auth.uid()::text
      or caller.identity_role in ('tenant_owner', 'tenant_admin')
    );
  if not found then
    return jsonb_build_object('ok', false, 'code', 'extraction_not_found');
  end if;

  select r.revision_id, r.revision_number, r.cleaned_text, r.steps, r.diff,
    r.status, r.edited_text, r.approved_at
  into revision
  from public.ingestion_cleaning_revisions r
  where r.tenant_id = caller.tenant_id
    and r.ingestion_job_id = target_job_id
    and r.deleted_at is null
  order by r.revision_number desc
  limit 1;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'jobId', target_job_id,
    'extractionId', extraction.extraction_id,
    'rawText', extraction.raw_text,
    'sourceLocations', extraction.source_locations,
    'revision', case when revision.revision_id is null then null else jsonb_build_object(
      'revisionId', revision.revision_id,
      'revisionNumber', revision.revision_number,
      'cleanedText', revision.cleaned_text,
      'steps', revision.steps,
      'diff', revision.diff,
      'status', revision.status,
      'editedText', revision.edited_text,
      'approvedAt', revision.approved_at
    ) end
  );
end;
$$;

-- The creator sees cleaned beside original with removals highlighted
-- (`revision.diff` / `revision.steps` above) and approves or edits here.
-- Nothing reaches students until this call succeeds.
create or replace function public.learning_ingestion_approve_revision(
  target_job_id uuid,
  target_revision_id uuid,
  requested_edited_text text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  owns_job boolean;
  new_status text;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in ('tenant_owner', 'tenant_admin', 'creator', 'teacher')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  if requested_edited_text is not null
    and length(requested_edited_text) not between 1 and 4000000
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select exists (
    select 1
    from public.ingestion_jobs ij
    join public.learning_sources ls
      on ls.tenant_id = ij.tenant_id and ls.source_id = ij.source_id
    left join public.upload_intents ui
      on ui.tenant_id = ij.tenant_id and ui.object_key = ls.external_ref
     and ls.source_type = 'upload'
    where ij.tenant_id = caller.tenant_id
      and ij.ingestion_job_id = target_job_id
      and (
        ui.actor_id = auth.uid()::text
        or caller.identity_role in ('tenant_owner', 'tenant_admin')
      )
  ) into owns_job;
  if not owns_job then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  new_status := case when requested_edited_text is null then 'approved' else 'edited_approved' end;

  update public.ingestion_cleaning_revisions
  set
    status = new_status,
    edited_text = requested_edited_text,
    approved_by = auth.uid(),
    approved_at = now(),
    updated_at = now(),
    record_version = record_version + 1
  where tenant_id = caller.tenant_id
    and ingestion_job_id = target_job_id
    and revision_id = target_revision_id
    and status = 'pending_review';
  if not found then
    return jsonb_build_object('ok', false, 'code', 'revision_not_pending');
  end if;

  perform app_private.ingestion_append_audit(
    caller.tenant_id,
    caller.identity_role,
    case when new_status = 'approved'
      then 'learning.ingestion.review.approve'
      else 'learning.ingestion.review.approve_edited'
    end,
    target_job_id::text,
    target_revision_id::text
  );

  insert into public.ingestion_checkpoints (
    tenant_id, ingestion_job_id, stage, checkpoint_key, status,
    input_hash, output_hash, started_at, finished_at, idempotency_key
  )
  select
    caller.tenant_id, target_job_id, 'review', 'creator_approval', 'succeeded',
    r.content_hash, r.content_hash, now(), now(),
    'ingestion-review-checkpoint:' || target_job_id::text
  from public.ingestion_cleaning_revisions r
  where r.tenant_id = caller.tenant_id and r.revision_id = target_revision_id
  on conflict (tenant_id, ingestion_job_id, checkpoint_key) do update set
    status = 'succeeded',
    output_hash = excluded.output_hash,
    input_hash = excluded.input_hash,
    finished_at = now(),
    updated_at = now(),
    record_version = public.ingestion_checkpoints.record_version + 1;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'jobId', target_job_id,
    'revisionId', target_revision_id,
    'status', new_status
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Stage 5 (Publish) projector. Reuses the authored path's chunker
-- (app_private.knowledge_split_text / knowledge_pack_chunks /
-- knowledge_normalize_text, unmodified) and its knowledge_versions /
-- learning_documents / learning_chunks lifecycle: build 'building', fill,
-- promote to 'published', then activate — all inside one transaction, so a
-- failure never leaves a course pointed at a half-built version.
-- ---------------------------------------------------------------------------

create or replace function app_private.knowledge_ingested_projection_hash(
  target_tenant_id uuid,
  target_course_id uuid
)
returns text
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select encode(
    extensions.digest(
      'ingested_cleaned_text:v1' || chr(29) ||
      coalesce(
        (
          select string_agg(f.fingerprint, chr(31) order by f.fingerprint)
          from (
            select
              ij.ingestion_job_id::text || chr(30) ||
              r.revision_id::text || chr(30) ||
              r.content_hash || chr(30) ||
              (r.edited_text is not null)::text as fingerprint
            from public.ingestion_jobs ij
            join public.ingestion_extractions ie
              on ie.tenant_id = ij.tenant_id
             and ie.ingestion_job_id = ij.ingestion_job_id
            join lateral (
              select r2.*
              from public.ingestion_cleaning_revisions r2
              where r2.tenant_id = ij.tenant_id
                and r2.ingestion_job_id = ij.ingestion_job_id
                and r2.status in ('approved', 'edited_approved')
                and r2.deleted_at is null
              order by r2.revision_number desc
              limit 1
            ) r on true
            where ij.tenant_id = target_tenant_id
              and ij.course_id = target_course_id
              and ij.deleted_at is null
          ) f
        ),
        ''
      ),
      'sha256'
    ),
    'hex'
  );
$$;

revoke execute on function app_private.knowledge_ingested_projection_hash(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function app_private.knowledge_project_ingested_course(
  target_tenant_id uuid,
  target_course_id uuid,
  caller_identity_role text,
  command_id text,
  replace_authored_knowledge boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  chunk_target constant integer := 1200;
  chunk_max constant integer := 1800;
  course record;
  active_version record;
  job_row record;
  prior_chunk record;
  projection_hash text;
  resolved_source_id uuid;
  new_version_id uuid;
  new_version_number integer;
  new_document_id uuid;
  effective_text text;
  expanded_parts text[];
  packed_chunks text[];
  chunk_body text;
  chunk_hash text;
  chunk_ordinal integer;
  chunk_cleaned_offset integer;
  chunk_raw_offset integer;
  chunk_provenance jsonb;
  context_header text;
  document_count integer := 0;
  chunk_count integer := 0;
  reused_count integer := 0;
  pending_count integer := 0;
  active_is_authored boolean := false;
  should_activate boolean := true;
begin
  select
    c.course_id, c.tenant_id, c.title, c.external_id, c.status,
    c.active_knowledge_version_id
  into course
  from public.courses c
  where c.tenant_id = target_tenant_id
    and c.course_id = target_course_id
    and c.deleted_at is null
  for update;
  if not found then
    raise no_data_found using message = 'Course was not found in this tenant';
  end if;

  projection_hash := app_private.knowledge_ingested_projection_hash(
    target_tenant_id, target_course_id
  );

  select
    kv.knowledge_version_id, kv.version_number, kv.status, kv.content_hash,
    kv.source_manifest, kv.published_at
  into active_version
  from public.knowledge_versions kv
  where kv.tenant_id = target_tenant_id
    and kv.course_id = target_course_id
    and kv.knowledge_version_id = course.active_knowledge_version_id;

  -- Nothing changed since the last publish: re-chunking would produce the
  -- same rows and re-embedding them would be paid for twice.
  if found
    and active_version.status = 'published'
    and active_version.content_hash = projection_hash
    and active_version.source_manifest @> '[{"kind": "ingested_cleaned_text"}]'::jsonb
  then
    select
      count(*)::integer,
      count(*) filter (where ch.embedding is null)::integer
    into chunk_count, pending_count
    from public.learning_chunks ch
    where ch.tenant_id = target_tenant_id
      and ch.course_id = target_course_id
      and ch.knowledge_version_id = active_version.knowledge_version_id
      and ch.deleted_at is null;

    return jsonb_build_object(
      'ok', true, 'dataMode', 'durable', 'changed', false, 'activated', true,
      'knowledgeVersionId', active_version.knowledge_version_id,
      'versionNumber', active_version.version_number,
      'contentHash', projection_hash,
      'documentCount', (
        select count(*)::integer from public.learning_documents d
        where d.tenant_id = target_tenant_id
          and d.knowledge_version_id = active_version.knowledge_version_id
          and d.deleted_at is null
      ),
      'chunkCount', chunk_count,
      'reusedEmbeddingCount', chunk_count - pending_count,
      'pendingEmbeddingCount', pending_count,
      'retrievable', chunk_count > 0
    );
  end if;

  -- Symmetric to the authored projector's "never silently discard an
  -- imported knowledge version" rule: an ingested publish must not silently
  -- discard an active AUTHORED version either, since a creator's typed
  -- lessons are usually the primary content and uploads a supplement.
  active_is_authored := course.active_knowledge_version_id is not null
    and active_version.knowledge_version_id is not null
    and active_version.source_manifest @> '[{"kind": "authored_content_blocks"}]'::jsonb;
  should_activate := (not active_is_authored) or replace_authored_knowledge;

  insert into public.learning_sources (
    tenant_id, course_id, source_type, name, status, external_ref,
    configuration, last_synced_at, idempotency_key
  ) values (
    target_tenant_id, target_course_id, 'api',
    left(coalesce(course.title, 'Course'), 160) || ' ingested uploads',
    'ready', 'ingested:' || target_course_id::text,
    jsonb_build_object('projector', 'ingested_cleaned_text', 'projectorVersion', 1),
    now(), 'ingested-source:' || target_course_id::text
  )
  on conflict (tenant_id, course_id, source_type, external_ref) do update
    set status = 'ready', last_synced_at = now()
  returning learning_sources.source_id into resolved_source_id;

  select coalesce(max(kv.version_number), 0) + 1
  into new_version_number
  from public.knowledge_versions kv
  where kv.tenant_id = target_tenant_id and kv.course_id = target_course_id;

  insert into public.knowledge_versions (
    tenant_id, course_id, version_number, status, source_manifest,
    content_hash, embedding_provider_key, embedding_model_key,
    embedding_dimensions, built_by, supersedes_version_id, idempotency_key
  ) values (
    target_tenant_id, target_course_id, new_version_number, 'building',
    jsonb_build_array(jsonb_build_object(
      'source', 'ingested:' || target_course_id::text,
      'kind', 'ingested_cleaned_text',
      'sourceId', resolved_source_id
    )),
    projection_hash, 'openai', 'text-embedding-3-small', 384,
    auth.uid(), course.active_knowledge_version_id,
    'ingested-knowledge:' || target_course_id::text || ':' || new_version_number::text
  )
  returning knowledge_versions.knowledge_version_id into new_version_id;

  for job_row in
    select
      ij.ingestion_job_id, ij.source_id,
      ie.extraction_id, ie.source_locations,
      r.revision_id, r.revision_number, r.cleaned_text, r.edited_text,
      r.offset_map,
      ls.name as source_name
    from public.ingestion_jobs ij
    join public.ingestion_extractions ie
      on ie.tenant_id = ij.tenant_id and ie.ingestion_job_id = ij.ingestion_job_id
    join lateral (
      select r2.*
      from public.ingestion_cleaning_revisions r2
      where r2.tenant_id = ij.tenant_id
        and r2.ingestion_job_id = ij.ingestion_job_id
        and r2.status in ('approved', 'edited_approved')
        and r2.deleted_at is null
      order by r2.revision_number desc
      limit 1
    ) r on true
    join public.learning_sources ls
      on ls.tenant_id = ij.tenant_id and ls.source_id = ij.source_id
    where ij.tenant_id = target_tenant_id
      and ij.course_id = target_course_id
      and ij.deleted_at is null
    order by ij.ingestion_job_id
  loop
    effective_text := coalesce(job_row.edited_text, job_row.cleaned_text);
    if btrim(coalesce(effective_text, '')) = '' then
      continue;
    end if;

    expanded_parts := app_private.knowledge_split_text(effective_text, chunk_max);
    packed_chunks := app_private.knowledge_pack_chunks(expanded_parts, chunk_target, chunk_max);
    if array_length(packed_chunks, 1) is null then
      continue;
    end if;

    insert into public.learning_documents (
      tenant_id, course_id, source_id, knowledge_version_id, external_id,
      title, media_type, language, content_hash, status, metadata,
      idempotency_key
    ) values (
      target_tenant_id, target_course_id, job_row.source_id, new_version_id,
      job_row.ingestion_job_id::text,
      left(coalesce(job_row.source_name, 'Upload'), 500),
      'text/plain', 'en',
      encode(extensions.digest(effective_text, 'sha256'), 'hex'),
      'ready',
      jsonb_build_object(
        'projector', 'ingested_cleaned_text',
        'ingestionJobId', job_row.ingestion_job_id,
        'extractionId', job_row.extraction_id,
        'revisionId', job_row.revision_id,
        'revisionNumber', job_row.revision_number,
        'editedByCreator', job_row.edited_text is not null,
        'chunkCount', array_length(packed_chunks, 1)
      ),
      'ingested-doc:' || new_version_id::text || ':' || job_row.ingestion_job_id::text
    )
    returning learning_documents.document_id into new_document_id;
    document_count := document_count + 1;

    context_header := concat_ws(
      ' · ',
      nullif(btrim(coalesce(course.title, '')), ''),
      nullif(btrim(coalesce(job_row.source_name, '')), '')
    );

    for chunk_ordinal in 1..array_length(packed_chunks, 1) loop
      chunk_body := case
        when context_header is null or context_header = '' then packed_chunks[chunk_ordinal]
        else context_header || E'\n\n' || packed_chunks[chunk_ordinal]
      end;
      chunk_hash := encode(extensions.digest(chunk_body, 'sha256'), 'hex');

      -- Best-effort provenance: locate this chunk's start inside the
      -- (unmodified) effective text, map it back to the raw upload through
      -- the cleaning revision's offset map, then find the nearest heading /
      -- timestamp / speaker anchor at or before it.
      chunk_cleaned_offset := greatest(
        position(packed_chunks[chunk_ordinal] in effective_text) - 1, 0
      );
      chunk_raw_offset := app_private.knowledge_map_offset(
        job_row.offset_map, chunk_cleaned_offset
      );
      chunk_provenance := app_private.knowledge_nearest_source_location(
        job_row.source_locations, chunk_raw_offset
      );

      select ch.embedding, ch.embedding_provider_key, ch.embedding_model_key,
        ch.embedding_dimensions
      into prior_chunk
      from public.learning_chunks ch
      where ch.tenant_id = target_tenant_id
        and ch.course_id = target_course_id
        and ch.content_hash = chunk_hash
        and ch.embedding is not null
      order by ch.updated_at desc, ch.chunk_id
      limit 1;

      insert into public.learning_chunks (
        tenant_id, course_id, knowledge_version_id, document_id, ordinal,
        body, token_count, content_hash, embedding, embedding_provider_key,
        embedding_model_key, embedding_dimensions, metadata, idempotency_key
      ) values (
        target_tenant_id, target_course_id, new_version_id, new_document_id,
        chunk_ordinal - 1, chunk_body, ceil(length(chunk_body) / 4.0)::integer,
        chunk_hash, prior_chunk.embedding, prior_chunk.embedding_provider_key,
        prior_chunk.embedding_model_key, prior_chunk.embedding_dimensions,
        jsonb_build_object(
          'courseSlug', coalesce(course.external_id, target_course_id::text),
          'courseName', course.title,
          'sectionName', job_row.source_name,
          'ingestionJobId', job_row.ingestion_job_id,
          'extractionId', job_row.extraction_id,
          'revisionId', job_row.revision_id,
          'projector', 'ingested_cleaned_text',
          'projectorVersion', 1,
          'provenance', jsonb_build_object(
            'rawOffset', chunk_raw_offset,
            'sourceLocation', chunk_provenance,
            'editedByCreator', job_row.edited_text is not null
          )
        ),
        'ingested-chunk:' || new_version_id::text || ':' ||
          job_row.ingestion_job_id::text || ':' || (chunk_ordinal - 1)::text
      );

      chunk_count := chunk_count + 1;
      if prior_chunk.embedding is null then
        pending_count := pending_count + 1;
      else
        reused_count := reused_count + 1;
      end if;
    end loop;
  end loop;

  update public.knowledge_versions
  set status = 'published', published_at = now()
  where tenant_id = target_tenant_id and knowledge_version_id = new_version_id;

  if should_activate then
    update public.courses
    set active_knowledge_version_id = new_version_id
    where tenant_id = target_tenant_id and course_id = target_course_id;
  end if;

  update public.knowledge_versions kv
  set status = 'retired'
  where kv.tenant_id = target_tenant_id
    and kv.course_id = target_course_id
    and kv.knowledge_version_id <> new_version_id
    and kv.status <> 'retired'
    and kv.source_manifest @> '[{"kind": "ingested_cleaned_text"}]'::jsonb;

  update public.learning_chunks ch
  set deleted_at = now()
  where ch.tenant_id = target_tenant_id
    and ch.course_id = target_course_id
    and ch.knowledge_version_id <> new_version_id
    and ch.deleted_at is null
    and exists (
      select 1 from public.knowledge_versions kv
      where kv.tenant_id = ch.tenant_id
        and kv.knowledge_version_id = ch.knowledge_version_id
        and kv.source_manifest @> '[{"kind": "ingested_cleaned_text"}]'::jsonb
    );

  update public.learning_documents d
  set deleted_at = now(), status = 'deleted'
  where d.tenant_id = target_tenant_id
    and d.course_id = target_course_id
    and d.knowledge_version_id <> new_version_id
    and d.deleted_at is null
    and exists (
      select 1 from public.knowledge_versions kv
      where kv.tenant_id = d.tenant_id
        and kv.knowledge_version_id = d.knowledge_version_id
        and kv.source_manifest @> '[{"kind": "ingested_cleaned_text"}]'::jsonb
    );

  delete from public.learning_chunks ch
  using public.knowledge_versions kv
  where kv.tenant_id = ch.tenant_id
    and kv.knowledge_version_id = ch.knowledge_version_id
    and kv.tenant_id = target_tenant_id
    and kv.course_id = target_course_id
    and kv.version_number < new_version_number - 1
    and kv.source_manifest @> '[{"kind": "ingested_cleaned_text"}]'::jsonb;

  delete from public.learning_documents d
  using public.knowledge_versions kv
  where kv.tenant_id = d.tenant_id
    and kv.knowledge_version_id = d.knowledge_version_id
    and kv.tenant_id = target_tenant_id
    and kv.course_id = target_course_id
    and kv.version_number < new_version_number - 1
    and kv.source_manifest @> '[{"kind": "ingested_cleaned_text"}]'::jsonb;

  update public.ingestion_jobs ij
  set status = 'succeeded', finished_at = now(), updated_at = now(),
      record_version = record_version + 1
  where ij.tenant_id = target_tenant_id
    and ij.course_id = target_course_id
    and ij.deleted_at is null
    and ij.status not in ('succeeded', 'cancelled', 'dead_letter')
    and exists (
      select 1
      from public.ingestion_cleaning_revisions r
      where r.tenant_id = ij.tenant_id
        and r.ingestion_job_id = ij.ingestion_job_id
        and r.status in ('approved', 'edited_approved')
        and r.deleted_at is null
    );

  perform app_private.ingestion_append_audit(
    target_tenant_id, coalesce(caller_identity_role, 'creator'),
    'learning.ingestion.publish', target_course_id::text, new_version_id::text
  );

  return jsonb_build_object(
    'ok', true, 'dataMode', 'durable', 'changed', true,
    'activated', should_activate,
    'knowledgeVersionId', new_version_id,
    'versionNumber', new_version_number,
    'contentHash', projection_hash,
    'documentCount', document_count,
    'chunkCount', chunk_count,
    'reusedEmbeddingCount', reused_count,
    'pendingEmbeddingCount', pending_count,
    'retrievable', should_activate and chunk_count > 0,
    'activationBlockedReason',
      case when should_activate then null else 'authored_knowledge_version_active' end
  );
end;
$$;

revoke execute on function app_private.knowledge_project_ingested_course(
  uuid, uuid, text, text, boolean
) from public, anon, authenticated, service_role;

create or replace function public.learning_ingestion_publish(
  target_course_id uuid,
  requested_idempotency_key text,
  replace_authored_knowledge boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  projection jsonb;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in ('tenant_owner', 'tenant_admin', 'creator', 'teacher')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if target_course_id is null
    or requested_idempotency_key is null
    or length(requested_idempotency_key) not between 8 and 200
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if not exists (
    select 1 from public.courses c
    where c.tenant_id = caller.tenant_id
      and c.course_id = target_course_id
      and c.deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'course_not_found');
  end if;

  projection := app_private.knowledge_project_ingested_course(
    caller.tenant_id,
    target_course_id,
    caller.identity_role,
    requested_idempotency_key,
    coalesce(replace_authored_knowledge, false)
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'courseId', target_course_id,
    'knowledge', projection
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Job/status detail, used by the review UI to show a quarantine upload's
-- real pipeline state (extraction / cleaning / review / publish), and by the
-- extract route to resolve the object key it needs to download.
-- ---------------------------------------------------------------------------

create or replace function public.learning_ingestion_job_detail(
  target_job_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  job record;
begin
  select * into caller from app_private.learning_rpc_context();
  if not found
    or caller.identity_role not in ('tenant_owner', 'tenant_admin', 'creator', 'teacher')
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select
    ij.ingestion_job_id, ij.course_id, ij.source_id, ij.status as job_status,
    ls.external_ref as object_key,
    ui.filename, ui.media_type, ui.actor_id,
    ic.status as malware_scan_status,
    ie.extraction_id, ie.content_hash as extraction_hash,
    jsonb_array_length(coalesce(ie.source_locations, '[]'::jsonb)) as source_location_count,
    rev.revision_id, rev.revision_number, rev.status as revision_status,
    rev.content_hash as revision_hash
  into job
  from public.ingestion_jobs ij
  join public.learning_sources ls
    on ls.tenant_id = ij.tenant_id and ls.source_id = ij.source_id
  left join public.upload_intents ui
    on ui.tenant_id = ij.tenant_id and ui.object_key = ls.external_ref
   and ls.source_type = 'upload'
  left join public.ingestion_checkpoints ic
    on ic.tenant_id = ij.tenant_id and ic.ingestion_job_id = ij.ingestion_job_id
   and ic.stage = 'security' and ic.checkpoint_key = 'malware_scan'
  left join public.ingestion_extractions ie
    on ie.tenant_id = ij.tenant_id and ie.ingestion_job_id = ij.ingestion_job_id
  left join lateral (
    select r.revision_id, r.revision_number, r.status, r.content_hash
    from public.ingestion_cleaning_revisions r
    where r.tenant_id = ij.tenant_id
      and r.ingestion_job_id = ij.ingestion_job_id
      and r.deleted_at is null
    order by r.revision_number desc
    limit 1
  ) rev on true
  where ij.tenant_id = caller.tenant_id
    and ij.ingestion_job_id = target_job_id
    and ij.deleted_at is null;

  if not found
    or job.actor_id is null
    or (
      job.actor_id <> auth.uid()::text
      and caller.identity_role not in ('tenant_owner', 'tenant_admin')
    )
  then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'jobId', job.ingestion_job_id,
    'courseId', job.course_id,
    'sourceId', job.source_id,
    'objectKey', job.object_key,
    'filename', job.filename,
    'mediaType', job.media_type,
    'jobStatus', job.job_status,
    'malwareScanStatus', coalesce(job.malware_scan_status, 'pending'),
    'extraction', case when job.extraction_id is null then null else jsonb_build_object(
      'extractionId', job.extraction_id,
      'contentHash', job.extraction_hash,
      'sourceLocationCount', job.source_location_count
    ) end,
    'latestRevision', case when job.revision_id is null then null else jsonb_build_object(
      'revisionId', job.revision_id,
      'revisionNumber', job.revision_number,
      'status', job.revision_status,
      'contentHash', job.revision_hash
    ) end
  );
end;
$$;

revoke execute on function public.learning_ingestion_record_extraction(
  uuid, text, integer, text, text, jsonb, text
) from public, anon, authenticated, service_role;
revoke execute on function public.learning_ingestion_boilerplate_shingles(text[])
  from public, anon, authenticated, service_role;
revoke execute on function public.learning_ingestion_record_cleaning(
  uuid, integer, text, jsonb, jsonb, jsonb, text, jsonb
) from public, anon, authenticated, service_role;
revoke execute on function public.learning_ingestion_review_queue()
  from public, anon, authenticated, service_role;
revoke execute on function public.learning_ingestion_get_revision(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.learning_ingestion_approve_revision(uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke execute on function public.learning_ingestion_publish(uuid, text, boolean)
  from public, anon, authenticated, service_role;
revoke execute on function public.learning_ingestion_job_detail(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.learning_ingestion_record_extraction(
  uuid, text, integer, text, text, jsonb, text
) to authenticated;
grant execute on function public.learning_ingestion_boilerplate_shingles(text[])
  to authenticated;
grant execute on function public.learning_ingestion_record_cleaning(
  uuid, integer, text, jsonb, jsonb, jsonb, text, jsonb
) to authenticated;
grant execute on function public.learning_ingestion_review_queue()
  to authenticated;
grant execute on function public.learning_ingestion_get_revision(uuid)
  to authenticated;
grant execute on function public.learning_ingestion_approve_revision(uuid, uuid, text)
  to authenticated;
grant execute on function public.learning_ingestion_publish(uuid, text, boolean)
  to authenticated;
grant execute on function public.learning_ingestion_job_detail(uuid)
  to authenticated;

commit;

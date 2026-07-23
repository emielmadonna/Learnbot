-- Source ingestion, resumable checkpoints and versioned retrieval knowledge.

begin;

create table public.learning_sources (
  source_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  course_id uuid not null,
  source_type text not null
    check (source_type in (
      'upload', 'circle', 'youtube', 'vimeo', 'url', 'kajabi',
      'teachable', 'skool', 'api', 'mcp'
    )),
  name text not null,
  status text not null default 'draft'
    check (status in (
      'draft', 'connecting', 'ready', 'syncing', 'degraded',
      'disconnected', 'failed'
    )),
  external_ref text,
  credential_vault_ref text,
  configuration jsonb not null default '{}'::jsonb,
  cursor_value text,
  last_synced_at timestamptz,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, course_id)
    references public.courses(tenant_id, course_id),
  unique (tenant_id, source_id),
  unique (tenant_id, source_id, course_id),
  unique (tenant_id, course_id, source_type, external_ref)
);
create index learning_sources_tenant_course_idx
  on public.learning_sources (tenant_id, course_id, status);
create unique index learning_sources_idempotency_uq
  on public.learning_sources (tenant_id, idempotency_key)
  where idempotency_key is not null;

create table public.ingestion_jobs (
  ingestion_job_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  course_id uuid not null,
  source_id uuid,
  job_type text not null,
  schema_version integer not null default 1 check (schema_version > 0),
  status text not null default 'queued'
    check (status in (
      'queued', 'running', 'waiting', 'succeeded', 'failed',
      'cancelled', 'dead_letter'
    )),
  priority smallint not null default 100,
  payload_ref text,
  trace_id text not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts > 0),
  lease_owner text,
  lease_expires_at timestamptz,
  error_code text,
  error_detail_safe jsonb,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null,
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, course_id)
    references public.courses(tenant_id, course_id),
  foreign key (tenant_id, source_id)
    references public.learning_sources(tenant_id, source_id),
  unique (tenant_id, ingestion_job_id),
  unique (tenant_id, idempotency_key)
);
create index ingestion_jobs_claim_idx
  on public.ingestion_jobs (tenant_id, status, priority, queued_at)
  where status in ('queued', 'waiting');
create index ingestion_jobs_trace_idx
  on public.ingestion_jobs (tenant_id, trace_id);

create table public.ingestion_checkpoints (
  checkpoint_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  ingestion_job_id uuid not null,
  stage text not null,
  checkpoint_key text not null,
  status text not null
    check (status in ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  input_hash text not null,
  output_ref text,
  output_hash text,
  metrics jsonb not null default '{}'::jsonb,
  error_code text,
  error_detail_safe jsonb,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, ingestion_job_id)
    references public.ingestion_jobs(tenant_id, ingestion_job_id),
  unique (tenant_id, checkpoint_id),
  unique (tenant_id, ingestion_job_id, checkpoint_key),
  unique (tenant_id, idempotency_key)
);
create index ingestion_checkpoints_job_idx
  on public.ingestion_checkpoints (tenant_id, ingestion_job_id, stage);

create table public.ingestion_issues (
  ingestion_issue_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  ingestion_job_id uuid not null,
  checkpoint_id uuid,
  code text not null,
  severity text not null check (severity in ('info', 'warning', 'error', 'fatal')),
  message text not null,
  safe_details jsonb not null default '{}'::jsonb,
  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'resolved', 'ignored')),
  resolution_note text,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, ingestion_job_id)
    references public.ingestion_jobs(tenant_id, ingestion_job_id),
  foreign key (tenant_id, checkpoint_id)
    references public.ingestion_checkpoints(tenant_id, checkpoint_id),
  unique (tenant_id, ingestion_issue_id)
);
create index ingestion_issues_job_status_idx
  on public.ingestion_issues (tenant_id, ingestion_job_id, status, severity);
create unique index ingestion_issues_idempotency_uq
  on public.ingestion_issues (tenant_id, idempotency_key)
  where idempotency_key is not null;

create table public.knowledge_versions (
  knowledge_version_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  course_id uuid not null,
  version_number integer not null check (version_number > 0),
  status text not null default 'building'
    check (status in ('building', 'validated', 'published', 'retired', 'failed')),
  source_manifest jsonb not null default '[]'::jsonb,
  content_hash text,
  embedding_provider_key text,
  embedding_model_key text,
  embedding_dimensions integer check (embedding_dimensions is null or embedding_dimensions > 0),
  built_by uuid,
  supersedes_version_id uuid,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, course_id)
    references public.courses(tenant_id, course_id),
  foreign key (tenant_id, supersedes_version_id)
    references public.knowledge_versions(tenant_id, knowledge_version_id),
  unique (tenant_id, knowledge_version_id),
  unique (tenant_id, knowledge_version_id, course_id),
  unique (tenant_id, course_id, version_number),
  unique (tenant_id, idempotency_key)
);
create index knowledge_versions_course_status_idx
  on public.knowledge_versions (tenant_id, course_id, status, version_number desc);

alter table public.courses
  add constraint courses_active_knowledge_version_fk
  foreign key (tenant_id, active_knowledge_version_id, course_id)
  references public.knowledge_versions(
    tenant_id, knowledge_version_id, course_id
  );

create table public.learning_documents (
  document_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  course_id uuid not null,
  source_id uuid not null,
  knowledge_version_id uuid not null,
  external_id text not null,
  title text not null,
  media_type text,
  language text,
  raw_storage_key text,
  extracted_storage_key text,
  content_hash text not null,
  status text not null default 'ready'
    check (status in ('quarantined', 'extracting', 'ready', 'rejected', 'deleted')),
  metadata jsonb not null default '{}'::jsonb,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, course_id)
    references public.courses(tenant_id, course_id),
  foreign key (tenant_id, source_id, course_id)
    references public.learning_sources(tenant_id, source_id, course_id),
  foreign key (tenant_id, knowledge_version_id, course_id)
    references public.knowledge_versions(
      tenant_id, knowledge_version_id, course_id
    ),
  unique (tenant_id, document_id),
  unique (tenant_id, document_id, course_id),
  unique (tenant_id, knowledge_version_id, source_id, external_id),
  check (
    raw_storage_key is null
    or raw_storage_key like tenant_id::text || '/%'
  ),
  check (
    extracted_storage_key is null
    or extracted_storage_key like tenant_id::text || '/%'
  )
);
create index learning_documents_version_idx
  on public.learning_documents (tenant_id, knowledge_version_id, status);
create unique index learning_documents_idempotency_uq
  on public.learning_documents (tenant_id, idempotency_key)
  where idempotency_key is not null;

create table public.learning_chunks (
  chunk_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  course_id uuid not null,
  knowledge_version_id uuid not null,
  document_id uuid not null,
  ordinal integer not null check (ordinal >= 0),
  body text not null,
  token_count integer check (token_count is null or token_count >= 0),
  content_hash text not null,
  embedding extensions.vector,
  embedding_provider_key text,
  embedding_model_key text,
  metadata jsonb not null default '{}'::jsonb,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, course_id)
    references public.courses(tenant_id, course_id),
  foreign key (tenant_id, knowledge_version_id, course_id)
    references public.knowledge_versions(
      tenant_id, knowledge_version_id, course_id
    ),
  foreign key (tenant_id, document_id, course_id)
    references public.learning_documents(tenant_id, document_id, course_id),
  unique (tenant_id, chunk_id),
  unique (tenant_id, knowledge_version_id, document_id, ordinal),
  check (
    embedding is null
    or embedding_dimensions = extensions.vector_dims(embedding)
  )
);
create index learning_chunks_retrieval_idx
  on public.learning_chunks (tenant_id, course_id, knowledge_version_id)
  where deleted_at is null;
create unique index learning_chunks_idempotency_uq
  on public.learning_chunks (tenant_id, idempotency_key)
  where idempotency_key is not null;

commit;

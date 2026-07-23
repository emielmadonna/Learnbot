-- Tenant presentation, verified learning context, progress and unified chat.

begin;

create table public.tenant_branding (
  tenant_branding_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  status text not null default 'draft'
    check (status in ('draft', 'published', 'retired')),
  version_number integer not null check (version_number > 0),
  assistant_name text not null,
  logo_storage_key text,
  avatar_storage_key text,
  primary_color text not null check (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  accent_color text not null check (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  surface_color text not null check (surface_color ~ '^#[0-9A-Fa-f]{6}$'),
  text_color text not null check (text_color ~ '^#[0-9A-Fa-f]{6}$'),
  launcher jsonb not null default '{}'::jsonb,
  welcome_message text not null,
  voice_configuration jsonb not null default '{}'::jsonb,
  privacy_copy text,
  published_by uuid,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  unique (tenant_id, tenant_branding_id),
  unique (tenant_id, version_number),
  unique (tenant_id, idempotency_key)
);
create unique index tenant_branding_one_published_uq
  on public.tenant_branding (tenant_id) where status = 'published';

create table public.learning_context_mappings (
  context_mapping_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  course_id uuid not null,
  module_id uuid,
  lesson_id uuid,
  source_type text not null,
  host_pattern text not null,
  external_course_id text,
  external_module_id text,
  external_lesson_id text,
  priority integer not null default 100,
  status text not null default 'active'
    check (status in ('draft', 'active', 'disabled')),
  resolver_configuration jsonb not null default '{}'::jsonb,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text,
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
  unique (tenant_id, context_mapping_id),
  unique (
    tenant_id, source_type, host_pattern,
    external_course_id, external_module_id, external_lesson_id
  ),
  check (lesson_id is null or module_id is not null)
);
create index learning_context_mappings_resolve_idx
  on public.learning_context_mappings (tenant_id, status, source_type, priority);
create unique index learning_context_mappings_idempotency_uq
  on public.learning_context_mappings (tenant_id, idempotency_key)
  where idempotency_key is not null;

create table public.student_progress (
  student_progress_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  user_id uuid not null,
  course_id uuid not null,
  module_id uuid,
  lesson_id uuid,
  progress_state text not null default 'not_started'
    check (progress_state in ('not_started', 'in_progress', 'completed', 'blocked')),
  lessons_completed integer not null default 0 check (lessons_completed >= 0),
  lessons_total integer not null default 0 check (lessons_total >= 0),
  percent_complete numeric(5,2) not null default 0
    check (percent_complete between 0 and 100),
  source_event_ref text,
  verified_at timestamptz,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text,
  last_activity_at timestamptz,
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
  unique (tenant_id, student_progress_id),
  unique (tenant_id, user_id, course_id),
  check (lesson_id is null or module_id is not null)
);
create index student_progress_user_activity_idx
  on public.student_progress (tenant_id, user_id, last_activity_at desc);
create unique index student_progress_idempotency_uq
  on public.student_progress (tenant_id, idempotency_key)
  where idempotency_key is not null;

create table public.conversations (
  conversation_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  subject_user_id uuid not null,
  course_id uuid,
  module_id uuid,
  lesson_id uuid,
  channel_state text not null default 'text'
    check (channel_state in ('text', 'voice_connecting', 'voice_listening', 'voice_thinking', 'voice_speaking')),
  status text not null default 'active'
    check (status in ('active', 'ended', 'deleted')),
  title text,
  metadata jsonb not null default '{}'::jsonb,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
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
  unique (tenant_id, conversation_id),
  check (lesson_id is null or module_id is not null)
);
create index conversations_subject_idx
  on public.conversations (tenant_id, subject_user_id, updated_at desc);
create unique index conversations_idempotency_uq
  on public.conversations (tenant_id, idempotency_key)
  where idempotency_key is not null;

create table public.messages (
  message_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  conversation_id uuid not null,
  actor_id uuid,
  actor_type text not null
    check (actor_type in ('student', 'assistant', 'creator', 'owner', 'system')),
  modality text not null
    check (modality in ('text', 'voice_transcript', 'tool', 'system')),
  status text not null default 'final'
    check (status in ('partial', 'final', 'interrupted', 'failed', 'deleted')),
  body text,
  structured_content jsonb,
  provider_key text,
  provider_request_ref text,
  trace_id text not null,
  sequence_number bigint not null check (sequence_number >= 0),
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, conversation_id)
    references public.conversations(tenant_id, conversation_id),
  unique (tenant_id, message_id),
  unique (tenant_id, message_id, conversation_id),
  unique (tenant_id, conversation_id, sequence_number),
  unique (tenant_id, idempotency_key)
);
create index messages_conversation_sequence_idx
  on public.messages (tenant_id, conversation_id, sequence_number);

create table public.attachments (
  attachment_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  conversation_id uuid not null,
  message_id uuid,
  uploaded_by uuid not null,
  original_filename text not null,
  storage_key text not null,
  media_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  content_hash text not null,
  malware_status text not null default 'pending'
    check (malware_status in ('pending', 'clean', 'quarantined', 'rejected')),
  extraction_status text not null default 'pending'
    check (extraction_status in ('pending', 'extracting', 'ready', 'failed', 'not_applicable')),
  extraction_ref text,
  promoted_knowledge_version_id uuid,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, conversation_id)
    references public.conversations(tenant_id, conversation_id),
  foreign key (tenant_id, message_id, conversation_id)
    references public.messages(tenant_id, message_id, conversation_id),
  foreign key (tenant_id, promoted_knowledge_version_id)
    references public.knowledge_versions(tenant_id, knowledge_version_id),
  unique (tenant_id, attachment_id),
  unique (tenant_id, storage_key),
  unique (tenant_id, idempotency_key),
  check (storage_key like tenant_id::text || '/%')
);
create index attachments_conversation_status_idx
  on public.attachments (
    tenant_id, conversation_id, malware_status, extraction_status
  );

commit;

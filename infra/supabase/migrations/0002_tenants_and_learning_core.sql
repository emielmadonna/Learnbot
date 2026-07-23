-- Tenant identity, authorization facts and authorable course hierarchy.

begin;

create table public.tenants (
  tenant_id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  display_name text not null,
  status text not null default 'provisioning'
    check (status in ('provisioning', 'active', 'suspended', 'deleted')),
  region text,
  settings jsonb not null default '{}'::jsonb,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  check (deleted_at is null or status = 'deleted')
);
create unique index tenants_idempotency_uq
  on public.tenants (idempotency_key) where idempotency_key is not null;

create table public.roles (
  role_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  role_key text not null
    check (role_key in (
      'owner', 'client_admin', 'client_viewer', 'student', 'system_worker'
    )),
  display_name text not null,
  capabilities text[] not null default '{}'::text[],
  is_system boolean not null default true,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  unique (tenant_id, role_id),
  unique (tenant_id, role_key)
);
create unique index roles_idempotency_uq
  on public.roles (tenant_id, idempotency_key)
  where idempotency_key is not null;

create table public.profiles (
  profile_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  user_id uuid not null,
  display_name text,
  email_ciphertext text,
  locale text,
  timezone text,
  metadata jsonb not null default '{}'::jsonb,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  unique (tenant_id, user_id)
);
create index profiles_tenant_user_idx on public.profiles (tenant_id, user_id);
create unique index profiles_idempotency_uq
  on public.profiles (tenant_id, idempotency_key)
  where idempotency_key is not null;

create table public.memberships (
  membership_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  user_id uuid not null,
  role_key text not null,
  status text not null default 'invited'
    check (status in ('invited', 'active', 'suspended', 'revoked')),
  granted_by uuid,
  expires_at timestamptz,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, role_key)
    references public.roles(tenant_id, role_key),
  unique (tenant_id, user_id)
);
create index memberships_tenant_role_idx
  on public.memberships (tenant_id, role_key, status);
create unique index memberships_idempotency_uq
  on public.memberships (tenant_id, idempotency_key)
  where idempotency_key is not null;

create table public.courses (
  course_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  external_id text,
  title text not null,
  description text,
  status text not null default 'draft'
    check (status in ('draft', 'published', 'archived')),
  active_knowledge_version_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  unique (tenant_id, external_id),
  unique (tenant_id, course_id)
);
create index courses_tenant_status_idx on public.courses (tenant_id, status);
create unique index courses_idempotency_uq
  on public.courses (tenant_id, idempotency_key)
  where idempotency_key is not null;

create table public.modules (
  module_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  course_id uuid not null,
  external_id text,
  title text not null,
  position integer not null check (position >= 0),
  status text not null default 'draft'
    check (status in ('draft', 'published', 'archived')),
  metadata jsonb not null default '{}'::jsonb,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, course_id)
    references public.courses(tenant_id, course_id),
  unique (tenant_id, course_id, position),
  unique (tenant_id, course_id, external_id),
  unique (tenant_id, module_id),
  unique (tenant_id, module_id, course_id)
);
create index modules_tenant_course_idx
  on public.modules (tenant_id, course_id, position);
create unique index modules_idempotency_uq
  on public.modules (tenant_id, idempotency_key)
  where idempotency_key is not null;

create table public.lessons (
  lesson_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  course_id uuid not null,
  module_id uuid not null,
  external_id text,
  title text not null,
  position integer not null check (position >= 0),
  status text not null default 'draft'
    check (status in ('draft', 'published', 'archived')),
  metadata jsonb not null default '{}'::jsonb,
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, module_id, course_id)
    references public.modules(tenant_id, module_id, course_id),
  unique (tenant_id, module_id, position),
  unique (tenant_id, module_id, external_id),
  unique (tenant_id, lesson_id),
  unique (tenant_id, lesson_id, course_id),
  unique (tenant_id, lesson_id, module_id, course_id)
);
create index lessons_tenant_course_module_idx
  on public.lessons (tenant_id, course_id, module_id, position);
create unique index lessons_idempotency_uq
  on public.lessons (tenant_id, idempotency_key)
  where idempotency_key is not null;

create table public.content_blocks (
  content_block_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(tenant_id),
  course_id uuid not null,
  lesson_id uuid not null,
  block_type text not null,
  position integer not null check (position >= 0),
  content jsonb not null,
  content_hash text not null,
  schema_version integer not null default 1 check (schema_version > 0),
  record_version bigint not null default 1 check (record_version > 0),
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  retain_until timestamptz,
  foreign key (tenant_id, lesson_id, course_id)
    references public.lessons(tenant_id, lesson_id, course_id),
  unique (tenant_id, lesson_id, position)
);
create index content_blocks_tenant_lesson_idx
  on public.content_blocks (tenant_id, lesson_id, position);
create unique index content_blocks_idempotency_uq
  on public.content_blocks (tenant_id, idempotency_key)
  where idempotency_key is not null;

commit;

-- The producer for pre-provisioned client workspaces.
--
-- Migration 0019 gave a client a way to *redeem* a one-time owner claim for a
-- workspace that already existed, but nothing in the schema ever created that
-- workspace: the only `insert into public.tenants` lived inside
-- public.auth_bootstrap_tenant_owner, which is the client signing themselves up.
-- This migration adds the missing first step of onboarding — the platform owner
-- creating a client workspace on the client's behalf, in one transaction, and
-- handing back a single-use owner claim.
--
-- Data boundary: nothing here reads or exposes learner conversation content,
-- prompt text, source bodies, attachments or credentials. The owner claim token
-- is generated, returned exactly once and never stored: only its SHA-256 digest
-- is persisted, exactly as public.auth_claim_preprovisioned_tenant_owner
-- expects to verify it.
--
-- On tenant status: public.tenants.status defaults to 'provisioning' and nothing
-- in the schema ever promotes it, which is why an entirely healthy workspace can
-- read as inactive. Every access gate accepts status in ('provisioning',
-- 'active'), so the default is not a security control -- it is an unfinished
-- lifecycle. Workspaces created here are 'active' from the start. The default
-- and the existing rows are deliberately left alone; changing them is a separate,
-- reviewable decision.

begin;

-- ---------------------------------------------------------------------------
-- Provisioning receipts
-- ---------------------------------------------------------------------------

-- One row per successful provisioning, keyed by the caller's idempotency key.
-- A retried request replays this receipt instead of creating a second workspace.
-- It deliberately holds no token material -- only the claim's tenant binding.
create table app_private.platform_client_provisionings (
  provisioning_id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique
    check (length(btrim(idempotency_key)) between 1 and 200),
  tenant_id uuid not null unique references public.tenants(tenant_id),
  slug text not null,
  created_by_auth_user_id uuid references auth.users(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index platform_client_provisionings_created_idx
  on app_private.platform_client_provisionings (created_at desc);

alter table app_private.platform_client_provisionings
  enable row level security;
alter table app_private.platform_client_provisionings
  force row level security;
revoke all on table app_private.platform_client_provisionings
  from public, anon, authenticated;
grant select, insert, update
  on table app_private.platform_client_provisionings
  to service_role;

create policy platform_client_provisionings_no_direct_access
  on app_private.platform_client_provisionings
  for all
  to anon, authenticated
  using (false)
  with check (false);

-- ---------------------------------------------------------------------------
-- Claim minting
-- ---------------------------------------------------------------------------

-- The claim contract is owned by migration 0019. That function looks the claim
-- up by tenant_id, requires status = 'pending', requires
-- expires_at > clock_timestamp(), and compares
-- encode(extensions.digest(claim_token, 'sha256'), 'hex') against token_sha256.
-- This helper is the mirror image of that check: it produces a token of a length
-- 0019 accepts (32..256 characters), stores only the digest in the exact lower
-- case hexadecimal shape the column's CHECK constraint demands, and returns the
-- plaintext to its caller for a single, immediate disclosure.
create or replace function app_private.platform_mint_owner_claim(
  target_tenant_id uuid,
  claim_lifetime interval
)
returns table (
  claim_id uuid,
  claim_secret text,
  expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  minted_secret text;
  minted record;
begin
  -- 32 random bytes rendered as 64 lowercase hexadecimal characters.
  minted_secret := encode(extensions.gen_random_bytes(32), 'hex');

  insert into app_private.tenant_owner_claims (
    tenant_id, token_sha256, status, expires_at
  ) values (
    target_tenant_id,
    encode(extensions.digest(minted_secret, 'sha256'), 'hex'),
    'pending',
    clock_timestamp() + claim_lifetime
  )
  returning * into minted;

  claim_id := minted.claim_id;
  claim_secret := minted_secret;
  expires_at := minted.expires_at;
  return next;
end;
$$;
revoke execute on function app_private.platform_mint_owner_claim(uuid, interval)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Create a client workspace
-- ---------------------------------------------------------------------------

-- Everything a usable client workspace needs, in one transaction: the tenant,
-- its role catalogue, a published branding/agent row, its section flags, its
-- onboarding control-plane records, and the one-time owner claim the client
-- redeems through public.auth_claim_preprovisioned_tenant_owner.
create or replace function public.platform_admin_create_tenant(
  requested_slug text,
  requested_display_name text,
  requested_assistant_name text,
  requested_primary_color text,
  requested_accent_color text,
  requested_idempotency_key text,
  requested_region text default null,
  requested_plan text default 'unconfirmed'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  caller_id uuid := auth.uid();
  normalized_key text;
  normalized_slug text;
  normalized_name text;
  normalized_assistant text;
  normalized_region text;
  normalized_plan text;
  provisioning_key text;
  existing_receipt record;
  existing_claim record;
  admin_principal_id text;
  new_tenant record;
  new_workspace record;
  minted record;
  receipt record;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  normalized_key := btrim(coalesce(requested_idempotency_key, ''));
  normalized_slug := lower(btrim(coalesce(requested_slug, '')));
  normalized_name := btrim(coalesce(requested_display_name, ''));
  normalized_assistant := btrim(coalesce(requested_assistant_name, ''));
  normalized_region := nullif(btrim(coalesce(requested_region, '')), '');
  normalized_plan := lower(btrim(coalesce(requested_plan, 'unconfirmed')));

  if length(normalized_key) not between 1 and 200
    or normalized_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$'
    or length(normalized_name) not between 1 and 160
    or length(normalized_assistant) not between 1 and 80
    or requested_primary_color !~ '^#[0-9A-Fa-f]{6}$'
    or requested_accent_color !~ '^#[0-9A-Fa-f]{6}$'
    or (normalized_region is not null
      and normalized_region !~ '^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$')
    or normalized_plan not in (
      'unconfirmed', 'starter', 'growth', 'enterprise'
    )
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  -- Serialize concurrent retries of the same request, and concurrent attempts
  -- on the same slug, before anything is written.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(normalized_key, 8026)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(normalized_slug, 8027)
  );

  select p.* into existing_receipt
  from app_private.platform_client_provisionings p
  where p.idempotency_key = normalized_key;

  if found then
    -- A replay. The workspace already exists and the token was disclosed once,
    -- at creation; it is not recoverable and is never re-issued here.
    -- Report what the workspace actually is, not what this call asked for.
    select
      t.tenant_id,
      t.slug,
      t.display_name,
      t.status,
      t.region,
      t.settings ->> 'planId' as plan_id,
      coalesce(b.assistant_name, 'LearningBot') as assistant_name
    into new_tenant
    from public.tenants t
    left join lateral (
      select tb.assistant_name
      from public.tenant_branding tb
      where tb.tenant_id = t.tenant_id
        and tb.status = 'published'
        and tb.deleted_at is null
      order by tb.version_number desc
      limit 1
    ) b on true
    where t.tenant_id = existing_receipt.tenant_id;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'tenant_not_found');
    end if;

    select
      c.claim_id,
      case
        when c.status = 'pending' and c.expires_at <= clock_timestamp()
          then 'expired'
        else c.status
      end as effective_status,
      c.expires_at
    into existing_claim
    from app_private.tenant_owner_claims c
    where c.tenant_id = existing_receipt.tenant_id;

    return jsonb_build_object(
      'ok', true,
      'dataMode', 'durable',
      'created', false,
      'generatedAt', clock_timestamp(),
      'tenantId', new_tenant.tenant_id,
      'slug', new_tenant.slug,
      'displayName', new_tenant.display_name,
      'status', new_tenant.status,
      'region', new_tenant.region,
      'plan', new_tenant.plan_id,
      'assistantName', new_tenant.assistant_name,
      'claim', case
        when existing_claim.claim_id is null then null
        else jsonb_build_object(
          'claimId', existing_claim.claim_id,
          'status', existing_claim.effective_status,
          'expiresAt', existing_claim.expires_at,
          -- Deliberately null: only the digest was ever stored.
          'token', null::text
        )
      end
    );
  end if;

  if exists (
    select 1 from public.tenants t where t.slug = normalized_slug
  ) then
    return jsonb_build_object('ok', false, 'code', 'slug_conflict');
  end if;

  provisioning_key :=
    'platform-client:' ||
    encode(
      extensions.digest(
        normalized_key || chr(31) || normalized_slug,
        'sha256'
      ),
      'hex'
    );

  select l.principal_id
  into admin_principal_id
  from app_private.supabase_auth_principal_links l
  where l.auth_user_id = caller_id;

  insert into public.tenants (
    slug, display_name, status, region, settings, idempotency_key
  ) values (
    normalized_slug,
    normalized_name,
    -- Created active on purpose: this workspace was provisioned by a human who
    -- is accountable for it, so it is not waiting on anything.
    'active',
    normalized_region,
    jsonb_build_object(
      'planId', normalized_plan,
      'locale', 'en-US',
      'timeZone', 'UTC',
      'featureFlags', '{}'::jsonb,
      'limits', '{}'::jsonb,
      'policyVersion', 'unconfirmed',
      'provisionedBy', 'platform_admin'
    ),
    provisioning_key
  )
  returning * into new_tenant;

  insert into public.roles (
    tenant_id, role_key, display_name, capabilities, idempotency_key
  )
  select
    new_tenant.tenant_id,
    role_seed.role_key,
    role_seed.display_name,
    role_seed.capabilities,
    provisioning_key || ':role:' || role_seed.role_key
  from (
    values
      ('owner', 'Owner', array['tenant.*']::text[]),
      ('client_admin', 'Client administrator', array['tenant.manage']::text[]),
      ('client_viewer', 'Client viewer', array['tenant.read']::text[]),
      ('student', 'Student', array['learning.read']::text[]),
      ('system_worker', 'System worker', array['system.execute']::text[])
  ) as role_seed(role_key, display_name, capabilities);

  -- Published, not draft: the client's first sign-in should land on a workspace
  -- that already looks like theirs.
  insert into public.tenant_branding (
    tenant_id, status, version_number, assistant_name, primary_color,
    accent_color, surface_color, text_color, welcome_message, icon_glyph,
    persona_instructions, agent_tone, agent_voice, agent_course_scope,
    published_by, published_at, idempotency_key
  ) values (
    new_tenant.tenant_id,
    'published',
    1,
    normalized_assistant,
    upper(requested_primary_color),
    upper(requested_accent_color),
    '#F7F8FC',
    '#101828',
    'Hi, I am ' || normalized_assistant ||
      '. How can I help you learn today?',
    upper(left(normalized_assistant, 1)),
    'You are ' || normalized_assistant || ', the learning assistant for ' ||
      normalized_name ||
      '. Answer only from this workspace''s published course material, and say' ||
      ' plainly when the material does not cover a question.',
    'friendly',
    null,
    '"all"'::jsonb,
    caller_id,
    now(),
    provisioning_key || ':branding'
  );

  insert into public.tenant_sections (
    tenant_id, section_key, enabled, updated_by, idempotency_key
  )
  select
    new_tenant.tenant_id,
    d.section_key,
    d.default_enabled,
    caller_id,
    'tenant-section-seed:' || new_tenant.tenant_id::text || ':' || d.section_key
  from app_private.tenant_section_definitions() d;

  insert into public.onboarding_workspaces (
    tenant_id, status, circle_plan, expected_identity_mode,
    owner_membership_id, idempotency_key
  ) values (
    new_tenant.tenant_id,
    'in_progress',
    'unconfirmed',
    'unconfirmed',
    -- Filled in by auth_claim_preprovisioned_tenant_owner when the client
    -- redeems the claim; that function requires this row to exist.
    null,
    provisioning_key || ':onboarding'
  )
  returning * into new_workspace;

  insert into public.onboarding_steps (
    tenant_id, onboarding_id, step_key, status, required, evidence_ref,
    completed_by_principal_id, completed_at, idempotency_key
  )
  select
    new_tenant.tenant_id,
    new_workspace.onboarding_id,
    seed.step_name,
    -- The tenant profile is genuinely done: a named platform administrator
    -- supplied it. It is only recorded as complete when that administrator has
    -- a durable principal to attribute it to.
    case
      when seed.step_name = 'tenant_profile' and admin_principal_id is not null
        then 'complete'
      else 'not_started'
    end,
    true,
    case
      when seed.step_name = 'tenant_profile' and admin_principal_id is not null
        then 'platform-admin-provisioning:' || normalized_key
      else null
    end,
    case
      when seed.step_name = 'tenant_profile' and admin_principal_id is not null
        then admin_principal_id
      else null
    end,
    case
      when seed.step_name = 'tenant_profile' and admin_principal_id is not null
        then now()
      else null
    end,
    provisioning_key || ':step:' || seed.step_name
  from pg_catalog.unnest(array[
    'tenant_profile',
    'identity_mode',
    'provider_funding',
    'source_ingestion',
    'assistant_voice_guide',
    'diagram_review',
    'context_mapping',
    'widget_branding',
    'privacy_consent',
    'recording_policy',
    'retention_policy',
    'playground_qa',
    'install_verification',
    'client_handoff'
  ]::text[]) as seed(step_name);

  select * into minted
  from app_private.platform_mint_owner_claim(
    new_tenant.tenant_id,
    interval '14 days'
  );

  insert into app_private.platform_client_provisionings (
    idempotency_key, tenant_id, slug, created_by_auth_user_id
  ) values (
    normalized_key,
    new_tenant.tenant_id,
    new_tenant.slug,
    caller_id
  )
  returning * into receipt;

  perform app_private.platform_admin_write_audit(
    new_tenant.tenant_id,
    'platform.client.create',
    'tenant',
    new_tenant.tenant_id::text,
    'allow',
    'platform_admin_created_client_workspace',
    receipt.provisioning_id::text
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'created', true,
    'generatedAt', clock_timestamp(),
    'tenantId', new_tenant.tenant_id,
    'slug', new_tenant.slug,
    'displayName', new_tenant.display_name,
    'status', new_tenant.status,
    'region', new_tenant.region,
    'plan', normalized_plan,
    'assistantName', normalized_assistant,
    'claim', jsonb_build_object(
      'claimId', minted.claim_id,
      'status', 'pending',
      'expiresAt', minted.expires_at,
      -- The only time this value is ever readable. It is not stored.
      'token', minted.claim_secret
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Outstanding claims
-- ---------------------------------------------------------------------------

-- Status and expiry only. There is no path from here back to a token: the
-- plaintext was never written down, and the digest is not returned either.
create or replace function public.platform_admin_list_client_claims()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  claims jsonb;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'claimId', c.claim_id,
        'tenantId', t.tenant_id,
        'slug', t.slug,
        'displayName', t.display_name,
        'tenantStatus', t.status,
        'status', case
          when c.status = 'pending' and c.expires_at <= clock_timestamp()
            then 'expired'
          else c.status
        end,
        'expiresAt', c.expires_at,
        'createdAt', c.created_at,
        'claimedAt', c.claimed_at,
        'provisionedByPlatform', p.provisioning_id is not null
      )
      order by c.created_at desc, c.claim_id
    ),
    '[]'::jsonb
  )
  into claims
  from app_private.tenant_owner_claims c
  join public.tenants t on t.tenant_id = c.tenant_id
  left join app_private.platform_client_provisionings p
    on p.tenant_id = c.tenant_id
  where t.deleted_at is null;

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'generatedAt', clock_timestamp(),
    'claims', claims
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Revoke a claim
-- ---------------------------------------------------------------------------

-- Revocation is the answer to a mis-delivered code. It is terminal for that
-- claim: 0019 only accepts status = 'pending', so a revoked row can never be
-- redeemed, and there is no un-revoke.
create or replace function public.platform_admin_revoke_client_claim(
  target_claim_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
declare
  claim_record record;
  revoked record;
begin
  if not public.platform_admin_is_authorized() then
    return jsonb_build_object('ok', false, 'code', 'access_denied');
  end if;
  if target_claim_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select c.* into claim_record
  from app_private.tenant_owner_claims c
  where c.claim_id = target_claim_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'claim_not_found');
  end if;
  if claim_record.status <> 'pending' then
    return jsonb_build_object('ok', false, 'code', 'claim_not_pending');
  end if;

  update app_private.tenant_owner_claims c
  set status = 'revoked',
      updated_at = clock_timestamp()
  where c.claim_id = target_claim_id
    and c.status = 'pending'
  returning * into revoked;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'claim_not_pending');
  end if;

  perform app_private.platform_admin_write_audit(
    revoked.tenant_id,
    'platform.client.claim.revoke',
    'tenant_owner_claim',
    revoked.claim_id::text,
    'allow',
    'platform_admin_revoked_owner_claim',
    revoked.tenant_id::text
  );

  return jsonb_build_object(
    'ok', true,
    'dataMode', 'durable',
    'claimId', revoked.claim_id,
    'tenantId', revoked.tenant_id,
    'status', revoked.status,
    'expiresAt', revoked.expires_at
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Execution boundary
-- ---------------------------------------------------------------------------

revoke execute on function public.platform_admin_create_tenant(
  text, text, text, text, text, text, text, text
) from public, anon, service_role;
revoke execute on function public.platform_admin_list_client_claims()
  from public, anon, service_role;
revoke execute on function public.platform_admin_revoke_client_claim(uuid)
  from public, anon, service_role;

grant execute on function public.platform_admin_create_tenant(
  text, text, text, text, text, text, text, text
) to authenticated;
grant execute on function public.platform_admin_list_client_claims()
  to authenticated;
grant execute on function public.platform_admin_revoke_client_claim(uuid)
  to authenticated;

commit;

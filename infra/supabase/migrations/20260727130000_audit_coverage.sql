-- ============================================================
-- 20260727130000_audit_coverage.sql
-- Phase 12: audit coverage for conversations, uploads and provisioning.
--
-- `public.audit_ledger` has existed since 0005 and is append-only, enforced by
-- reject_mutation triggers. Eight domains write to it -- onboarding, platform
-- admin, agent configuration, authoring, widget, question intelligence,
-- ingestion and avatars. Three do not, and they are the three that hold the
-- most personal data:
--
--   * conversations  -- public.messages has no audit writer at all
--   * uploads        -- public.upload_intents likewise
--   * provisioning   -- app_private.user_access_accounts likewise
--
-- WHY TRIGGERS RATHER THAN EDITING THE RPCs
--
-- The obvious shape is to add `perform app_private...._audit(...)` inside
-- learning_record_user_message, learning_record_assistant_message,
-- learning_create_upload_intent and learning_confirm_quarantine_upload. That
-- would mean `create or replace`-ing four large function bodies, which on this
-- project is the single most dangerous edit available: SCHEMA-DRIFT.md exists
-- because a re-applied migration once carried an older revision of
-- admin_provision_auth_user. Triggers avoid it entirely -- those four function
-- definitions are left byte-identical, and their md5 fingerprints are asserted
-- unchanged after this migration.
--
-- Triggers are also simply more complete. They fire for every writer, including
-- the ingestion paths that update upload_intents.status and any future RPC that
-- has not been written yet. An audit trail with a known hole is worth much less
-- than one without.
--
-- WHY NO MESSAGE BODIES IN THE LEDGER
--
-- The ledger records a sha256 of the body in `after_hash`, never the body. Two
-- reasons: audit_ledger is append-only and retained for 2555 days by default, so
-- a body written here could not be honoured in a deletion request; and the
-- ledger is readable by any tenant admin, which is a wider audience than the
-- conversation itself. A digest still proves what was said if someone later
-- produces the text.
--
-- COST, STATED PLAINLY
--
-- This puts one audit row behind every message row, on the hottest table in the
-- system, retained for 2555 days by default. That is the price of the trail
-- being complete rather than sampled. `tenants.settings.auditRetentionDays`
-- already exists as the per-tenant dial if it needs turning down.
-- ============================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. One shared writer. Mirrors app_private.authoring_append_audit, including
--    its retention rule (tenant setting, else 2555 days) and its deterministic
--    idempotency key, so a replayed statement cannot double-write.
-- ---------------------------------------------------------------------------

create or replace function app_private.lifecycle_append_audit(
  target_tenant_id uuid,
  actor_uuid uuid,
  caller_actor_type text,
  caller_actor_role text,
  audit_action text,
  target_resource_type text,
  target_resource_id text,
  decision_reason text,
  before_hash text,
  after_hash text,
  change_ref text,
  audit_trace_id text,
  audit_key text
)
returns void
language sql
security definer
set search_path = pg_catalog
as $$
  insert into public.audit_ledger (
    tenant_id, actor_id, actor_type, actor_role, action, resource_type,
    resource_id, policy_decision, decision_reason, before_hash, after_hash,
    change_ref, request_id, trace_id, idempotency_key, retain_until
  )
  select
    target_tenant_id,
    actor_uuid,
    caller_actor_type,
    caller_actor_role,
    audit_action,
    target_resource_type,
    target_resource_id,
    'allow',
    decision_reason,
    before_hash,
    after_hash,
    change_ref,
    audit_trace_id,
    audit_trace_id,
    'lifecycle-audit:' || encode(
      extensions.digest(
        target_tenant_id::text || chr(31) || target_resource_type || chr(31) ||
        coalesce(target_resource_id, '') || chr(31) || audit_action || chr(31) ||
        audit_key,
        'sha256'
      ),
      'hex'
    ),
    now() + make_interval(
      days => coalesce(
        nullif(t.settings ->> 'auditRetentionDays', '')::integer,
        2555
      )
    )
  from public.tenants t
  where t.tenant_id = target_tenant_id
  on conflict (tenant_id, idempotency_key) do nothing;
$$;
revoke execute on function app_private.lifecycle_append_audit(
  uuid, uuid, text, text, text, text, text, text, text, text, text, text, text
) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Conversations. Every message row, learner and assistant alike.
--
--    messages.actor_type allows 'assistant', audit_ledger does not -- it calls
--    the same thing 'agent'. Mapped rather than widened, because the ledger's
--    vocabulary is shared across every domain and 'agent' already means this.
-- ---------------------------------------------------------------------------

create or replace function app_private.messages_audit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  perform app_private.lifecycle_append_audit(
    new.tenant_id,
    new.actor_id,
    case new.actor_type when 'assistant' then 'agent' else new.actor_type end,
    null,
    'message.recorded',
    'message',
    new.message_id::text,
    'durable_conversation_write:' || new.modality,
    null,
    -- The digest, never the body. See the header.
    case
      when new.body is null then null
      else encode(extensions.digest(new.body, 'sha256'), 'hex')
    end,
    'conversation:' || new.conversation_id::text,
    new.trace_id,
    new.message_id::text || chr(31) || new.record_version::text
  );
  return null;
end;
$$;

drop trigger if exists messages_append_audit on public.messages;
create trigger messages_append_audit
after insert on public.messages
for each row execute function app_private.messages_audit();

-- ---------------------------------------------------------------------------
-- 3. Uploads. Creation, and every status transition after it.
--
--    The status transitions are the half that matters: 'quarantined' ->
--    'blocked' is a malware detection, -> 'promoted' is a file entering the
--    knowledge base. Auditing only the insert would record the intent and miss
--    the outcome.
--
--    upload_intents.actor_id is a principal id (text), not a uuid, so it cannot
--    go in audit_ledger.actor_id. It is carried in change_ref instead rather
--    than silently dropped.
-- ---------------------------------------------------------------------------

create or replace function app_private.upload_intents_audit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  -- OLD is unassigned on INSERT; referencing it there raises rather than
  -- yielding null, so the previous status is resolved once, under a guard.
  previous_status text := null;
begin
  if tg_op = 'UPDATE' then
    if new.status is not distinct from old.status then
      return null;
    end if;
    previous_status := old.status;
  end if;

  perform app_private.lifecycle_append_audit(
    new.tenant_id,
    auth.uid(),
    'creator',
    null,
    case tg_op
      when 'INSERT' then 'upload.intent_created'
      else 'upload.status_' || new.status
    end,
    'upload_intent',
    new.intent_id,
    case tg_op when 'INSERT' then 'quarantine_upload_created'
               else 'quarantine_upload_transition' end,
    -- before_hash / after_hash mean content digests elsewhere in this ledger.
    -- A status is not a digest, so it goes in change_ref and these stay null.
    null,
    null,
    'actor:' || new.actor_id || chr(31) ||
    'object:' || new.object_key || chr(31) ||
    'status:' || coalesce(previous_status || '->', '') || new.status,
    'upload:' || new.intent_id,
    new.intent_id || chr(31) || new.status || chr(31) || new.record_version::text
  );
  return null;
end;
$$;

drop trigger if exists upload_intents_append_audit on public.upload_intents;
create trigger upload_intents_append_audit
after insert or update on public.upload_intents
for each row execute function app_private.upload_intents_audit();

-- ---------------------------------------------------------------------------
-- 4. Provisioning. Account creation and credential rotation.
--
--    Deliberately a trigger on the table rather than an edit to
--    public.admin_provision_auth_user. That function has three live revisions in
--    this project's history and re-applying an older one can destroy a live
--    tenant; it is not going to be touched to add logging.
-- ---------------------------------------------------------------------------

create or replace function app_private.user_access_accounts_audit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  -- Same reason as upload_intents_audit: OLD does not exist on INSERT.
  previous_version bigint := null;
begin
  if tg_op = 'UPDATE' then
    if new.credential_version is not distinct from old.credential_version then
      return null;
    end if;
    previous_version := old.credential_version;
  end if;

  perform app_private.lifecycle_append_audit(
    new.tenant_id,
    new.auth_user_id,
    'system',
    null,
    case tg_op
      when 'INSERT' then 'access_account.provisioned'
      else 'access_account.credential_rotated'
    end,
    'access_account',
    new.principal_id,
    case tg_op when 'INSERT' then 'managed_account_provisioned'
               else 'managed_account_credential_rotated' end,
    null,
    null,
    -- The address is personal data and the ledger outlives the account, so it
    -- is recorded as a digest. Enough to answer "was this address provisioned".
    'email_sha256:' || encode(
      extensions.digest(new.email_normalized, 'sha256'), 'hex'
    ) || chr(31) ||
    'credential_version:' ||
    coalesce(previous_version::text || '->', '') ||
    new.credential_version::text,
    'provisioning:' || new.principal_id,
    new.principal_id || chr(31) || new.credential_version::text
  );
  return null;
end;
$$;

drop trigger if exists user_access_accounts_append_audit
  on app_private.user_access_accounts;
create trigger user_access_accounts_append_audit
after insert or update on app_private.user_access_accounts
for each row execute function app_private.user_access_accounts_audit();

commit;

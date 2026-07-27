-- Run after migrations 0001..20260726096000. Verifies the operational safety
-- controls: that the conversation operation secret can only be provisioned and
-- revoked by an authorized platform administrator, that rotation overlaps so it
-- never needs downtime, that the plaintext token is never stored or echoed,
-- that expiry is visible as days remaining, that a missing or expired secret
-- produces a named operational failure rather than a generic denial, that every
-- provider call is metered into public.cost_ledger with tenant isolation and
-- idempotent replay, that budgets and rate limits refuse in SQL rather than in
-- a per-process map, that spend is visible per client to the platform owner,
-- and that the tenant's configured voice is what the voice path reads.
-- All fixtures roll back.

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'f5500000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'ops-platform-owner@example.test', '',
    now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'f5500000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'ops-owner-a@example.test', '',
    now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'f5500000-0000-4000-8000-000000000003',
    'authenticated', 'authenticated', 'ops-owner-b@example.test', '',
    now(), '{"provider":"email","providers":["email"]}', '{}'::jsonb,
    now(), now()
  );

set local role authenticated;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f5500000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
select * from public.auth_bootstrap_tenant_owner(
  'ops-platform-home',
  'OPS Platform Owner Home',
  'ops-bootstrap-platform',
  'trace-ops-bootstrap-platform'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f5500000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
select * from public.auth_bootstrap_tenant_owner(
  'ops-client-a',
  'OPS Client A',
  'ops-bootstrap-a',
  'trace-ops-bootstrap-a'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f5500000-0000-4000-8000-000000000003',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
select * from public.auth_bootstrap_tenant_owner(
  'ops-client-b',
  'OPS Client B',
  'ops-bootstrap-b',
  'trace-ops-bootstrap-b'
);

reset role;

select set_config(
  'learningbot.test.ops_tenant_a',
  (select tenant_id::text from public.tenants where slug = 'ops-client-a'),
  true
);
select set_config(
  'learningbot.test.ops_tenant_b',
  (select tenant_id::text from public.tenants where slug = 'ops-client-b'),
  true
);

insert into app_private.platform_administrators (
  auth_user_id, reason
) values (
  'f5500000-0000-4000-8000-000000000001',
  'operational safety verification fixture'
);

-- ---------------------------------------------------------------------------
-- OPS-01: the conversation operation secret has a repeatable provisioning and
-- rotation path, it is platform-administrator only, rotation overlaps so no
-- answer is refused mid-rotation, and no plaintext token is ever stored.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f5500000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  result jsonb;
begin
  result := public.platform_admin_register_operation_secret(
    'conversation.answer.record',
    'ops-tenant-owner-must-not-provision-7Kq2vXb9',
    90,
    'illegitimate'
  );
  if coalesce(result ->> 'code', '') <> 'access_denied' then
    raise exception
      'OPS-01 failed: a tenant owner registered an operation secret (%)',
      result::text;
  end if;
  if coalesce(
    public.platform_admin_operation_secret_status() ->> 'code', ''
  ) <> 'access_denied' then
    raise exception 'OPS-01 failed: a tenant owner read operation secret status';
  end if;
  if coalesce(
    public.platform_admin_revoke_operation_secret(
      gen_random_uuid(), 'unauthorized'
    ) ->> 'code',
    ''
  ) <> 'access_denied' then
    raise exception 'OPS-01 failed: a tenant owner revoked an operation secret';
  end if;
end $$;

reset role;
do $$
begin
  if exists (select 1 from app_private.learning_operation_secrets) then
    raise exception 'OPS-01 failed: a secret was registered without authority';
  end if;
end $$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f5500000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  outgoing jsonb;
  incoming jsonb;
  status_payload jsonb;
  capability_row jsonb;
begin
  -- A weak, malformed or unknown-capability registration is refused before it
  -- can be installed.
  if coalesce(
    public.platform_admin_register_operation_secret(
      'conversation.answer.record', 'too-short', 90, 'weak'
    ) ->> 'code',
    ''
  ) <> 'weak_operation_token' then
    raise exception 'OPS-01 failed: a short operation token was accepted';
  end if;
  if coalesce(
    public.platform_admin_register_operation_secret(
      'conversation.answer.record',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      90,
      'low-entropy'
    ) ->> 'code',
    ''
  ) <> 'weak_operation_token' then
    raise exception 'OPS-01 failed: a low-entropy operation token was accepted';
  end if;
  if coalesce(
    public.platform_admin_register_operation_secret(
      'conversation.answer.unknown',
      'ops-outgoing-operation-token-7Kq2vXb9Zt4m',
      90,
      'unknown'
    ) ->> 'code',
    ''
  ) <> 'unknown_capability' then
    raise exception 'OPS-01 failed: an unknown capability was provisioned';
  end if;
  if coalesce(
    public.platform_admin_register_operation_secret(
      'conversation.answer.record',
      'ops-outgoing-operation-token-7Kq2vXb9Zt4m',
      0,
      'no-expiry'
    ) ->> 'code',
    ''
  ) <> 'invalid_validity_window' then
    raise exception 'OPS-01 failed: a secret was registered without an expiry';
  end if;

  outgoing := public.platform_admin_register_operation_secret(
    'conversation.answer.record',
    'ops-outgoing-operation-token-7Kq2vXb9Zt4m',
    30,
    'vercel-production-outgoing'
  );
  if coalesce((outgoing ->> 'ok')::boolean, false) is not true then
    raise exception 'OPS-01 failed: registration was refused (%)',
      outgoing::text;
  end if;
  if (outgoing ->> 'daysRemaining')::integer not between 29 and 30 then
    raise exception 'OPS-01 failed: days remaining was not reported (%)',
      outgoing::text;
  end if;
  if outgoing::text like '%7Kq2vXb9Zt4m%' then
    raise exception 'OPS-01 failed: the plaintext token was echoed back';
  end if;
  perform set_config(
    'learningbot.test.ops_outgoing_secret', outgoing ->> 'secretId', true
  );

  -- Re-registering the same plaintext is refused, so a rotation cannot silently
  -- extend the secret it was meant to replace.
  if coalesce(
    public.platform_admin_register_operation_secret(
      'conversation.answer.record',
      'ops-outgoing-operation-token-7Kq2vXb9Zt4m',
      30,
      'duplicate'
    ) ->> 'code',
    ''
  ) <> 'secret_already_registered' then
    raise exception 'OPS-01 failed: a duplicate secret was registered';
  end if;

  -- The interlock refuses to remove the only valid secret, which is the exact
  -- mistake that turns every answer into an unexplained denial.
  if coalesce(
    public.platform_admin_revoke_operation_secret(
      (outgoing ->> 'secretId')::uuid,
      'rotation without a replacement'
    ) ->> 'code',
    ''
  ) <> 'last_valid_secret' then
    raise exception
      'OPS-01 failed: the last valid secret was revoked without a replacement';
  end if;

  -- Overlapping validity: the replacement is installed while the outgoing
  -- secret is still accepted, which is what removes downtime from a rotation.
  incoming := public.platform_admin_register_operation_secret(
    'conversation.answer.record',
    'ops-incoming-operation-token-3Wd8pLr5Nc6y',
    90,
    'vercel-production-incoming'
  );
  if coalesce((incoming ->> 'ok')::boolean, false) is not true then
    raise exception 'OPS-01 failed: the replacement secret was refused (%)',
      incoming::text;
  end if;
  if (incoming ->> 'validSecretCount')::integer <> 2 then
    raise exception
      'OPS-01 failed: rotation did not overlap; valid secrets = %',
      incoming ->> 'validSecretCount';
  end if;

  -- The second capability in the catalogue, the embedding worker, is
  -- provisioned through the same path.
  if coalesce(
    (
      public.platform_admin_register_operation_secret(
        'knowledge.embedding.worker',
        'ops-embedding-worker-token-8Hn4tQz6Vb1p',
        90,
        'embedding-worker'
      ) ->> 'ok'
    )::boolean,
    false
  ) is not true then
    raise exception
      'OPS-01 failed: the embedding worker capability could not be provisioned';
  end if;

  -- Expiry visibility: the operator read names each capability, its count and
  -- its days remaining, and never discloses a usable token.
  status_payload := public.platform_admin_operation_secret_status();
  if coalesce((status_payload ->> 'healthy')::boolean, false) is not true then
    raise exception 'OPS-01 failed: a provisioned capability reported unhealthy';
  end if;
  select entry
  into capability_row
  from jsonb_array_elements(status_payload -> 'capabilities') as entry
  where entry ->> 'capability' = 'conversation.answer.record';
  if capability_row is null
    or (capability_row ->> 'validSecretCount')::integer <> 2
    or (capability_row ->> 'daysRemaining')::integer not between 29 and 30
    or capability_row ->> 'status' <> 'healthy'
  then
    raise exception 'OPS-01 failed: expiry visibility is wrong (%)',
      coalesce(capability_row::text, 'missing');
  end if;
  if status_payload::text like '%7Kq2vXb9Zt4m%'
    or status_payload::text like '%3Wd8pLr5Nc6y%'
    or status_payload::text like '%8Hn4tQz6Vb1p%'
  then
    raise exception 'OPS-01 failed: the status read disclosed a token';
  end if;
  if jsonb_array_length(status_payload -> 'capabilities') < 2 then
    raise exception
      'OPS-01 failed: the status read does not cover every capability';
  end if;
end $$;

reset role;
do $$
begin
  if exists (
    select 1
    from app_private.learning_operation_secrets s
    where s.token_hash like '%7Kq2vXb9Zt4m%'
       or s.token_hash like '%3Wd8pLr5Nc6y%'
       or coalesce(s.label, '') like '%7Kq2vXb9Zt4m%'
  ) then
    raise exception 'OPS-01 failed: the plaintext token reached storage';
  end if;
  if exists (
    select 1
    from app_private.learning_operation_secret_events e
    where e.token_digest_prefix !~ '^[0-9a-f]{8}$'
  ) then
    raise exception
      'OPS-01 failed: the provisioning event stored more than a digest prefix';
  end if;
  -- Both secrets satisfy the verifier at the same moment. This is the property
  -- that lets an operator install a new token before the old one expires.
  if not app_private.learning_operation_token_is_valid(
    'conversation.answer.record',
    'ops-outgoing-operation-token-7Kq2vXb9Zt4m'
  ) then
    raise exception
      'OPS-01 failed: the outgoing secret stopped working during rotation';
  end if;
  if not app_private.learning_operation_token_is_valid(
    'conversation.answer.record',
    'ops-incoming-operation-token-3Wd8pLr5Nc6y'
  ) then
    raise exception 'OPS-01 failed: the incoming secret is not accepted';
  end if;
end $$;

set local role authenticated;
do $$
declare
  revoked jsonb;
begin
  revoked := public.platform_admin_revoke_operation_secret(
    current_setting('learningbot.test.ops_outgoing_secret')::uuid,
    'rotation completed; replacement installed'
  );
  if coalesce((revoked ->> 'ok')::boolean, false) is not true
    or (revoked ->> 'validSecretCount')::integer <> 1
  then
    raise exception 'OPS-01 failed: the rotation could not be completed (%)',
      revoked::text;
  end if;
end $$;

reset role;
do $$
begin
  if app_private.learning_operation_token_is_valid(
    'conversation.answer.record',
    'ops-outgoing-operation-token-7Kq2vXb9Zt4m'
  ) then
    raise exception 'OPS-01 failed: a revoked secret is still accepted';
  end if;
  if not app_private.learning_operation_token_is_valid(
    'conversation.answer.record',
    'ops-incoming-operation-token-3Wd8pLr5Nc6y'
  ) then
    raise exception
      'OPS-01 failed: revoking the outgoing secret broke the incoming one';
  end if;
  if not exists (
    select 1
    from app_private.learning_operation_secret_events e
    where e.action = 'revoked'
      and e.actor_auth_user_id = 'f5500000-0000-4000-8000-000000000001'::uuid
      and e.reason = 'rotation completed; replacement installed'
  ) then
    raise exception 'OPS-01 failed: the revocation was not audited';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- OPS-02: a missing or expired secret is reported as a named operational
-- failure, and the persona read denies instead of degrading silently.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f5500000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  health jsonb;
  directive jsonb;
begin
  health := public.learning_operation_capability_health(
    'conversation.answer.record'
  );
  if coalesce((health ->> 'configured')::boolean, false) is not true
    or health ->> 'code' <> 'operation_secret_available'
  then
    raise exception
      'OPS-02 failed: a provisioned capability reported missing (%)',
      health::text;
  end if;
  directive := public.learning_get_agent_directive(
    'ops-incoming-operation-token-3Wd8pLr5Nc6y'
  );
  if coalesce((directive ->> 'ok')::boolean, false) is not true then
    raise exception
      'OPS-02 failed: a valid secret did not unlock the persona read (%)',
      directive::text;
  end if;
  if coalesce(
    public.learning_operation_capability_health('conversation.answer.unknown')
      ->> 'code',
    ''
  ) <> 'unknown_capability' then
    raise exception 'OPS-02 failed: an unknown capability was reported healthy';
  end if;
end $$;

-- Expire the way a real secret expires: by time, not by deletion.
reset role;
update app_private.learning_operation_secrets
set expires_at = statement_timestamp() - interval '1 minute'
where capability = 'conversation.answer.record'
  and status = 'active';

set local role authenticated;
do $$
declare
  health jsonb;
  directive jsonb;
begin
  health := public.learning_operation_capability_health(
    'conversation.answer.record'
  );
  if coalesce((health ->> 'configured')::boolean, true) is not false
    or health ->> 'code' <> 'operation_secret_unavailable'
  then
    raise exception
      'OPS-02 failed: an expired capability did not report an operational error (%)',
      health::text;
  end if;
  directive := public.learning_get_agent_directive(
    'ops-incoming-operation-token-3Wd8pLr5Nc6y'
  );
  if coalesce((directive ->> 'ok')::boolean, true) is not false then
    raise exception
      'OPS-02 failed: the persona was disclosed on an expired secret (%)',
      directive::text;
  end if;
end $$;

reset role;
update app_private.learning_operation_secrets
set expires_at = statement_timestamp() + interval '30 days'
where capability = 'conversation.answer.record'
  and status = 'active';

-- ---------------------------------------------------------------------------
-- OPS-03: every provider call is metered into public.cost_ledger, the ledger is
-- tenant-isolated, and a retried write replays instead of double-charging.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f5500000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  tenant_b uuid := current_setting('learningbot.test.ops_tenant_b')::uuid;
  first_write jsonb;
  replayed jsonb;
begin
  first_write := public.learning_record_provider_cost(
    'conversation.answer',
    'openai:openai-responses-production-v1',
    'gpt-5.6-luna',
    2400,
    'tokens',
    18500,
    'trace-ops-metering-0001',
    'cost:ops-metering-0001',
    'request-ops-metering-0001',
    null,
    jsonb_build_object('inputTokens', 1800, 'outputTokens', 600)
  );
  if coalesce((first_write ->> 'ok')::boolean, false) is not true
    or coalesce((first_write ->> 'replayed')::boolean, true) is not false
  then
    raise exception 'OPS-03 failed: the provider cost was not metered (%)',
      first_write::text;
  end if;
  perform set_config(
    'learningbot.test.ops_cost_entry', first_write ->> 'costEntryId', true
  );

  replayed := public.learning_record_provider_cost(
    'conversation.answer',
    'openai:openai-responses-production-v1',
    'gpt-5.6-luna',
    2400,
    'tokens',
    18500,
    'trace-ops-metering-0001',
    'cost:ops-metering-0001',
    'request-ops-metering-0001'
  );
  if coalesce((replayed ->> 'replayed')::boolean, false) is not true then
    raise exception 'OPS-03 failed: a retried meter write double-charged (%)',
      replayed::text;
  end if;

  -- A browser cannot meter spend against a tenant it does not belong to, and
  -- the anonymous form is unreachable without the server-held operation token.
  if coalesce(
    public.learning_record_provider_cost(
      'conversation.answer',
      'openai:openai-responses-production-v1',
      'gpt-5.6-luna',
      10,
      'tokens',
      100,
      'trace-ops-metering-cross-0001',
      'cost:ops-metering-cross-0001',
      null,
      null,
      '{}'::jsonb,
      tenant_b,
      'ops-not-a-valid-operation-token-000000000'
    ) ->> 'code',
    ''
  ) <> 'operation_secret_unavailable' then
    raise exception
      'OPS-03 failed: spend was metered against another tenant without a secret';
  end if;

  -- The trusted server path, holding the valid operation token, may meter for
  -- an anonymous widget visitor of another tenant.
  if coalesce(
    (
      public.learning_record_provider_cost(
        'widget.answer',
        'openai:openai-responses-production-v1',
        'gpt-5.6-luna',
        50,
        'tokens',
        900,
        'trace-ops-metering-widget-0001',
        'cost:ops-metering-widget-0001',
        null,
        null,
        '{}'::jsonb,
        tenant_b,
        'ops-incoming-operation-token-3Wd8pLr5Nc6y'
      ) ->> 'ok'
    )::boolean,
    false
  ) is not true then
    raise exception
      'OPS-03 failed: the trusted anonymous meter write was refused';
  end if;
end $$;

reset role;
do $$
declare
  tenant_a uuid := current_setting('learningbot.test.ops_tenant_a')::uuid;
  tenant_b uuid := current_setting('learningbot.test.ops_tenant_b')::uuid;
  entry public.cost_ledger%rowtype;
begin
  select * into entry
  from public.cost_ledger c
  where c.cost_entry_id
    = current_setting('learningbot.test.ops_cost_entry')::uuid;
  if entry.tenant_id <> tenant_a then
    raise exception 'OPS-03 failed: the ledger entry landed on another tenant';
  end if;
  if entry.estimated_cost_micro <> 18500 then
    raise exception 'OPS-03 failed: the micro-unit cost was not recorded (%)',
      entry.estimated_cost_micro;
  end if;
  -- 18 500 micro units is 1.85 minor units. Rounding up keeps the human-facing
  -- figure from silently under-reporting a real charge; truncation to cents is
  -- exactly why a per-call ledger in whole cents never trips a budget.
  if entry.estimated_cost_minor <> 2 then
    raise exception 'OPS-03 failed: minor-unit rounding lost a real charge (%)',
      entry.estimated_cost_minor;
  end if;
  if entry.capability <> 'conversation.answer'
    or entry.unit <> 'tokens'
    or entry.model_key <> 'gpt-5.6-luna'
    or entry.funding_source <> 'platform'
    or entry.trace_id <> 'trace-ops-metering-0001'
  then
    raise exception 'OPS-03 failed: the ledger entry is not attributable';
  end if;
  if length(entry.provider_metadata_safe::text) > 2000 then
    raise exception 'OPS-03 failed: unbounded provider metadata was stored';
  end if;
  if (
    select count(*)
    from public.cost_ledger c
    where c.tenant_id = tenant_a
      and c.idempotency_key = 'cost:ops-metering-0001'
  ) <> 1 then
    raise exception 'OPS-03 failed: the ledger holds a duplicate entry';
  end if;
  if (
    select count(*)
    from public.cost_ledger c
    where c.tenant_id = tenant_b
  ) <> 1 then
    raise exception
      'OPS-03 failed: cross-tenant metering is not isolated to the trusted path';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- OPS-04: budgets and rate limits are enforced in SQL. The counter is a table,
-- so a serverless cold start cannot reset it, and every refusal is named.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f5500000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  decision jsonb;
begin
  decision := public.learning_reserve_provider_call(
    'conversation.answer',
    'principal-ops-a'
  );
  if coalesce((decision ->> 'allowed')::boolean, false) is not true
    or decision ->> 'scope' <> 'durable-tenant'
  then
    raise exception 'OPS-04 failed: a first call within budget was refused (%)',
      decision::text;
  end if;
  if (decision ->> 'daySpendMicro')::bigint < 18500 then
    raise exception
      'OPS-04 failed: the reservation did not read recorded spend (%)',
      decision::text;
  end if;
  -- A tenant owner cannot raise their own budget.
  if coalesce(
    public.platform_admin_set_tenant_cost_policy(
      current_setting('learningbot.test.ops_tenant_a')::uuid,
      999999999, 999999999, 10000, 1000000, 1000, 'monitor'
    ) ->> 'code',
    ''
  ) <> 'access_denied' then
    raise exception 'OPS-04 failed: a tenant raised its own budget';
  end if;
end $$;

-- The platform owner tightens the per-learner burst allowance.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f5500000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
begin
  if coalesce(
    (
      public.platform_admin_set_tenant_cost_policy(
        current_setting('learningbot.test.ops_tenant_a')::uuid,
        25000000, 500000000, 60, 5000, 3, 'enforce'
      ) ->> 'ok'
    )::boolean,
    false
  ) is not true then
    raise exception 'OPS-04 failed: the platform owner could not set a budget';
  end if;
end $$;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f5500000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  decision jsonb;
  index_counter integer;
begin
  for index_counter in 1..3 loop
    perform public.learning_reserve_provider_call(
      'conversation.answer',
      'principal-ops-burst'
    );
  end loop;
  decision := public.learning_reserve_provider_call(
    'conversation.answer',
    'principal-ops-burst'
  );
  if coalesce((decision ->> 'allowed')::boolean, true) is not false
    or decision ->> 'code' <> 'subject_rate_limited'
    or (decision ->> 'retryAfterSeconds')::integer <= 0
  then
    raise exception
      'OPS-04 failed: the per-subject rate limit did not refuse (%)',
      decision::text;
  end if;
  -- One learner's burst must not block another learner in the same tenant.
  if coalesce(
    (
      public.learning_reserve_provider_call(
        'conversation.answer', 'principal-ops-other'
      ) ->> 'allowed'
    )::boolean,
    false
  ) is not true then
    raise exception 'OPS-04 failed: one learner burst blocked another';
  end if;
end $$;

-- The daily budget is dropped below the spend already recorded in OPS-03.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f5500000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
begin
  perform public.platform_admin_set_tenant_cost_policy(
    current_setting('learningbot.test.ops_tenant_a')::uuid,
    1000, 500000000, 60, 5000, 100, 'enforce'
  );
end $$;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f5500000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  decision jsonb;
begin
  decision := public.learning_reserve_provider_call(
    'conversation.answer',
    'principal-ops-budget'
  );
  if coalesce((decision ->> 'allowed')::boolean, true) is not false
    or decision ->> 'code' <> 'daily_budget_exceeded'
    or (decision ->> 'dailyBudgetMicro')::bigint <> 1000
  then
    raise exception 'OPS-04 failed: the daily budget did not refuse (%)',
      decision::text;
  end if;
end $$;

-- `monitor` records what would have been refused without refusing it, so a new
-- limit can be observed against real traffic before it bites.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f5500000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
begin
  perform public.platform_admin_set_tenant_cost_policy(
    current_setting('learningbot.test.ops_tenant_a')::uuid,
    1000, 500000000, 60, 5000, 100, 'monitor'
  );
end $$;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f5500000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  decision jsonb;
begin
  decision := public.learning_reserve_provider_call(
    'conversation.answer',
    'principal-ops-monitor'
  );
  if coalesce((decision ->> 'allowed')::boolean, false) is not true
    or coalesce((decision ->> 'wouldDeny')::boolean, false) is not true
    or decision ->> 'code' <> 'daily_budget_exceeded'
  then
    raise exception
      'OPS-04 failed: monitor mode did not observe without refusing (%)',
      decision::text;
  end if;
end $$;

reset role;
do $$
begin
  if exists (
    select 1
    from public.provider_rate_events e
    where e.subject_hash !~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'OPS-04 failed: a raw subject key reached the rate table';
  end if;
  if not exists (
    select 1
    from public.provider_rate_events e
    where e.tenant_id = current_setting('learningbot.test.ops_tenant_a')::uuid
      and e.decision = 'deny'
      and e.deny_reason = 'daily_budget_exceeded'
  ) then
    raise exception 'OPS-04 failed: refusals are not durably countable';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- OPS-05: spend is visible per client to the platform owner, the tenant's
-- configured voice is what the voice path reads, and every new surface is
-- least privilege.
-- ---------------------------------------------------------------------------

reset role;
update public.tenant_branding
set status = 'published',
    agent_voice = 'cedar',
    published_at = now()
where tenant_id = current_setting('learningbot.test.ops_tenant_a')::uuid;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f5500000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  tenant_a uuid := current_setting('learningbot.test.ops_tenant_a')::uuid;
  overview jsonb;
  tenant_row jsonb;
begin
  overview := public.platform_admin_cost_overview(30);
  if coalesce((overview ->> 'ok')::boolean, false) is not true then
    raise exception 'OPS-05 failed: the platform cost overview was refused (%)',
      overview::text;
  end if;
  select entry
  into tenant_row
  from jsonb_array_elements(overview -> 'tenants') as entry
  where (entry ->> 'tenantId')::uuid = tenant_a;
  if tenant_row is null
    or (tenant_row ->> 'windowSpendMicro')::bigint < 18500
    or (tenant_row ->> 'denialsToday')::bigint < 1
    or tenant_row ->> 'enforcement' is null
  then
    raise exception 'OPS-05 failed: cost per client is not visible (%)',
      coalesce(tenant_row::text, 'missing');
  end if;
  if (overview -> 'totals' ->> 'windowSpendMicro')::bigint < 19400 then
    raise exception 'OPS-05 failed: platform-wide spend is understated (%)',
      overview -> 'totals';
  end if;
  if coalesce(
    (overview -> 'operationSecrets' ->> 'ok')::boolean, false
  ) is not true then
    raise exception 'OPS-05 failed: secret expiry is absent from the owner read';
  end if;
end $$;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f5500000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  profile jsonb;
begin
  profile := public.tenant_get_voice_profile();
  if profile ->> 'voice' <> 'cedar' or profile ->> 'source' <> 'tenant' then
    raise exception 'OPS-05 failed: the configured voice was ignored (%)',
      profile::text;
  end if;
end $$;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f5500000-0000-4000-8000-000000000003',
    'role', 'authenticated',
    'is_anonymous', false,
    'app_metadata', '{}'::jsonb
  )::text,
  true
);
do $$
declare
  profile jsonb;
begin
  profile := public.tenant_get_voice_profile();
  if profile ->> 'voice' is not null or profile ->> 'source' <> 'default' then
    raise exception
      'OPS-05 failed: an unconfigured tenant did not fall back (%)',
      profile::text;
  end if;
end $$;

do $$
declare
  signature text;
begin
  -- Internal helpers stay invisible to every browser-reachable role.
  foreach signature in array array[
    'app_private.learning_operation_capabilities()',
    'app_private.learning_operation_valid_secret_count(text)',
    'app_private.provider_call_decision(uuid,text,text)',
    'app_private.provider_rate_subject_hash(uuid,text)',
    'app_private.tenant_cost_policy(uuid)'
  ]
  loop
    if has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('anon', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
    then
      raise exception 'OPS-05 failed: helper % is exposed', signature;
    end if;
  end loop;

  -- Platform-owner surfaces are never reachable anonymously or by a key.
  foreach signature in array array[
    'public.platform_admin_register_operation_secret(text,text,integer,text)',
    'public.platform_admin_revoke_operation_secret(uuid,text,boolean)',
    'public.platform_admin_operation_secret_status()',
    'public.platform_admin_cost_overview(integer)',
    'public.platform_admin_set_tenant_cost_policy(' ||
      'uuid,bigint,bigint,integer,integer,integer,text)',
    'public.learning_operation_capability_health(text)',
    'public.tenant_get_voice_profile()'
  ]
  loop
    if has_function_privilege('anon', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
    then
      raise exception 'OPS-05 failed: platform surface % is exposed', signature;
    end if;
  end loop;

  -- The durable counters and budgets reject every direct write.
  foreach signature in array array[
    'provider_rate_events',
    'tenant_cost_policies'
  ]
  loop
    if has_table_privilege('authenticated', 'public.' || signature, 'INSERT')
      or has_table_privilege('authenticated', 'public.' || signature, 'UPDATE')
      or has_table_privilege('authenticated', 'public.' || signature, 'DELETE')
      or has_table_privilege('anon', 'public.' || signature, 'SELECT')
    then
      raise exception 'OPS-05 failed: % accepts a direct write', signature;
    end if;
  end loop;
  if has_table_privilege(
    'authenticated',
    'app_private.learning_operation_secrets',
    'SELECT'
  ) then
    raise exception 'OPS-05 failed: operation secrets are directly readable';
  end if;
  if has_table_privilege('authenticated', 'public.cost_ledger', 'UPDATE')
    or has_table_privilege('authenticated', 'public.cost_ledger', 'DELETE')
  then
    raise exception 'OPS-05 failed: the cost ledger is not append-only';
  end if;
end $$;

rollback;

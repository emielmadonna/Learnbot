-- Circle Custom OAuth 2.0 bridge.
--
-- Only SHA-256 digests of client secrets, authorization codes, OAuth state,
-- and bearer tokens are persisted. Raw values exist only in the request that
-- creates or exchanges them and are returned to the caller when OAuth
-- requires it. The app_private tables are RLS-protected and reachable only
-- through the narrowly validated functions below.

begin;

create table app_private.circle_oauth_clients (
  client_id text primary key
    check (client_id ~ '^circle_[0-9a-f]{32}$'),
  tenant_id uuid not null references public.tenants(tenant_id),
  client_secret_hash text not null
    check (client_secret_hash ~ '^[0-9a-f]{64}$'),
  redirect_uri text not null
    check (
      length(redirect_uri) between 10 and 2048
      and redirect_uri !~ '[[:space:]#]'
      and (
        redirect_uri ~ '^https://'
        or redirect_uri ~ '^http://(localhost|127[.]0[.]0[.]1)(:[0-9]+)?/'
      )
    ),
  scopes text[] not null default array['openid', 'email', 'profile']::text[]
    check (
      scopes <@ array['openid', 'email', 'profile']::text[]
      and 'openid' = any(scopes)
      and 'email' = any(scopes)
    ),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index circle_oauth_clients_tenant_idx
  on app_private.circle_oauth_clients (tenant_id, created_at desc);

create table app_private.circle_oauth_codes (
  oauth_code_id uuid primary key default gen_random_uuid(),
  client_id text not null references app_private.circle_oauth_clients(client_id),
  tenant_id uuid not null references public.tenants(tenant_id),
  redirect_uri text not null,
  state_hash text not null check (state_hash ~ '^[0-9a-f]{64}$'),
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  code_challenge text,
  code_challenge_method text,
  nonce text,
  scopes text[] not null,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  code_expires_at timestamptz not null default (now() + interval '5 minutes'),
  code_used_at timestamptz,
  access_token_hash text unique check (
    access_token_hash is null or access_token_hash ~ '^[0-9a-f]{64}$'
  ),
  access_token_expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  check (code_challenge_method is null or code_challenge_method = 'S256'),
  check (code_challenge_method is not null or code_challenge is null),
  check (access_token_hash is null or access_token_expires_at is not null)
);
create index circle_oauth_codes_token_idx
  on app_private.circle_oauth_codes (access_token_hash)
  where access_token_hash is not null;
create index circle_oauth_codes_expiry_idx
  on app_private.circle_oauth_codes (code_expires_at, access_token_expires_at);

alter table app_private.circle_oauth_clients enable row level security;
alter table app_private.circle_oauth_codes enable row level security;
revoke all on table app_private.circle_oauth_clients, app_private.circle_oauth_codes
  from public, anon, authenticated;
grant select, insert, update on table
  app_private.circle_oauth_clients, app_private.circle_oauth_codes
  to service_role;

create or replace function public.circle_oauth_client_details(
  requested_client_id text
)
returns table (
  tenant_id uuid,
  client_id text,
  redirect_uri text,
  scopes text[]
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select c.tenant_id, c.client_id, c.redirect_uri, c.scopes
  from app_private.circle_oauth_clients c
  join public.tenants t on t.tenant_id = c.tenant_id
  where c.client_id = btrim(requested_client_id)
    and c.enabled
    and t.status in ('provisioning', 'active')
    and t.deleted_at is null;
$$;

create or replace function public.circle_oauth_issue_code(
  requested_client_id text,
  requested_redirect_uri text,
  requested_state_hash text,
  requested_code_hash text,
  requested_scopes text[],
  requested_code_challenge text default null,
  requested_code_challenge_method text default null,
  requested_nonce text default null
)
returns table (
  ok boolean,
  code text,
  tenant_id uuid,
  code_expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller_id uuid := auth.uid();
  client app_private.circle_oauth_clients%rowtype;
  linked_principal_id text;
  expires_at timestamptz := clock_timestamp() + interval '5 minutes';
begin
  if caller_id is null
    or requested_client_id is null
    or requested_redirect_uri is null
    or requested_state_hash is null
    or requested_code_hash is null
    or requested_state_hash !~ '^[0-9a-f]{64}$'
    or requested_code_hash !~ '^[0-9a-f]{64}$'
    or requested_scopes is null
    or not ('openid' = any(requested_scopes))
    or not ('email' = any(requested_scopes))
  then
    ok := false;
    code := 'invalid_request';
    return next;
    return;
  end if;

  select c.* into client
  from app_private.circle_oauth_clients c
  where c.client_id = btrim(requested_client_id)
    and c.enabled;
  if not found
    or client.redirect_uri <> requested_redirect_uri
    or not (requested_scopes <@ client.scopes)
  then
    ok := false;
    code := 'invalid_request';
    return next;
    return;
  end if;

  select l.principal_id into linked_principal_id
  from app_private.supabase_auth_principal_links l
  join public.identity_memberships m
    on m.principal_id = l.principal_id
   and m.tenant_id = client.tenant_id
  join public.tenants t on t.tenant_id = m.tenant_id
  where l.auth_user_id = caller_id
    and m.status = 'active'
    and m.deleted_at is null
    and t.status in ('provisioning', 'active')
    and t.deleted_at is null;
  if linked_principal_id is null then
    ok := false;
    code := 'access_denied';
    return next;
    return;
  end if;

  insert into app_private.circle_oauth_codes (
    client_id, tenant_id, redirect_uri, state_hash, code_hash,
    code_challenge, code_challenge_method, nonce, scopes,
    auth_user_id, code_expires_at
  ) values (
    client.client_id, client.tenant_id, client.redirect_uri,
    requested_state_hash, requested_code_hash,
    requested_code_challenge, requested_code_challenge_method, requested_nonce,
    requested_scopes, caller_id, expires_at
  );

  ok := true;
  code := 'issued';
  tenant_id := client.tenant_id;
  code_expires_at := expires_at;
  return next;
exception when unique_violation then
  ok := false;
  code := 'invalid_request';
  return next;
end;
$$;

create or replace function public.circle_oauth_redeem_code(
  requested_client_id text,
  requested_client_secret_hash text,
  requested_redirect_uri text,
  requested_code_hash text,
  requested_code_verifier_hash text,
  requested_access_token_hash text
)
returns table (
  ok boolean,
  code text,
  tenant_id uuid,
  auth_user_id uuid,
  email text,
  name text,
  scopes text[],
  access_token_expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  client app_private.circle_oauth_clients%rowtype;
  oauth_code app_private.circle_oauth_codes%rowtype;
  expires_at timestamptz := clock_timestamp() + interval '1 hour';
begin
  if requested_client_id is null
    or requested_client_secret_hash is null
    or requested_redirect_uri is null
    or requested_code_hash is null
    or requested_access_token_hash is null
    or requested_client_secret_hash !~ '^[0-9a-f]{64}$'
    or requested_code_hash !~ '^[0-9a-f]{64}$'
    or requested_access_token_hash !~ '^[0-9a-f]{64}$'
  then
    ok := false;
    code := 'invalid_request';
    return next;
    return;
  end if;

  select c.* into client
  from app_private.circle_oauth_clients c
  where c.client_id = btrim(requested_client_id)
    and c.enabled;
  if not found or client.client_secret_hash <> requested_client_secret_hash then
    ok := false;
    code := 'invalid_client';
    return next;
    return;
  end if;

  select * into oauth_code
  from app_private.circle_oauth_codes
  where code_hash = requested_code_hash
    and client_id = client.client_id
    and redirect_uri = requested_redirect_uri
  for update;
  if not found
    or oauth_code.code_used_at is not null
    or oauth_code.code_expires_at <= clock_timestamp()
    or (
      oauth_code.code_challenge is not null
      and (
        requested_code_verifier_hash is null
        or oauth_code.code_challenge <> requested_code_verifier_hash
      )
    )
  then
    ok := false;
    code := 'invalid_grant';
    return next;
    return;
  end if;

  update app_private.circle_oauth_codes
  set
    code_used_at = clock_timestamp(),
    access_token_hash = requested_access_token_hash,
    access_token_expires_at = expires_at
  where oauth_code_id = oauth_code.oauth_code_id;

  select
    true,
    'redeemed',
    oauth_code.tenant_id,
    oauth_code.auth_user_id,
    u.email,
    coalesce(p.display_name, split_part(u.email, '@', 1)),
    oauth_code.scopes,
    expires_at
  into ok, code, tenant_id, auth_user_id, email, name, scopes,
    access_token_expires_at
  from auth.users u
  left join public.profiles p
    on p.tenant_id = oauth_code.tenant_id
   and p.user_id = u.id
   and p.deleted_at is null
  where u.id = oauth_code.auth_user_id
    and u.deleted_at is null
    and u.email is not null;
  if not found then
    ok := false;
    code := 'invalid_grant';
    return next;
    return;
  end if;
  return next;
end;
$$;

create or replace function public.circle_oauth_userinfo(
  requested_access_token_hash text
)
returns table (
  ok boolean,
  code text,
  sub text,
  tenant_id uuid,
  email text,
  name text,
  scopes text[]
)
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
begin
  if requested_access_token_hash is null
    or requested_access_token_hash !~ '^[0-9a-f]{64}$'
  then
    ok := false;
    code := 'invalid_token';
    return next;
    return;
  end if;

  select
    true,
    'valid',
    'supabase-auth:' || c.auth_user_id::text,
    c.tenant_id,
    u.email,
    coalesce(p.display_name, split_part(u.email, '@', 1)),
    c.scopes
  into ok, code, sub, tenant_id, email, name, scopes
  from app_private.circle_oauth_codes c
  join auth.users u on u.id = c.auth_user_id
  left join public.profiles p
    on p.tenant_id = c.tenant_id
   and p.user_id = c.auth_user_id
   and p.deleted_at is null
  where c.access_token_hash = requested_access_token_hash
    and c.access_token_expires_at > clock_timestamp()
    and u.deleted_at is null
    and u.email is not null;
  if not found then
    ok := false;
    code := 'invalid_token';
    return next;
    return;
  end if;

  update app_private.circle_oauth_codes
  set last_used_at = clock_timestamp()
  where access_token_hash = requested_access_token_hash;
  return next;
end;
$$;

create or replace function public.circle_oauth_register_client(
  requested_redirect_uri text,
  requested_scopes text[] default array['openid', 'email', 'profile']::text[]
)
returns table (
  ok boolean,
  code text,
  tenant_id uuid,
  client_id text,
  client_secret text,
  redirect_uri text,
  scopes text[]
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller record;
  new_client_id text;
  new_client_secret text;
begin
  select c.* into caller
  from app_private.supabase_auth_context_for_user(auth.uid()) c;
  if not found or caller.identity_role not in ('tenant_owner', 'tenant_admin') then
    ok := false;
    code := 'access_denied';
    return next;
    return;
  end if;
  if requested_redirect_uri is null
    or length(requested_redirect_uri) not between 10 and 2048
    or requested_redirect_uri ~ '[[:space:]#]'
    or (
      requested_redirect_uri !~ '^https://'
      and requested_redirect_uri !~ '^http://(localhost|127[.]0[.]0[.]1)(:[0-9]+)?/'
    )
    or requested_scopes is null
    or not (requested_scopes <@ array['openid', 'email', 'profile']::text[])
    or not ('openid' = any(requested_scopes))
    or not ('email' = any(requested_scopes))
  then
    ok := false;
    code := 'invalid_request';
    return next;
    return;
  end if;

  new_client_secret := translate(
    encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_'
  );
  loop
    new_client_id := 'circle_' || encode(extensions.gen_random_bytes(16), 'hex');
    exit when not exists (
      select 1 from app_private.circle_oauth_clients c
      where c.client_id = new_client_id
    );
  end loop;
  insert into app_private.circle_oauth_clients (
    client_id, tenant_id, client_secret_hash, redirect_uri, scopes
  ) values (
    new_client_id,
    caller.tenant_id,
    encode(extensions.digest(new_client_secret, 'sha256'), 'hex'),
    requested_redirect_uri,
    requested_scopes
  );
  ok := true;
  code := 'created';
  tenant_id := caller.tenant_id;
  client_id := new_client_id;
  client_secret := new_client_secret;
  redirect_uri := requested_redirect_uri;
  scopes := requested_scopes;
  return next;
end;
$$;

create or replace function public.circle_oauth_list_clients()
returns table (
  tenant_id uuid,
  client_id text,
  redirect_uri text,
  scopes text[],
  enabled boolean,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select c.tenant_id, c.client_id, c.redirect_uri, c.scopes, c.enabled, c.created_at
  from app_private.circle_oauth_clients c
  where c.tenant_id = (select context.tenant_id from app_private.supabase_auth_context_for_user(auth.uid()) context)
  order by c.created_at desc;
$$;

revoke execute on function public.circle_oauth_client_details(text)
  from public;
revoke execute on function public.circle_oauth_issue_code(text, text, text, text, text[], text, text, text)
  from public, anon;
revoke execute on function public.circle_oauth_redeem_code(text, text, text, text, text, text)
  from public;
revoke execute on function public.circle_oauth_userinfo(text)
  from public;
revoke execute on function public.circle_oauth_register_client(text, text[])
  from public, anon;
revoke execute on function public.circle_oauth_list_clients()
  from public, anon;

grant execute on function public.circle_oauth_client_details(text)
  to anon, authenticated;
grant execute on function public.circle_oauth_issue_code(text, text, text, text, text[], text, text, text)
  to authenticated;
grant execute on function public.circle_oauth_redeem_code(text, text, text, text, text, text)
  to anon, authenticated;
grant execute on function public.circle_oauth_userinfo(text)
  to anon, authenticated;
grant execute on function public.circle_oauth_register_client(text, text[])
  to authenticated;
grant execute on function public.circle_oauth_list_clients()
  to authenticated;

commit;

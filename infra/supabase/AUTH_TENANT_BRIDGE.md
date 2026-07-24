# Supabase Auth tenant bridge

Migration `0011_supabase_auth_tenant_bridge.sql` connects a verified Supabase
Auth user to LearningBot's durable opaque-principal identity model. It does not
trust browser-supplied tenant or role values.

Run it as part of the complete ordered migration set through
`0016_onboarding_invitation_conflict_constraint.sql`. Migrations 0013–0016 are
forward-only corrections for PostgreSQL parameter/column name resolution
exposed by hosted tenant-selection and authenticated-onboarding acceptance;
they do not weaken the UID, membership or RPC privilege boundary described
here.

## Trust boundary

- `auth.uid()` is the only caller identity accepted by the authenticated RPCs.
- First-owner bootstrap requires a non-anonymous, active Auth user with a
  confirmed email or phone.
- `raw_user_meta_data` / JWT `user_metadata` is never read for authorization.
- The selected tenant is stored in `app_private` and is valid only while the
  exact `(tenant_id, membership_id, principal_id)` membership remains active.
- Existing RLS helpers resolve linked Supabase users from that database
  selection. A stale access token cannot retain access after a tenant switch,
  suspension or revocation.
- The custom access-token hook copies the current durable context into
  `app_metadata` to make clients refresh-aware. Those claims are presentation
  hints; database membership remains authoritative.
- The coarse SQL-era role mapping is explicit: `tenant_owner → owner`,
  `tenant_admin → client_admin`, `creator/teacher → client_viewer`,
  `student → student`, and `service → system_worker`. Creator/teacher writes
  remain behind the server's exact identity-role authorization boundary rather
  than inheriting tenant-administrator rights. A role from one tenant is never
  reused for another tenant.

Every `SECURITY DEFINER` function has `search_path = pg_catalog`, uses
schema-qualified objects and revokes `EXECUTE` from `PUBLIC`. The Auth hook is
executable only by `supabase_auth_admin`; the four UID-bound application RPCs
are executable only by `authenticated`.

## Application flow

After Supabase Auth verifies the user:

1. Call `auth_bootstrap_tenant_owner(...)` once for a new account. It
   atomically creates the tenant, canonical legacy roles, opaque principal,
   owner memberships, draft branding, onboarding workspace, all fourteen
   onboarding steps, the private Auth link/selection and an append-only audit
   event. Retries for the same Auth user return the existing owner context and
   never create a second tenant.
2. Call `auth_list_tenant_memberships()` to render the tenant picker.
3. Call `auth_select_tenant(target_tenant_id, request_id, trace_id)`. An exact
   active membership is required. Allowed and denied attempts are appended to
   `identity_audit_events`; denied selection returns
   `membership_not_active` and does not reveal or change another tenant.
4. Call `auth_current_tenant_context()`. If
   `claims_refresh_required = true`, refresh the Supabase session before using
   claims for display. Do not delay authorization on that refresh; RLS already
   uses the durable membership.

Anonymous signup remains disabled in `config.toml`. Whether public verified
users may self-create tenants is a product enrollment choice: production Auth
signup/allow-list settings must match the approved acquisition policy. Do not
expose `service_role` to implement this flow.

## Enable the access-token hook

The migration creates `public.learningbot_custom_access_token_hook(jsonb)` and
the required least-privilege grants. After the migration is verified in
staging, configure that function as the project's **Custom Access Token**
Postgres hook under Authentication → Hooks. Hook activation is project
configuration and is intentionally not guessed or silently changed by SQL.

The hook removes stale legacy LearningBot custom claims and writes these
database-verified `app_metadata` keys when an active selection exists:

- `learningbot_tenant_id`
- `learningbot_membership_id`
- `learningbot_app_role`
- `learningbot_selection_version`

Session refresh is still required before a client sees new hook output.

## Verification

Run the structural verifier:

```sh
node infra/supabase/scripts/verify-auth-tenant-bridge.mjs
```

Run the SQL suite after all migrations on a disposable local or dedicated
staging database:

```sh
psql "$DATABASE_URL" \
  --set ON_ERROR_STOP=1 \
  --file infra/supabase/tests/auth_tenant_bridge_verification.sql
```

The transactional SQL suite rolls back its fixtures and covers:

- `AUTH-01`: verified first-owner bootstrap and retry idempotency;
- `AUTH-02`: forged `user_metadata` cannot create tenant/role access;
- `AUTH-03`: exact multi-tenant selection, stale-claim fallback and
  cross-tenant denial with audit evidence;
- `AUTH-04`: immediate revocation despite an unrefreshed JWT;
- `AUTH-05`: private-table and privileged-function boundaries.

Run this suite on PostgreSQL/Supabase; the Node structural check is not a
substitute for executing the SQL.

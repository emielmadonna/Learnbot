# Production Supabase Auth boundary

The production web entry points are:

- `/auth/sign-in` — passwordless work-email sign-in;
- `/auth/callback` — PKCE code exchange and verified-user check;
- `/onboarding` — first-owner tenant bootstrap or durable tenant selection;
- `/app` — authenticated tenant-context landing page.

The existing `/dev/**` routes remain explicitly labeled fixture previews. They
are not a fallback for any production authentication or tenant RPC failure.

## Required environment

Set these in local `.env.local` and in the deployment environment:

```text
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Only use a Supabase publishable key. This application never needs or accepts a
secret/service-role key in browser code.

In Supabase Auth URL Configuration, set the production application origin as
the Site URL and allow these exact callback patterns for the environments that
are intentionally supported:

```text
http://127.0.0.1:3100/auth/callback
https://<production-origin>/auth/callback
```

Configure a production SMTP provider before relying on magic-link delivery.
Supabase's default email service is intended for trial use and may be restricted
to organization members.

## Database contract

Apply and verify the complete ordered migration set through
`0016_onboarding_invitation_conflict_constraint.sql` before enabling this
surface. The web boundary uses:

- `auth_bootstrap_tenant_owner`
- `auth_list_tenant_memberships`
- `auth_select_tenant`
- `auth_current_tenant_context`

Migration `0012_authenticated_onboarding_rpcs.sql` enables the production
onboarding workspace. Forward migrations 0013–0016 preserve that contract while
correcting PostgreSQL parameter/column name resolution found by hosted
transactional acceptance. `/onboarding` loads only its durable snapshot and
uses UID-bound RPCs for profile/branding, readiness evidence, invitation
creation/revocation, and exact authenticated-email acceptance. Application
denials arrive as `{ ok: false, code }` and are always shown as failures.
Invitation creation persists the invitation but does not claim that an email
was delivered; an approved delivery connector remains required.

Enable `public.learningbot_custom_access_token_hook(jsonb)` as the project's
Custom Access Token Hook after applying the migration. The database's durable
selection remains the authorization source of truth; JWT application metadata
is refreshed for client display and never treated as the sole authority.

Creator/Teacher authorization must use the exact `identity_role` returned by
the database. The coarser `app_role` exists for the existing RLS contract and
must not grant Creator users tenant-administration privileges.

All mutations require same-origin POST requests, a verified non-anonymous
Supabase user, and a database membership check. Missing environment values,
RPC errors, stale/revoked memberships, and failed claim refreshes close access
without substituting fixture data.

O-07 recording policy and O-13 retention policy remain locked. The production
UI cannot mark those steps complete without approved human policy records.

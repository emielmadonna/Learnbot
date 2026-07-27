# OIDC assertion verifier

**This package is a JWT verifier. It is not the application's authentication.**

Nothing in `apps/` imports it. The console authenticates through Supabase Auth
(`lib/supabase/auth-boundary.ts` → `auth_current_access_state`), and roles come
from `public.identity_memberships` via `SECURITY DEFINER` RPCs. This package is
kept on ice for the day an enterprise buyer requires OIDC SSO, because
`src/oidc.ts` is 376 lines of real, `jose`-backed verification that would be
tedious and risky to rewrite under deal pressure.

## What is here

`OidcAssertionVerifier` verifies a raw compact JWT and produces a
`VerifiedAuthenticationAssertion`:

- exact issuer and audience pinning, explicit algorithm allowlist;
- bounded clock skew and maximum token age;
- local (pinned JWK) or HTTPS remote JWKS resolution, with an injected `fetch`
  and `kid`-triggered refresh for key rotation;
- only `sub` plus optional email / name / session claims are mapped. Tenant,
  role, permission and scope claims are **never** promoted to authorization —
  the same rule `learningbot_custom_access_token_hook` (`0011:917-921`) enforces
  by stripping `tenant_id`/`app_role` from Supabase access tokens.

## What was deleted on 2026-07-26, and why

`fakes.ts`, `service.ts`, `repositories.ts`, `permissions.ts`, `host-context.ts`
and `errors.ts` were removed. They described SAML, SCIM provisioning, invitation
acceptance, host-signed embed trust and a tenant-authorization service. None of
it was implemented:

- **SAML** existed only as a string in a union. There was never a SAML file.
- **SCIM** had no `/scim/v2/*` route, no schema parser, no filter parser, no
  PATCH parser. `identity_scim_bindings` and `identity_scim_receipts`
  (`0008:150,167`) are referenced by zero SQL functions and zero app code.
- The service layer required injected repositories whose only implementations
  were the in-memory fakes.

An enterprise buyer asking for "Okta SSO" or "SCIM deprovisioning" gets neither
today. Keeping the stubs made that harder to see, not easier.

## Wiring it, if that day comes

1. Configure `OidcAssertionVerifier` with the exact issuer, audience, algorithm
   allowlist, token-age policy and JWKS source, then call `verify`. OIDC
   discovery and the credential exchange itself are outside this package.
2. Exchange the resulting assertion for a Supabase session, then let the
   existing `auth-boundary.ts` → RPC path resolve tenant and role as it already
   does. Do not build a second authorization model in TypeScript.

## Commands

```sh
pnpm --filter @course-ai/identity-access typecheck
pnpm --filter @course-ai/identity-access build
pnpm --filter @course-ai/identity-access test
```

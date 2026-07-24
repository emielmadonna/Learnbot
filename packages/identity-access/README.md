# Identity access boundary

Provider-neutral identity and tenant authorization for LearningBot. This package
accepts verified OIDC/SAML assertions, verified signed host contexts, or
registered service principals. Its OIDC boundary verifies raw compact JWTs
before producing an assertion, and it never treats a request-body tenant ID as
authorization.

## Boundary guarantees

- Normalizes OIDC, SAML, host-signed embed, and service-principal identities.
- Resolves tenant scope from active repository membership. A client-provided
  tenant is only a selector among memberships already granted to the principal.
- Verifies compact signed host contexts through pluggable key and signature
  abstractions, including `kid` rotation, issuer, audience, algorithm, nonce,
  issued-at, maximum lifetime, expiry, and single-use replay checks.
- Verifies OIDC JWTs with `jose`, an explicit issuer/audience/algorithm policy,
  bounded clock skew and token age, and local or HTTPS remote JWKS resolution.
  Remote resolution supports an injected fetch implementation and `kid`
  refresh for key rotation.
- Maps only subject and optional email/name/session claims from OIDC. Tenant,
  role, permission, and scope claims are never promoted to authorization.
- Maps active memberships to the exact `PlatformRole` and
  `PlatformPermission` contracts in `@course-ai/application-services`.
- Intersects service-role permissions with registered API/MCP scopes.
- Supports idempotent invitation acceptance and SCIM-style provision /
  deprovision commands.
- Emits redacted audit events and converts unexpected failures to stable,
  non-enumerating errors.

## Integration contract

At an HTTP, realtime, or MCP boundary:

1. For a compact OIDC JWT, configure `OidcAssertionVerifier` with the exact
   issuer, audience, algorithm allowlist, token-age policy, and pinned or remote
   JWKS source, then call `verify`. OIDC discovery and credential exchange
   remain outside this package. A SAML adapter must still verify its assertion
   and certificate policy before constructing a
   `VerifiedAuthenticationAssertion`.
2. For host embeds, call `HostContextVerifier.verify`.
3. Pass the resulting `VerifiedAuthenticationAssertion` to
   `IdentityAccessService.resolveSession`.
4. Pass only the returned `request` / tenant / role / permissions downstream.
   Do not copy tenant or role fields from a request body.

Production implementations must supply durable repositories, a distributed
atomic replay store, an approved crypto verifier/HSM or KMS integration,
transactional invitation/SCIM writes, and a durable audit sink. The deterministic
fakes are test-only and are intentionally not cryptographic.

## Commands

```sh
pnpm --filter @course-ai/identity-access typecheck
pnpm --filter @course-ai/identity-access build
pnpm --filter @course-ai/identity-access test
```

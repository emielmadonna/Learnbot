# Identity access boundary

Provider-neutral identity and tenant authorization for LearningBot. This package
accepts only already-verified OIDC/SAML assertions, verified signed host
contexts, or registered service principals. It never accepts a raw IdP token
and never treats a request-body tenant ID as authorization.

## Boundary guarantees

- Normalizes OIDC, SAML, host-signed embed, and service-principal identities.
- Resolves tenant scope from active repository membership. A client-provided
  tenant is only a selector among memberships already granted to the principal.
- Verifies compact signed host contexts through pluggable key and signature
  abstractions, including `kid` rotation, issuer, audience, algorithm, nonce,
  issued-at, maximum lifetime, expiry, and single-use replay checks.
- Maps active memberships to the exact `PlatformRole` and
  `PlatformPermission` contracts in `@course-ai/application-services`.
- Intersects service-role permissions with registered API/MCP scopes.
- Supports idempotent invitation acceptance and SCIM-style provision /
  deprovision commands.
- Emits redacted audit events and converts unexpected failures to stable,
  non-enumerating errors.

## Integration contract

At an HTTP, realtime, or MCP boundary:

1. A protocol adapter verifies the IdP assertion. OIDC discovery/JWK validation,
   SAML XML signature validation, certificate policy, and credential exchange
   remain outside this package.
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

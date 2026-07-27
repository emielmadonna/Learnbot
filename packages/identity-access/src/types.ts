import type { IsoTimestamp, TenantId } from "@course-ai/contracts";

/**
 * The one type the OIDC verifier produces.
 *
 * This file used to carry a much larger identity model — principals,
 * memberships, invitations, SCIM provisioning commands, a `"saml"` method — all
 * of which described capabilities that did not exist. There was never a SAML
 * file, never a `/scim/v2/*` route, never a schema or filter or PATCH parser,
 * and `identity_scim_bindings`/`identity_scim_receipts` (`0008:150,167`) are
 * referenced by zero SQL functions and zero application code. Those stubs were
 * deleted on 2026-07-26 so that nobody reads them as an implementation.
 *
 * `host_signed` and `service_principal` are retained in the union because the
 * shape of a verified assertion is protocol-independent by design, but note
 * that no verifier for either exists here either. Only `oidc` has one.
 */
export type AuthenticationMethod =
  | "oidc"
  | "host_signed"
  | "service_principal";

/**
 * An assertion is accepted only after the protocol-specific verifier has
 * authenticated it. Raw bearer tokens deliberately do not fit this interface.
 *
 * Authorization claims are intentionally absent. Roles and tenant membership
 * are read from `public.identity_memberships` in Postgres, never from a token —
 * `learningbot_custom_access_token_hook` (`0011:917-921`) strips top-level
 * `tenant_id`/`app_role` for exactly this reason.
 */
export interface VerifiedAuthenticationAssertion {
  readonly method: AuthenticationMethod;
  readonly issuer: string;
  readonly subject: string;
  readonly authenticatedAt: IsoTimestamp;
  readonly sessionId?: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly tenantBinding?: TenantId;
  readonly servicePrincipalId?: string;
  readonly grantedScopes?: readonly string[];
}

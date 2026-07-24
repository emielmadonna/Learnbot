import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
  type RemoteJWKSetOptions,
} from "jose";

import type { VerifiedAuthenticationAssertion } from "./types.js";

const DEFAULT_CLOCK_SKEW_SECONDS = 30;
const MAX_CLOCK_SKEW_SECONDS = 300;
const MAX_TOKEN_AGE_SECONDS = 30 * 24 * 60 * 60;
const MAX_COMPACT_TOKEN_LENGTH = 64 * 1024;

export type OidcVerificationErrorCode =
  | "OIDC_CONFIGURATION_INVALID"
  | "OIDC_TOKEN_INVALID"
  | "OIDC_TOKEN_EXPIRED"
  | "OIDC_KEY_UNAVAILABLE";

const SAFE_ERROR_MESSAGES: Readonly<
  Record<OidcVerificationErrorCode, string>
> = {
  OIDC_CONFIGURATION_INVALID: "The OIDC verifier configuration is invalid.",
  OIDC_TOKEN_INVALID: "The OIDC assertion could not be verified.",
  OIDC_TOKEN_EXPIRED: "The OIDC assertion has expired.",
  OIDC_KEY_UNAVAILABLE: "The OIDC signing keys are unavailable.",
};

/** A low-detail error suitable for an authentication boundary. */
export class OidcVerificationError extends Error {
  readonly code: OidcVerificationErrorCode;

  constructor(code: OidcVerificationErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = "OidcVerificationError";
    this.code = code;
  }
}

export interface OidcClaimMapping {
  readonly emailClaim: string;
  readonly displayNameClaim: string;
  readonly sessionIdClaim: string;
}

export interface LocalOidcJwksSource {
  readonly kind: "local";
  /** Pinned/test JWKS. Private key material must never be supplied here. */
  readonly jwks: JSONWebKeySet;
}

export interface RemoteOidcJwksSource {
  readonly kind: "remote";
  readonly uri: string | URL;
  /** Enables connection policy, observability, and deterministic integration tests. */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly cooldownMs?: number;
  readonly cacheMaxAgeMs?: number;
}

export type OidcJwksSource = LocalOidcJwksSource | RemoteOidcJwksSource;

export interface OidcVerificationPolicy {
  readonly issuer: string;
  readonly audience: string | readonly string[];
  readonly allowedAlgorithms: readonly string[];
  readonly maxTokenAgeSeconds: number;
  readonly clockSkewSeconds?: number;
  readonly claimMapping?: Partial<OidcClaimMapping>;
}

export interface OidcAssertionVerifierOptions {
  readonly policy: OidcVerificationPolicy;
  readonly jwks: OidcJwksSource;
  /** Test seam only; production callers should omit it. */
  readonly now?: () => Date;
}

const DEFAULT_CLAIM_MAPPING: OidcClaimMapping = {
  emailClaim: "email",
  displayNameClaim: "name",
  sessionIdClaim: "sid",
};

/**
 * Verifies a compact OIDC JWT and returns only provider-neutral identity
 * evidence. Tenant, role, permission, and scope claims are intentionally
 * ignored; authorization continues to come from membership storage.
 */
export class OidcAssertionVerifier {
  private readonly policy: OidcVerificationPolicy;
  private readonly clockSkewSeconds: number;
  private readonly claims: OidcClaimMapping;
  private readonly resolveKey: JWTVerifyGetKey;
  private readonly now: () => Date;
  private readonly usesRemoteKeys: boolean;

  constructor(options: OidcAssertionVerifierOptions) {
    validatePolicy(options.policy);
    this.policy = options.policy;
    this.clockSkewSeconds =
      options.policy.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
    this.claims = {
      ...DEFAULT_CLAIM_MAPPING,
      ...options.policy.claimMapping,
    };
    validateClaimMapping(this.claims);
    this.now = options.now ?? (() => new Date());
    this.usesRemoteKeys = options.jwks.kind === "remote";
    this.resolveKey = createKeyResolver(options.jwks);
  }

  async verify(compactToken: string): Promise<VerifiedAuthenticationAssertion> {
    if (
      typeof compactToken !== "string" ||
      compactToken.length === 0 ||
      compactToken.length > MAX_COMPACT_TOKEN_LENGTH
    ) {
      throw new OidcVerificationError("OIDC_TOKEN_INVALID");
    }

    const now = this.now();
    if (!Number.isFinite(now.getTime())) {
      throw new OidcVerificationError("OIDC_CONFIGURATION_INVALID");
    }

    try {
      const { payload } = await jwtVerify(compactToken, this.resolveKey, {
        issuer: this.policy.issuer,
        audience:
          typeof this.policy.audience === "string"
            ? this.policy.audience
            : [...this.policy.audience],
        algorithms: [...this.policy.allowedAlgorithms],
        clockTolerance: this.clockSkewSeconds,
        currentDate: now,
        maxTokenAge: this.policy.maxTokenAgeSeconds,
        requiredClaims: ["exp", "iat", "sub"],
      });

      const subject = requiredStringClaim(payload.sub, 1_024);
      const issuedAt = requiredNumericDate(payload.iat);
      const nowSeconds = Math.floor(now.getTime() / 1_000);
      if (issuedAt > nowSeconds + this.clockSkewSeconds) {
        throw new OidcVerificationError("OIDC_TOKEN_INVALID");
      }

      const email = optionalStringClaim(
        payload[this.claims.emailClaim],
        3_200,
      );
      const displayName = optionalStringClaim(
        payload[this.claims.displayNameClaim],
        1_024,
      );
      const sessionId = optionalStringClaim(
        payload[this.claims.sessionIdClaim],
        1_024,
      );

      return {
        method: "oidc",
        issuer: this.policy.issuer,
        subject,
        authenticatedAt: new Date(issuedAt * 1_000).toISOString(),
        ...(email === undefined ? {} : { email }),
        ...(displayName === undefined ? {} : { displayName }),
        ...(sessionId === undefined ? {} : { sessionId }),
      };
    } catch (error) {
      if (error instanceof OidcVerificationError) {
        throw error;
      }
      if (error instanceof joseErrors.JWTExpired) {
        throw new OidcVerificationError("OIDC_TOKEN_EXPIRED");
      }
      if (isRemoteKeyAvailabilityFailure(error, this.usesRemoteKeys)) {
        throw new OidcVerificationError("OIDC_KEY_UNAVAILABLE");
      }
      throw new OidcVerificationError("OIDC_TOKEN_INVALID");
    }
  }
}

function createKeyResolver(source: OidcJwksSource): JWTVerifyGetKey {
  if (source.kind === "local") {
    if (
      !source.jwks ||
      !Array.isArray(source.jwks.keys) ||
      source.jwks.keys.length === 0
    ) {
      throw new OidcVerificationError("OIDC_CONFIGURATION_INVALID");
    }
    return createLocalJWKSet(source.jwks);
  }

  let uri: URL;
  try {
    uri = source.uri instanceof URL ? source.uri : new URL(source.uri);
  } catch {
    throw new OidcVerificationError("OIDC_CONFIGURATION_INVALID");
  }
  if (uri.protocol !== "https:") {
    throw new OidcVerificationError("OIDC_CONFIGURATION_INVALID");
  }

  validateOptionalDuration(source.timeoutMs, 1_000, 30_000);
  validateOptionalDuration(source.cooldownMs, 0, 15 * 60_000);
  validateOptionalDuration(source.cacheMaxAgeMs, 1_000, 24 * 60 * 60_000);

  const remoteOptions: RemoteJWKSetOptions = {};
  if (source.timeoutMs !== undefined) {
    remoteOptions.timeoutDuration = source.timeoutMs;
  }
  if (source.cooldownMs !== undefined) {
    remoteOptions.cooldownDuration = source.cooldownMs;
  }
  if (source.cacheMaxAgeMs !== undefined) {
    remoteOptions.cacheMaxAge = source.cacheMaxAgeMs;
  }
  if (source.fetch !== undefined) {
    remoteOptions[customFetch] = source.fetch;
  }
  return createRemoteJWKSet(uri, remoteOptions);
}

function validatePolicy(policy: OidcVerificationPolicy): void {
  if (
    typeof policy.issuer !== "string" ||
    policy.issuer.length === 0 ||
    policy.issuer.length > 2_048
  ) {
    throw new OidcVerificationError("OIDC_CONFIGURATION_INVALID");
  }

  const audiences =
    typeof policy.audience === "string"
      ? [policy.audience]
      : [...policy.audience];
  if (
    audiences.length === 0 ||
    audiences.some(
      (audience) =>
        typeof audience !== "string" ||
        audience.length === 0 ||
        audience.length > 2_048,
    )
  ) {
    throw new OidcVerificationError("OIDC_CONFIGURATION_INVALID");
  }

  if (
    policy.allowedAlgorithms.length === 0 ||
    policy.allowedAlgorithms.some(
      (algorithm) =>
        typeof algorithm !== "string" ||
        algorithm.length === 0 ||
        algorithm.toLowerCase() === "none",
    )
  ) {
    throw new OidcVerificationError("OIDC_CONFIGURATION_INVALID");
  }

  if (
    !Number.isSafeInteger(policy.maxTokenAgeSeconds) ||
    policy.maxTokenAgeSeconds <= 0 ||
    policy.maxTokenAgeSeconds > MAX_TOKEN_AGE_SECONDS
  ) {
    throw new OidcVerificationError("OIDC_CONFIGURATION_INVALID");
  }

  const skew = policy.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  if (
    !Number.isSafeInteger(skew) ||
    skew < 0 ||
    skew > MAX_CLOCK_SKEW_SECONDS
  ) {
    throw new OidcVerificationError("OIDC_CONFIGURATION_INVALID");
  }
}

function validateClaimMapping(mapping: OidcClaimMapping): void {
  const names = [
    mapping.emailClaim,
    mapping.displayNameClaim,
    mapping.sessionIdClaim,
  ];
  if (
    names.some(
      (name) =>
        typeof name !== "string" ||
        name.length === 0 ||
        name.length > 128 ||
        name === "__proto__" ||
        name === "constructor" ||
        name === "prototype",
    )
  ) {
    throw new OidcVerificationError("OIDC_CONFIGURATION_INVALID");
  }
}

function validateOptionalDuration(
  value: number | undefined,
  minimum: number,
  maximum: number,
): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value < minimum || value > maximum)
  ) {
    throw new OidcVerificationError("OIDC_CONFIGURATION_INVALID");
  }
}

function requiredStringClaim(value: unknown, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    throw new OidcVerificationError("OIDC_TOKEN_INVALID");
  }
  return value;
}

function optionalStringClaim(
  value: unknown,
  maximumLength: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requiredStringClaim(value, maximumLength);
}

function requiredNumericDate(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new OidcVerificationError("OIDC_TOKEN_INVALID");
  }
  return value;
}

function isRemoteKeyAvailabilityFailure(
  error: unknown,
  usesRemoteKeys: boolean,
): boolean {
  if (!usesRemoteKeys) {
    return false;
  }
  if (error instanceof TypeError) {
    return true;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return (
      error.code === "ERR_JWKS_TIMEOUT" ||
      error.code === "ERR_JWKS_FETCH_FAILED"
    );
  }
  return false;
}

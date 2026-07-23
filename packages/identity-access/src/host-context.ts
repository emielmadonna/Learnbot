import { IdentityAccessError } from "./errors.js";
import type {
  HostSignatureVerifier,
  HostVerificationKeyResolver,
  IdentityAuditSink,
  IdentityClock,
  ReplayStore,
} from "./repositories.js";
import type {
  HostContextClaims,
  HostTokenHeader,
  HostVerificationPolicy,
  VerifiedAuthenticationAssertion,
} from "./types.js";

function decodeBase64Url(value: string): Uint8Array {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
      Math.ceil(value.length / 4) * 4,
      "=",
    );
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new IdentityAccessError("TOKEN_INVALID");
  }
}

function parseJson(value: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(value)) as unknown;
  } catch {
    throw new IdentityAccessError("TOKEN_INVALID");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHeader(value: unknown): HostTokenHeader {
  if (
    !isRecord(value) ||
    typeof value.alg !== "string" ||
    value.alg.length === 0 ||
    value.alg === "none" ||
    typeof value.kid !== "string" ||
    value.kid.length === 0 ||
    (value.typ !== undefined && typeof value.typ !== "string")
  ) {
    throw new IdentityAccessError("TOKEN_INVALID");
  }
  return {
    alg: value.alg,
    kid: value.kid,
    ...(value.typ !== undefined ? { typ: value.typ } : {}),
  };
}

function parseClaims(value: unknown): HostContextClaims {
  if (
    !isRecord(value) ||
    typeof value.iss !== "string" ||
    (typeof value.aud !== "string" &&
      (!Array.isArray(value.aud) ||
        !value.aud.every((entry) => typeof entry === "string"))) ||
    typeof value.sub !== "string" ||
    typeof value.tenantId !== "string" ||
    typeof value.nonce !== "string" ||
    typeof value.iat !== "number" ||
    typeof value.exp !== "number" ||
    value.sub.length === 0 ||
    value.tenantId.length === 0 ||
    value.nonce.length < 8 ||
    !Number.isInteger(value.iat) ||
    !Number.isInteger(value.exp) ||
    (value.sessionId !== undefined && typeof value.sessionId !== "string") ||
    (value.email !== undefined && typeof value.email !== "string") ||
    (value.displayName !== undefined && typeof value.displayName !== "string")
  ) {
    throw new IdentityAccessError("TOKEN_INVALID");
  }
  return {
    iss: value.iss,
    aud: value.aud as string | readonly string[],
    sub: value.sub,
    tenantId: value.tenantId,
    nonce: value.nonce,
    iat: value.iat,
    exp: value.exp,
    ...(value.sessionId !== undefined ? { sessionId: value.sessionId } : {}),
    ...(value.email !== undefined ? { email: value.email } : {}),
    ...(value.displayName !== undefined ? { displayName: value.displayName } : {}),
  };
}

export interface HostContextVerifierDependencies {
  readonly policy: HostVerificationPolicy;
  readonly keys: HostVerificationKeyResolver;
  readonly signatures: HostSignatureVerifier;
  readonly replay: ReplayStore;
  readonly clock: IdentityClock;
  readonly audit?: IdentityAuditSink;
}

export class HostContextVerifier {
  constructor(private readonly dependencies: HostContextVerifierDependencies) {}

  async verify(
    compactToken: string,
    requestId?: string,
  ): Promise<VerifiedAuthenticationAssertion> {
    try {
      const segments = compactToken.split(".");
      if (segments.length !== 3) {
        throw new IdentityAccessError("TOKEN_INVALID");
      }
      const [encodedHeader, encodedClaims, encodedSignature] = segments;
      if (
        encodedHeader === undefined ||
        encodedClaims === undefined ||
        encodedSignature === undefined ||
        encodedSignature.length === 0
      ) {
        throw new IdentityAccessError("TOKEN_INVALID");
      }
      const header = parseHeader(parseJson(decodeBase64Url(encodedHeader)));
      if (!this.dependencies.policy.allowedAlgorithms.includes(header.alg)) {
        throw new IdentityAccessError("TOKEN_INVALID");
      }
      const key = await this.dependencies.keys.resolve(
        this.dependencies.policy.trustedIssuer,
        header.kid,
      );
      const nowMs = this.dependencies.clock.now().getTime();
      if (
        key === undefined ||
        key.algorithm !== header.alg ||
        (key.activeFromMs !== undefined && nowMs < key.activeFromMs) ||
        (key.retiredAfterMs !== undefined && nowMs >= key.retiredAfterMs)
      ) {
        throw new IdentityAccessError("TOKEN_INVALID");
      }
      const signatureValid = await this.dependencies.signatures.verify({
        algorithm: header.alg,
        key,
        signingInput: new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
        signature: decodeBase64Url(encodedSignature),
      });
      if (!signatureValid) {
        throw new IdentityAccessError("TOKEN_INVALID");
      }

      const claims = parseClaims(parseJson(decodeBase64Url(encodedClaims)));
      const policy = this.dependencies.policy;
      const nowSeconds = Math.floor(nowMs / 1000);
      const skew = policy.clockSkewSeconds ?? 0;
      const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
      if (claims.iss !== policy.trustedIssuer || !audiences.includes(policy.audience)) {
        throw new IdentityAccessError("TOKEN_INVALID");
      }
      if (claims.exp <= nowSeconds - skew) {
        throw new IdentityAccessError("TOKEN_EXPIRED");
      }
      if (
        claims.iat > nowSeconds + skew ||
        claims.exp <= claims.iat ||
        claims.exp - claims.iat > policy.maximumLifetimeSeconds
      ) {
        throw new IdentityAccessError("TOKEN_INVALID");
      }

      const replayKey = `${claims.iss}\u0000${claims.nonce}`;
      const consumed = await this.dependencies.replay.consumeOnce(
        replayKey,
        claims.exp * 1000,
        nowMs,
      );
      if (!consumed) {
        throw new IdentityAccessError("TOKEN_REPLAYED");
      }
      await this.dependencies.audit?.emit({
        eventId: `host:${claims.nonce}`,
        action: "identity.host_context.verify",
        outcome: "allowed",
        occurredAt: this.dependencies.clock.now().toISOString(),
        ...(requestId !== undefined ? { requestId } : {}),
        tenantId: claims.tenantId,
        safeMetadata: { keyId: header.kid, algorithm: header.alg },
      });
      return {
        method: "host_signed",
        issuer: claims.iss,
        subject: claims.sub,
        tenantBinding: claims.tenantId,
        authenticatedAt: new Date(claims.iat * 1000).toISOString(),
        ...(claims.sessionId !== undefined ? { sessionId: claims.sessionId } : {}),
        ...(claims.email !== undefined ? { email: claims.email } : {}),
        ...(claims.displayName !== undefined
          ? { displayName: claims.displayName }
          : {}),
      };
    } catch (error) {
      const safe =
        error instanceof IdentityAccessError
          ? error
          : new IdentityAccessError("TOKEN_INVALID");
      await this.dependencies.audit?.emit({
        eventId: `host-denied:${requestId ?? "untracked"}`,
        action: "identity.host_context.verify",
        outcome: "denied",
        occurredAt: this.dependencies.clock.now().toISOString(),
        ...(requestId !== undefined ? { requestId } : {}),
        safeMetadata: { code: safe.code },
      });
      throw safe;
    }
  }
}

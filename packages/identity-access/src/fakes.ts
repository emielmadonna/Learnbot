import type { PlatformRole } from "@course-ai/application-services";
import type { ActorId, TenantContext, TenantId } from "@course-ai/contracts";
import type {
  HostSignatureVerifier,
  HostVerificationKeyResolver,
  IdentityAuditSink,
  IdentityClock,
  IdentityIdGenerator,
  InvitationRepository,
  MembershipRepository,
  ReplayStore,
  ScimStateRepository,
  ServicePrincipalRepository,
  TenantIdentityRepository,
} from "./repositories.js";
import type {
  HostContextClaims,
  HostTokenHeader,
  HostVerificationKey,
  IdentityAuditEvent,
  Invitation,
  ServicePrincipal,
  TenantMembership,
} from "./types.js";

export class FixedClock implements IdentityClock {
  constructor(private value: Date) {}
  now(): Date {
    return new Date(this.value);
  }
  set(value: Date): void {
    this.value = new Date(value);
  }
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

export class DeterministicIdentityIds implements IdentityIdGenerator {
  deterministic(prefix: string, scope: string): string {
    return `${prefix}_${stableHash(scope)}`;
  }
}

export class MemoryMembershipRepository implements MembershipRepository {
  readonly records: TenantMembership[];

  constructor(seed: readonly TenantMembership[] = []) {
    this.records = [...seed];
  }

  async listActiveForPrincipal(
    principalId: ActorId,
  ): Promise<readonly TenantMembership[]> {
    return this.records.filter(
      (record) =>
        record.principalId === principalId && record.status === "active",
    );
  }

  async find(
    principalId: ActorId,
    tenantId: TenantId,
  ): Promise<TenantMembership | undefined> {
    return this.records.find(
      (record) =>
        record.principalId === principalId && record.tenantId === tenantId,
    );
  }

  async upsert(input: {
    readonly tenantId: TenantId;
    readonly principalId: ActorId;
    readonly role: PlatformRole;
    readonly provisionedBy: TenantMembership["provisionedBy"];
    readonly now: string;
  }): Promise<TenantMembership> {
    const existingIndex = this.records.findIndex(
      (record) =>
        record.tenantId === input.tenantId &&
        record.principalId === input.principalId,
    );
    const existing = this.records[existingIndex];
    const next: TenantMembership = {
      membershipId:
        existing?.membershipId ??
        `membership_${stableHash(`${input.tenantId}:${input.principalId}`)}`,
      tenantId: input.tenantId,
      principalId: input.principalId,
      role: input.role,
      status: "active",
      provisionedBy: input.provisionedBy,
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
    };
    if (existingIndex >= 0) {
      this.records[existingIndex] = next;
    } else {
      this.records.push(next);
    }
    return next;
  }

  async revoke(
    principalId: ActorId,
    tenantId: TenantId,
    now: string,
  ): Promise<void> {
    const index = this.records.findIndex(
      (record) =>
        record.principalId === principalId && record.tenantId === tenantId,
    );
    const existing = this.records[index];
    if (existing !== undefined) {
      this.records[index] = { ...existing, status: "revoked", updatedAt: now };
    }
  }
}

export class MemoryTenantIdentityRepository
  implements TenantIdentityRepository
{
  constructor(private readonly records: readonly TenantContext[]) {}

  async getActive(tenantId: TenantId): Promise<TenantContext | undefined> {
    return this.records.find(
      (record) => record.tenantId === tenantId && record.status === "active",
    );
  }
}

export class MemoryServicePrincipalRepository
  implements ServicePrincipalRepository
{
  constructor(private readonly records: readonly ServicePrincipal[] = []) {}

  async findByClientId(clientId: string): Promise<ServicePrincipal | undefined> {
    return this.records.find((record) => record.clientId === clientId);
  }
}

export class MemoryInvitationRepository implements InvitationRepository {
  readonly invitations: Map<string, Invitation>;
  readonly acceptances = new Map<
    string,
    { readonly principalId: ActorId; readonly membershipId: string }
  >();

  constructor(seed: readonly Invitation[] = []) {
    this.invitations = new Map(seed.map((item) => [item.invitationId, item]));
  }

  async get(invitationId: string): Promise<Invitation | undefined> {
    return this.invitations.get(invitationId);
  }

  async save(invitation: Invitation): Promise<void> {
    this.invitations.set(invitation.invitationId, invitation);
  }

  async getAcceptance(
    invitationId: string,
    idempotencyKey: string,
  ): Promise<
    { readonly principalId: ActorId; readonly membershipId: string } | undefined
  > {
    return this.acceptances.get(`${invitationId}\u0000${idempotencyKey}`);
  }

  async saveAcceptance(input: {
    readonly invitationId: string;
    readonly idempotencyKey: string;
    readonly principalId: ActorId;
    readonly membershipId: string;
  }): Promise<void> {
    this.acceptances.set(`${input.invitationId}\u0000${input.idempotencyKey}`, {
      principalId: input.principalId,
      membershipId: input.membershipId,
    });
  }
}

export class MemoryScimStateRepository implements ScimStateRepository {
  readonly bindings = new Map<string, ActorId>();
  readonly idempotency = new Map<string, TenantMembership>();

  async getPrincipalId(
    tenantId: TenantId,
    externalId: string,
  ): Promise<ActorId | undefined> {
    return this.bindings.get(`${tenantId}\u0000${externalId}`);
  }

  async bind(
    tenantId: TenantId,
    externalId: string,
    principalId: ActorId,
  ): Promise<void> {
    this.bindings.set(`${tenantId}\u0000${externalId}`, principalId);
  }

  async getIdempotentResult(
    tenantId: TenantId,
    idempotencyKey: string,
  ): Promise<TenantMembership | undefined> {
    return this.idempotency.get(`${tenantId}\u0000${idempotencyKey}`);
  }

  async saveIdempotentResult(
    tenantId: TenantId,
    idempotencyKey: string,
    membership: TenantMembership,
  ): Promise<void> {
    this.idempotency.set(`${tenantId}\u0000${idempotencyKey}`, membership);
  }
}

export class MemoryAuditSink implements IdentityAuditSink {
  readonly events: IdentityAuditEvent[] = [];
  async emit(event: IdentityAuditEvent): Promise<void> {
    this.events.push(event);
  }
}

export class MemoryReplayStore implements ReplayStore {
  readonly consumed = new Map<string, number>();

  async consumeOnce(
    key: string,
    expiresAtMs: number,
    nowMs: number,
  ): Promise<boolean> {
    for (const [candidate, expiry] of this.consumed) {
      if (expiry <= nowMs) this.consumed.delete(candidate);
    }
    if (this.consumed.has(key)) return false;
    this.consumed.set(key, expiresAtMs);
    return true;
  }
}

export class MemoryHostVerificationKeyResolver
  implements HostVerificationKeyResolver
{
  constructor(private readonly keys: readonly HostVerificationKey[]) {}

  async resolve(
    _issuer: string,
    keyId: string,
  ): Promise<HostVerificationKey | undefined> {
    return this.keys.find((key) => key.keyId === keyId);
  }
}

function fakeSignature(secret: string, signingInput: Uint8Array): Uint8Array {
  const input = `${secret}\u0000${new TextDecoder().decode(signingInput)}`;
  return new TextEncoder().encode(stableHash(input));
}

export class DeterministicHostSignatureVerifier
  implements HostSignatureVerifier
{
  async verify(input: {
    readonly algorithm: string;
    readonly key: HostVerificationKey;
    readonly signingInput: Uint8Array;
    readonly signature: Uint8Array;
  }): Promise<boolean> {
    if (typeof input.key.material !== "string") return false;
    const expected = fakeSignature(input.key.material, input.signingInput);
    return (
      expected.length === input.signature.length &&
      expected.every((value, index) => value === input.signature[index])
    );
  }
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function createDeterministicHostToken(input: {
  readonly header: HostTokenHeader;
  readonly claims: HostContextClaims;
  readonly secret: string;
}): string {
  const header = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(input.header)),
  );
  const claims = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(input.claims)),
  );
  const signingInput = new TextEncoder().encode(`${header}.${claims}`);
  const signature = encodeBase64Url(fakeSignature(input.secret, signingInput));
  return `${header}.${claims}.${signature}`;
}

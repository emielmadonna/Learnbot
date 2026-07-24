import type { PlatformRole } from "@course-ai/application-services";
import type {
  ActorId,
  TenantContext,
  TenantId,
} from "@course-ai/contracts";
import type {
  Invitation,
  InvitationRepository,
  MembershipRepository,
  NormalizedPrincipal,
  ScimStateRepository,
  ServicePrincipal,
  ServicePrincipalRepository,
  TenantIdentityRepository,
  TenantMembership,
} from "@course-ai/identity-access";
import type {
  PostgresExecutor,
  PostgresTransaction,
} from "./database.js";
import { readIsoTimestamp } from "./database.js";
import { DurableAdapterError } from "./errors.js";

interface MembershipRow {
  readonly membership_id: string;
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly role: string;
  readonly status: string;
  readonly provisioned_by: string;
  readonly created_at: string | Date;
  readonly updated_at: string | Date;
}

interface TenantRow {
  readonly tenant_id: string;
  readonly slug: string;
  readonly status: string;
  readonly region: string | null;
  readonly settings: unknown;
  readonly updated_at: string | Date;
}

interface ServicePrincipalRow {
  readonly service_principal_id: string;
  readonly tenant_id: string;
  readonly client_id: string;
  readonly status: string;
  readonly scopes: unknown;
  readonly created_at: string | Date;
}

interface InvitationRow {
  readonly invitation_id: string;
  readonly tenant_id: string;
  readonly email_normalized: string;
  readonly role: string;
  readonly status: string;
  readonly expires_at: string | Date;
  readonly accepted_by_principal_id: string | null;
  readonly accepted_at: string | Date | null;
  readonly created_at: string | Date;
}

interface TenantLookupRow {
  readonly tenant_id: string;
}

interface AcceptanceRow {
  readonly principal_id: string;
  readonly membership_id: string;
}

interface ScimPrincipalRow {
  readonly principal_id: string;
}

const PLATFORM_ROLES = new Set<PlatformRole>([
  "tenant_owner",
  "tenant_admin",
  "creator",
  "teacher",
  "student",
  "service",
]);
const INVITABLE_ROLES = new Set<PlatformRole>([
  "tenant_owner",
  "tenant_admin",
  "creator",
  "teacher",
  "student",
]);
const MEMBERSHIP_STATUSES = new Set<TenantMembership["status"]>([
  "active",
  "suspended",
  "revoked",
]);
const PROVISIONERS = new Set<TenantMembership["provisionedBy"]>([
  "invitation",
  "scim",
  "manual",
  "host",
]);
const INVITATION_STATUSES = new Set<Invitation["status"]>([
  "pending",
  "accepted",
  "revoked",
  "expired",
]);

function invalidRow(subject: string): never {
  throw new DurableAdapterError(
    "durable.invalid_row",
    `Postgres returned an invalid ${subject} row.`,
  );
}

function nonEmpty(value: unknown, subject: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalidRow(subject);
  }
  return value;
}

function platformRole(value: unknown): PlatformRole {
  if (typeof value !== "string" || !PLATFORM_ROLES.has(value as PlatformRole)) {
    return invalidRow("identity role");
  }
  return value as PlatformRole;
}

function invitationRole(value: unknown): PlatformRole {
  const role = platformRole(value);
  if (!INVITABLE_ROLES.has(role)) return invalidRow("invitation role");
  return role;
}

export interface IdentityPrincipalRecord {
  readonly principalId: ActorId;
  readonly kind: NormalizedPrincipal["kind"];
  readonly method: NormalizedPrincipal["method"];
  readonly issuer: string;
  readonly subject: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PrincipalRow {
  readonly principal_id: string;
  readonly principal_kind: string;
  readonly authentication_method: string;
  readonly issuer: string;
  readonly subject: string;
  readonly created_at: string | Date;
  readonly updated_at: string | Date;
}

function mapPrincipal(row: PrincipalRow): IdentityPrincipalRecord {
  if (
    (row.principal_kind !== "human" && row.principal_kind !== "service") ||
    !["oidc", "saml", "host_signed", "service_principal"].includes(
      row.authentication_method,
    )
  ) {
    return invalidRow("identity principal");
  }
  return {
    principalId: nonEmpty(row.principal_id, "principal ID"),
    kind: row.principal_kind,
    method: row.authentication_method as NormalizedPrincipal["method"],
    issuer: nonEmpty(row.issuer, "principal issuer"),
    subject: nonEmpty(row.subject, "principal subject"),
    createdAt: readIsoTimestamp(row.created_at, "principal created_at"),
    updatedAt: readIsoTimestamp(row.updated_at, "principal updated_at"),
  };
}

function mapMembership(row: MembershipRow): TenantMembership {
  if (
    !MEMBERSHIP_STATUSES.has(row.status as TenantMembership["status"]) ||
    !PROVISIONERS.has(row.provisioned_by as TenantMembership["provisionedBy"])
  ) {
    return invalidRow("identity membership");
  }
  return {
    membershipId: nonEmpty(row.membership_id, "membership ID"),
    tenantId: nonEmpty(row.tenant_id, "tenant ID"),
    principalId: nonEmpty(row.principal_id, "principal ID"),
    role: platformRole(row.role),
    status: row.status as TenantMembership["status"],
    provisionedBy: row.provisioned_by as TenantMembership["provisionedBy"],
    createdAt: readIsoTimestamp(row.created_at, "membership created_at"),
    updatedAt: readIsoTimestamp(row.updated_at, "membership updated_at"),
  };
}

function plainObject(value: unknown, subject: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidRow(subject);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  object: Readonly<Record<string, unknown>>,
  key: string,
): string {
  return nonEmpty(object[key], `tenant settings.${key}`);
}

function booleanRecord(value: unknown, subject: string): Record<string, boolean> {
  const object = plainObject(value, subject);
  const result: Record<string, boolean> = {};
  for (const [key, item] of Object.entries(object)) {
    if (key.length === 0 || typeof item !== "boolean") return invalidRow(subject);
    result[key] = item;
  }
  return result;
}

function numberRecord(value: unknown, subject: string): Record<string, number> {
  const object = plainObject(value, subject);
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(object)) {
    if (
      key.length === 0 ||
      typeof item !== "number" ||
      !Number.isFinite(item) ||
      item < 0
    ) {
      return invalidRow(subject);
    }
    result[key] = item;
  }
  return result;
}

function mapTenant(row: TenantRow): TenantContext {
  if (row.status !== "active") return invalidRow("active tenant");
  const settings = plainObject(row.settings, "tenant settings");
  // Identity resolution fails closed unless every required setting is
  // explicitly configured. This adapter does not invent plan or policy facts.
  return {
    tenantId: nonEmpty(row.tenant_id, "tenant ID"),
    slug: nonEmpty(row.slug, "tenant slug"),
    status: "active",
    planId: requiredString(settings, "planId"),
    locale: requiredString(settings, "locale"),
    timeZone: requiredString(settings, "timeZone"),
    featureFlags: booleanRecord(
      settings.featureFlags,
      "tenant settings.featureFlags",
    ),
    limits: numberRecord(settings.limits, "tenant settings.limits"),
    policyVersion: requiredString(settings, "policyVersion"),
    resolvedAt: readIsoTimestamp(row.updated_at, "tenant updated_at"),
    ...(row.region === null ? {} : { region: nonEmpty(row.region, "tenant region") }),
  };
}

function mapServicePrincipal(row: ServicePrincipalRow): ServicePrincipal {
  if (row.status !== "active" && row.status !== "revoked") {
    return invalidRow("service principal");
  }
  if (
    !Array.isArray(row.scopes) ||
    row.scopes.some((scope) => typeof scope !== "string" || scope.length === 0)
  ) {
    return invalidRow("service principal scopes");
  }
  return {
    servicePrincipalId: nonEmpty(
      row.service_principal_id,
      "service principal ID",
    ),
    tenantId: nonEmpty(row.tenant_id, "tenant ID"),
    clientId: nonEmpty(row.client_id, "service principal client ID"),
    status: row.status,
    scopes: row.scopes as readonly string[],
    createdAt: readIsoTimestamp(
      row.created_at,
      "service principal created_at",
    ),
  };
}

function mapInvitation(row: InvitationRow): Invitation {
  if (!INVITATION_STATUSES.has(row.status as Invitation["status"])) {
    return invalidRow("invitation");
  }
  return {
    invitationId: nonEmpty(row.invitation_id, "invitation ID"),
    tenantId: nonEmpty(row.tenant_id, "tenant ID"),
    email: nonEmpty(row.email_normalized, "invitation email"),
    role: invitationRole(row.role),
    status: row.status as Invitation["status"],
    expiresAt: readIsoTimestamp(row.expires_at, "invitation expires_at"),
    createdAt: readIsoTimestamp(row.created_at, "invitation created_at"),
    ...(row.accepted_by_principal_id === null
      ? {}
      : {
          acceptedByPrincipalId: nonEmpty(
            row.accepted_by_principal_id,
            "accepted principal ID",
          ),
        }),
    ...(row.accepted_at === null
      ? {}
      : {
          acceptedAt: readIsoTimestamp(
            row.accepted_at,
            "invitation accepted_at",
          ),
        }),
  };
}

async function oneTenantForBootstrap(
  transaction: PostgresTransaction,
  marker: string,
  functionName: string,
  identifier: string,
): Promise<TenantId | undefined> {
  const result = await transaction.query<TenantLookupRow>(
    `/* ${marker} */
    select tenant_id
    from app_private.${functionName}($1)`,
    [identifier],
  );
  if (result.rowCount === 0) return undefined;
  if (result.rowCount !== 1 || result.rows[0] === undefined) {
    return invalidRow("identity tenant bootstrap");
  }
  return nonEmpty(result.rows[0].tenant_id, "tenant ID");
}

export class PostgresMembershipRepository implements MembershipRepository {
  constructor(private readonly database: PostgresExecutor) {}

  async listActiveForPrincipal(
    principalId: ActorId,
  ): Promise<readonly TenantMembership[]> {
    return this.database.transaction(async (transaction) => {
      const result = await transaction.query<MembershipRow>(
        `/* identity:membership.list_active */
        select membership_id, tenant_id, principal_id, role, status,
               provisioned_by, created_at, updated_at
        from app_private.list_active_identity_memberships($1)
        order by tenant_id, membership_id`,
        [principalId],
      );
      return result.rows.map(mapMembership);
    });
  }

  async find(
    principalId: ActorId,
    tenantId: TenantId,
  ): Promise<TenantMembership | undefined> {
    return this.database.transaction(async (transaction) => {
      const result = await transaction.query<MembershipRow>(
        `/* identity:membership.find */
        select membership_id, tenant_id, principal_id, role, status,
               provisioned_by, created_at, updated_at
        from public.identity_memberships
        where tenant_id = $1 and principal_id = $2 and deleted_at is null`,
        [tenantId, principalId],
      );
      return result.rows[0] === undefined
        ? undefined
        : mapMembership(result.rows[0]);
    });
  }

  async upsert(input: {
    readonly tenantId: TenantId;
    readonly principalId: ActorId;
    readonly role: PlatformRole;
    readonly provisionedBy: TenantMembership["provisionedBy"];
    readonly now: string;
  }): Promise<TenantMembership> {
    platformRole(input.role);
    return this.database.transaction(async (transaction) => {
      const result = await transaction.query<MembershipRow>(
        `/* identity:membership.upsert */
        insert into public.identity_memberships (
          membership_id, tenant_id, principal_id, role, status,
          provisioned_by, idempotency_key, created_at, updated_at
        ) values (
          'membership_' || encode(
            extensions.digest($1 || chr(31) || $2, 'sha256'), 'hex'
          ),
          $1, $2, $3, 'active', $4,
          'membership:' || $2, $5::timestamptz, $5::timestamptz
        )
        on conflict (tenant_id, principal_id) do update
          set role = excluded.role,
              status = 'active',
              provisioned_by = excluded.provisioned_by,
              updated_at = excluded.updated_at,
              record_version = public.identity_memberships.record_version + 1,
              deleted_at = null
        where public.identity_memberships.tenant_id = $1
          and public.identity_memberships.principal_id = $2
        returning membership_id, tenant_id, principal_id, role, status,
                  provisioned_by, created_at, updated_at`,
        [
          input.tenantId,
          input.principalId,
          input.role,
          input.provisionedBy,
          input.now,
        ],
      );
      if (result.rowCount !== 1 || result.rows[0] === undefined) {
        return invalidRow("upserted identity membership");
      }
      return mapMembership(result.rows[0]);
    });
  }

  async revoke(
    principalId: ActorId,
    tenantId: TenantId,
    now: string,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        `/* identity:membership.revoke */
        update public.identity_memberships
        set status = 'revoked',
            updated_at = $3::timestamptz,
            record_version = record_version + 1
        where tenant_id = $1 and principal_id = $2 and deleted_at is null`,
        [tenantId, principalId, now],
      );
    });
  }
}

/**
 * Registers the identity authenticated by the protocol verifier. Application
 * wiring must call this before membership/invitation/SCIM writes so their
 * foreign keys cannot point at an unverified placeholder.
 *
 * This is intentionally separate from IdentityAccessService today because its
 * dependency contract has no principal repository or outer unit-of-work.
 */
export class PostgresIdentityPrincipalRepository {
  constructor(private readonly database: PostgresExecutor) {}

  async registerVerified(
    principal: NormalizedPrincipal,
    now: string,
  ): Promise<IdentityPrincipalRecord> {
    return this.database.transaction(async (transaction) => {
      const result = await transaction.query<PrincipalRow>(
        `/* identity:principal.register_verified */
        insert into public.identity_principals (
          principal_id, principal_kind, authentication_method, issuer, subject,
          idempotency_key, created_at, updated_at
        ) values (
          $1, $2, $3, $4, $5,
          'principal:' || encode(
            extensions.digest($3 || chr(31) || $4 || chr(31) || $5, 'sha256'),
            'hex'
          ),
          $6::timestamptz, $6::timestamptz
        )
        on conflict (authentication_method, issuer, subject) do update
          set updated_at = public.identity_principals.updated_at
        where public.identity_principals.principal_id = $1
          and public.identity_principals.principal_kind = $2
          and public.identity_principals.authentication_method = $3
          and public.identity_principals.issuer = $4
          and public.identity_principals.subject = $5
          and public.identity_principals.deleted_at is null
        returning principal_id, principal_kind, authentication_method, issuer,
                  subject, created_at, updated_at`,
        [
          principal.principalId,
          principal.kind,
          principal.method,
          principal.issuer,
          principal.subject,
          now,
        ],
      );
      if (result.rowCount !== 1 || result.rows[0] === undefined) {
        throw new DurableAdapterError(
          "durable.idempotency_conflict",
          "The verified identity resolves to a different principal.",
        );
      }
      return mapPrincipal(result.rows[0]);
    });
  }
}

export class PostgresTenantIdentityRepository
  implements TenantIdentityRepository
{
  constructor(private readonly database: PostgresExecutor) {}

  async getActive(tenantId: TenantId): Promise<TenantContext | undefined> {
    return this.database.transaction(async (transaction) => {
      const result = await transaction.query<TenantRow>(
        `/* identity:tenant.get_active */
        select tenant_id, slug, status, region, settings, updated_at
        from public.tenants
        where tenant_id = $1 and status = 'active' and deleted_at is null`,
        [tenantId],
      );
      return result.rows[0] === undefined ? undefined : mapTenant(result.rows[0]);
    });
  }
}

export class PostgresServicePrincipalRepository
  implements ServicePrincipalRepository
{
  constructor(private readonly database: PostgresExecutor) {}

  async findByClientId(clientId: string): Promise<ServicePrincipal | undefined> {
    return this.database.transaction(async (transaction) => {
      const tenantId = await oneTenantForBootstrap(
        transaction,
        "identity:service_principal.resolve_tenant",
        "resolve_identity_service_principal_tenant",
        clientId,
      );
      if (tenantId === undefined) return undefined;
      const result = await transaction.query<ServicePrincipalRow>(
        `/* identity:service_principal.find */
        select service_principal_id, tenant_id, client_id, status, scopes,
               created_at
        from public.identity_service_principals
        where tenant_id = $1 and client_id = $2 and deleted_at is null`,
        [tenantId, clientId],
      );
      return result.rows[0] === undefined
        ? undefined
        : mapServicePrincipal(result.rows[0]);
    });
  }
}

export class PostgresInvitationRepository implements InvitationRepository {
  constructor(private readonly database: PostgresExecutor) {}

  async get(invitationId: string): Promise<Invitation | undefined> {
    return this.database.transaction(async (transaction) => {
      const tenantId = await this.resolveTenant(transaction, invitationId);
      if (tenantId === undefined) return undefined;
      const result = await transaction.query<InvitationRow>(
        `/* identity:invitation.get */
        select invitation_id, tenant_id, email_normalized, role, status,
               expires_at, accepted_by_principal_id, accepted_at, created_at
        from public.identity_invitations
        where tenant_id = $1 and invitation_id = $2 and deleted_at is null`,
        [tenantId, invitationId],
      );
      return result.rows[0] === undefined
        ? undefined
        : mapInvitation(result.rows[0]);
    });
  }

  async save(invitation: Invitation): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const result = await transaction.query(
        `/* identity:invitation.save */
        update public.identity_invitations
        set status = $3,
            accepted_by_principal_id = $4,
            accepted_at = $5::timestamptz,
            updated_at = clock_timestamp(),
            record_version = record_version + 1
        where tenant_id = $1 and invitation_id = $2 and deleted_at is null`,
        [
          invitation.tenantId,
          invitation.invitationId,
          invitation.status,
          invitation.acceptedByPrincipalId ?? null,
          invitation.acceptedAt ?? null,
        ],
      );
      if (result.rowCount !== 1) {
        throw new DurableAdapterError(
          "durable.invalid_row",
          "The tenant-scoped invitation update did not affect exactly one row.",
        );
      }
    });
  }

  async getAcceptance(
    invitationId: string,
    idempotencyKey: string,
  ): Promise<
    { readonly principalId: ActorId; readonly membershipId: string } | undefined
  > {
    return this.database.transaction(async (transaction) => {
      const tenantId = await this.resolveTenant(transaction, invitationId);
      if (tenantId === undefined) return undefined;
      const result = await transaction.query<AcceptanceRow>(
        `/* identity:invitation.get_acceptance */
        select principal_id, membership_id
        from public.identity_invitation_acceptances
        where tenant_id = $1 and invitation_id = $2
          and idempotency_key = $3 and deleted_at is null`,
        [tenantId, invitationId, idempotencyKey],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : {
            principalId: nonEmpty(row.principal_id, "principal ID"),
            membershipId: nonEmpty(row.membership_id, "membership ID"),
          };
    });
  }

  async saveAcceptance(input: {
    readonly invitationId: string;
    readonly idempotencyKey: string;
    readonly principalId: ActorId;
    readonly membershipId: string;
  }): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const tenantId = await this.resolveTenant(transaction, input.invitationId);
      if (tenantId === undefined) {
        throw new DurableAdapterError(
          "durable.invalid_row",
          "The invitation no longer exists.",
        );
      }
      await transaction.query(
        `/* identity:invitation.save_acceptance */
        insert into public.identity_invitation_acceptances (
          tenant_id, invitation_id, idempotency_key, principal_id,
          membership_id
        ) values ($1, $2, $3, $4, $5)
        on conflict (tenant_id, invitation_id, idempotency_key) do nothing`,
        [
          tenantId,
          input.invitationId,
          input.idempotencyKey,
          input.principalId,
          input.membershipId,
        ],
      );
      const stored = await transaction.query<AcceptanceRow>(
        `/* identity:invitation.verify_acceptance */
        select principal_id, membership_id
        from public.identity_invitation_acceptances
        where tenant_id = $1 and invitation_id = $2 and idempotency_key = $3
          and principal_id = $4 and membership_id = $5
          and deleted_at is null`,
        [
          tenantId,
          input.invitationId,
          input.idempotencyKey,
          input.principalId,
          input.membershipId,
        ],
      );
      if (stored.rowCount !== 1) {
        throw new DurableAdapterError(
          "durable.idempotency_conflict",
          "The invitation idempotency key already has a different result.",
        );
      }
    });
  }

  private async resolveTenant(
    transaction: PostgresTransaction,
    invitationId: string,
  ): Promise<TenantId | undefined> {
    return oneTenantForBootstrap(
      transaction,
      "identity:invitation.resolve_tenant",
      "resolve_identity_invitation_tenant",
      invitationId,
    );
  }
}

export class PostgresScimStateRepository implements ScimStateRepository {
  constructor(private readonly database: PostgresExecutor) {}

  async getPrincipalId(
    tenantId: TenantId,
    externalId: string,
  ): Promise<ActorId | undefined> {
    return this.database.transaction(async (transaction) => {
      const result = await transaction.query<ScimPrincipalRow>(
        `/* identity:scim.get_principal */
        select principal_id
        from public.identity_scim_bindings
        where tenant_id = $1 and external_id = $2 and deleted_at is null`,
        [tenantId, externalId],
      );
      return result.rows[0] === undefined
        ? undefined
        : nonEmpty(result.rows[0].principal_id, "principal ID");
    });
  }

  async bind(
    tenantId: TenantId,
    externalId: string,
    principalId: ActorId,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const result = await transaction.query<ScimPrincipalRow>(
        `/* identity:scim.bind */
        insert into public.identity_scim_bindings (
          tenant_id, external_id, principal_id, idempotency_key
        ) values ($1, $2, $3, 'scim-binding:' || $2)
        on conflict (tenant_id, external_id) do update
          set updated_at = clock_timestamp(),
              record_version = public.identity_scim_bindings.record_version + 1
        where public.identity_scim_bindings.tenant_id = $1
          and public.identity_scim_bindings.external_id = $2
          and public.identity_scim_bindings.principal_id = $3
        returning principal_id`,
        [tenantId, externalId, principalId],
      );
      if (result.rowCount !== 1) {
        throw new DurableAdapterError(
          "durable.idempotency_conflict",
          "The SCIM external ID is already bound to another principal.",
        );
      }
    });
  }

  async getIdempotentResult(
    tenantId: TenantId,
    idempotencyKey: string,
  ): Promise<TenantMembership | undefined> {
    return this.database.transaction(async (transaction) => {
      const result = await transaction.query<MembershipRow>(
        `/* identity:scim.get_result */
        select membership_id, tenant_id, principal_id, role, status,
               provisioned_by, membership_created_at as created_at,
               membership_updated_at as updated_at
        from public.identity_scim_receipts
        where tenant_id = $1 and idempotency_key = $2 and deleted_at is null`,
        [tenantId, idempotencyKey],
      );
      return result.rows[0] === undefined
        ? undefined
        : mapMembership(result.rows[0]);
    });
  }

  async saveIdempotentResult(
    tenantId: TenantId,
    idempotencyKey: string,
    membership: TenantMembership,
  ): Promise<void> {
    if (membership.tenantId !== tenantId) {
      throw new DurableAdapterError(
        "durable.idempotency_conflict",
        "A SCIM receipt cannot store a cross-tenant membership.",
      );
    }
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        `/* identity:scim.save_result */
        insert into public.identity_scim_receipts (
          tenant_id, idempotency_key, membership_id, principal_id, role,
          status, provisioned_by, membership_created_at, membership_updated_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz)
        on conflict (tenant_id, idempotency_key) do nothing`,
        [
          tenantId,
          idempotencyKey,
          membership.membershipId,
          membership.principalId,
          membership.role,
          membership.status,
          membership.provisionedBy,
          membership.createdAt,
          membership.updatedAt,
        ],
      );
      const stored = await transaction.query(
        `/* identity:scim.verify_result */
        select membership_id
        from public.identity_scim_receipts
        where tenant_id = $1 and idempotency_key = $2
          and membership_id = $3 and principal_id = $4
          and role = $5 and status = $6 and provisioned_by = $7
          and membership_created_at = $8::timestamptz
          and membership_updated_at = $9::timestamptz
          and deleted_at is null`,
        [
          tenantId,
          idempotencyKey,
          membership.membershipId,
          membership.principalId,
          membership.role,
          membership.status,
          membership.provisionedBy,
          membership.createdAt,
          membership.updatedAt,
        ],
      );
      if (stored.rowCount !== 1) {
        throw new DurableAdapterError(
          "durable.idempotency_conflict",
          "The SCIM idempotency key already has a different result.",
        );
      }
    });
  }
}

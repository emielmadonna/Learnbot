import { IntelligenceError } from "./errors.js";
import type {
  EventAppendOutcome,
  EventQuarantineRepository,
  EventRepository,
  EvidenceRepository,
  IntelligenceClock,
  IntelligenceIdFactory,
  OpportunityRepository,
} from "./repositories.js";
import type {
  AnyDomainEvent,
  IsoTimestamp,
  OpportunityAuditEntry,
  OpportunityEvidenceRecord,
  OpportunityFeedback,
  QuarantinedEvent,
  StudentOpportunity,
  TenantId,
} from "./types.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function key(...parts: readonly string[]): string {
  return parts.join("\u0000");
}

export class InMemoryEventRepository implements EventRepository {
  readonly #events = new Map<string, AnyDomainEvent>();
  readonly #fingerprintsByEvent = new Map<string, string>();
  readonly #idempotency = new Map<string, string>();

  async append(
    event: AnyDomainEvent,
    canonicalFingerprint: string,
  ): Promise<EventAppendOutcome> {
    const eventKey = key(event.tenantId, event.eventId);
    const existingEventFingerprint = this.#fingerprintsByEvent.get(eventKey);
    if (existingEventFingerprint !== undefined) {
      return existingEventFingerprint === canonicalFingerprint
        ? { outcome: "duplicate" }
        : { outcome: "conflict", issue: "eventId was reused for a different fact" };
    }
    if (event.idempotencyKey !== undefined) {
      const idempotencyKey = key(event.tenantId, event.idempotencyKey);
      const existingIdempotencyFingerprint = this.#idempotency.get(idempotencyKey);
      if (existingIdempotencyFingerprint !== undefined) {
        return existingIdempotencyFingerprint === canonicalFingerprint
          ? { outcome: "duplicate" }
          : {
              outcome: "conflict",
              issue: "idempotencyKey was reused for a different fact",
            };
      }
    }

    this.#events.set(eventKey, clone(event));
    this.#fingerprintsByEvent.set(eventKey, canonicalFingerprint);
    if (event.idempotencyKey !== undefined) {
      this.#idempotency.set(
        key(event.tenantId, event.idempotencyKey),
        canonicalFingerprint,
      );
    }
    return { outcome: "appended" };
  }

  async list(tenantId: TenantId): Promise<readonly AnyDomainEvent[]> {
    return [...this.#events.values()]
      .filter((event) => event.tenantId === tenantId)
      .map(clone);
  }
}

export class InMemoryEventQuarantineRepository
  implements EventQuarantineRepository
{
  readonly #records: QuarantinedEvent[] = [];

  async append(record: QuarantinedEvent): Promise<void> {
    this.#records.push(clone(record));
  }

  async list(tenantId?: TenantId): Promise<readonly QuarantinedEvent[]> {
    return this.#records
      .filter((record) => tenantId === undefined || record.tenantId === tenantId)
      .map(clone);
  }
}

export class InMemoryEvidenceRepository implements EvidenceRepository {
  readonly #records = new Map<string, OpportunityEvidenceRecord>();

  constructor(records: readonly OpportunityEvidenceRecord[] = []) {
    for (const record of records) this.put(record);
  }

  put(record: OpportunityEvidenceRecord): void {
    this.#records.set(key(record.tenantId, record.kind, record.refId), clone(record));
  }

  async get(
    tenantId: TenantId,
    kind: OpportunityEvidenceRecord["kind"],
    refId: string,
  ): Promise<OpportunityEvidenceRecord | undefined> {
    const record = this.#records.get(key(tenantId, kind, refId));
    return record === undefined ? undefined : clone(record);
  }
}

export class InMemoryOpportunityRepository implements OpportunityRepository {
  readonly #opportunities = new Map<string, StudentOpportunity>();
  readonly #feedback: OpportunityFeedback[] = [];
  readonly #audit: OpportunityAuditEntry[] = [];

  async create(opportunity: StudentOpportunity): Promise<void> {
    const opportunityKey = key(opportunity.tenantId, opportunity.id);
    if (this.#opportunities.has(opportunityKey)) {
      throw new IntelligenceError(
        "opportunity.already_exists",
        "Opportunity already exists in this tenant.",
      );
    }
    this.#opportunities.set(opportunityKey, clone(opportunity));
  }

  async get(
    tenantId: TenantId,
    opportunityId: string,
  ): Promise<StudentOpportunity | undefined> {
    const opportunity = this.#opportunities.get(key(tenantId, opportunityId));
    return opportunity === undefined ? undefined : clone(opportunity);
  }

  async compareAndSetStatus(
    tenantId: TenantId,
    opportunityId: string,
    expectedStatus: StudentOpportunity["status"],
    nextStatus: StudentOpportunity["status"],
    audit: OpportunityAuditEntry,
  ): Promise<StudentOpportunity | undefined> {
    const opportunityKey = key(tenantId, opportunityId);
    const current = this.#opportunities.get(opportunityKey);
    if (current === undefined || current.status !== expectedStatus) return undefined;
    if (
      audit.tenantId !== tenantId ||
      audit.opportunityId !== opportunityId ||
      audit.fromStatus !== expectedStatus ||
      audit.toStatus !== nextStatus
    ) {
      throw new IntelligenceError(
        "opportunity.tenant_mismatch",
        "Status and audit records must share one tenant and opportunity.",
      );
    }
    const updated = { ...current, status: nextStatus };
    this.#opportunities.set(opportunityKey, clone(updated));
    this.#audit.push(clone(audit));
    return clone(updated);
  }

  async appendFeedback(
    feedback: OpportunityFeedback,
    audit: OpportunityAuditEntry,
  ): Promise<void> {
    if (
      feedback.tenantId !== audit.tenantId ||
      feedback.opportunityId !== audit.opportunityId ||
      audit.feedbackId !== feedback.id ||
      !this.#opportunities.has(key(feedback.tenantId, feedback.opportunityId))
    ) {
      throw new IntelligenceError(
        "opportunity.tenant_mismatch",
        "Feedback and audit records must share an existing tenant opportunity.",
      );
    }
    this.#feedback.push(clone(feedback));
    this.#audit.push(clone(audit));
  }

  async listFeedback(
    tenantId: TenantId,
    opportunityId: string,
  ): Promise<readonly OpportunityFeedback[]> {
    return this.#feedback
      .filter(
        (feedback) =>
          feedback.tenantId === tenantId &&
          feedback.opportunityId === opportunityId,
      )
      .map(clone);
  }

  async listAudit(
    tenantId: TenantId,
    opportunityId: string,
  ): Promise<readonly OpportunityAuditEntry[]> {
    return this.#audit
      .filter(
        (entry) =>
          entry.tenantId === tenantId &&
          entry.opportunityId === opportunityId,
      )
      .map(clone);
  }
}

export class DeterministicIntelligenceRuntime
  implements IntelligenceClock, IntelligenceIdFactory
{
  #sequence = 0;

  constructor(public currentTime: IsoTimestamp) {}

  now(): IsoTimestamp {
    return this.currentTime;
  }

  next(prefix: "quarantine" | "feedback" | "audit"): string {
    this.#sequence += 1;
    return `${prefix}_${this.#sequence}`;
  }
}

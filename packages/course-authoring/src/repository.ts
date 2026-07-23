import type { CourseDraft, CourseId, TenantId } from "@course-ai/contracts";
import { AuthoringError, requireAuthoring } from "./errors.js";
import type {
  CommandReceipt,
  CommitCourseInput,
  CourseAuthoringRepository,
  CourseRevision,
} from "./types.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function resourceKey(tenantId: TenantId, courseId: CourseId): string {
  return `${tenantId}\u0000${courseId}`;
}

function receiptKey(tenantId: TenantId, idempotencyKey: string): string {
  return `${tenantId}\u0000${idempotencyKey}`;
}

export class InMemoryCourseAuthoringRepository implements CourseAuthoringRepository {
  readonly #courses = new Map<string, CourseDraft>();
  readonly #revisions = new Map<string, CourseRevision[]>();
  readonly #receipts = new Map<string, CommandReceipt<unknown>>();

  async get(tenantId: TenantId, courseId: CourseId): Promise<CourseDraft | undefined> {
    const value = this.#courses.get(resourceKey(tenantId, courseId));
    return value === undefined ? undefined : clone(value);
  }

  async create<TResult>(
    course: CourseDraft,
    revision: CourseRevision,
    receipt: CommandReceipt<TResult>,
  ): Promise<void> {
    const key = resourceKey(course.tenantId, course.courseId);
    requireAuthoring(
      !this.#courses.has(key),
      "authoring.invalid_input",
      "Course already exists.",
      { courseId: course.courseId },
    );
    this.#assertReceiptAvailable(receipt);
    this.#courses.set(key, clone(course));
    this.#revisions.set(key, [clone(revision)]);
    this.#receipts.set(receiptKey(receipt.tenantId, receipt.idempotencyKey), clone(receipt));
  }

  async commit<TResult>(input: CommitCourseInput<TResult>): Promise<void> {
    const key = resourceKey(input.tenantId, input.courseId);
    const current = this.#courses.get(key);
    requireAuthoring(
      current !== undefined,
      "authoring.not_found",
      "Course was not found in this tenant.",
      { courseId: input.courseId },
    );
    requireAuthoring(
      current.version === input.expectedVersion,
      "authoring.version_conflict",
      "Course changed since this edit began.",
      { expectedVersion: input.expectedVersion, actualVersion: current.version },
    );
    requireAuthoring(
      input.course.tenantId === input.tenantId &&
        input.revision.tenantId === input.tenantId &&
        input.course.courseId === input.courseId &&
        input.revision.courseId === input.courseId,
      "authoring.tenant_mismatch",
      "A commit cannot cross tenant or course boundaries.",
    );
    requireAuthoring(
      input.course.version === current.version + 1 &&
        input.revision.version === input.course.version,
      "authoring.invalid_input",
      "A commit must advance exactly one course version.",
    );
    this.#assertReceiptAvailable(input.receipt);

    // These synchronous mutations form the in-memory transaction. Durable
    // adapters must perform this compare-and-swap plus revision/receipt insert
    // in one database transaction.
    this.#courses.set(key, clone(input.course));
    this.#revisions.set(key, [
      ...(this.#revisions.get(key) ?? []),
      clone(input.revision),
    ]);
    this.#receipts.set(
      receiptKey(input.receipt.tenantId, input.receipt.idempotencyKey),
      clone(input.receipt),
    );
  }

  async findReceipt<TResult>(
    tenantId: TenantId,
    idempotencyKey: string,
  ): Promise<CommandReceipt<TResult> | undefined> {
    const receipt = this.#receipts.get(receiptKey(tenantId, idempotencyKey));
    return receipt === undefined ? undefined : (clone(receipt) as CommandReceipt<TResult>);
  }

  async listRevisions(
    tenantId: TenantId,
    courseId: CourseId,
  ): Promise<readonly CourseRevision[]> {
    return clone(this.#revisions.get(resourceKey(tenantId, courseId)) ?? []);
  }

  async getRevision(
    tenantId: TenantId,
    courseId: CourseId,
    version: number,
  ): Promise<CourseRevision | undefined> {
    const value = this.#revisions
      .get(resourceKey(tenantId, courseId))
      ?.find((revision) => revision.version === version);
    return value === undefined ? undefined : clone(value);
  }

  #assertReceiptAvailable(receipt: CommandReceipt<unknown>): void {
    const existing = this.#receipts.get(
      receiptKey(receipt.tenantId, receipt.idempotencyKey),
    );
    if (existing !== undefined) {
      throw new AuthoringError(
        "authoring.idempotency_conflict",
        "The idempotency key has already been committed.",
      );
    }
  }
}

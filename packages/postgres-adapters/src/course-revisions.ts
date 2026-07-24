import type {
  PostgresExecutor,
  PostgresTransaction,
} from "./database.js";
import { readIsoTimestamp } from "./database.js";
import { DurableAdapterError } from "./errors.js";
import { serializeDurableJson } from "./json.js";

interface HeadRow {
  readonly current_revision_number: number | string;
}

interface RevisionRow {
  readonly revision_id: string;
  readonly tenant_id: string;
  readonly course_id: string;
  readonly revision_number: number | string;
  readonly revision_kind: CourseRevisionKind;
  readonly command_id: string;
  readonly content_hash: string;
  readonly snapshot: unknown;
  readonly created_at: string | Date;
}

export type CourseRevisionKind =
  | "created"
  | "edited"
  | "published"
  | "rolled_back";

export interface CommitCourseRevisionInput<TSnapshot> {
  readonly tenantId: string;
  readonly courseId: string;
  readonly revisionId: string;
  readonly expectedRevisionNumber: number;
  readonly revisionKind: CourseRevisionKind;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly contentHash: string;
  readonly snapshot: TSnapshot;
  readonly actorId?: string;
  readonly auditNote?: string;
  readonly rollbackTargetRevisionNumber?: number;
}

export interface DurableCourseRevision<TSnapshot> {
  readonly revisionId: string;
  readonly tenantId: string;
  readonly courseId: string;
  readonly revisionNumber: number;
  readonly revisionKind: CourseRevisionKind;
  readonly commandId: string;
  readonly contentHash: string;
  readonly snapshot: TSnapshot;
  readonly createdAt: string;
}

export class PostgresCourseRevisionStore {
  constructor(private readonly database: PostgresExecutor) {}

  async commit<TSnapshot>(
    input: CommitCourseRevisionInput<TSnapshot>,
  ): Promise<DurableCourseRevision<TSnapshot>> {
    return this.database.transaction((transaction) =>
      this.commitInTransaction(transaction, input),
    );
  }

  async commitInTransaction<TSnapshot>(
    transaction: PostgresTransaction,
    input: CommitCourseRevisionInput<TSnapshot>,
  ): Promise<DurableCourseRevision<TSnapshot>> {
    await transaction.query(
      `/* durable:revision.ensure_head */
      insert into public.course_revision_heads (
        tenant_id, course_id, current_revision_number
      ) values ($1, $2, 0)
      on conflict (tenant_id, course_id) do nothing`,
      [input.tenantId, input.courseId],
    );

    const locked = await transaction.query<HeadRow>(
      `/* durable:revision.lock_head */
      select current_revision_number
      from public.course_revision_heads
      where tenant_id = $1 and course_id = $2
      for update`,
      [input.tenantId, input.courseId],
    );
    const current = Number(locked.rows[0]?.current_revision_number);
    if (!Number.isSafeInteger(current)) {
      throw new DurableAdapterError(
        "durable.invalid_row",
        "The course revision head is missing or invalid.",
      );
    }
    if (current !== input.expectedRevisionNumber) {
      throw new DurableAdapterError(
        "durable.revision_conflict",
        "The course changed after this edit began.",
        {
          expectedRevisionNumber: input.expectedRevisionNumber,
          actualRevisionNumber: current,
        },
      );
    }

    const nextRevisionNumber = current + 1;
    const durableSnapshot = serializeDurableJson(
      input.snapshot,
      "Course revision snapshot",
    );
    const inserted = await transaction.query<RevisionRow>(
      `/* durable:revision.insert */
      insert into public.course_revisions (
        revision_id, tenant_id, course_id, revision_number, revision_kind,
        command_id, idempotency_key, actor_id, audit_note,
        rollback_target_revision_number, content_hash, snapshot
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
      )
      returning revision_id, tenant_id, course_id, revision_number,
        revision_kind, command_id, content_hash, snapshot, created_at`,
      [
        input.revisionId,
        input.tenantId,
        input.courseId,
        nextRevisionNumber,
        input.revisionKind,
        input.commandId,
        input.idempotencyKey,
        input.actorId ?? null,
        input.auditNote ?? null,
        input.rollbackTargetRevisionNumber ?? null,
        input.contentHash,
        durableSnapshot.text,
      ],
    );

    const advanced = await transaction.query(
      `/* durable:revision.advance_head */
      update public.course_revision_heads
      set current_revision_number = $3,
          current_revision_id = $4,
          updated_at = clock_timestamp(),
          record_version = record_version + 1
      where tenant_id = $1
        and course_id = $2
        and current_revision_number = $5
      returning current_revision_number`,
      [
        input.tenantId,
        input.courseId,
        nextRevisionNumber,
        input.revisionId,
        input.expectedRevisionNumber,
      ],
    );
    if (advanced.rowCount !== 1) {
      throw new DurableAdapterError(
        "durable.revision_conflict",
        "The course revision compare-and-swap failed.",
      );
    }

    const row = inserted.rows[0];
    if (row === undefined) {
      throw new DurableAdapterError(
        "durable.invalid_row",
        "The committed course revision was not returned.",
      );
    }
    return {
      revisionId: row.revision_id,
      tenantId: row.tenant_id,
      courseId: row.course_id,
      revisionNumber: Number(row.revision_number),
      revisionKind: row.revision_kind,
      commandId: row.command_id,
      contentHash: row.content_hash,
      snapshot: row.snapshot as TSnapshot,
      createdAt: readIsoTimestamp(row.created_at, "course revision created_at"),
    };
  }
}

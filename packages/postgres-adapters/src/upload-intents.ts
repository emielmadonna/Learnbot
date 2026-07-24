import type {
  MalwareScanResult,
  RecordedScanResult,
  SignedUploadGrant,
  UploadActorScope,
  UploadCallbackReceipt,
  UploadIntent,
  UploadIntentFailure,
  UploadIntentRepository,
  UploadIntentStatus,
  UploadIntentTransaction,
} from "@course-ai/learning-pipeline";
import type {
  PostgresExecutor,
  PostgresTransaction,
} from "./database.js";
import { readIsoTimestamp } from "./database.js";
import { DurableAdapterError } from "./errors.js";
import { serializeDurableJson } from "./json.js";

interface UploadIntentRow {
  readonly intent_id: string;
  readonly tenant_id: string;
  readonly actor_id: string;
  readonly filename: string;
  readonly media_type: string;
  readonly declared_size_bytes: number | string;
  readonly object_key: string;
  readonly expires_at: string | Date;
  readonly status: string;
  readonly signed_upload: unknown;
  readonly scan_results: unknown;
  readonly failure: unknown | null;
  readonly promotion: unknown | null;
  readonly promotion_attempts: number | string;
  readonly record_version: number | string;
  readonly created_at: string | Date;
  readonly updated_at: string | Date;
}

interface CallbackRow {
  readonly callback_id: string;
  readonly fingerprint: string;
}

const UPLOAD_STATUSES = new Set<UploadIntentStatus>([
  "quarantined",
  "blocked",
  "promotion_failed",
  "promoted",
]);
const UPLOAD_FAILURE_CODES = new Set<UploadIntentFailure["code"]>([
  "TENANT_ACCESS_DENIED",
  "UPLOAD_POLICY_REJECTED",
  "UPLOAD_INTENT_EXPIRED",
  "IDENTIFIER_CONFLICT",
  "OBJECT_KEY_MISMATCH",
  "CALLBACK_CONFLICT",
  "DECLARED_SIZE_MISMATCH",
  "MEDIA_TYPE_MISMATCH",
  "MALWARE_DETECTED",
  "SCAN_INCOMPLETE",
  "PROMOTION_FAILED",
  "PROMOTION_NOT_READY",
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

function safeInteger(value: unknown, subject: string): number {
  const result =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(result) || result < 0) return invalidRow(subject);
  return result;
}

function record(
  value: unknown,
  subject: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidRow(subject);
  }
  return value as Readonly<Record<string, unknown>>;
}

function stringRecord(
  value: unknown,
  subject: string,
): Readonly<Record<string, string>> {
  const source = record(value, subject);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(source)) {
    if (key.trim() === "" || typeof item !== "string") {
      return invalidRow(subject);
    }
    result[key] = item;
  }
  return result;
}

function signedUpload(value: unknown): SignedUploadGrant {
  const source = record(value, "upload signed grant");
  const method = source.method;
  if (method !== "PUT" && method !== "POST") {
    return invalidRow("upload signed grant");
  }
  const url = nonEmpty(source.url, "upload signed grant URL");
  try {
    if (new URL(url).protocol !== "https:") {
      return invalidRow("upload signed grant URL");
    }
  } catch {
    return invalidRow("upload signed grant URL");
  }
  return {
    url,
    method,
    expiresAt: readIsoTimestamp(
      nonEmpty(source.expiresAt, "upload signed grant expiresAt"),
      "upload signed grant expiresAt",
    ),
    requiredHeaders: stringRecord(
      source.requiredHeaders,
      "upload signed grant headers",
    ),
  };
}

function malwareResult(value: unknown): MalwareScanResult {
  const source = record(value, "upload malware result");
  const status = source.status;
  if (
    status !== "clean" &&
    status !== "infected" &&
    status !== "indeterminate"
  ) {
    return invalidRow("upload malware result");
  }
  const threatName =
    source.threatName === undefined
      ? undefined
      : nonEmpty(source.threatName, "upload threat name");
  return {
    status,
    engine: nonEmpty(source.engine, "upload malware engine"),
    signatureVersion: nonEmpty(
      source.signatureVersion,
      "upload malware signature version",
    ),
    scannedAt: readIsoTimestamp(
      nonEmpty(source.scannedAt, "upload malware scannedAt"),
      "upload malware scannedAt",
    ),
    ...(threatName === undefined ? {} : { threatName }),
  };
}

function scanResult(value: unknown): RecordedScanResult {
  const source = record(value, "upload scan result");
  const magic = record(source.magicBytes, "upload magic-byte result");
  if (typeof magic.matchesDeclaredType !== "boolean") {
    return invalidRow("upload magic-byte result");
  }
  const observedSizeBytes = safeInteger(
    source.observedSizeBytes,
    "upload observed size",
  );
  return {
    callbackId: nonEmpty(source.callbackId, "upload callback ID"),
    intentId: nonEmpty(source.intentId, "upload scan intent ID"),
    objectKey: nonEmpty(source.objectKey, "upload scan object key"),
    observedSizeBytes,
    magicBytes: {
      detectedMediaType: nonEmpty(
        magic.detectedMediaType,
        "upload detected media type",
      ),
      signature: nonEmpty(magic.signature, "upload magic-byte signature"),
      matchesDeclaredType: magic.matchesDeclaredType,
    },
    malware: malwareResult(source.malware),
    recordedAt: readIsoTimestamp(
      nonEmpty(source.recordedAt, "upload scan recordedAt"),
      "upload scan recordedAt",
    ),
  };
}

function optionalFailure(value: unknown): UploadIntentFailure | undefined {
  if (value === null) return undefined;
  const source = record(value, "upload failure");
  if (typeof source.retryable !== "boolean") {
    return invalidRow("upload failure");
  }
  const code = nonEmpty(
    source.code,
    "upload failure code",
  ) as UploadIntentFailure["code"];
  if (!UPLOAD_FAILURE_CODES.has(code)) return invalidRow("upload failure code");
  return {
    code,
    message: nonEmpty(source.message, "upload failure message"),
    retryable: source.retryable,
  };
}

function optionalPromotion(
  value: unknown,
): UploadIntent["promotion"] | undefined {
  if (value === null) return undefined;
  const source = record(value, "upload promotion");
  return {
    assetId: nonEmpty(source.assetId, "upload promoted asset ID"),
    promotedAt: readIsoTimestamp(
      nonEmpty(source.promotedAt, "upload promotion promotedAt"),
      "upload promotion promotedAt",
    ),
  };
}

function mapIntent(row: UploadIntentRow): UploadIntent {
  if (!UPLOAD_STATUSES.has(row.status as UploadIntentStatus)) {
    return invalidRow("upload intent status");
  }
  if (!Array.isArray(row.scan_results)) {
    return invalidRow("upload scan results");
  }
  const status = row.status as UploadIntentStatus;
  const failure = optionalFailure(row.failure);
  const promotion = optionalPromotion(row.promotion);
  if (
    (status === "promoted") !== (promotion !== undefined) ||
    (status === "blocked" || status === "promotion_failed") !==
      (failure !== undefined)
  ) {
    return invalidRow("upload intent terminal state");
  }
  const intentId = nonEmpty(row.intent_id, "upload intent ID");
  const objectKey = nonEmpty(row.object_key, "upload object key");
  const scanResults = row.scan_results.map(scanResult);
  if (
    scanResults.some(
      (scan) => scan.intentId !== intentId || scan.objectKey !== objectKey,
    )
  ) {
    return invalidRow("upload scan ownership");
  }
  return {
    intentId,
    tenantId: nonEmpty(row.tenant_id, "upload tenant ID"),
    actorId: nonEmpty(row.actor_id, "upload actor ID"),
    filename: nonEmpty(row.filename, "upload filename"),
    mediaType: nonEmpty(row.media_type, "upload media type"),
    declaredSizeBytes: safeInteger(
      row.declared_size_bytes,
      "upload declared size",
    ),
    objectKey,
    expiresAt: readIsoTimestamp(row.expires_at, "upload expires_at"),
    status,
    disposition: "quarantine",
    signedUpload: signedUpload(row.signed_upload),
    scanResults,
    ...(failure === undefined ? {} : { failure }),
    ...(promotion === undefined ? {} : { promotion }),
    promotionAttempts: safeInteger(
      row.promotion_attempts,
      "upload promotion attempts",
    ),
    createdAt: readIsoTimestamp(row.created_at, "upload created_at"),
    updatedAt: readIsoTimestamp(row.updated_at, "upload updated_at"),
  };
}

function sameImmutableIdentity(left: UploadIntent, right: UploadIntent): boolean {
  return (
    left.intentId === right.intentId &&
    left.tenantId === right.tenantId &&
    left.actorId === right.actorId &&
    left.filename === right.filename &&
    left.mediaType === right.mediaType &&
    left.declaredSizeBytes === right.declaredSizeBytes &&
    left.objectKey === right.objectKey &&
    left.expiresAt === right.expiresAt &&
    left.disposition === right.disposition &&
    left.createdAt === right.createdAt &&
    JSON.stringify(left.signedUpload) === JSON.stringify(right.signedUpload)
  );
}

class PostgresUploadIntentTransaction implements UploadIntentTransaction {
  replacement: UploadIntent;
  replaced = false;
  readonly consumed: UploadCallbackReceipt[] = [];

  constructor(
    readonly intent: UploadIntent,
    private readonly callbacks: Map<string, UploadCallbackReceipt>,
  ) {
    this.replacement = intent;
  }

  getCallback(callbackId: string): UploadCallbackReceipt | undefined {
    const receipt = this.callbacks.get(callbackId);
    return receipt === undefined ? undefined : structuredClone(receipt);
  }

  consumeCallback(receipt: UploadCallbackReceipt): void {
    if (
      receipt.callbackId.trim() === "" ||
      receipt.fingerprint.trim() === "" ||
      this.callbacks.has(receipt.callbackId)
    ) {
      throw new DurableAdapterError(
        "durable.idempotency_conflict",
        "The upload callback receipt is empty or was already consumed.",
      );
    }
    const durableReceipt = structuredClone(receipt);
    this.callbacks.set(receipt.callbackId, durableReceipt);
    this.consumed.push(durableReceipt);
  }

  replaceIntent(intent: UploadIntent): void {
    if (!sameImmutableIdentity(this.intent, intent)) {
      throw new DurableAdapterError(
        "durable.invalid_row",
        "An upload transaction cannot change immutable intent identity.",
      );
    }
    this.replacement = structuredClone(intent);
    this.replaced = true;
  }
}

const INTENT_COLUMNS = `intent_id, tenant_id, actor_id, filename, media_type,
  declared_size_bytes, object_key, expires_at, status, signed_upload,
  scan_results, failure, promotion, promotion_attempts, record_version,
  created_at, updated_at`;

/**
 * Durable implementation of the upload boundary repository.
 *
 * Every transaction locks one exact tenant/actor/intent row before reading
 * callback receipts. Callback consumption and state replacement then commit in
 * the same Postgres transaction.
 */
export class PostgresUploadIntentRepository implements UploadIntentRepository {
  constructor(private readonly database: PostgresExecutor) {}

  async create(intent: UploadIntent): Promise<boolean> {
    const signed = serializeDurableJson(intent.signedUpload, "Signed upload grant");
    const scans = serializeDurableJson(intent.scanResults, "Upload scan results");
    const failure =
      intent.failure === undefined
        ? null
        : serializeDurableJson(intent.failure, "Upload failure").text;
    const promotion =
      intent.promotion === undefined
        ? null
        : serializeDurableJson(intent.promotion, "Upload promotion").text;
    return this.database.transaction(async (transaction) => {
      const inserted = await transaction.query(
        `/* upload:intent.create */
        insert into public.upload_intents (
          intent_id, tenant_id, actor_id, filename, media_type,
          declared_size_bytes, object_key, expires_at, status, disposition,
          signed_upload, scan_results, failure, promotion, promotion_attempts,
          idempotency_key, created_at, updated_at
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, 'quarantine',
          $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14, $1, $15, $16
        )
        on conflict do nothing
        returning intent_id`,
        [
          intent.intentId,
          intent.tenantId,
          intent.actorId,
          intent.filename,
          intent.mediaType,
          intent.declaredSizeBytes,
          intent.objectKey,
          intent.expiresAt,
          intent.status,
          signed.text,
          scans.text,
          failure,
          promotion,
          intent.promotionAttempts,
          intent.createdAt,
          intent.updatedAt,
        ],
      );
      return inserted.rowCount === 1;
    });
  }

  async transact<T>(
    scope: UploadActorScope,
    intentId: string,
    operation: (transaction: UploadIntentTransaction) => Promise<T>,
  ): Promise<T | undefined> {
    return this.database.transaction(async (databaseTransaction) => {
      const locked = await databaseTransaction.query<UploadIntentRow>(
        `/* upload:intent.lock_owned */
        select ${INTENT_COLUMNS}
        from public.upload_intents
        where tenant_id = $1 and actor_id = $2 and intent_id = $3
        for update`,
        [scope.tenantId, scope.actorId, intentId],
      );
      const row = locked.rows[0];
      if (row === undefined) return undefined;

      const current = mapIntent(row);
      const callbackRows = await databaseTransaction.query<CallbackRow>(
        `/* upload:callback.list */
        select callback_id, fingerprint
        from public.upload_callback_receipts
        where tenant_id = $1 and intent_id = $2
        order by created_at, callback_id`,
        [scope.tenantId, intentId],
      );
      const callbacks = new Map<string, UploadCallbackReceipt>();
      for (const callback of callbackRows.rows) {
        const receipt = {
          callbackId: nonEmpty(callback.callback_id, "upload callback ID"),
          fingerprint: nonEmpty(
            callback.fingerprint,
            "upload callback fingerprint",
          ),
        };
        if (callbacks.has(receipt.callbackId)) {
          return invalidRow("duplicate upload callback");
        }
        callbacks.set(receipt.callbackId, receipt);
      }

      const uploadTransaction = new PostgresUploadIntentTransaction(
        current,
        callbacks,
      );
      const result = await operation(uploadTransaction);
      await this.#persistCallbacks(
        databaseTransaction,
        current,
        uploadTransaction.consumed,
      );
      if (uploadTransaction.replaced) {
        await this.#replace(
          databaseTransaction,
          current,
          uploadTransaction.replacement,
          safeInteger(row.record_version, "upload record version"),
        );
      }
      return result;
    });
  }

  async #persistCallbacks(
    transaction: PostgresTransaction,
    intent: UploadIntent,
    receipts: readonly UploadCallbackReceipt[],
  ): Promise<void> {
    for (const receipt of receipts) {
      const inserted = await transaction.query(
        `/* upload:callback.consume */
        insert into public.upload_callback_receipts (
          tenant_id, intent_id, callback_id, fingerprint, idempotency_key
        ) values ($1, $2, $3, $4, $3)
        on conflict do nothing
        returning callback_id`,
        [
          intent.tenantId,
          intent.intentId,
          receipt.callbackId,
          receipt.fingerprint,
        ],
      );
      if (inserted.rowCount !== 1) {
        throw new DurableAdapterError(
          "durable.idempotency_conflict",
          "The upload callback receipt conflicted during commit.",
        );
      }
    }
  }

  async #replace(
    transaction: PostgresTransaction,
    current: UploadIntent,
    replacement: UploadIntent,
    recordVersion: number,
  ): Promise<void> {
    if (!sameImmutableIdentity(current, replacement)) {
      throw new DurableAdapterError(
        "durable.invalid_row",
        "An upload transaction cannot change immutable intent identity.",
      );
    }
    const scans = serializeDurableJson(
      replacement.scanResults,
      "Upload scan results",
    );
    const failure =
      replacement.failure === undefined
        ? null
        : serializeDurableJson(replacement.failure, "Upload failure").text;
    const promotion =
      replacement.promotion === undefined
        ? null
        : serializeDurableJson(replacement.promotion, "Upload promotion").text;
    const updated = await transaction.query(
      `/* upload:intent.replace */
      update public.upload_intents
      set status = $4,
          scan_results = $5::jsonb,
          failure = $6::jsonb,
          promotion = $7::jsonb,
          promotion_attempts = $8,
          updated_at = $9,
          record_version = record_version + 1
      where tenant_id = $1
        and actor_id = $2
        and intent_id = $3
        and record_version = $10
      returning intent_id`,
      [
        current.tenantId,
        current.actorId,
        current.intentId,
        replacement.status,
        scans.text,
        failure,
        promotion,
        replacement.promotionAttempts,
        replacement.updatedAt,
        recordVersion,
      ],
    );
    if (updated.rowCount !== 1) {
      throw new DurableAdapterError(
        "durable.revision_conflict",
        "The upload intent compare-and-swap failed.",
      );
    }
  }
}

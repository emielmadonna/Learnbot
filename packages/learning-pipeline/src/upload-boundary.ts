import type { Clock } from "./types.js";

export const UPLOAD_INTENT_STATUSES = [
  "quarantined",
  "blocked",
  "promotion_failed",
  "promoted",
] as const;

export type UploadIntentStatus = (typeof UPLOAD_INTENT_STATUSES)[number];

export type UploadBoundaryFailureCode =
  | "TENANT_ACCESS_DENIED"
  | "UPLOAD_POLICY_REJECTED"
  | "UPLOAD_INTENT_EXPIRED"
  | "IDENTIFIER_CONFLICT"
  | "OBJECT_KEY_MISMATCH"
  | "CALLBACK_CONFLICT"
  | "DECLARED_SIZE_MISMATCH"
  | "MEDIA_TYPE_MISMATCH"
  | "MALWARE_DETECTED"
  | "SCAN_INCOMPLETE"
  | "PROMOTION_FAILED"
  | "PROMOTION_NOT_READY";

export class UploadBoundaryFailure extends Error {
  override readonly name = "UploadBoundaryFailure";

  constructor(
    readonly code: UploadBoundaryFailureCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface UploadActorScope {
  readonly tenantId: string;
  readonly actorId: string;
}

export interface UploadPolicy {
  readonly allowedMediaTypes: readonly string[];
  readonly maxDeclaredSizeBytes: number;
  readonly maxIntentTtlMs: number;
  readonly maxFilenameLength?: number;
}

export interface CreateUploadIntentRequest {
  readonly filename: string;
  readonly mediaType: string;
  readonly declaredSizeBytes: number;
  /** Callers must supply the short expiry; the service never invents one. */
  readonly expiresAt: string;
}

export interface SignedQuarantineUploadRequest {
  readonly intentId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly objectKey: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly declaredSizeBytes: number;
  readonly expiresAt: string;
  readonly disposition: "quarantine";
}

export interface SignedUploadGrant {
  readonly url: string;
  readonly method: "PUT" | "POST";
  readonly expiresAt: string;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

export interface PromoteQuarantinedObjectRequest {
  readonly intentId: string;
  readonly tenantId: string;
  readonly objectKey: string;
  readonly mediaType: string;
  readonly verifiedSizeBytes: number;
}

export interface PromotionReceipt {
  readonly assetId: string;
  readonly promotedAt: string;
}

/** Provider-neutral signing and promotion port for a production adapter. */
export interface QuarantineStorage {
  createSignedUpload(
    request: SignedQuarantineUploadRequest,
  ): Promise<SignedUploadGrant>;
  /** Must be idempotent for `intentId` so a repository CAS retry is safe. */
  promote(
    request: PromoteQuarantinedObjectRequest,
  ): Promise<PromotionReceipt>;
}

export interface OpaqueIdentifierFactory {
  create(kind: "intent" | "object"): string;
}

export interface MagicByteScanResult {
  readonly detectedMediaType: string;
  readonly signature: string;
  readonly matchesDeclaredType: boolean;
}

export interface MalwareScanResult {
  readonly status: "clean" | "infected" | "indeterminate";
  readonly engine: string;
  readonly signatureVersion: string;
  readonly scannedAt: string;
  readonly threatName?: string;
}

export interface UploadScanCallback {
  readonly callbackId: string;
  readonly intentId: string;
  readonly objectKey: string;
  readonly observedSizeBytes: number;
  readonly magicBytes: MagicByteScanResult;
  readonly malware: MalwareScanResult;
}

export interface RecordedScanResult extends UploadScanCallback {
  readonly recordedAt: string;
}

export interface UploadIntentFailure {
  readonly code: UploadBoundaryFailureCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface UploadIntent {
  readonly intentId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly declaredSizeBytes: number;
  readonly objectKey: string;
  readonly expiresAt: string;
  readonly status: UploadIntentStatus;
  readonly disposition: "quarantine";
  readonly signedUpload: SignedUploadGrant;
  readonly scanResults: readonly RecordedScanResult[];
  readonly failure?: UploadIntentFailure;
  readonly promotion?: PromotionReceipt;
  readonly promotionAttempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UploadCallbackReceipt {
  readonly callbackId: string;
  readonly fingerprint: string;
}

export interface UploadIntentTransaction {
  readonly intent: UploadIntent;
  getCallback(callbackId: string): UploadCallbackReceipt | undefined;
  consumeCallback(receipt: UploadCallbackReceipt): void;
  replaceIntent(intent: UploadIntent): void;
}

/**
 * Production repositories must make `transact` serializable for one intent:
 * ownership load, callback receipt consumption, and intent replacement commit
 * together under one database transaction, lock, or compare-and-swap loop.
 */
export interface UploadIntentRepository {
  create(intent: UploadIntent): Promise<boolean>;
  transact<T>(
    scope: UploadActorScope,
    intentId: string,
    operation: (transaction: UploadIntentTransaction) => Promise<T>,
  ): Promise<T | undefined>;
}

/** Explicit deterministic test/local fake; production must inject a durable repository. */
export class MemoryUploadIntentRepository implements UploadIntentRepository {
  readonly #intents = new Map<string, UploadIntent>();
  readonly #callbacks = new Map<string, Map<string, UploadCallbackReceipt>>();
  readonly #lockTails = new Map<string, Promise<void>>();

  async create(intent: UploadIntent): Promise<boolean> {
    return this.#withLock(intent.intentId, () => {
      if (this.#intents.has(intent.intentId)) return false;
      this.#intents.set(intent.intentId, structuredClone(intent));
      return true;
    });
  }

  async transact<T>(
    scope: UploadActorScope,
    intentId: string,
    operation: (transaction: UploadIntentTransaction) => Promise<T>,
  ): Promise<T | undefined> {
    return this.#withLock(intentId, async () => {
      const stored = this.#intents.get(intentId);
      if (
        stored === undefined ||
        stored.tenantId !== scope.tenantId ||
        stored.actorId !== scope.actorId
      ) {
        return undefined;
      }
      const callbacks = new Map(
        this.#callbacks.get(intentId)?.entries() ?? [],
      );
      const transaction = new MemoryUploadIntentTransaction(
        structuredClone(stored),
        callbacks,
      );
      const result = await operation(transaction);
      const replacement = transaction.replacement;
      if (
        replacement.intentId !== stored.intentId ||
        replacement.tenantId !== stored.tenantId ||
        replacement.actorId !== stored.actorId ||
        replacement.objectKey !== stored.objectKey
      ) {
        throw new Error("Upload repository transaction changed immutable identity.");
      }
      this.#intents.set(intentId, structuredClone(replacement));
      this.#callbacks.set(intentId, callbacks);
      return result;
    });
  }

  async #withLock<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
    const predecessor = this.#lockTails.get(key) ?? Promise.resolve();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.then(() => gate);
    this.#lockTails.set(key, tail);
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (this.#lockTails.get(key) === tail) this.#lockTails.delete(key);
    }
  }
}

class MemoryUploadIntentTransaction implements UploadIntentTransaction {
  replacement: UploadIntent;

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
    if (this.callbacks.has(receipt.callbackId)) {
      throw new Error("Callback receipt must be consumed at most once.");
    }
    this.callbacks.set(receipt.callbackId, structuredClone(receipt));
  }

  replaceIntent(intent: UploadIntent): void {
    this.replacement = structuredClone(intent);
  }
}

export class SignedUploadBoundary {
  constructor(
    private readonly repository: UploadIntentRepository,
    private readonly storage: QuarantineStorage,
    private readonly identifiers: OpaqueIdentifierFactory,
    private readonly policy: UploadPolicy,
    private readonly clock: Clock = {
      now: () => new Date().toISOString(),
    },
  ) {
    validatePolicy(policy);
  }

  async createIntent(
    scope: UploadActorScope,
    request: CreateUploadIntentRequest,
  ): Promise<UploadIntent> {
    const now = this.clock.now();
    const mediaType = canonicalMediaType(request.mediaType);
    validateScope(scope);
    validateFilename(request.filename, this.policy.maxFilenameLength ?? 255);
    validateDeclaredSize(request.declaredSizeBytes, this.policy);
    validateMediaType(mediaType, this.policy);
    validateExpiry(now, request.expiresAt, this.policy.maxIntentTtlMs);

    const intentId = this.identifiers.create("intent");
    const objectKey = this.identifiers.create("object");
    assertOpaqueIdentifier(intentId, "intent");
    assertOpaqueIdentifier(objectKey, "object");

    const signedUpload = await this.storage.createSignedUpload({
      intentId,
      tenantId: scope.tenantId,
      actorId: scope.actorId,
      objectKey,
      filename: request.filename,
      mediaType,
      declaredSizeBytes: request.declaredSizeBytes,
      expiresAt: request.expiresAt,
      disposition: "quarantine",
    });
    validateGrant(
      signedUpload,
      request.expiresAt,
      mediaType,
      request.declaredSizeBytes,
    );

    const intent: UploadIntent = {
      intentId,
      tenantId: scope.tenantId,
      actorId: scope.actorId,
      filename: request.filename,
      mediaType,
      declaredSizeBytes: request.declaredSizeBytes,
      objectKey,
      expiresAt: request.expiresAt,
      status: "quarantined",
      disposition: "quarantine",
      signedUpload: structuredClone(signedUpload),
      scanResults: [],
      promotionAttempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    if (!(await this.repository.create(intent))) {
      throw new UploadBoundaryFailure(
        "IDENTIFIER_CONFLICT",
        "The generated upload intent identifier is already in use.",
        true,
      );
    }
    return snapshot(intent);
  }

  async getIntent(
    scope: UploadActorScope,
    intentId: string,
  ): Promise<UploadIntent> {
    return this.#withOwnedIntent(scope, intentId, async ({ intent }) =>
      snapshot(intent),
    );
  }

  async recordScanResult(
    scope: UploadActorScope,
    callback: UploadScanCallback,
  ): Promise<UploadIntent> {
    validateScanIdentity(callback);
    return this.#withOwnedIntent(
      scope,
      callback.intentId,
      async (transaction) => {
        const intent = transaction.intent;
        const fingerprint = callbackFingerprint(callback);
        const replay = transaction.getCallback(callback.callbackId);
        if (replay !== undefined) {
          if (replay.fingerprint !== fingerprint) {
            throw new UploadBoundaryFailure(
              "CALLBACK_CONFLICT",
              "The callback identifier was already used for a different result.",
              false,
            );
          }
          return snapshot(intent);
        }
        if (callback.objectKey !== intent.objectKey) {
          throw new UploadBoundaryFailure(
            "OBJECT_KEY_MISMATCH",
            "The scan result does not reference the issued opaque object key.",
            false,
          );
        }
        if (Date.parse(this.clock.now()) >= Date.parse(intent.expiresAt)) {
          throw new UploadBoundaryFailure(
            "UPLOAD_INTENT_EXPIRED",
            "The upload intent expired before the scan callback was accepted.",
            false,
          );
        }
        if (intent.status !== "quarantined") {
          throw new UploadBoundaryFailure(
            "CALLBACK_CONFLICT",
            "A terminal upload intent cannot accept a new scan result.",
            false,
          );
        }

        const recordedAt = this.clock.now();
        const withScan: UploadIntent = {
          ...intent,
          scanResults: [
            ...intent.scanResults,
            { ...structuredClone(callback), recordedAt },
          ],
          updatedAt: recordedAt,
        };
        transaction.consumeCallback({
          callbackId: callback.callbackId,
          fingerprint,
        });

        const failure = scanFailure(withScan, callback, this.policy);
        if (failure !== undefined) {
          const blocked: UploadIntent = {
            ...withScan,
            status: "blocked",
            failure,
          };
          transaction.replaceIntent(blocked);
          return snapshot(blocked);
        }
        const promoted = await this.#promote(withScan);
        transaction.replaceIntent(promoted);
        return snapshot(promoted);
      },
    );
  }

  async resumePromotion(
    scope: UploadActorScope,
    intentId: string,
  ): Promise<UploadIntent> {
    return this.#withOwnedIntent(scope, intentId, async (transaction) => {
      const intent = transaction.intent;
      if (intent.status === "promoted") return snapshot(intent);
      if (intent.status !== "promotion_failed") {
        throw new UploadBoundaryFailure(
          "PROMOTION_NOT_READY",
          "Only a clean, verified upload with a retryable promotion failure can resume.",
          false,
        );
      }
      const promoted = await this.#promote(intent);
      transaction.replaceIntent(promoted);
      return snapshot(promoted);
    });
  }

  async #promote(intent: UploadIntent): Promise<UploadIntent> {
    const cleanScan = intent.scanResults.at(-1);
    if (cleanScan === undefined || scanFailure(intent, cleanScan, this.policy)) {
      throw new UploadBoundaryFailure(
        "PROMOTION_NOT_READY",
        "Promotion requires a recorded clean scan and verified size and type.",
        false,
      );
    }

    const promotionAttempts = intent.promotionAttempts + 1;
    try {
      const promotion = await this.storage.promote({
        intentId: intent.intentId,
        tenantId: intent.tenantId,
        objectKey: intent.objectKey,
        mediaType: cleanScan.magicBytes.detectedMediaType,
        verifiedSizeBytes: cleanScan.observedSizeBytes,
      });
      const { failure: _failure, ...withoutFailure } = intent;
      return {
        ...withoutFailure,
        status: "promoted",
        promotion: structuredClone(promotion),
        promotionAttempts,
        updatedAt: this.clock.now(),
      };
    } catch {
      return {
        ...intent,
        status: "promotion_failed",
        promotionAttempts,
        failure: {
          code: "PROMOTION_FAILED",
          message: "Verified quarantine object promotion failed.",
          retryable: true,
        },
        updatedAt: this.clock.now(),
      };
    }
  }

  async #withOwnedIntent<T>(
    scope: UploadActorScope,
    intentId: string,
    operation: (transaction: UploadIntentTransaction) => Promise<T>,
  ): Promise<T> {
    const result = await this.repository.transact(scope, intentId, operation);
    if (result === undefined) {
      throw new UploadBoundaryFailure(
        "TENANT_ACCESS_DENIED",
        "The requested upload intent is unavailable to this tenant and actor.",
        false,
      );
    }
    return result;
  }
}

function validatePolicy(policy: UploadPolicy): void {
  if (
    policy.allowedMediaTypes.length === 0 ||
    !Number.isSafeInteger(policy.maxDeclaredSizeBytes) ||
    policy.maxDeclaredSizeBytes <= 0 ||
    !Number.isSafeInteger(policy.maxIntentTtlMs) ||
    policy.maxIntentTtlMs <= 0
  ) {
    throw new UploadBoundaryFailure(
      "UPLOAD_POLICY_REJECTED",
      "Upload policy limits and media types must be explicit and positive.",
      false,
    );
  }
}

function validateScope(scope: UploadActorScope): void {
  if (scope.tenantId.trim() === "" || scope.actorId.trim() === "") {
    throw new UploadBoundaryFailure(
      "UPLOAD_POLICY_REJECTED",
      "Tenant and actor identity are required.",
      false,
    );
  }
}

function validateFilename(filename: string, maxLength: number): void {
  if (
    filename.trim() === "" ||
    filename.length > maxLength ||
    filename === "." ||
    filename === ".." ||
    /[\/\\\0]/u.test(filename)
  ) {
    throw new UploadBoundaryFailure(
      "UPLOAD_POLICY_REJECTED",
      "Filename must be a bounded basename without path separators.",
      false,
    );
  }
}

function validateDeclaredSize(size: number, policy: UploadPolicy): void {
  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > policy.maxDeclaredSizeBytes
  ) {
    throw new UploadBoundaryFailure(
      "UPLOAD_POLICY_REJECTED",
      "Declared upload size is invalid or exceeds policy.",
      false,
    );
  }
}

function validateMediaType(mediaType: string, policy: UploadPolicy): void {
  if (
    mediaType === "" ||
    !policy.allowedMediaTypes.map(canonicalMediaType).includes(mediaType)
  ) {
    throw new UploadBoundaryFailure(
      "UPLOAD_POLICY_REJECTED",
      "Declared media type is not allowed.",
      false,
    );
  }
}

function validateExpiry(
  now: string,
  expiresAt: string,
  maxIntentTtlMs: number,
): void {
  const nowMs = Date.parse(now);
  const expiryMs = Date.parse(expiresAt);
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(expiryMs) ||
    expiryMs <= nowMs ||
    expiryMs - nowMs > maxIntentTtlMs
  ) {
    throw new UploadBoundaryFailure(
      "UPLOAD_POLICY_REJECTED",
      "Upload expiry must be explicit, in the future, and within policy.",
      false,
    );
  }
}

function validateGrant(
  grant: SignedUploadGrant,
  intentExpiry: string,
  mediaType: string,
  declaredSizeBytes: number,
): void {
  const grantExpiryMs = Date.parse(grant.expiresAt);
  const headers = Object.fromEntries(
    Object.entries(grant.requiredHeaders).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
  let protocol: string | undefined;
  try {
    protocol = new URL(grant.url).protocol;
  } catch {
    protocol = undefined;
  }
  if (
    protocol !== "https:" ||
    !Number.isFinite(grantExpiryMs) ||
    grantExpiryMs > Date.parse(intentExpiry) ||
    canonicalMediaType(headers["content-type"] ?? "") !== mediaType ||
    headers["content-length"] !== String(declaredSizeBytes)
  ) {
    throw new UploadBoundaryFailure(
      "UPLOAD_POLICY_REJECTED",
      "Storage returned an insecure, overlong, or insufficiently bound upload grant.",
      false,
    );
  }
}

function canonicalMediaType(mediaType: string): string {
  return mediaType.trim().toLowerCase();
}

function assertOpaqueIdentifier(
  value: string,
  kind: "intent" | "object",
): void {
  if (
    value.trim() === "" ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes(":")
  ) {
    throw new UploadBoundaryFailure(
      "UPLOAD_POLICY_REJECTED",
      `The ${kind} identifier factory must return an opaque identifier.`,
      false,
    );
  }
}

function scanFailure(
  intent: UploadIntent,
  scan: UploadScanCallback,
  policy: UploadPolicy,
): UploadIntentFailure | undefined {
  if (
    !Number.isSafeInteger(scan.observedSizeBytes) ||
    scan.observedSizeBytes <= 0 ||
    scan.observedSizeBytes > policy.maxDeclaredSizeBytes ||
    scan.observedSizeBytes !== intent.declaredSizeBytes
  ) {
    return {
      code: "DECLARED_SIZE_MISMATCH",
      message: "Observed object size does not match the declared size.",
      retryable: false,
    };
  }
  if (
    !scan.magicBytes.matchesDeclaredType ||
    canonicalMediaType(scan.magicBytes.detectedMediaType) !== intent.mediaType ||
    !policy.allowedMediaTypes
      .map(canonicalMediaType)
      .includes(canonicalMediaType(scan.magicBytes.detectedMediaType))
  ) {
    return {
      code: "MEDIA_TYPE_MISMATCH",
      message: "Magic-byte type does not match the declared allowed type.",
      retryable: false,
    };
  }
  if (scan.malware.status === "infected") {
    return {
      code: "MALWARE_DETECTED",
      message: "Malware scanning blocked the quarantine object.",
      retryable: false,
    };
  }
  if (scan.malware.status !== "clean") {
    return {
      code: "SCAN_INCOMPLETE",
      message: "Malware scanning did not return a clean result.",
      retryable: true,
    };
  }
  return undefined;
}

function callbackFingerprint(callback: UploadScanCallback): string {
  return JSON.stringify([
    callback.intentId,
    callback.objectKey,
    callback.observedSizeBytes,
    callback.magicBytes.detectedMediaType,
    callback.magicBytes.signature,
    callback.magicBytes.matchesDeclaredType,
    callback.malware.status,
    callback.malware.engine,
    callback.malware.signatureVersion,
    callback.malware.scannedAt,
    callback.malware.threatName ?? null,
  ]);
}

function validateScanIdentity(callback: UploadScanCallback): void {
  if (
    callback.callbackId.trim() === "" ||
    callback.intentId.trim() === "" ||
    callback.objectKey.trim() === "" ||
    callback.magicBytes.detectedMediaType.trim() === "" ||
    callback.magicBytes.signature.trim() === "" ||
    callback.malware.engine.trim() === "" ||
    callback.malware.signatureVersion.trim() === "" ||
    !Number.isFinite(Date.parse(callback.malware.scannedAt))
  ) {
    throw new UploadBoundaryFailure(
      "SCAN_INCOMPLETE",
      "Scan callback identity and evidence must be complete.",
      true,
    );
  }
}

function snapshot(intent: UploadIntent): UploadIntent {
  return structuredClone(intent);
}

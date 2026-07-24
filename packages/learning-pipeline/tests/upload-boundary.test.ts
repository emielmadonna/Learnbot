import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryUploadIntentRepository,
  SignedUploadBoundary,
  UploadBoundaryFailure,
  type Clock,
  type OpaqueIdentifierFactory,
  type PromoteQuarantinedObjectRequest,
  type PromotionReceipt,
  type QuarantineStorage,
  type SignedQuarantineUploadRequest,
  type SignedUploadGrant,
  type UploadScanCallback,
} from "../src/index.js";

class MutableClock implements Clock {
  constructor(public instant = "2026-01-01T00:00:00.000Z") {}

  now(): string {
    return this.instant;
  }
}

class SequentialIdentifiers implements OpaqueIdentifierFactory {
  #next = 0;

  create(kind: "intent" | "object"): string {
    this.#next += 1;
    return `${kind}-${this.#next}`;
  }
}

class RecordingStorage implements QuarantineStorage {
  readonly signed: SignedQuarantineUploadRequest[] = [];
  readonly promotions: PromoteQuarantinedObjectRequest[] = [];
  failPromotions = 0;
  grantUrl = "https://upload.invalid";

  async createSignedUpload(
    request: SignedQuarantineUploadRequest,
  ): Promise<SignedUploadGrant> {
    this.signed.push(structuredClone(request));
    return {
      url: `${this.grantUrl}/${request.objectKey}`,
      method: "PUT",
      expiresAt: request.expiresAt,
      requiredHeaders: {
        "content-type": request.mediaType,
        "content-length": String(request.declaredSizeBytes),
      },
    };
  }

  async promote(
    request: PromoteQuarantinedObjectRequest,
  ): Promise<PromotionReceipt> {
    this.promotions.push(structuredClone(request));
    if (this.failPromotions > 0) {
      this.failPromotions -= 1;
      throw new Error("transient storage failure");
    }
    return {
      assetId: `asset-${request.intentId}`,
      promotedAt: "2026-01-01T00:00:10.000Z",
    };
  }
}

const tenantA = { tenantId: "tenant-a", actorId: "actor-a" } as const;
const tenantB = { tenantId: "tenant-b", actorId: "actor-b" } as const;

test("intent is tenant/actor bound, short-lived, opaque, and quarantined", async () => {
  const { boundary, storage } = fixture();
  const intent = await createIntent(boundary);

  assert.equal(intent.status, "quarantined");
  assert.equal(intent.disposition, "quarantine");
  assert.equal(intent.tenantId, tenantA.tenantId);
  assert.equal(intent.actorId, tenantA.actorId);
  assert.equal(intent.objectKey, "object-2");
  assert.equal(storage.signed[0]?.disposition, "quarantine");
  assert.equal(storage.signed[0]?.tenantId, tenantA.tenantId);
  assert.equal(storage.signed[0]?.actorId, tenantA.actorId);
  await expectFailure(
    boundary.getIntent(tenantB, intent.intentId),
    "TENANT_ACCESS_DENIED",
  );
  await expectFailure(
    boundary.recordScanResult(
      tenantB,
      cleanCallback(intent.intentId, intent.objectKey),
    ),
    "TENANT_ACCESS_DENIED",
  );
  await expectFailure(
    boundary.getIntent(
      { tenantId: tenantA.tenantId, actorId: "different-actor" },
      intent.intentId,
    ),
    "TENANT_ACCESS_DENIED",
  );
});

test("storage signer must return an HTTPS, size/type-bound grant", async () => {
  const { boundary, storage } = fixture();
  storage.grantUrl = "http://upload.invalid";

  await expectFailure(
    boundary.createIntent(tenantA, baseRequest()),
    "UPLOAD_POLICY_REJECTED",
  );
});

test("policy rejects unsafe filename, MIME, declared size, and overlong expiry", async () => {
  const { boundary } = fixture();
  for (const request of [
    baseRequest({ filename: "../lesson.pdf" }),
    baseRequest({ mediaType: "application/executable" }),
    baseRequest({ declaredSizeBytes: 1_000_001 }),
    baseRequest({ expiresAt: "2026-01-01T00:06:00.000Z" }),
  ]) {
    await expectFailure(
      boundary.createIntent(tenantA, request),
      "UPLOAD_POLICY_REJECTED",
    );
  }
});

test("forged object key is rejected without authorizing by path", async () => {
  const { boundary, storage } = fixture();
  const intent = await createIntent(boundary);

  await expectFailure(
    boundary.recordScanResult(
      tenantA,
      cleanCallback(intent.intentId, "tenant-a/looks-legitimate.pdf"),
    ),
    "OBJECT_KEY_MISMATCH",
  );
  assert.equal(storage.promotions.length, 0);
  assert.equal(
    (await boundary.getIntent(tenantA, intent.intentId)).status,
    "quarantined",
  );
});

test("oversized or magic-byte mismatched objects remain blocked", async () => {
  const sizeFixture = fixture();
  const sizeIntent = await createIntent(sizeFixture.boundary);
  const oversized = await sizeFixture.boundary.recordScanResult(tenantA, {
    ...cleanCallback(sizeIntent.intentId, sizeIntent.objectKey),
    observedSizeBytes: 101,
  });
  assert.equal(oversized.status, "blocked");
  assert.equal(oversized.failure?.code, "DECLARED_SIZE_MISMATCH");
  assert.equal(sizeFixture.storage.promotions.length, 0);

  const typeFixture = fixture();
  const typeIntent = await createIntent(typeFixture.boundary);
  const mismatched = await typeFixture.boundary.recordScanResult(tenantA, {
    ...cleanCallback(typeIntent.intentId, typeIntent.objectKey),
    magicBytes: {
      detectedMediaType: "text/plain",
      signature: "ASCII",
      matchesDeclaredType: false,
    },
  });
  assert.equal(mismatched.status, "blocked");
  assert.equal(mismatched.failure?.code, "MEDIA_TYPE_MISMATCH");
  assert.equal(typeFixture.storage.promotions.length, 0);
});

test("callback replay is idempotent and conflicting reuse is rejected", async () => {
  const { boundary, storage } = fixture();
  const intent = await createIntent(boundary);
  const callback = cleanCallback(intent.intentId, intent.objectKey);

  const [promoted, replay] = await Promise.all([
    boundary.recordScanResult(tenantA, callback),
    boundary.recordScanResult(tenantA, callback),
  ]);
  assert.deepEqual(replay, promoted);
  assert.equal(storage.promotions.length, 1);
  assert.equal(replay.scanResults.length, 1);

  await expectFailure(
    boundary.recordScanResult(tenantA, {
      ...callback,
      observedSizeBytes: 99,
    }),
    "CALLBACK_CONFLICT",
  );
});

test("durable repository survives service re-instantiation", async () => {
  const { boundary, storage, clock, repository } = fixture();
  const intent = await createIntent(boundary);
  const restarted = createBoundary(repository, storage, clock);

  assert.deepEqual(
    await restarted.getIntent(tenantA, intent.intentId),
    intent,
  );
  const promoted = await restarted.recordScanResult(
    tenantA,
    cleanCallback(intent.intentId, intent.objectKey),
  );
  assert.equal(promoted.status, "promoted");
  assert.equal(storage.promotions.length, 1);
});

test("concurrent conflicting callbacks consume one id atomically", async () => {
  const { boundary, storage } = fixture();
  const intent = await createIntent(boundary);
  const clean = cleanCallback(intent.intentId, intent.objectKey);
  const conflict = { ...clean, observedSizeBytes: 99 };
  const results = await Promise.allSettled([
    boundary.recordScanResult(tenantA, clean),
    boundary.recordScanResult(tenantA, conflict),
  ]);

  assert.equal(results[0]?.status, "fulfilled");
  assert.equal(results[1]?.status, "rejected");
  if (results[1]?.status === "rejected") {
    assert.equal(isFailure("CALLBACK_CONFLICT")(results[1].reason), true);
  }
  assert.equal(storage.promotions.length, 1);
  assert.equal(
    (await boundary.getIntent(tenantA, intent.intentId)).scanResults.length,
    1,
  );
});

test("malware result is recorded and blocks promotion", async () => {
  const { boundary, storage } = fixture();
  const intent = await createIntent(boundary);
  const blocked = await boundary.recordScanResult(tenantA, {
    ...cleanCallback(intent.intentId, intent.objectKey),
    malware: {
      status: "infected",
      engine: "scanner",
      signatureVersion: "2026.001",
      scannedAt: "2026-01-01T00:00:01.000Z",
      threatName: "EICAR-Test-File",
    },
  });

  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.failure?.code, "MALWARE_DETECTED");
  assert.equal(blocked.scanResults[0]?.malware.threatName, "EICAR-Test-File");
  assert.equal(storage.promotions.length, 0);
});

test("expired intent rejects callback and never promotes", async () => {
  const { boundary, clock, storage } = fixture();
  const intent = await createIntent(boundary);
  clock.instant = intent.expiresAt;

  await expectFailure(
    boundary.recordScanResult(
      tenantA,
      cleanCallback(intent.intentId, intent.objectKey),
    ),
    "UPLOAD_INTENT_EXPIRED",
  );
  assert.equal(storage.promotions.length, 0);
});

test("clean verified scan promotes and retryable promotion resumes", async () => {
  const { boundary, storage } = fixture();
  storage.failPromotions = 1;
  const intent = await createIntent(boundary);
  const failed = await boundary.recordScanResult(
    tenantA,
    cleanCallback(intent.intentId, intent.objectKey),
  );

  assert.equal(failed.status, "promotion_failed");
  assert.deepEqual(failed.failure, {
    code: "PROMOTION_FAILED",
    message: "Verified quarantine object promotion failed.",
    retryable: true,
  });
  assert.equal(failed.promotionAttempts, 1);

  const resumed = await boundary.resumePromotion(tenantA, intent.intentId);
  assert.equal(resumed.status, "promoted");
  assert.equal(resumed.promotionAttempts, 2);
  assert.equal(resumed.failure, undefined);
  assert.equal(resumed.promotion?.assetId, `asset-${intent.intentId}`);
  assert.equal(storage.promotions.length, 2);
  assert.deepEqual(storage.promotions[1], {
    intentId: intent.intentId,
    tenantId: tenantA.tenantId,
    objectKey: intent.objectKey,
    mediaType: "application/pdf",
    verifiedSizeBytes: 100,
  });
});

function fixture(): {
  boundary: SignedUploadBoundary;
  storage: RecordingStorage;
  clock: MutableClock;
  repository: MemoryUploadIntentRepository;
} {
  const storage = new RecordingStorage();
  const clock = new MutableClock();
  const repository = new MemoryUploadIntentRepository();
  return {
    boundary: createBoundary(repository, storage, clock),
    storage,
    clock,
    repository,
  };
}

function createBoundary(
  repository: MemoryUploadIntentRepository,
  storage: RecordingStorage,
  clock: MutableClock,
): SignedUploadBoundary {
  return new SignedUploadBoundary(
    repository,
    storage,
    new SequentialIdentifiers(),
    {
      allowedMediaTypes: ["application/pdf", "text/plain"],
      maxDeclaredSizeBytes: 1_000_000,
      maxIntentTtlMs: 5 * 60 * 1_000,
    },
    clock,
  );
}

async function createIntent(
  boundary: SignedUploadBoundary,
): Promise<Awaited<ReturnType<SignedUploadBoundary["createIntent"]>>> {
  return boundary.createIntent(tenantA, baseRequest());
}

function baseRequest(
  overrides: Partial<Parameters<SignedUploadBoundary["createIntent"]>[1]> = {},
): Parameters<SignedUploadBoundary["createIntent"]>[1] {
  return {
    filename: "lesson.pdf",
    mediaType: "application/pdf",
    declaredSizeBytes: 100,
    expiresAt: "2026-01-01T00:04:00.000Z",
    ...overrides,
  };
}

function cleanCallback(
  intentId: string,
  objectKey: string,
): UploadScanCallback {
  return {
    callbackId: "callback-1",
    intentId,
    objectKey,
    observedSizeBytes: 100,
    magicBytes: {
      detectedMediaType: "application/pdf",
      signature: "25504446",
      matchesDeclaredType: true,
    },
    malware: {
      status: "clean",
      engine: "scanner",
      signatureVersion: "2026.001",
      scannedAt: "2026-01-01T00:00:01.000Z",
    },
  };
}

function isFailure(
  code: UploadBoundaryFailure["code"],
): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error instanceof UploadBoundaryFailure && error.code === code;
}

async function expectFailure(
  operation: Promise<unknown>,
  code: UploadBoundaryFailure["code"],
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    assert.equal(isFailure(code)(error), true);
    return;
  }
  throw new Error(`Expected ${code}.`);
}

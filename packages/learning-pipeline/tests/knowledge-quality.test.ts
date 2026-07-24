import assert from "node:assert/strict";
import test from "node:test";
import {
  DeterministicKnowledgeQualityService,
  PipelineFailure,
  VersionedIndexPublicationService,
  type EmbeddedChunk,
  type IndexPublicationCandidate,
  type IndexPublicationRepository,
  type ProcessingFingerprint,
  type PublishedIndexVersion,
} from "../src/index.js";

const tenant = { tenantId: "tenant-a" } as const;
const service = new DeterministicKnowledgeQualityService();

test("reports cleaned chunk quality from measurable checks without a score", () => {
  const good = chunk("chunk-a", "alpha beta gamma");
  const duplicate = chunk("chunk-b", "alpha beta gamma");
  const malformed = {
    ...chunk("chunk-c", "delta"),
    tokenCount: 99,
  };
  const usable = chunk("chunk-d", "epsilon zeta");

  const report = service.assessCleanedChunks(
    tenant,
    [good, duplicate, malformed, usable],
    { minimumTokens: 1, maximumTokens: 20 },
  );

  assert.equal(report.state, "partial");
  assert.equal(report.chunkCount, 4);
  assert.equal(report.usableChunkCount, 1);
  assert.deepEqual(
    report.checks.find((check) => check.check === "duplicate_text_absent")
      ?.affectedChunkIds,
    ["chunk-a", "chunk-b"],
  );
  assert.deepEqual(
    report.checks.find((check) => check.check === "token_bounds")
      ?.affectedChunkIds,
    ["chunk-c"],
  );
  assert.equal("score" in report, false);
});

test("distinguishes blocked, partial and known cleaned evidence", () => {
  assert.equal(
    service.assessCleanedChunks(tenant, [], {
      minimumTokens: 1,
      maximumTokens: 20,
    }).state,
    "blocked",
  );
  assert.equal(
    service.assessCleanedChunks(
      tenant,
      [chunk("chunk-a", "alpha beta gamma")],
      { minimumTokens: 1, maximumTokens: 20 },
    ).state,
    "known",
  );
});

test("aligns objectives only to explicit author-supplied evidence terms", () => {
  const report = service.assessObjectiveAlignment(
    tenant,
    [
      {
        objectiveId: "objective-a",
        text: "Explain spaced practice",
        requiredEvidenceTerms: ["spaced practice", "retrieval"],
      },
      {
        objectiveId: "objective-b",
        text: "Apply feedback",
        requiredEvidenceTerms: ["feedback loop", "reflection"],
      },
    ],
    [
      chunk(
        "chunk-a",
        "Spaced practice combines retrieval with deliberate review.",
      ),
      chunk("chunk-b", "A feedback loop supports improvement."),
    ],
  );

  assert.equal(report.state, "partial");
  assert.deepEqual(report.objectives[0], {
    objectiveId: "objective-a",
    state: "known",
    matchedTerms: ["spaced practice", "retrieval"],
    missingTerms: [],
    supportingChunkIds: ["chunk-a"],
  });
  assert.deepEqual(report.objectives[1]?.missingTerms, ["reflection"]);
});

test("blocks objective claims when objectives lack explicit evidence terms", () => {
  const report = service.assessObjectiveAlignment(
    tenant,
    [
      {
        objectiveId: "objective-a",
        text: "Understand the material",
        requiredEvidenceTerms: [],
      },
    ],
    [chunk("chunk-a", "Material")],
  );
  assert.equal(report.state, "blocked");
  assert.equal(report.objectives[0]?.state, "blocked");
});

test("retrieval readiness preserves per-chunk evidence and exact failure reasons", () => {
  const ready = retrieval(chunk("chunk-a", "alpha beta"));
  const failed = retrieval({
    ...chunk("chunk-b", "gamma delta"),
    embedding: [0.2, Number.NaN],
  });
  const report = service.assessRetrievalReadiness(
    tenant,
    [ready, failed],
    3,
  );

  assert.equal(report.state, "partial");
  assert.equal(report.readyChunkCount, 1);
  assert.deepEqual(report.chunks[1]?.reasons, [
    "embedding_dimension_mismatch",
    "embedding_not_finite",
  ]);
  assert.equal(report.chunks[0]?.sourceHash, "source-hash");
  assert.equal(report.chunks[0]?.documentVersion, 2);
});

test("quality operations deny cross-tenant chunks", () => {
  assert.throws(
    () =>
      service.assessCleanedChunks(
        tenant,
        [{ ...chunk("chunk-a", "alpha"), tenantId: "tenant-b" }],
        { minimumTokens: 1, maximumTokens: 20 },
      ),
    (error: unknown) =>
      error instanceof PipelineFailure &&
      error.code === "TENANT_ACCESS_DENIED",
  );
});

test("selective reprocessing invalidates only stages downstream of measured changes", () => {
  const previous = fingerprint();
  const next: ProcessingFingerprint = {
    ...previous,
    embeddingModel: "embedding-v2",
    diagramVersion: "diagram-v2",
  };
  const decision = service.decideSelectiveReprocessing(tenant, previous, next, [
    chunk("chunk-a", "alpha"),
    chunk("chunk-b", "beta"),
  ]);

  assert.equal(decision.required, true);
  assert.deepEqual(decision.reasons, [
    "embedding_changed",
    "diagram_extractor_changed",
  ]);
  assert.deepEqual(decision.invalidatedStages, ["embed", "diagram.extract"]);
  assert.equal(decision.estimatedEmbeddingWrites, 2);
  assert.deepEqual(decision.affectedChunkIds, ["chunk-a", "chunk-b"]);

  const unchanged = service.decideSelectiveReprocessing(
    tenant,
    previous,
    previous,
    [chunk("chunk-a", "alpha")],
  );
  assert.deepEqual(unchanged, {
    required: false,
    reasons: [],
    invalidatedStages: [],
    affectedChunkIds: [],
    estimatedEmbeddingWrites: 0,
  });
});

test("source changes deterministically invalidate the complete pipeline", () => {
  const previous = fingerprint();
  const decision = service.decideSelectiveReprocessing(
    tenant,
    previous,
    { ...previous, sourceHash: "new-source" },
    [chunk("chunk-a", "alpha")],
  );
  assert.deepEqual(decision.reasons, ["source_changed"]);
  assert.deepEqual(decision.invalidatedStages, [
    "validate",
    "scan",
    "extract",
    "clean",
    "structure",
    "chunk",
    "embed",
    "diagram.extract",
  ]);
});

test("publishes a versioned index only with complete known evidence", async () => {
  const repository = new RecordingIndexRepository();
  const publisher = new VersionedIndexPublicationService(repository, {
    now: () => "2026-07-23T12:00:00.000Z",
  });
  const candidate = publicationCandidate();
  const published = await publisher.publish(tenant, candidate);

  assert.equal(published.status, "active");
  assert.equal(published.publishedAt, "2026-07-23T12:00:00.000Z");
  assert.deepEqual(published.evidence, {
    chunkQuality: "known",
    objectiveAlignment: "known",
    retrievalReadiness: "known",
  });
  assert.equal(repository.active?.indexVersionId, "index-v1");
});

test("versioned publication fails closed for partial evidence and races", async () => {
  const repository = new RecordingIndexRepository();
  const publisher = new VersionedIndexPublicationService(repository);
  const candidate = publicationCandidate();

  await assert.rejects(
    publisher.publish(tenant, {
      ...candidate,
      objectiveAlignment: {
        ...candidate.objectiveAlignment,
        state: "partial",
      },
    }),
    isVersionConflict,
  );

  repository.active = {
    ...(await publisher.publish(tenant, candidate)),
    indexVersionId: "index-v2",
  };
  await assert.rejects(
    publisher.publish(tenant, {
      ...candidate,
      indexVersionId: "index-v3",
    }),
    isVersionConflict,
  );
});

test("versioned publication detects an atomic activation race", async () => {
  const repository = new RecordingIndexRepository();
  const publisher = new VersionedIndexPublicationService(repository);
  const first = await publisher.publish(tenant, publicationCandidate());
  repository.failNextActivation = true;

  await assert.rejects(
    publisher.publish(
      tenant,
      {
        ...publicationCandidate(),
        indexVersionId: "index-v2",
      },
      first.indexVersionId,
    ),
    isVersionConflict,
  );
  assert.equal(repository.active?.indexVersionId, "index-v1");
});

function chunk(chunkId: string, text: string): EmbeddedChunk {
  return {
    chunkId,
    tenantId: "tenant-a",
    documentId: "document-a",
    text,
    ordinal: 0,
    tokenCount: Math.ceil(text.trim().split(/\s+/u).filter(Boolean).length * 1.33),
    assetIds: [],
    metadata: { wordStart: 0 },
    embedding: [0.1, 0.2, 0.3],
  };
}

function retrieval(candidate: EmbeddedChunk) {
  return {
    chunk: candidate,
    source: {
      sourceHash: "source-hash",
      documentVersion: 2,
      locator: "page:1",
    },
  };
}

function fingerprint(): ProcessingFingerprint {
  return {
    sourceHash: "source-v1",
    cleanupVersion: "cleanup-v1",
    structureVersion: "structure-v1",
    chunkingVersion: "chunk-v1",
    embeddingProvider: "provider-a",
    embeddingModel: "embedding-v1",
    embeddingDimensions: 3,
    diagramVersion: "diagram-v1",
  };
}

function publicationCandidate(): IndexPublicationCandidate {
  const readyChunk = chunk("chunk-a", "alpha beta");
  return {
    tenantId: "tenant-a",
    indexName: "course-search",
    indexVersionId: "index-v1",
    knowledgeVersionId: "knowledge-v1",
    embedding: {
      provider: "provider-a",
      model: "embedding-v1",
      dimensions: 3,
    },
    chunkIds: ["chunk-a"],
    builtAt: "2026-07-23T11:00:00.000Z",
    artifactHash: "sha256:artifact",
    chunkQuality: service.assessCleanedChunks(tenant, [readyChunk], {
      minimumTokens: 1,
      maximumTokens: 20,
    }),
    objectiveAlignment: service.assessObjectiveAlignment(
      tenant,
      [
        {
          objectiveId: "objective-a",
          text: "Recall alpha",
          requiredEvidenceTerms: ["alpha"],
        },
      ],
      [readyChunk],
    ),
    retrievalReadiness: service.assessRetrievalReadiness(
      tenant,
      [retrieval(readyChunk)],
      3,
    ),
  };
}

class RecordingIndexRepository implements IndexPublicationRepository {
  active: PublishedIndexVersion | undefined;
  failNextActivation = false;

  async getActive() {
    return this.active;
  }

  async activate(
    _scope: { readonly tenantId: string },
    publication: PublishedIndexVersion,
    expectedActiveVersionId: string | undefined,
  ) {
    if (this.failNextActivation) {
      this.failNextActivation = false;
      return false;
    }
    if (this.active?.indexVersionId !== expectedActiveVersionId) return false;
    this.active = publication;
    return true;
  }
}

function isVersionConflict(error: unknown): boolean {
  return (
    error instanceof PipelineFailure && error.code === "VERSION_CONFLICT"
  );
}

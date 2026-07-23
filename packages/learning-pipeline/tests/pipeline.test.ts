import assert from "node:assert/strict";
import test from "node:test";
import {
  DeterministicLearningPipeline,
  LEGACY_OVERLAP_WORDS,
  LEGACY_PAUSE_BOUNDARY_MS,
  LEGACY_TARGET_WORDS,
  PipelineFailure,
  legacyChunk,
  paragraphizeTranscript,
  type Clock,
  type SourceIntake,
} from "../src/index.js";

class IncrementingClock implements Clock {
  #tick = 0;

  now(): string {
    this.#tick += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, this.#tick)).toISOString();
  }
}

const tenantA = { tenantId: "tenant-a" } as const;
const tenantB = { tenantId: "tenant-b" } as const;

test("ING-02 preserves the 1.8s paragraph boundary and 220/40 chunking", () => {
  const firstWords = numberedWords(1, 120);
  const secondWords = numberedWords(121, 260);
  const paragraphs = paragraphizeTranscript([
    { text: firstWords, startMs: 0, endMs: 10_000 },
    {
      text: secondWords,
      startMs: 10_000 + LEGACY_PAUSE_BOUNDARY_MS,
      endMs: 30_000,
    },
  ]);

  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[0]?.text, firstWords);
  assert.equal(paragraphs[1]?.text, secondWords);
  assert.equal(paragraphs[0]?.startMs, 0);
  assert.equal(paragraphs[1]?.startMs, 11_800);

  const chunks = legacyChunk("tenant-a", "document-a", paragraphs);
  assert.equal(chunks.length, 2);
  const first = chunks[0]!.text.split(" ");
  const second = chunks[1]!.text.split(" ");
  assert.equal(first.length, LEGACY_TARGET_WORDS);
  assert.equal(second.length, 80);
  assert.deepEqual(
    first.slice(-LEGACY_OVERLAP_WORDS),
    second.slice(0, LEGACY_OVERLAP_WORDS),
  );
  assert.equal(chunks[0]!.metadata.wordCount, 220);
  assert.equal(chunks[1]!.metadata.wordStart, 180);
  assert.equal(chunks[0]!.metadata.startTimestampMs, 0);
  assert.equal(chunks[1]!.metadata.endTimestampMs, 30_000);
  assert.equal(
    chunks.flatMap((chunk, index) =>
      index === 0
        ? chunk.text.split(" ")
        : chunk.text.split(" ").slice(LEGACY_OVERLAP_WORDS),
    ).join(" "),
    `${firstWords} ${secondWords}`,
  );
});

test("ING-04 previews exact selective impact and keeps active retrieval stable", () => {
  const pipeline = new DeterministicLearningPipeline(new IncrementingClock());
  const initial = pipeline.start(
    tenantA,
    intake(numberedWords(1, 300)),
    "initial-import",
  );
  assert.equal(initial.status, "succeeded");
  const active = pipeline.publish(tenantA, initial.draftVersionId!, undefined);
  const originalChunkIds = active.chunks.map((chunk) => chunk.chunkId);

  const change = {
    kind: "cleanup_recipe" as const,
    documentIds: ["document-a"],
    recipes: [
      {
        type: "replace" as const,
        search: "word150",
        replacement: "corrected150",
      },
    ],
  };
  const preview = pipeline.previewSelectiveReprocess(tenantA, change);
  assert.deepEqual(preview.targetDocumentIds, ["document-a"]);
  assert.deepEqual(preview.affectedChunkIds, originalChunkIds);
  assert.deepEqual(preview.invalidatedStages, [
    "clean",
    "structure",
    "chunk",
    "embed",
    "diagram.extract",
  ]);
  assert.equal(preview.activeVersionRemains, active.versionId);

  const result = pipeline.selectiveReprocess(
    tenantA,
    change,
    "selective-cleanup",
  );
  assert.equal(pipeline.getActiveVersion(tenantA)?.versionId, active.versionId);
  assert.equal(result.draftVersion.status, "draft");
  assert.match(result.draftVersion.documents[0]!.body, /corrected150/u);
  assert.deepEqual(
    result.job.stages
      .filter((stage) => stage.attempt === 1)
      .map((stage) => stage.stage),
    preview.invalidatedStages,
  );
  assert.deepEqual(
    result.job.stages
      .filter((stage) => stage.attempt === 0)
      .map((stage) => stage.stage),
    ["validate", "scan", "extract"],
  );

  const newlyActive = pipeline.publish(
    tenantA,
    result.draftVersion.versionId,
    active.versionId,
  );
  assert.equal(newlyActive.status, "active");
  assert.equal(
    pipeline.listVersions(tenantA).find((version) => version.versionId === active.versionId)
      ?.status,
    "retired",
  );
  const rolledBack = pipeline.rollback(
    tenantA,
    active.versionId,
    newlyActive.versionId,
  );
  assert.equal(rolledBack.versionId, active.versionId);
  assert.equal(pipeline.getActiveVersion(tenantA)?.versionId, active.versionId);
});

test("ING-05 exposes one typed stage failure to UI, API and MCP and resumes idempotently", () => {
  const pipeline = new DeterministicLearningPipeline(new IncrementingClock());
  const failed = pipeline.start(tenantA, intake("Diagram: Learn -> Practice"), "failed-job", {
    failAtStage: "embed",
  });
  assert.equal(failed.status, "failed");

  const ui = pipeline.getUiOperationState(tenantA, failed.jobId);
  const api = pipeline.getApiOperationState(tenantA, failed.jobId);
  const mcp = pipeline.getMcpOperationState(tenantA, failed.jobId);
  assert.deepEqual(ui, api);
  assert.deepEqual(api, mcp);
  assert.deepEqual(ui.failure, {
    stage: "embed",
    code: "EMBED_FAILED",
    message: "Simulated embed failure.",
    retryable: true,
  });

  const resumed = pipeline.resume(tenantA, failed.jobId);
  assert.equal(resumed.status, "succeeded");
  assert.equal(
    resumed.stages.find((stage) => stage.stage === "chunk")?.attempt,
    1,
  );
  assert.equal(
    resumed.stages.find((stage) => stage.stage === "embed")?.attempt,
    2,
  );
  const replay = pipeline.start(
    tenantA,
    intake("Diagram: Learn -> Practice"),
    "failed-job",
  );
  assert.deepEqual(replay, resumed);
  assert.equal(resumed.artifacts.diagrams[0]?.state, "pending");
  assert.equal(resumed.artifacts.diagrams[0]?.safety, "safe");
  const approved = pipeline.reviewDiagramCandidate(
    tenantA,
    resumed.draftVersionId!,
    resumed.artifacts.diagrams[0]!.candidateId,
    "approve",
    "Verified against the lesson.",
  );
  assert.equal(approved.state, "approved");
});

test("resume replays original intake when extraction itself failed", () => {
  const pipeline = new DeterministicLearningPipeline(new IncrementingClock());
  const failed = pipeline.start(
    tenantA,
    intake("original source content"),
    "extract-retry",
    { failAtStage: "extract" },
  );
  assert.equal(failed.status, "failed");
  const resumed = pipeline.resume(tenantA, failed.jobId);
  assert.equal(resumed.status, "succeeded");
  assert.equal(resumed.artifacts.document?.body, "original source content");
  assert.equal(
    resumed.stages.find((stage) => stage.stage === "extract")?.attempt,
    2,
  );
});

test("tenant boundaries deny source intake, job reads, versions and impact previews", () => {
  const pipeline = new DeterministicLearningPipeline(new IncrementingClock());
  assert.throws(
    () => pipeline.start(tenantB, intake("private tenant A content"), "cross-tenant"),
    isTenantDenial,
  );

  const job = pipeline.start(
    tenantA,
    intake("private tenant A content"),
    "tenant-a-job",
  );
  const active = pipeline.publish(tenantA, job.draftVersionId!, undefined);
  assert.throws(() => pipeline.getJob(tenantB, job.jobId), isTenantDenial);
  assert.throws(
    () => pipeline.publish(tenantB, active.versionId),
    isTenantDenial,
  );
  assert.throws(
    () =>
      pipeline.previewSelectiveReprocess(tenantB, {
        kind: "edit_document",
        documentIds: ["document-a"],
        replacementBody: "attempted theft",
      }),
    (error: unknown) =>
      error instanceof PipelineFailure && error.code === "NOT_FOUND",
  );
});

function intake(body: string): SourceIntake {
  return {
    tenantId: tenantA.tenantId,
    sourceId: "source-a",
    documentId: "document-a",
    title: "A lesson",
    mediaType: "text/plain",
    contentHash: `hash-${body.length}`,
    body,
    courseId: "course-a",
    moduleId: "module-a",
    lessonId: "lesson-a",
  };
}

function numberedWords(start: number, end: number): string {
  return Array.from(
    { length: end - start + 1 },
    (_, index) => `word${start + index}`,
  ).join(" ");
}

function isTenantDenial(error: unknown): boolean {
  return (
    error instanceof PipelineFailure && error.code === "TENANT_ACCESS_DENIED"
  );
}

import type { IsoTimestamp } from "@course-ai/contracts";
import { PIPELINE_STAGES, PipelineFailure } from "./types.js";
import type {
  EmbeddedChunk,
  PipelineStage,
  TenantScope,
} from "./types.js";

export type EvidenceState = "known" | "partial" | "blocked";

export type QualityCheckStatus = "passed" | "failed" | "blocked";

export interface QualityCheck {
  readonly check:
    | "chunks_present"
    | "text_present"
    | "token_count_valid"
    | "token_bounds"
    | "control_characters_absent"
    | "duplicate_text_absent";
  readonly status: QualityCheckStatus;
  readonly measured: number;
  readonly expected: string;
  readonly affectedChunkIds: readonly string[];
}

export interface ChunkQualityPolicy {
  readonly minimumTokens: number;
  readonly maximumTokens: number;
}

export interface CleanedChunkQualityReport {
  readonly tenantId: string;
  readonly state: EvidenceState;
  readonly chunkCount: number;
  readonly usableChunkCount: number;
  readonly checks: readonly QualityCheck[];
}

export interface LearningObjective {
  /**
   * Author- or curriculum-supplied terms that count as evidence. The service
   * deliberately does not infer semantic equivalence or invent a quality score.
   */
  readonly objectiveId: string;
  readonly text: string;
  readonly requiredEvidenceTerms: readonly string[];
}

export interface ObjectiveEvidence {
  readonly objectiveId: string;
  readonly state: EvidenceState;
  readonly matchedTerms: readonly string[];
  readonly missingTerms: readonly string[];
  readonly supportingChunkIds: readonly string[];
}

export interface ObjectiveAlignmentReport {
  readonly tenantId: string;
  readonly state: EvidenceState;
  readonly objectives: readonly ObjectiveEvidence[];
}

export interface SourceEvidence {
  readonly sourceHash: string;
  readonly documentVersion: number;
  readonly locator?: string;
}

export interface RetrievalCandidate {
  readonly chunk: EmbeddedChunk;
  readonly source: SourceEvidence;
}

export type RetrievalBlockReason =
  | "empty_text"
  | "invalid_token_count"
  | "embedding_missing"
  | "embedding_dimension_mismatch"
  | "embedding_not_finite"
  | "source_hash_missing"
  | "document_version_invalid";

export interface RetrievalChunkEvidence {
  readonly chunkId: string;
  readonly ready: boolean;
  readonly reasons: readonly RetrievalBlockReason[];
  readonly embeddingDimensions: number;
  readonly sourceHash: string;
  readonly documentVersion: number;
}

export interface RetrievalReadinessReport {
  readonly tenantId: string;
  readonly state: EvidenceState;
  readonly expectedEmbeddingDimensions: number;
  readonly readyChunkCount: number;
  readonly chunks: readonly RetrievalChunkEvidence[];
}

export interface ProcessingFingerprint {
  readonly sourceHash: string;
  readonly cleanupVersion: string;
  readonly structureVersion: string;
  readonly chunkingVersion: string;
  readonly embeddingProvider: string;
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
  readonly diagramVersion: string;
}

export type ReprocessingReason =
  | "source_changed"
  | "cleanup_changed"
  | "structure_changed"
  | "chunking_changed"
  | "embedding_changed"
  | "diagram_extractor_changed";

export interface ReprocessingDecision {
  readonly required: boolean;
  readonly reasons: readonly ReprocessingReason[];
  readonly invalidatedStages: readonly PipelineStage[];
  readonly affectedChunkIds: readonly string[];
  readonly estimatedEmbeddingWrites: number;
}

export interface EmbeddingIdentity {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
}

export interface IndexPublicationCandidate {
  readonly tenantId: string;
  readonly indexName: string;
  readonly indexVersionId: string;
  readonly knowledgeVersionId: string;
  readonly embedding: EmbeddingIdentity;
  readonly chunkIds: readonly string[];
  readonly builtAt: IsoTimestamp;
  readonly artifactHash: string;
  readonly chunkQuality: CleanedChunkQualityReport;
  readonly objectiveAlignment: ObjectiveAlignmentReport;
  readonly retrievalReadiness: RetrievalReadinessReport;
}

export interface PublishedIndexVersion
  extends Omit<
    IndexPublicationCandidate,
    "chunkQuality" | "objectiveAlignment" | "retrievalReadiness"
  > {
  readonly status: "active";
  readonly publishedAt: IsoTimestamp;
  readonly evidence: {
    readonly chunkQuality: "known";
    readonly objectiveAlignment: "known";
    readonly retrievalReadiness: "known";
  };
}

export interface IndexPublicationRepository {
  getActive(
    scope: TenantScope,
    indexName: string,
  ): Promise<PublishedIndexVersion | undefined>;

  /**
   * Implementations must compare and activate atomically. Returning false
   * represents an optimistic-concurrency conflict.
   */
  activate(
    scope: TenantScope,
    publication: PublishedIndexVersion,
    expectedActiveVersionId: string | undefined,
  ): Promise<boolean>;
}

export interface QualityClock {
  now(): IsoTimestamp;
}

export class DeterministicKnowledgeQualityService {
  assessCleanedChunks(
    scope: TenantScope,
    chunks: readonly EmbeddedChunk[],
    policy: ChunkQualityPolicy,
  ): CleanedChunkQualityReport {
    assertPolicy(policy);
    assertChunkTenancy(scope, chunks);

    const textMissing = chunks.filter((chunk) => chunk.text.trim() === "");
    const tokenInvalid = chunks.filter(
      (chunk) =>
        !Number.isSafeInteger(chunk.tokenCount) || chunk.tokenCount < 1,
    );
    const outsideBounds = chunks.filter(
      (chunk) =>
        chunk.tokenCount < policy.minimumTokens ||
        chunk.tokenCount > policy.maximumTokens,
    );
    const controlCharacters = chunks.filter((chunk) =>
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(chunk.text),
    );
    const duplicateIds = duplicateTextChunkIds(chunks);
    const usableChunkCount = chunks.filter(
      (chunk) =>
        chunk.text.trim() !== "" &&
        Number.isSafeInteger(chunk.tokenCount) &&
        chunk.tokenCount >= 1 &&
        chunk.tokenCount >= policy.minimumTokens &&
        chunk.tokenCount <= policy.maximumTokens &&
        !controlCharacters.includes(chunk) &&
        !duplicateIds.has(chunk.chunkId),
    ).length;

    const checks: readonly QualityCheck[] = [
      {
        check: "chunks_present",
        status: chunks.length === 0 ? "blocked" : "passed",
        measured: chunks.length,
        expected: "at least 1",
        affectedChunkIds: [],
      },
      checkFor("text_present", textMissing, chunks.length, "non-empty text"),
      checkFor(
        "token_count_valid",
        tokenInvalid,
        chunks.length,
        "positive integer supplied by the configured tokenizer",
      ),
      checkFor(
        "token_bounds",
        outsideBounds,
        chunks.length,
        `${policy.minimumTokens}..${policy.maximumTokens} tokens`,
      ),
      checkFor(
        "control_characters_absent",
        controlCharacters,
        chunks.length,
        "0 disallowed control characters",
      ),
      {
        check: "duplicate_text_absent",
        status: duplicateIds.size === 0 ? "passed" : "failed",
        measured: duplicateIds.size,
        expected: "0 duplicate chunks",
        affectedChunkIds: [...duplicateIds].sort(),
      },
    ];

    return {
      tenantId: scope.tenantId,
      state:
        chunks.length === 0 || usableChunkCount === 0
          ? "blocked"
          : checks.every((check) => check.status === "passed")
            ? "known"
            : "partial",
      chunkCount: chunks.length,
      usableChunkCount,
      checks,
    };
  }

  assessObjectiveAlignment(
    scope: TenantScope,
    objectives: readonly LearningObjective[],
    chunks: readonly EmbeddedChunk[],
  ): ObjectiveAlignmentReport {
    assertChunkTenancy(scope, chunks);
    const normalizedChunks = chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      text: normalizeEvidenceText(chunk.text),
    }));
    const objectiveEvidence = objectives.map<ObjectiveEvidence>((objective) => {
      const terms = uniqueNormalizedTerms(objective.requiredEvidenceTerms);
      if (
        objective.objectiveId.trim() === "" ||
        objective.text.trim() === "" ||
        terms.length === 0 ||
        chunks.length === 0
      ) {
        return {
          objectiveId: objective.objectiveId,
          state: "blocked",
          matchedTerms: [],
          missingTerms: terms,
          supportingChunkIds: [],
        };
      }
      const matchedTerms = terms.filter((term) =>
        normalizedChunks.some((chunk) => containsPhrase(chunk.text, term)),
      );
      const supportingChunkIds = normalizedChunks
        .filter((chunk) =>
          matchedTerms.some((term) => containsPhrase(chunk.text, term)),
        )
        .map((chunk) => chunk.chunkId);
      const missingTerms = terms.filter((term) => !matchedTerms.includes(term));
      return {
        objectiveId: objective.objectiveId,
        state: missingTerms.length === 0 ? "known" : "partial",
        matchedTerms,
        missingTerms,
        supportingChunkIds,
      };
    });

    return {
      tenantId: scope.tenantId,
      state:
        objectiveEvidence.length === 0 ||
        objectiveEvidence.some((objective) => objective.state === "blocked")
          ? "blocked"
          : objectiveEvidence.every((objective) => objective.state === "known")
            ? "known"
            : "partial",
      objectives: objectiveEvidence,
    };
  }

  assessRetrievalReadiness(
    scope: TenantScope,
    candidates: readonly RetrievalCandidate[],
    expectedEmbeddingDimensions: number,
  ): RetrievalReadinessReport {
    if (
      !Number.isSafeInteger(expectedEmbeddingDimensions) ||
      expectedEmbeddingDimensions < 1
    ) {
      throw new PipelineFailure(
        "SOURCE_INVALID",
        "Expected embedding dimensions must be a positive integer.",
        false,
      );
    }
    assertChunkTenancy(
      scope,
      candidates.map((candidate) => candidate.chunk),
    );
    const chunks = candidates.map<RetrievalChunkEvidence>((candidate) => {
      const reasons: RetrievalBlockReason[] = [];
      if (candidate.chunk.text.trim() === "") reasons.push("empty_text");
      if (
        !Number.isSafeInteger(candidate.chunk.tokenCount) ||
        candidate.chunk.tokenCount < 1
      ) {
        reasons.push("invalid_token_count");
      }
      if (candidate.chunk.embedding.length === 0) {
        reasons.push("embedding_missing");
      } else if (
        candidate.chunk.embedding.length !== expectedEmbeddingDimensions
      ) {
        reasons.push("embedding_dimension_mismatch");
      }
      if (
        candidate.chunk.embedding.some((component) => !Number.isFinite(component))
      ) {
        reasons.push("embedding_not_finite");
      }
      if (candidate.source.sourceHash.trim() === "") {
        reasons.push("source_hash_missing");
      }
      if (
        !Number.isSafeInteger(candidate.source.documentVersion) ||
        candidate.source.documentVersion < 1
      ) {
        reasons.push("document_version_invalid");
      }
      return {
        chunkId: candidate.chunk.chunkId,
        ready: reasons.length === 0,
        reasons,
        embeddingDimensions: candidate.chunk.embedding.length,
        sourceHash: candidate.source.sourceHash,
        documentVersion: candidate.source.documentVersion,
      };
    });
    const readyChunkCount = chunks.filter((chunk) => chunk.ready).length;
    return {
      tenantId: scope.tenantId,
      state:
        chunks.length === 0 || readyChunkCount === 0
          ? "blocked"
          : readyChunkCount === chunks.length
            ? "known"
            : "partial",
      expectedEmbeddingDimensions,
      readyChunkCount,
      chunks,
    };
  }

  decideSelectiveReprocessing(
    scope: TenantScope,
    previous: ProcessingFingerprint,
    next: ProcessingFingerprint,
    currentChunks: readonly EmbeddedChunk[],
  ): ReprocessingDecision {
    assertChunkTenancy(scope, currentChunks);
    assertFingerprint(previous);
    assertFingerprint(next);
    const reasons: ReprocessingReason[] = [];
    const invalidated = new Set<PipelineStage>();
    const invalidateFrom = (
      stage: PipelineStage,
      reason: ReprocessingReason,
    ): void => {
      reasons.push(reason);
      const index = PIPELINE_STAGES.indexOf(stage);
      PIPELINE_STAGES.slice(index).forEach((candidate) =>
        invalidated.add(candidate),
      );
    };

    if (previous.sourceHash !== next.sourceHash) {
      invalidateFrom("validate", "source_changed");
    } else {
      if (previous.cleanupVersion !== next.cleanupVersion) {
        invalidateFrom("clean", "cleanup_changed");
      }
      if (previous.structureVersion !== next.structureVersion) {
        invalidateFrom("structure", "structure_changed");
      }
      if (previous.chunkingVersion !== next.chunkingVersion) {
        invalidateFrom("chunk", "chunking_changed");
      }
      if (
        previous.embeddingProvider !== next.embeddingProvider ||
        previous.embeddingModel !== next.embeddingModel ||
        previous.embeddingDimensions !== next.embeddingDimensions
      ) {
        invalidateFrom("embed", "embedding_changed");
      }
      if (previous.diagramVersion !== next.diagramVersion) {
        invalidated.add("diagram.extract");
        reasons.push("diagram_extractor_changed");
      }
    }

    const invalidatedStages = PIPELINE_STAGES.filter((stage) =>
      invalidated.has(stage),
    );
    return {
      required: reasons.length > 0,
      reasons,
      invalidatedStages,
      affectedChunkIds:
        reasons.length === 0
          ? []
          : currentChunks.map((chunk) => chunk.chunkId).sort(),
      estimatedEmbeddingWrites: invalidated.has("embed")
        ? currentChunks.length
        : 0,
    };
  }
}

export class VersionedIndexPublicationService {
  constructor(
    private readonly repository: IndexPublicationRepository,
    private readonly clock: QualityClock = {
      now: () => new Date().toISOString(),
    },
  ) {}

  async publish(
    scope: TenantScope,
    candidate: IndexPublicationCandidate,
    expectedActiveVersionId?: string,
  ): Promise<PublishedIndexVersion> {
    assertPublicationTenant(scope, candidate);
    assertPublicationEvidence(candidate);
    const active = await this.repository.getActive(scope, candidate.indexName);
    if (active !== undefined && active.tenantId !== scope.tenantId) {
      throw new PipelineFailure(
        "TENANT_ACCESS_DENIED",
        "The active retrieval index is unavailable in this tenant.",
        false,
      );
    }
    if (active?.indexVersionId !== expectedActiveVersionId) {
      throw new PipelineFailure(
        "VERSION_CONFLICT",
        "The active retrieval index changed before publication.",
        true,
      );
    }
    const publication: PublishedIndexVersion = {
      tenantId: candidate.tenantId,
      indexName: candidate.indexName,
      indexVersionId: candidate.indexVersionId,
      knowledgeVersionId: candidate.knowledgeVersionId,
      embedding: { ...candidate.embedding },
      chunkIds: [...candidate.chunkIds],
      builtAt: candidate.builtAt,
      artifactHash: candidate.artifactHash,
      status: "active",
      publishedAt: this.clock.now(),
      evidence: {
        chunkQuality: "known",
        objectiveAlignment: "known",
        retrievalReadiness: "known",
      },
    };
    const activated = await this.repository.activate(
      scope,
      publication,
      expectedActiveVersionId,
    );
    if (!activated) {
      throw new PipelineFailure(
        "VERSION_CONFLICT",
        "The active retrieval index changed during publication.",
        true,
      );
    }
    return publication;
  }
}

function checkFor(
  check: QualityCheck["check"],
  affected: readonly EmbeddedChunk[],
  total: number,
  expected: string,
): QualityCheck {
  return {
    check,
    status: total === 0 ? "blocked" : affected.length === 0 ? "passed" : "failed",
    measured: affected.length,
    expected,
    affectedChunkIds: affected.map((chunk) => chunk.chunkId).sort(),
  };
}

function assertPolicy(policy: ChunkQualityPolicy): void {
  if (
    !Number.isSafeInteger(policy.minimumTokens) ||
    !Number.isSafeInteger(policy.maximumTokens) ||
    policy.minimumTokens < 1 ||
    policy.maximumTokens < policy.minimumTokens
  ) {
    throw new PipelineFailure(
      "SOURCE_INVALID",
      "Chunk token bounds must be positive ordered integers.",
      false,
    );
  }
}

function assertChunkTenancy(
  scope: TenantScope,
  chunks: readonly EmbeddedChunk[],
): void {
  if (chunks.some((chunk) => chunk.tenantId !== scope.tenantId)) {
    throw new PipelineFailure(
      "TENANT_ACCESS_DENIED",
      "Quality evidence cannot cross tenant boundaries.",
      false,
    );
  }
}

function assertPublicationTenant(
  scope: TenantScope,
  candidate: IndexPublicationCandidate,
): void {
  const reportTenants = [
    candidate.tenantId,
    candidate.chunkQuality.tenantId,
    candidate.objectiveAlignment.tenantId,
    candidate.retrievalReadiness.tenantId,
  ];
  if (reportTenants.some((tenantId) => tenantId !== scope.tenantId)) {
    throw new PipelineFailure(
      "TENANT_ACCESS_DENIED",
      "Index publication evidence cannot cross tenant boundaries.",
      false,
    );
  }
}

function assertPublicationEvidence(candidate: IndexPublicationCandidate): void {
  const identityFields = [
    candidate.indexName,
    candidate.indexVersionId,
    candidate.knowledgeVersionId,
    candidate.embedding.provider,
    candidate.embedding.model,
    candidate.artifactHash,
  ];
  if (
    identityFields.some((field) => field.trim() === "") ||
    !Number.isSafeInteger(candidate.embedding.dimensions) ||
    candidate.embedding.dimensions < 1 ||
    candidate.chunkIds.length === 0 ||
    new Set(candidate.chunkIds).size !== candidate.chunkIds.length ||
    candidate.chunkQuality.state !== "known" ||
    candidate.chunkQuality.chunkCount !== candidate.chunkIds.length ||
    candidate.chunkQuality.usableChunkCount !== candidate.chunkIds.length ||
    candidate.chunkQuality.checks.some((check) => check.status !== "passed") ||
    candidate.objectiveAlignment.state !== "known" ||
    candidate.objectiveAlignment.objectives.length === 0 ||
    candidate.objectiveAlignment.objectives.some(
      (objective) =>
        objective.state !== "known" ||
        objective.missingTerms.length > 0 ||
        objective.matchedTerms.length === 0 ||
        objective.supportingChunkIds.length === 0,
    ) ||
    candidate.retrievalReadiness.state !== "known" ||
    candidate.retrievalReadiness.expectedEmbeddingDimensions !==
      candidate.embedding.dimensions ||
    candidate.retrievalReadiness.readyChunkCount !== candidate.chunkIds.length ||
    candidate.retrievalReadiness.chunks.some(
      (chunk) =>
        !chunk.ready ||
        chunk.reasons.length > 0 ||
        chunk.embeddingDimensions !== candidate.embedding.dimensions ||
        chunk.sourceHash.trim() === "" ||
        !Number.isSafeInteger(chunk.documentVersion) ||
        chunk.documentVersion < 1,
    ) ||
    !sameMembers(
      candidate.chunkIds,
      candidate.retrievalReadiness.chunks.map((chunk) => chunk.chunkId),
    )
  ) {
    throw new PipelineFailure(
      "VERSION_CONFLICT",
      "The retrieval index lacks complete, consistent publication evidence.",
      false,
    );
  }
}

function duplicateTextChunkIds(
  chunks: readonly EmbeddedChunk[],
): ReadonlySet<string> {
  const byText = new Map<string, string[]>();
  for (const chunk of chunks) {
    const normalized = normalizeEvidenceText(chunk.text);
    if (normalized === "") continue;
    byText.set(normalized, [...(byText.get(normalized) ?? []), chunk.chunkId]);
  }
  return new Set(
    [...byText.values()]
      .filter((chunkIds) => chunkIds.length > 1)
      .flat(),
  );
}

function uniqueNormalizedTerms(terms: readonly string[]): readonly string[] {
  return [
    ...new Set(
      terms.map(normalizeEvidenceText).filter((term) => term.length > 0),
    ),
  ];
}

function normalizeEvidenceText(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function containsPhrase(normalizedText: string, normalizedTerm: string): boolean {
  return ` ${normalizedText} `.includes(` ${normalizedTerm} `);
}

function assertFingerprint(fingerprint: ProcessingFingerprint): void {
  const versions = [
    fingerprint.sourceHash,
    fingerprint.cleanupVersion,
    fingerprint.structureVersion,
    fingerprint.chunkingVersion,
    fingerprint.embeddingProvider,
    fingerprint.embeddingModel,
    fingerprint.diagramVersion,
  ];
  if (
    versions.some((value) => value.trim() === "") ||
    !Number.isSafeInteger(fingerprint.embeddingDimensions) ||
    fingerprint.embeddingDimensions < 1
  ) {
    throw new PipelineFailure(
      "SOURCE_INVALID",
      "Processing fingerprints require explicit versions and embedding dimensions.",
      false,
    );
  }
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

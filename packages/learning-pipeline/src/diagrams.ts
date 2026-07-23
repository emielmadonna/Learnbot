import { PipelineFailure, type DiagramCandidate } from "./types.js";
import { stableId } from "./legacy-chunker.js";

const DIAGRAM_LINE = /(?:diagram|flow)\s*:\s*(.+(?:->|→).+)/giu;

export function extractDiagramCandidates(
  tenantId: string,
  documentId: string,
  text: string,
): readonly DiagramCandidate[] {
  return Array.from(text.matchAll(DIAGRAM_LINE)).map((match, index) => {
    const sourceText = (match[1] ?? "").trim();
    const nodes = sourceText
      .split(/\s*(?:->|→)\s*/u)
      .map((node) => node.trim())
      .filter(Boolean);
    return {
      candidateId: stableId(
        "diagram",
        `${tenantId}:${documentId}:${index}:${sourceText}`,
      ),
      tenantId,
      documentId,
      sourceText,
      nodes,
      safety: classifySafety(sourceText),
      state: "pending",
    };
  });
}

export function reviewDiagramCandidate(
  candidate: DiagramCandidate,
  decision: "approve" | "reject",
  reviewerNote?: string,
): DiagramCandidate {
  if (decision === "approve" && candidate.safety !== "safe") {
    throw new PipelineFailure(
      "DIAGRAM_UNSAFE",
      "Only candidates classified as safe can be approved.",
      false,
      "diagram.extract",
    );
  }
  return {
    ...candidate,
    state: decision === "approve" ? "approved" : "rejected",
    ...(reviewerNote === undefined ? {} : { reviewerNote }),
  };
}

function classifySafety(text: string): DiagramCandidate["safety"] {
  if (/<script|javascript:|data:text\/html/iu.test(text)) return "blocked";
  if (/https?:\/\/|@[\w.-]+/iu.test(text)) return "requires_review";
  return "safe";
}

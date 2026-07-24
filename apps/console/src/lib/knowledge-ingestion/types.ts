export type KnowledgeSourceFormat = "text" | "markdown" | "csv";

export type KnowledgeIssueKind =
  | "missing_section"
  | "duplicate_section"
  | "noise";

export type KnowledgeIssueSeverity = "warning" | "error";

export interface KnowledgeSection {
  readonly sectionId: string;
  readonly heading: string | null;
  readonly body: string;
  readonly sourceLine: number;
}

export interface KnowledgeIssue {
  readonly issueId: string;
  readonly kind: KnowledgeIssueKind;
  readonly severity: KnowledgeIssueSeverity;
  readonly message: string;
  readonly sectionId?: string;
  readonly evidence?: string;
}

export type DiagramFlagKind = "flow" | "sequence" | "comparison" | "table";
export type DiagramReviewState = "pending" | "accepted" | "dismissed";

export interface DiagramFlag {
  readonly flagId: string;
  readonly sectionId: string;
  readonly kind: DiagramFlagKind;
  readonly title: string;
  readonly evidence: string;
  readonly state: DiagramReviewState;
}

export interface KnowledgeDraft {
  readonly sourceName: string;
  readonly format: KnowledgeSourceFormat;
  readonly title: string;
  readonly description: string;
  readonly normalizedText: string;
  readonly contentHash: string;
  readonly sections: readonly KnowledgeSection[];
  readonly issues: readonly KnowledgeIssue[];
  readonly diagramFlags: readonly DiagramFlag[];
  readonly stats: {
    readonly inputCharacters: number;
    readonly outputCharacters: number;
    readonly wordCount: number;
    readonly removedNoiseLines: number;
  };
  readonly processing: {
    readonly cleanedLocally: true;
    readonly embeddingStatus: "not_requested";
    readonly retrievalStatus: "not_available";
  };
}

export interface KnowledgeDraftInput {
  readonly sourceName?: string;
  readonly format: KnowledgeSourceFormat;
  readonly text: string;
  readonly title?: string;
  readonly description?: string;
}

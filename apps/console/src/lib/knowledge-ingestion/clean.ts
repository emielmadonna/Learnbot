import type {
  DiagramFlag,
  DiagramFlagKind,
  KnowledgeDraft,
  KnowledgeDraftInput,
  KnowledgeIssue,
  KnowledgeSection,
  KnowledgeSourceFormat,
} from "./types";

const HEADING_PATTERN = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u;
const PAGE_MARKER_PATTERN = /^(?:page\s+\d+|\d+\s*\/\s*\d+|[-–—]?\s*\d+\s*[-–—]?)$/iu;
const ORDERED_LINE_PATTERN = /^\s*(?:\d+[.)]|step\s+\d+|[a-z][.)])\s+/iu;

export function prepareKnowledgeDraft(input: KnowledgeDraftInput): KnowledgeDraft {
  const sourceName = cleanSourceName(input.sourceName);
  const sourceText = input.text.normalize("NFKC").replace(/^\uFEFF/u, "");
  const importedText =
    input.format === "csv" ? csvToMarkdown(sourceText) : sourceText;
  const normalizedInput = normalizeLines(importedText);
  const noise = findNoiseLines(normalizedInput.split("\n"));
  const cleanedLines = normalizedInput
    .split("\n")
    .filter((line) => !noise.removed.has(lineKey(line)))
    .join("\n");
  const sections = sectionize(cleanedLines, input.format);
  const issues = [
    ...noise.issues,
    ...findSectionIssues(sections),
  ];
  const normalizedText = renderSections(sections, input.format);
  const title =
    input.title?.trim() ||
    sections.find((section) => section.heading)?.heading ||
    titleFromSourceName(sourceName);
  const description =
    input.description?.trim() ||
    `Prepared from ${sourceName}. Review the flagged sections before publishing.`;

  return {
    sourceName,
    format: input.format,
    title: title.slice(0, 160),
    description: description.slice(0, 2_000),
    normalizedText,
    contentHash: stableId("content", normalizedText),
    sections,
    issues,
    diagramFlags: findDiagramFlags(sections, input.format),
    stats: {
      inputCharacters: sourceText.length,
      outputCharacters: normalizedText.length,
      wordCount: wordCount(normalizedText),
      removedNoiseLines: noise.removed.size,
    },
    processing: {
      cleanedLocally: true,
      embeddingStatus: "not_requested",
      retrievalStatus: "not_available",
    },
  };
}

export function reviewDiagramFlag(
  draft: KnowledgeDraft,
  flagId: string,
  state: Exclude<DiagramFlag["state"], "pending">,
): KnowledgeDraft {
  return {
    ...draft,
    diagramFlags: draft.diagramFlags.map((flag) =>
      flag.flagId === flagId ? { ...flag, state } : flag,
    ),
  };
}

export function allDiagramFlagsReviewed(draft: KnowledgeDraft): boolean {
  return draft.diagramFlags.every((flag) => flag.state !== "pending");
}

/** Creates a useful local outline without making a provider call. */
export function agentAssistedStarter(goal: string): string {
  const cleanedGoal = goal.trim().replace(/\s+/gu, " ");
  const outcome = cleanedGoal || "apply the core idea in a real situation";
  const heading = outcome
    .replace(/[.!?]+$/u, "")
    .replace(/^./u, (letter) => letter.toUpperCase());
  return [
    `# ${heading}`,
    "",
    "## Outcome",
    `Learners will be able to ${outcome}.`,
    "",
    "## Practice",
    "1. Identify the situation where this matters.",
    "2. Choose one small action to try.",
    "3. Reflect on what changed and what to adjust next.",
    "",
    "## Review",
    "Add the trusted source material, examples, and boundaries before publishing.",
  ].join("\n");
}

function normalizeLines(text: string): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/gu, " ").trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function findNoiseLines(lines: readonly string[]) {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const key = lineKey(line);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const removed = new Set<string>();
  const issues: KnowledgeIssue[] = [];
  for (const line of lines) {
    const key = lineKey(line);
    if (!key || removed.has(key)) continue;
    const repeated =
      (counts.get(key) ?? 0) > 1 &&
      !HEADING_PATTERN.test(line) &&
      key.split(" ").length <= 4;
    const marker = PAGE_MARKER_PATTERN.test(line) || /^[-_=*]{4,}$/u.test(line);
    if (!repeated && !marker) continue;
    removed.add(key);
    issues.push({
      issueId: stableId("issue", `noise:${key}`),
      kind: "noise",
      severity: "warning",
      message: marker
        ? "A page marker or separator was removed."
        : "A repeated line was removed as likely header/footer noise.",
      evidence: line.slice(0, 120),
    });
  }
  return { removed, issues };
}

function sectionize(text: string, format: KnowledgeSourceFormat): readonly KnowledgeSection[] {
  const lines = text.split("\n");
  const hasHeadings = lines.some((line) => HEADING_PATTERN.test(line));
  if (!hasHeadings) {
    return text
      .split(/\n\s*\n/gu)
      .map((body, index) => body.trim())
      .filter(Boolean)
      .map((body, index) => ({
        sectionId: stableId("section", `${format}:${index}:${body}`),
        heading: null,
        body,
        sourceLine: index + 1,
      }));
  }

  const sections: Array<{
    heading: string | null;
    bodyLines: string[];
    sourceLine: number;
  }> = [];
  let current: (typeof sections)[number] | undefined;
  lines.forEach((line, index) => {
    const heading = line.match(HEADING_PATTERN)?.[2]?.trim();
    if (heading) {
      current = { heading, bodyLines: [], sourceLine: index + 1 };
      sections.push(current);
    } else if (current) {
      current.bodyLines.push(line);
    } else if (line.trim()) {
      current = { heading: null, bodyLines: [line], sourceLine: index + 1 };
      sections.push(current);
    }
  });
  return sections.map((section, index) => {
    const body = section.bodyLines.join("\n").trim();
    return {
      sectionId: stableId(
        "section",
        `${format}:${index}:${section.heading ?? ""}:${body}`,
      ),
      heading: section.heading,
      body,
      sourceLine: section.sourceLine,
    };
  });
}

function findSectionIssues(sections: readonly KnowledgeSection[]): readonly KnowledgeIssue[] {
  const issues: KnowledgeIssue[] = [];
  const seenBodies = new Map<string, KnowledgeSection>();
  for (const section of sections) {
    if (section.heading && !section.body) {
      issues.push({
        issueId: stableId("issue", `missing:${section.sectionId}`),
        kind: "missing_section",
        severity: "error",
        message: `“${section.heading}” has no content yet.`,
        sectionId: section.sectionId,
      });
    }
    const bodyKey = canonical(section.body);
    if (!bodyKey) continue;
    const previous = seenBodies.get(bodyKey);
    if (previous) {
      issues.push({
        issueId: stableId("issue", `duplicate:${section.sectionId}`),
        kind: "duplicate_section",
        severity: "warning",
        message: "This section repeats content already present elsewhere.",
        sectionId: section.sectionId,
        evidence: previous.heading ?? `Section starting line ${previous.sourceLine}`,
      });
    } else {
      seenBodies.set(bodyKey, section);
    }
  }
  return issues;
}

function findDiagramFlags(
  sections: readonly KnowledgeSection[],
  format: KnowledgeSourceFormat,
): readonly DiagramFlag[] {
  const flags: DiagramFlag[] = [];
  for (const section of sections) {
    const body = section.body;
    const add = (kind: DiagramFlagKind, title: string, evidence: string) => {
      flags.push({
        flagId: stableId("diagram", `${section.sectionId}:${kind}:${evidence}`),
        sectionId: section.sectionId,
        kind,
        title,
        evidence: evidence.slice(0, 180),
        state: "pending",
      });
    };
    const flow = body.match(/[^\n]{1,100}(?:->|→|=>)[^\n]{1,100}/u);
    if (flow) add("flow", "Flow or process map", flow[0].trim());

    const orderedLines = body.split("\n").filter((line) => ORDERED_LINE_PATTERN.test(line));
    if (orderedLines.length >= 3) {
      add("sequence", "Step-by-step sequence", orderedLines.slice(0, 3).join(" "));
    }

    if (/(?:\bvs\.?\b|versus|compare|difference between|trade-?off)/iu.test(body)) {
      add("comparison", "Comparison or decision guide", firstSentence(body));
    }

    const tableRows = body.split("\n").filter((line) => line.split("|").length >= 3);
    if ((format === "csv" || tableRows.length >= 3) && tableRows.length >= 2) {
      add("table", "Structured table", tableRows.slice(0, 3).join(" "));
    }
  }
  return flags;
}

function renderSections(sections: readonly KnowledgeSection[], format: KnowledgeSourceFormat): string {
  return sections
    .map((section) => {
      if (section.heading) return `## ${section.heading}\n${section.body}`.trim();
      return section.body.trim();
    })
    .filter(Boolean)
    .join("\n\n")
    .trim() || (format === "csv" ? "## Imported table" : "");
}

function csvToMarkdown(text: string): string {
  const rows = parseCsv(text).filter((row) => row.some((cell) => cell.trim()));
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const padded = rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ""));
  const [header, ...body] = padded;
  const divider = header?.map(() => "---") ?? [];
  return [
    "## Imported table",
    `| ${header?.map(escapeCell).join(" | ") ?? ""} |`,
    `| ${divider.join(" | ")} |`,
    ...body.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
  ].join("\n");
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (character === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if (character === "\n" && !quoted) {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character ?? "";
    }
  }
  if (cell || row.length) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\n/gu, " ");
}

function lineKey(line: string): string {
  return canonical(line);
}

function canonical(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function firstSentence(value: string): string {
  return value.split(/(?<=[.!?])\s+/u)[0]?.trim() || value.trim();
}

function wordCount(value: string): number {
  return value.trim() ? value.trim().split(/\s+/u).length : 0;
}

function cleanSourceName(value: string | undefined): string {
  const name = value?.trim().replace(/\s+/gu, " ");
  return name || "Pasted course material";
}

function titleFromSourceName(sourceName: string): string {
  const withoutExtension = sourceName.replace(/\.[^.]+$/u, "");
  return withoutExtension.replace(/[-_]+/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase()) || "Imported knowledge";
}

export function stableId(prefix: string, value: string): string {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `${prefix}_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

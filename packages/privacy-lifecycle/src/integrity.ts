import { createHash } from "node:crypto";
import type { IntegrityProvider } from "./repositories.js";
import type { ExportManifest, ExportManifestItem } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export class Sha256IntegrityProvider implements IntegrityProvider {
  sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }
}

export function manifestRootInput(input: {
  readonly schemaVersion: 1;
  readonly manifestId: string;
  readonly jobId: string;
  readonly tenantId: string;
  readonly subjectId: string;
  readonly identityTier: "verified" | "self_reported";
  readonly createdAt: string;
  readonly dataThrough: string;
  readonly items: readonly ExportManifestItem[];
  readonly itemCount: number;
  readonly totalBytes: number;
}): string {
  return canonicalJson({
    ...input,
    items: [...input.items].sort((left, right) =>
      left.recordId.localeCompare(right.recordId),
    ),
  });
}

export function exportManifestRootInput(manifest: ExportManifest): string {
  const { rootSha256: _rootSha256, ...body } = manifest;
  return manifestRootInput(body);
}

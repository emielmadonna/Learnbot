import type {
  DataHealthSnapshot,
  DataSource,
  IdentityCoverage,
  IsoTimestamp,
  OverallDataHealth,
  SourceCoverage,
  TenantId,
} from "./types.js";

function validTimestamp(value: string | undefined): value is string {
  return value !== undefined && Number.isFinite(Date.parse(value));
}

function earliestTimestamp(values: readonly string[]): string | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((earliest, value) =>
    Date.parse(value) < Date.parse(earliest) ? value : earliest,
  );
}

function overallState(sources: readonly SourceCoverage[]): OverallDataHealth {
  if (sources.some((source) => source.state === "degraded")) return "degraded";
  if (sources.some((source) => source.state === "missing")) return "missing";
  if (
    sources.some(
      (source) =>
        source.state === "partial" ||
        (source.state === "complete" && !validTimestamp(source.dataThrough)),
    )
  ) {
    return "partial";
  }
  return "healthy";
}

function identityCoverage(
  sources: readonly SourceCoverage[],
  identifiedSubjects: number | undefined,
  observedSubjects: number | undefined,
): IdentityCoverage {
  if (
    identifiedSubjects === undefined ||
    observedSubjects === undefined ||
    !Number.isInteger(identifiedSubjects) ||
    !Number.isInteger(observedSubjects) ||
    identifiedSubjects < 0 ||
    observedSubjects <= 0 ||
    identifiedSubjects > observedSubjects
  ) {
    return { state: "unknown" };
  }
  const identitySource = sources.find((source) => source.source === "identity");
  const state =
    identitySource?.state === "complete"
      ? "known"
      : identitySource?.state === "partial" || identitySource?.state === "degraded"
        ? "partial"
        : "unknown";
  if (state === "unknown") return { state };
  return {
    state,
    identifiedSubjects,
    observedSubjects,
    ratio: identifiedSubjects / observedSubjects,
  };
}

export interface BuildDataHealthInput {
  readonly tenantId: TenantId;
  readonly computedAt: IsoTimestamp;
  readonly sources: readonly SourceCoverage[];
  readonly identifiedSubjects?: number;
  readonly observedSubjects?: number;
}

export function buildDataHealthSnapshot(
  input: BuildDataHealthInput,
): DataHealthSnapshot {
  const limitations: string[] = [];
  const seen = new Set<DataSource>();
  for (const source of input.sources) {
    if (seen.has(source.source)) limitations.push(`duplicate_source:${source.source}`);
    seen.add(source.source);
    if (source.state === "missing") limitations.push(`missing_source:${source.source}`);
    if (source.state === "partial") limitations.push(`partial_source:${source.source}`);
    if (source.state === "degraded") limitations.push(`degraded_source:${source.source}`);
    if (source.state === "complete" && !validTimestamp(source.dataThrough)) {
      limitations.push(`missing_data_through:${source.source}`);
    }
  }

  const dataThrough = earliestTimestamp(
    input.sources
      .map((source) => source.dataThrough)
      .filter(validTimestamp),
  );
  const coverage = identityCoverage(
    input.sources,
    input.identifiedSubjects,
    input.observedSubjects,
  );
  if (coverage.state !== "known") limitations.push("identity_coverage_not_complete");

  return {
    tenantId: input.tenantId,
    computedAt: input.computedAt,
    state: overallState(input.sources),
    ...(dataThrough === undefined ? {} : { dataThrough }),
    sources: input.sources.map((source) => ({ ...source })),
    identityCoverage: coverage,
    limitations: [...new Set(limitations)],
  };
}

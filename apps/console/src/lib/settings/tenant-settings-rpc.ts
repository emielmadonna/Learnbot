import type { SupabaseClient } from "@supabase/supabase-js";
import {
  LearningRpcError,
  requireLearningRpcSuccess,
} from "../supabase/learning-rpc";

export type ExportFormat = "json" | "csv";

export type TenantDataPolicy = {
  ok: true;
  dataMode: "durable";
  tenantId: string;
  retentionDays: number;
  exportsEnabled: boolean;
  defaultExportFormat: ExportFormat;
  recordVersion: number;
  updatedAt: string | null;
};

export type TenantDataExportRecord = {
  category: string;
  recordId: string;
  data: Record<string, unknown>;
};

export type TenantDataExport = {
  ok: true;
  dataMode: "durable";
  tenantId: string;
  tenantSlug: string;
  format: ExportFormat;
  generatedAt: string;
  retentionDays: number;
  recordCount: number;
  truncated: boolean;
  records: TenantDataExportRecord[];
};

export type TenantPlanUsage = {
  ok: true;
  dataMode: "durable";
  plan: string;
  subscriptionStatus: string;
  dunningStage: string;
  gracePeriodEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  currency: string;
  microUnitsPerMajorUnit: number;
  dayToDateBilledMicro: number;
  monthToDateBilledMicro: number;
  callsToday: number;
  callsThisMonth: number;
  limits: {
    dailyBudgetMicro: number | null;
    monthlyBudgetMicro: number | null;
    maxCallsPerMinute: number | null;
    maxCallsPerDay: number | null;
    maxSubjectCallsPerMinute: number | null;
    enforcement: string | null;
  };
  enabledSections: string[];
  generatedAt: string;
  message: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown) {
  return typeof value === "string" ? value : null;
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function requiredText(value: unknown) {
  const parsed = text(value);
  if (parsed === null) throw new LearningRpcError("invalid_response");
  return parsed;
}

function requiredNumber(value: unknown) {
  const parsed = number(value);
  if (parsed === null) throw new LearningRpcError("invalid_response");
  return parsed;
}

function requiredBoolean(value: unknown) {
  const parsed = boolean(value);
  if (parsed === null) throw new LearningRpcError("invalid_response");
  return parsed;
}

function format(value: unknown): ExportFormat {
  if (value !== "json" && value !== "csv") {
    throw new LearningRpcError("invalid_response");
  }
  return value;
}

async function rpc(
  supabase: SupabaseClient,
  name: string,
  input: Record<string, unknown> = {},
) {
  const response = await supabase.rpc(name, input);
  if (response.error) throw new LearningRpcError("request_failed");
  return requireLearningRpcSuccess(response.data);
}

function parsePolicy(value: Record<string, unknown>): TenantDataPolicy {
  if (value.dataMode !== "durable") {
    throw new LearningRpcError("invalid_response");
  }
  return {
    ok: true,
    dataMode: "durable",
    tenantId: requiredText(value.tenantId),
    retentionDays: requiredNumber(value.retentionDays),
    exportsEnabled: requiredBoolean(value.exportsEnabled),
    defaultExportFormat: format(value.defaultExportFormat),
    recordVersion: requiredNumber(value.recordVersion),
    updatedAt: text(value.updatedAt),
  };
}

export async function getTenantDataPolicy(supabase: SupabaseClient) {
  return parsePolicy(await rpc(supabase, "tenant_get_data_policy"));
}

export async function setTenantDataPolicy(
  supabase: SupabaseClient,
  input: {
    retentionDays: number;
    exportsEnabled: boolean;
    defaultExportFormat: ExportFormat;
    expectedVersion: number;
  },
) {
  return parsePolicy(
    await rpc(supabase, "tenant_set_data_policy", {
      retention_days: input.retentionDays,
      exports_enabled: input.exportsEnabled,
      default_export_format: input.defaultExportFormat,
      expected_version: input.expectedVersion,
    }),
  );
}

export async function prepareTenantDataExport(
  supabase: SupabaseClient,
  requestedFormat: ExportFormat,
): Promise<TenantDataExport> {
  const value = await rpc(supabase, "tenant_prepare_data_export", {
    requested_format: requestedFormat,
  });
  if (
    value.dataMode !== "durable" ||
    !Array.isArray(value.records) ||
    value.records.some(
      (record) =>
        !isRecord(record) ||
        typeof record.category !== "string" ||
        typeof record.recordId !== "string" ||
        !isRecord(record.data),
    )
  ) {
    throw new LearningRpcError("invalid_response");
  }
  return {
    ok: true,
    dataMode: "durable",
    tenantId: requiredText(value.tenantId),
    tenantSlug: requiredText(value.tenantSlug),
    format: format(value.format),
    generatedAt: requiredText(value.generatedAt),
    retentionDays: requiredNumber(value.retentionDays),
    recordCount: requiredNumber(value.recordCount),
    truncated: requiredBoolean(value.truncated),
    records: value.records as TenantDataExportRecord[],
  };
}

export async function getTenantPlanUsage(
  supabase: SupabaseClient,
): Promise<TenantPlanUsage> {
  const value = await rpc(supabase, "tenant_get_billing_summary");
  if (
    value.dataMode !== "durable" ||
    !isRecord(value.limits) ||
    !Array.isArray(value.enabledSections) ||
    value.enabledSections.some((section) => typeof section !== "string")
  ) {
    throw new LearningRpcError("invalid_response");
  }
  const limits = value.limits;
  return {
    ok: true,
    dataMode: "durable",
    plan: requiredText(value.plan),
    subscriptionStatus: requiredText(value.subscriptionStatus),
    dunningStage: requiredText(value.dunningStage),
    gracePeriodEndsAt: text(value.gracePeriodEndsAt),
    currentPeriodEnd: text(value.currentPeriodEnd),
    cancelAtPeriodEnd: requiredBoolean(value.cancelAtPeriodEnd),
    currency: requiredText(value.currency),
    microUnitsPerMajorUnit: requiredNumber(value.microUnitsPerMajorUnit),
    dayToDateBilledMicro: requiredNumber(value.dayToDateBilledMicro),
    monthToDateBilledMicro: requiredNumber(value.monthToDateBilledMicro),
    callsToday: requiredNumber(value.callsToday),
    callsThisMonth: requiredNumber(value.callsThisMonth),
    limits: {
      dailyBudgetMicro: number(limits.dailyBudgetMicro),
      monthlyBudgetMicro: number(limits.monthlyBudgetMicro),
      maxCallsPerMinute: number(limits.maxCallsPerMinute),
      maxCallsPerDay: number(limits.maxCallsPerDay),
      maxSubjectCallsPerMinute: number(limits.maxSubjectCallsPerMinute),
      enforcement: text(limits.enforcement),
    },
    enabledSections: value.enabledSections as string[],
    generatedAt: requiredText(value.generatedAt),
    message: text(value.message),
  };
}

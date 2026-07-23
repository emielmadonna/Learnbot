import type {
  DeletionPolicy,
  PersonalDataClass,
  RetentionPolicy,
  RetentionRule,
  TenantId,
} from "./types.js";
import { PERSONAL_DATA_CLASSES } from "./types.js";

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validClass(value: unknown): value is PersonalDataClass {
  return (
    typeof value === "string" &&
    (PERSONAL_DATA_CLASSES as readonly string[]).includes(value)
  );
}

function validDisposition(value: unknown): boolean {
  return (
    value === "delete" ||
    value === "deidentify" ||
    value === "retain_minimal"
  );
}

export function validateDeletionPolicy(
  policy: DeletionPolicy,
  tenantId: TenantId,
): readonly string[] {
  const issues: string[] = [];
  if (policy.tenantId !== tenantId) issues.push("policy_tenant_mismatch");
  if (!nonEmpty(policy.policyId)) issues.push("policy_id_missing");
  if (!nonEmpty(policy.version)) issues.push("policy_version_missing");
  if (!nonEmpty(policy.approvedBy)) issues.push("policy_approval_missing");
  if (!validTimestamp(policy.approvedAt)) issues.push("policy_approved_at_invalid");
  if (policy.legalHoldMode !== "suppress") issues.push("legal_hold_mode_invalid");
  for (const [dataClass, disposition] of Object.entries(policy.dispositions)) {
    if (!validClass(dataClass) || !validDisposition(disposition)) {
      issues.push(`invalid_disposition:${dataClass}`);
      continue;
    }
    if (
      (
        [
          "profile",
          "messages",
          "evidence",
          "vectors",
          "assets",
          "attachments",
          "transcripts",
          "voice_recordings",
        ] as const
      ).includes(dataClass as never) &&
      disposition !== "delete"
    ) {
      issues.push(`personal_content_must_delete:${dataClass}`);
    }
    if (
      (dataClass === "events" || dataClass === "derived_insights") &&
      disposition === "retain_minimal"
    ) {
      issues.push(`derived_or_event_data_must_delete_or_deidentify:${dataClass}`);
    }
  }
  return issues;
}

function validateRetentionRule(rule: RetentionRule): readonly string[] {
  const issues: string[] = [];
  if (!validClass(rule.dataClass)) issues.push("rule_data_class_invalid");
  if (
    !Number.isInteger(rule.retentionDays) ||
    rule.retentionDays < 0
  ) {
    issues.push(`retention_days_invalid:${String(rule.dataClass)}`);
  }
  if (!validDisposition(rule.disposition)) {
    issues.push(`rule_disposition_invalid:${String(rule.dataClass)}`);
  }
  return issues;
}

export function validateRetentionPolicy(
  policy: RetentionPolicy,
  tenantId: TenantId,
  dataThrough: string,
): readonly string[] {
  const issues: string[] = [];
  if (policy.tenantId !== tenantId) issues.push("policy_tenant_mismatch");
  if (!nonEmpty(policy.policyId)) issues.push("policy_id_missing");
  if (!nonEmpty(policy.version)) issues.push("policy_version_missing");
  if (!nonEmpty(policy.approvedBy)) issues.push("policy_approval_missing");
  if (!validTimestamp(policy.approvedAt)) issues.push("policy_approved_at_invalid");
  if (!validTimestamp(policy.effectiveAt)) issues.push("policy_effective_at_invalid");
  if (policy.legalHoldMode !== "suppress") issues.push("legal_hold_mode_invalid");
  if (policy.rules.length === 0) issues.push("retention_rules_missing");
  const seen = new Set<PersonalDataClass>();
  for (const rule of policy.rules) {
    issues.push(...validateRetentionRule(rule));
    if (seen.has(rule.dataClass)) issues.push(`duplicate_rule:${rule.dataClass}`);
    seen.add(rule.dataClass);
  }
  if (
    validTimestamp(policy.effectiveAt) &&
    validTimestamp(dataThrough) &&
    Date.parse(policy.effectiveAt) > Date.parse(dataThrough)
  ) {
    issues.push("policy_not_effective_at_data_through");
  }
  return issues;
}

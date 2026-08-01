import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isWidgetKey,
  parseWidgetBootstrap,
  WidgetRpcError,
  type WidgetBootstrapResult,
} from "../../../lib/supabase/widget-rpc";

export type HostedAssistantResolution = {
  bootstrap: WidgetBootstrapResult;
  deliveryKey: string;
};

export class HostedAssistantResolutionError extends WidgetRpcError {
  constructor(readonly slugReserved: boolean | null) {
    super("request_denied");
    this.name = "HostedAssistantResolutionError";
  }
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : null;
}

export function normalizeHostedSlug(value: string) {
  const slug = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(slug) ? slug : null;
}

export async function resolveHostedAssistant(
  supabase: SupabaseClient,
  input: {
    slug: string;
    origin: string;
    operationToken: string;
  },
): Promise<HostedAssistantResolution> {
  const slug = normalizeHostedSlug(input.slug);
  if (
    slug === null ||
    input.operationToken.length < 32 ||
    input.operationToken.length > 512
  ) {
    throw new WidgetRpcError("request_denied");
  }

  const response = await supabase.rpc("hosted_assistant_bootstrap", {
    slug,
    origin: input.origin,
    operation_token: input.operationToken,
  });
  if (response.error) throw new WidgetRpcError("request_failed");

  const record = firstRecord(response.data);
  if (
    record === null ||
    record.ok !== true ||
    !isWidgetKey(record.deliveryKey)
  ) {
    throw new HostedAssistantResolutionError(
      record?.slugReserved === true
        ? true
        : record?.slugReserved === false
          ? false
          : null,
    );
  }

  return {
    bootstrap: parseWidgetBootstrap(record),
    deliveryKey: record.deliveryKey,
  };
}

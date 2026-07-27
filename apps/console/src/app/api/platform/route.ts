import { NextResponse } from "next/server";
import {
  AuthenticationBoundaryError,
  assertSameOrigin,
  classifyAuthBoundaryError,
} from "../../../lib/supabase/auth-boundary";
import { authenticatedLearningClient } from "../../../lib/supabase/learning-route";
import {
  PlatformRpcError,
  createPlatformClient,
  enterPlatformTenant,
  exitPlatformTenant,
  getPlatformClientClaims,
  getPlatformOverview,
  getPlatformTenantDetail,
  isPlatformAdmin,
  isPlatformClientPlan,
  isPlatformSectionKey,
  isPlatformSlug,
  isPlatformTenantStatus,
  revokePlatformClientClaim,
  setPlatformTenantStatus,
  setTenantSection,
} from "../../../lib/supabase/platform-rpc";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const statusByCode = new Map<string, number>([
  ["access_denied", 403],
  ["invalid_request", 400],
  ["tenant_not_found", 404],
  ["tenant_unavailable", 409],
  ["membership_conflict", 409],
  ["principal_not_linked", 409],
  ["tenant_selection_required", 409],
  ["slug_conflict", 409],
  ["claim_not_found", 404],
  ["claim_not_pending", 409],
  // The RPC could not be executed, or answered in a shape this route cannot
  // vouch for. Neither is a client error, and neither is an auth failure.
  ["request_failed", 503],
  ["invalid_response", 502],
]);

const hexColorPattern = /^#[0-9a-f]{6}$/iu;

function response(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function errorResponse(error: unknown) {
  if (error instanceof AuthenticationBoundaryError) {
    const failure = classifyAuthBoundaryError(error);
    return response({ ok: false, code: failure.code }, failure.status);
  }
  if (error instanceof PlatformRpcError) {
    return response(
      { ok: false, code: error.code },
      statusByCode.get(error.code) ?? 400,
    );
  }
  // Fail closed without lying about the cause. An unrecognized failure is
  // never reported as success, and never as a rejected request either.
  return response({ ok: false, code: "request_failed" }, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireTenantId(value: unknown) {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new PlatformRpcError("invalid_request");
  }
  return value;
}

function requireClaimId(value: unknown) {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new PlatformRpcError("invalid_request");
  }
  return value;
}

function requireBoundedText(value: unknown, max: number) {
  if (typeof value !== "string") throw new PlatformRpcError("invalid_request");
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) {
    throw new PlatformRpcError("invalid_request");
  }
  return trimmed;
}

function requireHexColor(value: unknown) {
  if (typeof value !== "string" || !hexColorPattern.test(value)) {
    throw new PlatformRpcError("invalid_request");
  }
  return value;
}

function optionalBoundedText(value: unknown, max: number) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new PlatformRpcError("invalid_request");
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) throw new PlatformRpcError("invalid_request");
  return trimmed;
}

async function platformClient(request: Request, mutation: boolean) {
  if (mutation) assertSameOrigin(request);
  const supabase = await authenticatedLearningClient(request, { mutation });
  if (!(await isPlatformAdmin(supabase))) {
    throw new PlatformRpcError("access_denied");
  }
  return supabase;
}

export async function GET(request: Request) {
  try {
    const supabase = await platformClient(request, false);
    const requestedTenantId = new URL(request.url).searchParams.get("tenantId");
    if (requestedTenantId !== null) {
      return response(
        await getPlatformTenantDetail(
          supabase,
          requireTenantId(requestedTenantId),
        ),
      );
    }
    return response(await getPlatformOverview(supabase));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await platformClient(request, true);
    const input = (await request.json()) as unknown;
    if (!isRecord(input)) throw new PlatformRpcError("invalid_request");
    const action = typeof input.action === "string" ? input.action : "";

    if (action === "section") {
      if (
        !isPlatformSectionKey(input.sectionKey) ||
        typeof input.enabled !== "boolean"
      ) {
        throw new PlatformRpcError("invalid_request");
      }
      return response(
        await setTenantSection(supabase, {
          tenantId: requireTenantId(input.tenantId),
          sectionKey: input.sectionKey,
          enabled: input.enabled,
        }),
      );
    }

    if (action === "status") {
      if (!isPlatformTenantStatus(input.status)) {
        throw new PlatformRpcError("invalid_request");
      }
      return response(
        await setPlatformTenantStatus(supabase, {
          tenantId: requireTenantId(input.tenantId),
          status: input.status,
        }),
      );
    }

    if (action === "enter") {
      return response(
        await enterPlatformTenant(supabase, requireTenantId(input.tenantId)),
        201,
      );
    }

    if (action === "exit") {
      return response(await exitPlatformTenant(supabase));
    }

    // Creating a client workspace. The response carries the one-time owner
    // claim token, so it is never cached and never logged beyond this reply.
    if (action === "client.create") {
      if (
        !isPlatformSlug(input.slug) ||
        (input.plan !== undefined && !isPlatformClientPlan(input.plan))
      ) {
        throw new PlatformRpcError("invalid_request");
      }
      const creation = await createPlatformClient(supabase, {
        slug: input.slug,
        displayName: requireBoundedText(input.displayName, 160),
        assistantName: requireBoundedText(input.assistantName, 80),
        primaryColor: requireHexColor(input.primaryColor),
        accentColor: requireHexColor(input.accentColor),
        idempotencyKey: requireBoundedText(input.idempotencyKey, 200),
        region: optionalBoundedText(input.region, 60),
        plan: isPlatformClientPlan(input.plan) ? input.plan : "unconfirmed",
      });
      // 200 on a replay: an idempotent retry did not create anything.
      return response(creation, creation.created ? 201 : 200);
    }

    if (action === "client.claims") {
      return response(await getPlatformClientClaims(supabase));
    }

    if (action === "client.revokeClaim") {
      return response(
        await revokePlatformClientClaim(
          supabase,
          requireClaimId(input.claimId),
        ),
      );
    }

    throw new PlatformRpcError("invalid_request");
  } catch (error) {
    return errorResponse(error);
  }
}

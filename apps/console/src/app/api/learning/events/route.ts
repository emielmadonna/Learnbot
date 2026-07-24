import { NextResponse } from "next/server";
import {
  AuthenticationBoundaryError,
  assertSameOrigin,
} from "../../../../lib/supabase/auth-boundary";
import {
  authenticatedLearningClient,
  executeLearningRpc,
} from "../../../../lib/supabase/learning-route";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = (await request.json()) as Record<string, unknown>;
    const eventName =
      typeof input.eventName === "string" ? input.eventName : "";
    const idempotencyKey =
      typeof input.idempotencyKey === "string" ? input.idempotencyKey : "";
    const properties =
      input.properties &&
      typeof input.properties === "object" &&
      !Array.isArray(input.properties)
        ? input.properties
        : {};
    const supabase = await authenticatedLearningClient(request, {
      mutation: true,
    });
    const result = await executeLearningRpc(
      supabase,
      "learning_record_usage_event",
      {
        requested_event_name: eventName,
        requested_idempotency_key: idempotencyKey,
        requested_properties: properties,
      },
    );
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        code:
          error instanceof AuthenticationBoundaryError
            ? "authentication_required"
            : "invalid_request",
      },
      {
        status: error instanceof AuthenticationBoundaryError ? 401 : 400,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
}

import { NextResponse } from "next/server";

import {
  clearDevelopmentOpenAIKey,
  configureDevelopmentOpenAIKey,
  getDevelopmentProviderConfiguration,
  getDevelopmentProviderConfigurations,
} from "../../../../lib/provider-runtime";
import {
  developmentApiErrorStatus,
  requireDevSession,
} from "../../../../lib/dev-session-guard";
import { serializeDevelopmentError } from "../../../../lib/dev-runtime";

export async function GET(request: Request) {
  try {
    await requireDevSession(request, { principal: "owner", permission: "tenant.read" });
    return NextResponse.json({ routes: getDevelopmentProviderConfigurations() }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(serializeDevelopmentError(error), {
      status: developmentApiErrorStatus(error),
    });
  }
}

export async function POST(request: Request) {
  try {
    await requireDevSession(request, { principal: "owner", permission: "tenant.write" });
    const input = (await request.json()) as {
      apiKey?: unknown;
      scopeId?: unknown;
      provider?: unknown;
      model?: unknown;
    };
    const scopeId = typeof input.scopeId === "string" && /^[a-z0-9:_-]{2,80}$/iu.test(input.scopeId)
      ? input.scopeId
      : "workspace";
    const provider = input.provider === "development-local" ? "development-local" : "openai";
    const model = typeof input.model === "string" && /^[a-z0-9._:-]{2,120}$/iu.test(input.model)
      ? input.model
      : "gpt-4o-mini";
    if (provider === "openai" && (
      typeof input.apiKey !== "string" ||
      input.apiKey.trim().length < 20 ||
      input.apiKey.trim().length > 512
    )) {
      return NextResponse.json(
        { code: "INVALID_API_KEY", message: "Enter a valid-looking provider key." },
        { status: 400 },
      );
    }
    configureDevelopmentOpenAIKey(
      provider === "openai" && typeof input.apiKey === "string" ? input.apiKey.trim() : "",
      scopeId,
      model,
      provider,
    );
    return NextResponse.json(getDevelopmentProviderConfiguration(scopeId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(serializeDevelopmentError(error), {
      status: developmentApiErrorStatus(error),
    });
  }
}

export async function DELETE(request: Request) {
  try {
    await requireDevSession(request, { principal: "owner", permission: "tenant.write" });
    const url = new URL(request.url);
    const scopeId = url.searchParams.get("scopeId") ?? "workspace";
    clearDevelopmentOpenAIKey(scopeId);
    return NextResponse.json(getDevelopmentProviderConfiguration(scopeId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(serializeDevelopmentError(error), {
      status: developmentApiErrorStatus(error),
    });
  }
}

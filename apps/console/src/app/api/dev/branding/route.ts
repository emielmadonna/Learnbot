import { NextResponse } from "next/server";

import {
  getDevelopmentRuntime,
  serializeDevelopmentError,
} from "../../../../lib/dev-runtime";
import {
  assertDevTenantMatch,
  developmentApiErrorStatus,
  requireDevSession,
  tenantClaimFromBody,
} from "../../../../lib/dev-session-guard";

type BrandingRequest = {
  assistantName: string;
  logoDataUrl?: string | null;
  primary: string;
  accent: string;
  surface: string;
  welcome: string;
  voice: string;
  attribution: boolean;
  privacyLink: boolean;
  idempotencyKey?: string;
};

export async function GET(request: Request) {
  try {
    const { context } = await requireDevSession(request, {
      principal: "owner",
      permission: "branding.read",
    });
    const branding =
      await getDevelopmentRuntime().services.getPublishedBranding(context);
    return NextResponse.json(branding);
  } catch (error) {
    return NextResponse.json(serializeDevelopmentError(error), {
      status: developmentApiErrorStatus(error),
    });
  }
}

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as BrandingRequest;
    const session = await requireDevSession(request, {
      principal: "owner",
      permission: "branding.write",
    });
    assertDevTenantMatch(session, tenantClaimFromBody(input));
    const context = session.context;
    const services = getDevelopmentRuntime().services;
    const key = input.idempotencyKey ?? crypto.randomUUID();
    const draft = await services.saveBrandingDraft(
      context,
      {
        assistant: {
          name: input.assistantName,
          ...(input.logoDataUrl ? { logoUrl: input.logoDataUrl } : {}),
          welcomeMessage: input.welcome,
        },
        colors: {
          primary: input.primary,
          accent: input.accent,
          canvas: "#eef2ef",
          surface: input.surface,
          text: "#17211d",
        },
        typography: { family: "system" },
        launcher: {
          style: "pill",
          position: "bottom_right",
          label: `Ask ${input.assistantName}`,
        },
        attribution: {
          showPlatformAttribution: input.attribution,
          ...(input.privacyLink
            ? { privacyUrl: "https://northstar.example/privacy" }
            : {}),
        },
        voice: {
          enabled: true,
          voiceId: input.voice.toLowerCase(),
          displayName: input.voice,
        },
      },
      `${key}:draft`,
    );
    const published = await services.publishBranding(
      context,
      draft.version,
      `${key}:publish`,
    );
    return NextResponse.json({ published });
  } catch (error) {
    return NextResponse.json(serializeDevelopmentError(error), {
      status: developmentApiErrorStatus(error),
    });
  }
}

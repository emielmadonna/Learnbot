import { NextResponse } from "next/server";

import {
  getDevelopmentRuntime,
  serializeDevelopmentError,
} from "../../../../lib/dev-runtime";
import {
  developmentApiErrorStatus,
  requireDevSession,
} from "../../../../lib/dev-session-guard";
import { getDevelopmentProviderTelemetry } from "../../../../lib/provider-runtime";
import { getDevelopmentVoiceSessionCount } from "../../../../lib/voice-runtime";

export async function GET(request: Request) {
  try {
    const { context } = await requireDevSession(request, {
      principal: "owner",
      permission: "tenant.read",
    });
    const { services, pipeline } = getDevelopmentRuntime();
    const [tenant, branding, courses, jobs, audit, cost] = await Promise.all([
      services.getTenantConfiguration(context),
      services.getPublishedBranding(context),
      services.listCourses(context),
      services.listIngestionJobs(context),
      services.listAuditRecords(context),
      services.summarizeCosts(
        context,
        "2026-07-01T00:00:00.000Z",
        "2026-07-31T23:59:59.999Z",
        "USD",
      ),
    ]);
    return NextResponse.json({
      tenant,
      branding,
      courses,
      jobs,
      audit,
      cost,
      knowledge: {
        active: pipeline.getActiveVersion({ tenantId: context.tenantId }),
        versions: pipeline.listVersions({ tenantId: context.tenantId }),
      },
      providers: {
        policyVersion: tenant.tenant.policyVersion,
        ...getDevelopmentProviderTelemetry(),
      },
      voice: {
        orchestrator: "@course-ai/realtime-voice",
        activeSessions: getDevelopmentVoiceSessionCount(),
        transport: "browser-speech-bridge",
        productionCredentialsPresent: false,
      },
    });
  } catch (error) {
    return NextResponse.json(serializeDevelopmentError(error), {
      status: developmentApiErrorStatus(error),
    });
  }
}

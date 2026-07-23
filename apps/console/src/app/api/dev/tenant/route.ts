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

export async function GET(request: Request) {
  try {
    const { context } = await requireDevSession(request, {
      principal: "owner",
      permission: "tenant.read",
    });
    const tenant =
      await getDevelopmentRuntime().services.getTenantConfiguration(context);
    return NextResponse.json(tenant);
  } catch (error) {
    return NextResponse.json(serializeDevelopmentError(error), {
      status: developmentApiErrorStatus(error),
    });
  }
}

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as {
      monthlyBudgetUsd?: number;
      idempotencyKey?: string;
    };
    const session = await requireDevSession(request, {
      principal: "owner",
      permission: "tenant.write",
    });
    assertDevTenantMatch(session, tenantClaimFromBody(input));
    if (
      typeof input.monthlyBudgetUsd !== "number" ||
      !Number.isFinite(input.monthlyBudgetUsd) ||
      input.monthlyBudgetUsd <= 0
    ) {
      return NextResponse.json(
        {
          code: "INVALID_BUDGET",
          message: "Monthly budget must be a positive number.",
        },
        { status: 400 },
      );
    }
    const context = session.context;
    const services = getDevelopmentRuntime().services;
    const current = await services.getTenantConfiguration(context);
    const tenant = await services.updateTenantConfiguration(
      context,
      {
        limits: {
          ...current.tenant.limits,
          monthlyBudgetUsd: input.monthlyBudgetUsd,
        },
      },
      input.idempotencyKey ?? crypto.randomUUID(),
    );
    return NextResponse.json({ tenant });
  } catch (error) {
    return NextResponse.json(serializeDevelopmentError(error), {
      status: developmentApiErrorStatus(error),
    });
  }
}

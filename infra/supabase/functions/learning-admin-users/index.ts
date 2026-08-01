import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const allowedRoles = new Set([
  "tenant_owner",
  "tenant_admin",
  "creator",
  "teacher",
  "student",
]);

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
    },
  });
}

function safeProviderMessage(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 500)
    : "The invitation provider did not accept the request.";
}

function publishableKey() {
  const legacy = Deno.env.get("SUPABASE_ANON_KEY")?.trim() ?? "";
  if (legacy) return legacy;
  try {
    const parsed = JSON.parse(
      Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}",
    ) as Record<string, unknown>;
    return typeof parsed.default === "string" ? parsed.default.trim() : "";
  } catch {
    return "";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function invitationRedirect() {
  const configured = Deno.env.get("LEARNINGBOT_APP_URL") ?? "";
  try {
    const base = new URL(configured);
    const local =
      base.protocol === "http:" &&
      (base.hostname === "localhost" || base.hostname === "127.0.0.1");
    if (base.protocol !== "https:" && !local) return null;
    return new URL("/auth/invite", base).toString();
  } catch {
    return null;
  }
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return json({ ok: false, code: "method_not_allowed" }, 405);
  }
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return json({ ok: false, code: "authentication_required" }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = publishableKey();
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !anonKey || !serviceRoleKey) {
    return json({ ok: false, code: "provider_not_configured" }, 503);
  }

  const token = authorization.slice("Bearer ".length);
  const callerClient = createClient(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: { headers: { Authorization: authorization } },
  });
  const { data: identity, error: identityError } =
    await callerClient.auth.getUser(token);
  if (identityError || !identity.user || identity.user.is_anonymous) {
    return json({ ok: false, code: "authentication_required" }, 401);
  }

  let input: Record<string, unknown>;
  try {
    input = await request.json();
  } catch {
    return json({ ok: false, code: "invalid_request" }, 400);
  }
  const email =
    typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const displayName =
    typeof input.displayName === "string" ? input.displayName.trim() : "";
  const role = typeof input.role === "string" ? input.role : "";
  const tenantId =
    typeof input.tenantId === "string" ? input.tenantId.trim() : "";
  const idempotencyKey =
    typeof input.idempotencyKey === "string" ? input.idempotencyKey : "";
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
    displayName.length < 1 ||
    displayName.length > 160 ||
    !allowedRoles.has(role) ||
    !uuidPattern.test(tenantId) ||
    idempotencyKey.length < 8 ||
    idempotencyKey.length > 200
  ) {
    return json({ ok: false, code: "invalid_request" }, 400);
  }

  const service = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });

  const prepared = await service.rpc("admin_prepare_auth_invitation", {
    caller_auth_user_id: identity.user.id,
    target_tenant_id: tenantId,
    target_email: email,
    target_display_name: displayName,
    target_identity_role: role,
    requested_idempotency_key: idempotencyKey,
  });
  const preparation = record(prepared.data);
  if (prepared.error || !preparation || preparation.ok !== true) {
    const code =
      typeof preparation?.code === "string"
        ? preparation.code
        : "invitation_preparation_failed";
    const status =
      code === "access_denied"
        ? 403
        : code === "account_exists" || code === "idempotency_conflict"
          ? 409
          : code === "owner_identity_conflict"
            ? 409
            : code === "tenant_not_found"
              ? 404
              : 400;
    return json({ ok: false, code }, status);
  }

  const deliveryId =
    typeof preparation.deliveryId === "string" ? preparation.deliveryId : "";
  const invitationId =
    typeof preparation.invitationId === "string"
      ? preparation.invitationId
      : "";
  if (!uuidPattern.test(deliveryId) || !invitationId) {
    return json({ ok: false, code: "invitation_preparation_failed" }, 502);
  }
  const canonicalEmail =
    typeof preparation.email === "string" ? preparation.email : email;
  const canonicalDisplayName =
    typeof preparation.displayName === "string"
      ? preparation.displayName
      : displayName;
  const canonicalRole =
    typeof preparation.role === "string" ? preparation.role : role;
  const canonicalTenantId =
    typeof preparation.tenantId === "string"
      ? preparation.tenantId
      : tenantId;
  if (
    canonicalEmail !== email ||
    canonicalDisplayName !== displayName ||
    canonicalRole !== role ||
    canonicalTenantId !== tenantId
  ) {
    return json({ ok: false, code: "idempotency_conflict" }, 409);
  }

  if (preparation.status === "sent" || preparation.status === "accepted") {
    return json({
      ok: true,
      invitation: {
        deliveryId,
        invitationId,
        tenantId: canonicalTenantId,
        email: canonicalEmail,
        displayName: canonicalDisplayName,
        role: canonicalRole,
        status: "sent",
      },
      deliveryStatus: preparation.status,
      idempotentReplay: true,
    });
  }
  if (preparation.status === "expired" || preparation.status === "revoked") {
    return json(
      {
        ok: false,
        code: `invitation_${preparation.status}`,
        deliveryStatus: preparation.status,
        resendRequired: true,
      },
      409,
    );
  }

  async function recordFailure(
    targetStatus: "provider_failed" | "provisioning_failed",
    providerCode: string,
    providerMessage: string,
  ) {
    const persisted = await service.rpc(
      "admin_record_auth_invitation_failure",
      {
        target_delivery_id: deliveryId,
        target_status: targetStatus,
        target_error_code: providerCode,
        target_error_message: providerMessage,
      },
    );
    const payload = record(persisted.data);
    return {
      ok: !persisted.error && payload?.ok === true,
      error: persisted.error,
      payload,
    };
  }

  const begun = await service.rpc(
    "admin_begin_auth_invitation_provider_attempt",
    {
      caller_auth_user_id: identity.user.id,
      target_delivery_id: deliveryId,
    },
  );
  const attempt = record(begun.data);
  if (begun.error || !attempt || attempt.ok !== true) {
    const code =
      typeof attempt?.code === "string"
        ? attempt.code
        : "invitation_state_failed";
    return json(
      {
        ok: false,
        code,
        resendRequired:
          code === "invitation_expired" || code === "invitation_revoked",
      },
      code === "access_denied"
        ? 403
        : code === "invitation_expired" || code === "invitation_revoked"
          ? 409
          : 502,
    );
  }
  if (attempt.status === "sent" || attempt.status === "accepted") {
    return json({
      ok: true,
      invitation: {
        deliveryId,
        invitationId,
        tenantId: canonicalTenantId,
        email: canonicalEmail,
        displayName: canonicalDisplayName,
        role: canonicalRole,
        status: "sent",
      },
      deliveryStatus: attempt.status,
      idempotentReplay: true,
    });
  }

  const redirectTo = invitationRedirect();
  if (redirectTo === null) {
    const providerMessage =
      "LEARNINGBOT_APP_URL is missing or is not a secure application URL.";
    const failure = await recordFailure(
      "provider_failed",
      "provider_not_configured",
      providerMessage,
    );
    if (!failure.ok) {
      return json(
        {
          ok: false,
          code: "invitation_audit_failed",
          providerMessage,
          deliveryStatus: "unknown",
        },
        503,
      );
    }
    return json(
      {
        ok: false,
        code: "provider_not_configured",
        providerMessage,
        deliveryStatus: "provider_failed",
      },
      503,
    );
  }

  let providerAuthUserId =
    typeof attempt.providerAuthUserId === "string"
      ? attempt.providerAuthUserId
      : "";
  let reusedProviderUser = false;
  if (!uuidPattern.test(providerAuthUserId)) {
    const resolved = await service.rpc(
      "admin_resolve_auth_invitation_provider_user",
      {
        caller_auth_user_id: identity.user.id,
        target_delivery_id: deliveryId,
      },
    );
    const candidate = record(resolved.data);
    if (resolved.error || !candidate || candidate.ok !== true) {
      const providerMessage = resolved.error
        ? safeProviderMessage(resolved.error.message)
        : "The invitation provider recovery state could not be verified.";
      const failure = await recordFailure(
        "provider_failed",
        "provider_recovery_failed",
        providerMessage,
      );
      return json(
        {
          ok: false,
          code: failure.ok
            ? "invitation_provider_failed"
            : "invitation_audit_failed",
          providerMessage,
          deliveryStatus: failure.ok ? "provider_failed" : "unknown",
        },
        502,
      );
    }

    const candidateId =
      candidate.found === true && typeof candidate.authUserId === "string"
        ? candidate.authUserId
        : "";
    const candidateIsConfirmed =
      uuidPattern.test(candidateId) && candidate.emailConfirmed === true;
    reusedProviderUser = uuidPattern.test(candidateId);

    if (candidateIsConfirmed) {
      const recovered = await service.auth.resetPasswordForEmail(
        canonicalEmail,
        { redirectTo },
      );
      if (recovered.error) {
        const providerMessage = safeProviderMessage(recovered.error.message);
        const providerCode =
          typeof recovered.error.code === "string"
            ? recovered.error.code
            : "invitation_provider_failed";
        const failure = await recordFailure(
          "provider_failed",
          providerCode,
          providerMessage,
        );
        return json(
          {
            ok: false,
            code: failure.ok
              ? "invitation_provider_failed"
              : "invitation_audit_failed",
            providerCode,
            providerMessage,
            deliveryStatus: failure.ok ? "provider_failed" : "unknown",
          },
          502,
        );
      }
      providerAuthUserId = candidateId;
    } else {
      const invited = await service.auth.admin.inviteUserByEmail(
        canonicalEmail,
        {
          redirectTo,
          data: {
            display_name: canonicalDisplayName,
            invitation_id: invitationId,
          },
        },
      );
      let providerError = invited.error;
      if (
        (providerError || !invited.data.user) &&
        uuidPattern.test(candidateId)
      ) {
        const resent = await service.auth.resend({
          type: "signup",
          email: canonicalEmail,
          options: { emailRedirectTo: redirectTo },
        });
        providerError = resent.error;
        if (!providerError) providerAuthUserId = candidateId;
      } else if (invited.data.user) {
        providerAuthUserId = invited.data.user.id;
      }
      if (providerError || !uuidPattern.test(providerAuthUserId)) {
        const providerMessage = safeProviderMessage(providerError?.message);
        const providerCode =
          typeof providerError?.code === "string"
            ? providerError.code
            : "invitation_provider_failed";
        const failure = await recordFailure(
          "provider_failed",
          providerCode,
          providerMessage,
        );
        return json(
          {
            ok: false,
            code: failure.ok
              ? "invitation_provider_failed"
              : "invitation_audit_failed",
            providerCode,
            providerMessage,
            deliveryStatus: failure.ok ? "provider_failed" : "unknown",
          },
          502,
        );
      }
    }

    const recorded = await service.rpc(
      "admin_record_auth_invitation_provider_user",
      {
        caller_auth_user_id: identity.user.id,
        target_delivery_id: deliveryId,
        target_auth_user_id: providerAuthUserId,
      },
    );
    const providerState = record(recorded.data);
    if (recorded.error || !providerState || providerState.ok !== true) {
      const stateCode =
        typeof providerState?.code === "string"
          ? providerState.code
          : "provider_user_record_failed";
      let cleanupFailed = false;
      // Only remove a user created by this exact request after a durable,
      // non-retryable ownership conflict. Recovered users are never deleted.
      if (!reusedProviderUser && stateCode === "auth_user_unavailable") {
        const cleanup = await service.auth.admin.deleteUser(
          providerAuthUserId,
          true,
        );
        cleanupFailed = Boolean(cleanup.error);
      }
      const providerMessage = recorded.error
        ? safeProviderMessage(recorded.error.message)
        : `Invitation provider state failed: ${stateCode}.`;
      const failure = await recordFailure(
        "provider_failed",
        stateCode,
        providerMessage,
      );
      return json(
        {
          ok: false,
          code: cleanupFailed
            ? "invitation_cleanup_failed"
            : failure.ok
              ? "invitation_provider_failed"
              : "invitation_audit_failed",
          providerMessage,
          deliveryStatus: failure.ok ? "provider_failed" : "unknown",
          resumable: !cleanupFailed,
        },
        502,
      );
    }
  }

  const provisioned = await service.rpc("admin_complete_auth_invitation", {
    caller_auth_user_id: identity.user.id,
    target_delivery_id: deliveryId,
    target_auth_user_id: providerAuthUserId,
  });
  const result = record(provisioned.data);
  if (provisioned.error || !result || result.ok !== true) {
    const providerMessage = provisioned.error
      ? safeProviderMessage(provisioned.error.message)
      : `Invitation delivery finalization failed: ${
          typeof result?.code === "string" ? result.code : "unknown"
        }.`;
    const failure = await recordFailure(
      "provisioning_failed",
      typeof result?.code === "string"
        ? result.code
        : "invitation_finalization_failed",
      providerMessage,
    );
    const denied = result?.code === "access_denied";
    return json(
      {
        ok: false,
        code: denied
          ? "access_denied"
          : failure.ok
            ? "invitation_finalization_failed"
            : "invitation_audit_failed",
        providerMessage,
        deliveryStatus: failure.ok ? "provisioning_failed" : "unknown",
        resumable: true,
      },
      denied ? 403 : 502,
    );
  }

  return json({
    ok: true,
    invitation: {
      deliveryId,
      invitationId,
      authUserId: providerAuthUserId,
      tenantId: canonicalTenantId,
      email: canonicalEmail,
      displayName: canonicalDisplayName,
      role: canonicalRole,
      status: "sent",
    },
    deliveryStatus: "sent",
  });
});

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const allowedRoles = new Set([
  "tenant_owner",
  "tenant_admin",
  "creator",
  "teacher",
  "student",
]);

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

function generateTemporaryPassword() {
  const lowercase = "abcdefghijkmnopqrstuvwxyz";
  const uppercase = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const symbols = "!@#$%&*+-=?";
  const all = lowercase + uppercase + digits + symbols;
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const required = [
    lowercase[bytes[0] % lowercase.length],
    uppercase[bytes[1] % uppercase.length],
    digits[bytes[2] % digits.length],
    symbols[bytes[3] % symbols.length],
  ];
  const remaining = Array.from(bytes.slice(4), (byte) => all[byte % all.length]);
  return [...required, ...remaining]
    .sort(() => crypto.getRandomValues(new Uint8Array(1))[0] - 128)
    .join("");
}

type ProviderError = {
  name?: unknown;
  status?: unknown;
  code?: unknown;
  message?: unknown;
};

function providerErrorDetails(error: unknown) {
  const candidate = (error ?? {}) as ProviderError;
  const status =
    typeof candidate.status === "number" ? candidate.status : undefined;
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  const name = typeof candidate.name === "string" ? candidate.name : undefined;
  const message =
    typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";

  const category =
    status === 401 || status === 403
      ? "provider_authorization_failed"
      : message.includes("already registered") ||
          message.includes("already exists") ||
          message.includes("user already")
        ? "account_exists"
        : status === 429
          ? "provider_rate_limited"
          : status !== undefined && status >= 500
            ? "provider_unavailable"
            : "provider_request_failed";

  return { category, status, code, name };
}

function logProviderFailure(stage: string, error: unknown) {
  // Keep diagnostics useful without logging provider messages, emails, tokens,
  // or temporary credentials.
  console.error(`learning-admin-users.${stage}`, providerErrorDetails(error));
}

function rpcDiagnostic(
  error: unknown,
  result: Record<string, unknown> | null,
) {
  const details = providerErrorDetails(error);
  const diagnostic: Record<string, string | number> = {
    kind: error ? "rpc_error" : "rpc_rejected",
  };
  for (const key of ["stage", "sqlstate", "constraint"]) {
    const value = result?.[key];
    if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,80}$/u.test(value)) {
      diagnostic[key] = value;
    }
  }
  if (details.code) diagnostic.providerCode = details.code;
  if (details.status !== undefined) diagnostic.providerStatus = details.status;
  return diagnostic;
}

function publishableKeyFromEnvironment() {
  const direct = Deno.env.get("SUPABASE_ANON_KEY")?.trim();
  if (direct) return direct;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
    return typeof keys?.default === "string" ? keys.default.trim() : "";
  } catch {
    return "";
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
  const anonKey = publishableKeyFromEnvironment();
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
  const idempotencyKey =
    typeof input.idempotencyKey === "string" ? input.idempotencyKey : "";
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
    displayName.length < 1 ||
    displayName.length > 160 ||
    !allowedRoles.has(role) ||
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
  const temporaryPassword = generateTemporaryPassword();
  const created = await service.auth.admin.createUser({
    email,
    password: temporaryPassword,
    email_confirm: true,
    app_metadata: {
      learningbot_managed: true,
      must_change_password: true,
    },
  });
  if (created.error || !created.data.user) {
    logProviderFailure("auth-create-failed", created.error);
    const details = providerErrorDetails(created.error);
    const status = details.category === "account_exists" ? 409 : 400;
    return json(
      {
        ok: false,
        code:
          status === 409
            ? "account_exists"
            : details.category === "provider_authorization_failed"
              ? "provider_authorization_failed"
              : details.category === "provider_unavailable"
                ? "provider_unavailable"
                : "account_creation_failed",
        diagnostic: {
          kind: "auth_create",
          ...(details.code ? { providerCode: details.code } : {}),
          ...(details.status !== undefined
            ? { providerStatus: details.status }
            : {}),
        },
      },
      status,
    );
  }

  const provisioned = await service.rpc("admin_provision_auth_user", {
    caller_auth_user_id: identity.user.id,
    target_auth_user_id: created.data.user.id,
    target_email: email,
    target_display_name: displayName,
    target_identity_role: role,
    requested_idempotency_key: idempotencyKey,
  });
  const result = provisioned.data as Record<string, unknown> | null;
  if (provisioned.error || !result || result.ok !== true) {
    if (provisioned.error) {
      logProviderFailure("rpc-failed", provisioned.error);
    } else {
      console.error("learning-admin-users.rpc-rejected", {
        code: typeof result?.code === "string" ? result.code : "unknown",
      });
    }
    let cleanupError: ProviderError | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const cleanup = await service.auth.admin.deleteUser(
        created.data.user.id,
        true,
      );
      if (!cleanup.error) {
        cleanupError = null;
        break;
      }
      cleanupError = cleanup.error;
    }
    if (cleanupError) {
      logProviderFailure("auth-cleanup-failed", cleanupError);
      const details = providerErrorDetails(cleanupError);
      return json(
        {
          ok: false,
          code: "account_cleanup_failed",
          diagnostic: {
            kind: "auth_cleanup",
            ...(details.code ? { providerCode: details.code } : {}),
            ...(details.status !== undefined
              ? { providerStatus: details.status }
              : {}),
          },
        },
        503,
      );
    }
    const denied = result?.code === "access_denied";
    return json(
      {
        ok: false,
        code: denied ? "access_denied" : "account_provisioning_failed",
        diagnostic: rpcDiagnostic(provisioned.error, result),
      },
      denied ? 403 : 400,
    );
  }

  return json({
    ok: true,
    account: {
      authUserId: created.data.user.id,
      email,
      displayName,
      role,
      mustChangePassword: true,
    },
    temporaryPassword,
    passwordReturnedOnce: true,
  });
});

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

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return json({ ok: false, code: "method_not_allowed" }, 405);
  }
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return json({ ok: false, code: "authentication_required" }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey =
    Deno.env.get("SUPABASE_ANON_KEY") ??
    JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}").default ??
    "";
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
    const status = created.error?.message.toLowerCase().includes("registered")
      ? 409
      : 400;
    return json(
      {
        ok: false,
        code: status === 409 ? "account_exists" : "account_creation_failed",
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
    await service.auth.admin.deleteUser(created.data.user.id, true);
    const denied = result?.code === "access_denied";
    return json(
      {
        ok: false,
        code: denied ? "access_denied" : "account_provisioning_failed",
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

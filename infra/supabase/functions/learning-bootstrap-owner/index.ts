import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

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
  const groups = [
    "abcdefghijkmnopqrstuvwxyz",
    "ABCDEFGHJKLMNPQRSTUVWXYZ",
    "23456789",
    "!@#$%&*+-=?",
  ];
  const all = groups.join("");
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const characters = groups.map(
    (group, index) => group[bytes[index] % group.length],
  );
  for (const byte of bytes.slice(groups.length)) {
    characters.push(all[byte % all.length]);
  }
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const random = crypto.getRandomValues(new Uint32Array(1))[0];
    const swap = random % (index + 1);
    [characters[index], characters[swap]] = [
      characters[swap],
      characters[index],
    ];
  }
  return characters.join("");
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return json({ ok: false, code: "method_not_allowed" }, 405);
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

  let input: Record<string, unknown>;
  try {
    input = await request.json();
  } catch {
    return json({ ok: false, code: "invalid_request" }, 400);
  }
  const email =
    typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const slug = typeof input.slug === "string" ? input.slug.trim() : "";
  const claimToken =
    typeof input.claimToken === "string" ? input.claimToken.trim() : "";
  const existingAuthUserId =
    typeof input.existingAuthUserId === "string"
      ? input.existingAuthUserId.trim()
      : "";
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
    !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(slug) ||
    claimToken.length < 32 ||
    claimToken.length > 256 ||
    (existingAuthUserId &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        existingAuthUserId,
      ))
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
  let authUserId = existingAuthUserId;
  let accountWasCreated = false;
  if (authUserId) {
    const current = await service.auth.admin.getUserById(authUserId);
    if (
      current.error ||
      !current.data.user ||
      current.data.user.email?.toLowerCase() !== email
    ) {
      return json({ ok: false, code: "account_recovery_denied" }, 403);
    }
    const updated = await service.auth.admin.updateUserById(authUserId, {
      password: temporaryPassword,
      email_confirm: true,
      app_metadata: {
        ...current.data.user.app_metadata,
        learningbot_managed: true,
        must_change_password: true,
      },
    });
    if (updated.error || !updated.data.user) {
      return json({ ok: false, code: "account_recovery_failed" }, 400);
    }
  } else {
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
      return json({ ok: false, code: "account_creation_failed" }, 400);
    }
    authUserId = created.data.user.id;
    accountWasCreated = true;
  }

  const userClient = createClient(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  const signedIn = await userClient.auth.signInWithPassword({
    email,
    password: temporaryPassword,
  });
  if (signedIn.error || !signedIn.data.user) {
    if (accountWasCreated) {
      await service.auth.admin.deleteUser(authUserId, true);
    }
    return json({ ok: false, code: "account_bootstrap_failed" }, 400);
  }

  const requestId = `bootstrap:${crypto.randomUUID()}`;
  const claim = await userClient.rpc("auth_claim_preprovisioned_tenant_owner", {
    requested_slug: slug,
    claim_token: claimToken,
    request_id: requestId,
    trace_id: requestId,
  });
  const claimResult = Array.isArray(claim.data) ? claim.data[0] : claim.data;
  if (claim.error || !claimResult || claimResult.claimed !== true) {
    if (accountWasCreated) {
      await service.auth.admin.deleteUser(authUserId, true);
    }
    return json({ ok: false, code: "owner_claim_denied" }, 403);
  }

  const registered = await service.rpc("admin_register_claimed_owner_access", {
    target_auth_user_id: authUserId,
    target_email: email,
  });
  const registration = registered.data as Record<string, unknown> | null;
  if (registered.error || !registration || registration.ok !== true) {
    return json({ ok: false, code: "access_registration_failed" }, 500);
  }

  await userClient.auth.signOut();
  return json({
    ok: true,
    account: {
      authUserId,
      email,
      role: "tenant_owner",
      tenantSlug: slug,
      mustChangePassword: true,
    },
    temporaryPassword,
    passwordReturnedOnce: true,
  });
});

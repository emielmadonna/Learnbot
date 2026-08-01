import { redirect } from "next/navigation";
import AppShell from "../../components/app-shell/app-shell";
import type {
  AgentConfig,
  PanelKey,
  ShellPayload,
  ShellRole,
} from "../../components/app-shell/contract";
import shellStyles from "../../components/app-shell/shell.module.css";
import {
  getCurrentTenantContext,
  requireVerifiedUser,
} from "../../lib/supabase/auth-boundary";
import { getLearningWorkspace } from "../../lib/supabase/learning-rpc";
import {
  isPlatformSectionKey,
  parseTenantSections,
} from "../../lib/supabase/platform-rpc";
import { createServerSupabaseClient } from "../../lib/supabase/server";
import { resolveAppAccessMode } from "./access-mode";

const TENANT_ADMIN_ROLES = ["tenant_owner", "tenant_admin"];

const BRAND_ASSET_TTL_SECONDS = 600;

/**
 * Resolve a private branding asset to a short-lived signed URL.
 *
 * Brand images live in the tenant-private bucket, so they cannot be linked
 * directly. A missing key is the normal case (most tenants never upload a
 * logo), and a signing failure must not take the whole workspace down — either
 * way the shell falls back to the tenant-derived initial.
 */
async function signedBrandAsset(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  storageKey: string | null | undefined,
): Promise<string | null> {
  if (!storageKey) return null;
  try {
    const signed = await supabase.storage
      .from("tenant-private")
      .createSignedUrl(storageKey, BRAND_ASSET_TTL_SECONDS);
    return signed.error ? null : (signed.data?.signedUrl ?? null);
  } catch {
    return null;
  }
}

/**
 * Read the tenant's durable section flags, falling back to role-derived
 * defaults.
 *
 * The fallback is not a convenience: it is what keeps the workspace usable on a
 * database where the section-control migration has not been applied. It is
 * deliberately no more permissive than the durable record can be — a section
 * the role could not reach is never enabled here.
 */
async function resolveSections(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  access: { canAdminister: boolean; canManagePlatform: boolean },
): Promise<Record<PanelKey, boolean>> {
  const permitted: Record<PanelKey, boolean> = {
    agent: true,
    course: true,
    insights: access.canAdminister,
    people: access.canAdminister,
    platform: access.canManagePlatform,
    // The widget is the tenant's own site-facing surface, so it sits behind
    // the same administrative gate as People and Insights.
    widget: access.canAdminister,
    settings: true,
  };

  try {
    const response = await supabase.rpc("tenant_get_sections");
    if (!response.error) {
      const sections = parseTenantSections(
        (response.data as { sections?: unknown } | null)?.sections,
      );
      for (const section of sections) {
        if (!isPlatformSectionKey(section.sectionKey)) continue;
        const key = section.sectionKey as PanelKey;
        // A tenant may switch a section off, but never on past its role gate.
        permitted[key] = permitted[key] && section.enabled;
      }
    }
  } catch {
    // Fall through to the operator carve-out on the defaults above.
  }

  // Operator entitlements, applied LAST so they hold on every path — including
  // an RPC error or an empty catalogue, where the loop above never runs. These
  // are account-level entitlements rather than client preferences, and a
  // client's own section catalogue must not take either away from an
  // authorized platform administrator who also holds a membership there:
  //
  //   platform — the operator control plane itself. Losing it strands the
  //              operator inside the client workspace with no route back.
  //   insights — analytics and the learner questions behind them. A client may
  //              legitimately have results switched off in their own console,
  //              but the operator still has to see what learners are asking in
  //              order to support the account.
  //
  // This only ever widens what the OPERATOR sees. A client's own view is
  // decided by `section.enabled` in the loop above, so switching results off
  // for a tenant genuinely hides it from that tenant.
  if (access.canManagePlatform) {
    permitted.platform = true;
    permitted.insights = true;
  }

  return permitted;
}

function toShellRole(identityRole: string, canManagePlatform: boolean): ShellRole {
  // Platform authority takes precedence over any tenant membership. The same
  // human may legitimately own a client workspace, but that must not collapse
  // the platform dock into the client-only creator dock.
  if (canManagePlatform) return "platform_owner";

  switch (identityRole) {
    case "tenant_owner":
      return "tenant_owner";
    case "tenant_admin":
      return "tenant_admin";
    case "teacher":
      return "teacher";
    case "creator":
      return "creator";
    default:
      return "learner";
  }
}

export default async function AuthenticatedAppPage() {
  let supabase;
  try {
    supabase = await createServerSupabaseClient();
  } catch {
    return (
      <main className={shellStyles.closed}>
        <section>
          <h1>Production access is not configured.</h1>
          <p>Supabase configuration is missing. Access remains closed.</p>
        </section>
      </main>
    );
  }

  let user;
  try {
    user = await requireVerifiedUser(supabase);
  } catch {
    redirect("/auth/sign-in?error=authentication_required&next=/app");
  }

  const platformAuthorization = await supabase.rpc(
    "platform_admin_is_authorized",
  );
  const canManagePlatform =
    !platformAuthorization.error && platformAuthorization.data === true;
  const context = await getCurrentTenantContext(supabase);
  const accessMode = resolveAppAccessMode({
    platformAuthorized: canManagePlatform,
    selectedTenant: context.selected && context.tenantId !== null,
  });

  const accountName =
    (typeof user.user_metadata?.full_name === "string"
      ? user.user_metadata.full_name.trim().split(/\s+/u)[0]
      : "") ||
    user.email?.split("@")[0] ||
    "there";

  if (accessMode === "onboarding") redirect("/onboarding");
  if (accessMode === "platform_control_plane") {
    const payload: ShellPayload = {
      role: "platform_owner",
      tenant: {
        tenantId: "",
        slug: "",
        displayName: "Corso",
      },
      agent: {
        assistantName: "Platform",
        logoUrl: null,
        avatarUrl: null,
        iconGlyph: "◎",
        primaryColor: "#4a637f",
        accentColor: "#4a637f",
        surfaceColor: "#ffffff",
        textColor: "#1d1d1f",
        welcomeMessage: "Manage Corso client workspaces.",
        personaInstructions: "",
        tone: "",
        voice: "Default",
        courseScope: "all",
      },
      sections: {
        agent: false,
        course: false,
        insights: false,
        people: false,
        platform: true,
        widget: false,
        settings: false,
      },
      workspace: null,
    };
    return (
      <AppShell
        payload={payload}
        accountName={accountName}
        accountEmail={user.email ?? null}
      />
    );
  }

  let workspace;
  try {
    workspace = await getLearningWorkspace(supabase);
  } catch {
    redirect("/onboarding?error=selection_failed");
  }

  const identityRole = workspace.identity.role || context.identityRole || "";
  const canAdminister = TENANT_ADMIN_ROLES.includes(identityRole);
  const brand = workspace.branding;

  // The workspace payload is the authoritative source for presentation: it is
  // the only branding a learner is allowed to see, and it always resolves. The
  // agent record below supplies the fields the workspace deliberately withholds
  // from non-admins. Both paths degrade to workspace values, so the shell
  // themes correctly whether or not the agent migration has been applied.
  const agent: AgentConfig = {
    assistantName: brand?.assistantName ?? "Corso",
    logoUrl: await signedBrandAsset(supabase, brand?.logoStorageKey),
    avatarUrl: await signedBrandAsset(supabase, brand?.avatarStorageKey),
    iconGlyph: brand?.iconGlyph ?? "◎",
    // Unbranded defaults are NEUTRAL graphite, drawn from the neutral ramp in
    // globals.css (--n-800 / --n-600 / --n-50 / --n-900). A tenant that has not
    // chosen colours should look like an unbranded product, not like somebody
    // else's: these used to be one client's green and gold, which is how that
    // palette ended up painting the whole console.
    primaryColor: brand?.primaryColor ?? "#4a637f",
    accentColor: brand?.accentColor ?? "#4a637f",
    surfaceColor: brand?.surfaceColor ?? "#ffffff",
    textColor: brand?.textColor ?? "#1d1d1f",
    welcomeMessage:
      brand?.welcomeMessage ??
      "Ask a question about your learning and I’ll help you find the answer.",
    // Behaviour directives are admin-only by design: `learning_get_workspace`
    // omits them entirely for learners so the assistant's instructions cannot
    // be read and worked around. Empty here simply means "not disclosed to this
    // role", never "not configured".
    personaInstructions: brand?.personaInstructions ?? "",
    tone: brand?.tone ?? "",
    voice: brand?.voice ?? "Default",
    courseScope: brand?.courseScope ?? "all",
  };

  const sections = await resolveSections(supabase, {
    canAdminister,
    canManagePlatform,
  });

  const payload: ShellPayload = {
    role: toShellRole(identityRole, canManagePlatform),
    tenant: {
      tenantId: workspace.tenant.tenantId,
      slug: workspace.tenant.slug,
      displayName: workspace.tenant.displayName,
    },
    agent,
    sections,
    workspace,
  };

  return (
    <AppShell
      payload={payload}
      accountName={accountName}
      accountEmail={user.email ?? null}
    />
  );
}

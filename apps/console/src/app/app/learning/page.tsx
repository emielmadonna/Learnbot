import { redirect } from "next/navigation";
import {
  getCurrentTenantContext,
  requireVerifiedUser,
} from "../../../lib/supabase/auth-boundary";
import { getLearningWorkspace } from "../../../lib/supabase/learning-rpc";
import { createServerSupabaseClient } from "../../../lib/supabase/server";
import KnowledgeWorkbench from "./knowledge-workbench";

export default async function KnowledgeLearningPage() {
  let supabase;
  try {
    supabase = await createServerSupabaseClient();
    await requireVerifiedUser(supabase);
  } catch {
    redirect("/auth/sign-in?error=authentication_required&next=/app/learning");
  }

  const context = await getCurrentTenantContext(supabase);
  if (!context.selected || !context.tenantId) redirect("/onboarding");
  if (!context.identityRole || !["tenant_owner", "tenant_admin", "creator", "teacher"].includes(context.identityRole)) {
    redirect("/app/entry");
  }

  let workspace;
  try {
    workspace = await getLearningWorkspace(supabase);
  } catch {
    redirect("/onboarding?error=selection_failed");
  }

  return (
    <KnowledgeWorkbench
      assistantName={workspace.branding?.assistantName ?? "LearningBot"}
      tenantName={workspace.tenant.displayName}
    />
  );
}

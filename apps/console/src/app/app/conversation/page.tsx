import { redirect } from "next/navigation";
import type { CSSProperties } from "react";
import {
  getCurrentTenantContext,
  requireVerifiedUser,
} from "../../../lib/supabase/auth-boundary";
import { getLearningWorkspace } from "../../../lib/supabase/learning-rpc";
import { createServerSupabaseClient } from "../../../lib/supabase/server";
import ConversationClient from "./conversation-client";
import styles from "./conversation.module.css";

export default async function ConversationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  let supabase;
  try {
    supabase = await createServerSupabaseClient();
  } catch {
    return (
      <main className={styles.closed}>
        <section>
          <span className={styles.closedMark}>E</span>
          <h1>Production access is not configured.</h1>
          <p>Supabase configuration is missing. Access remains closed.</p>
        </section>
      </main>
    );
  }

  try {
    await requireVerifiedUser(supabase);
  } catch {
    redirect(
      "/auth/sign-in?error=authentication_required&next=/app/conversation",
    );
  }

  const context = await getCurrentTenantContext(supabase);
  if (!context.selected || !context.tenantId) redirect("/onboarding");

  let workspace;
  try {
    workspace = await getLearningWorkspace(supabase);
  } catch {
    redirect("/onboarding?error=selection_failed");
  }

  const parameters = await searchParams;
  const requestedMode =
    typeof parameters.mode === "string" ? parameters.mode : "text";
  const requestedCourseId =
    typeof parameters.courseId === "string" ? parameters.courseId : null;
  const requestedLessonId =
    typeof parameters.lessonId === "string" ? parameters.lessonId : null;
  const brand = workspace.branding;
  const theme = {
    "--brand-primary": brand?.primaryColor ?? "#234f40",
    "--brand-accent": brand?.accentColor ?? "#d2a85f",
    "--brand-surface": brand?.surfaceColor ?? "#f5f4ef",
    "--brand-text": brand?.textColor ?? "#14231d",
  } as CSSProperties;

  return (
    <main className={styles.shell} style={theme}>
      <ConversationClient
        assistantName={brand?.assistantName ?? "Estie"}
        tenantName={workspace.tenant.displayName}
        welcomeMessage={
          brand?.welcomeMessage ??
          "Ask a question about your learning and I’ll help you find the answer."
        }
        role={workspace.identity.role}
        initialMode={requestedMode === "voice" ? "voice" : "text"}
        initialCourseId={requestedCourseId}
        initialLessonId={requestedLessonId}
        courses={workspace.courses.map((course) => ({
          courseId: course.courseId,
          title: course.title,
          modules: course.modules.map((module) => ({
            moduleId: module.moduleId,
            title: module.title,
            lessons: module.lessons.map((lesson) => ({
              lessonId: lesson.lessonId,
              title: lesson.title,
            })),
          })),
        }))}
      />
    </main>
  );
}

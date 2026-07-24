import Link from "next/link";
import { redirect } from "next/navigation";
import type { CSSProperties } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getCurrentTenantContext,
  requireVerifiedUser,
} from "../../../lib/supabase/auth-boundary";
import { getLearningWorkspace } from "../../../lib/supabase/learning-rpc";
import { getOnboardingSnapshot } from "../../../lib/supabase/onboarding-rpc";
import { createServerSupabaseClient } from "../../../lib/supabase/server";
import styles from "./admin.module.css";

type CountedTable =
  | "courses"
  | "modules"
  | "lessons"
  | "learning_sources"
  | "learning_documents"
  | "learning_chunks";

async function exactTenantCount(
  supabase: SupabaseClient,
  table: CountedTable,
  tenantId: string,
  status?: string,
) {
  let query = supabase
    .from(table)
    .select("tenant_id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  if (status) query = query.eq("status", status);
  const response = await query;
  return response.error || response.count === null ? null : response.count;
}

function countLabel(value: number | null) {
  return value === null ? "Restricted" : value.toLocaleString();
}

function roleLabel(role: string) {
  return role.replaceAll("_", " ").replace(/\b\w/gu, (letter) =>
    letter.toUpperCase(),
  );
}

export default async function AdminOverviewPage() {
  let supabase;
  try {
    supabase = await createServerSupabaseClient();
    await requireVerifiedUser(supabase);
  } catch {
    redirect("/auth/sign-in?error=authentication_required&next=/app/admin");
  }

  const context = await getCurrentTenantContext(supabase);
  if (!context.selected || !context.tenantId) redirect("/onboarding");
  if (!["tenant_owner", "tenant_admin"].includes(context.identityRole ?? "")) {
    redirect("/app?error=access_denied");
  }

  let workspace;
  try {
    workspace = await getLearningWorkspace(supabase);
  } catch {
    redirect("/onboarding?error=selection_failed");
  }
  const platformAuthorization = await supabase.rpc(
    "platform_admin_is_authorized",
  );
  const canManagePlatform =
    !platformAuthorization.error && platformAuthorization.data === true;

  const [
    onboarding,
    courseCount,
    publishedCourseCount,
    moduleCount,
    lessonCount,
    sourceCount,
    documentCount,
    chunkCount,
  ] = await Promise.all([
    getOnboardingSnapshot(supabase).catch(() => null),
    exactTenantCount(supabase, "courses", context.tenantId),
    exactTenantCount(supabase, "courses", context.tenantId, "published"),
    exactTenantCount(supabase, "modules", context.tenantId),
    exactTenantCount(supabase, "lessons", context.tenantId),
    exactTenantCount(supabase, "learning_sources", context.tenantId),
    exactTenantCount(supabase, "learning_documents", context.tenantId),
    exactTenantCount(supabase, "learning_chunks", context.tenantId),
  ]);

  const visibleModuleCount = workspace.courses.reduce(
    (total, course) => total + course.modules.length,
    0,
  );
  const visibleLessonCount = workspace.courses.reduce(
    (total, course) =>
      total +
      course.modules.reduce(
        (moduleTotal, module) => moduleTotal + module.lessons.length,
        0,
      ),
    0,
  );
  const resolvedCourseCount = courseCount ?? workspace.courses.length;
  const resolvedModuleCount = moduleCount ?? visibleModuleCount;
  const resolvedLessonCount = lessonCount ?? visibleLessonCount;
  const exactLearningStructure =
    courseCount !== null && moduleCount !== null && lessonCount !== null;
  const completedSteps =
    onboarding?.steps.filter((step) =>
      ["complete", "not_applicable"].includes(step.status),
    ).length ?? null;
  const branding = workspace.branding;
  const assistantName = branding?.assistantName ?? "Estie";
  const theme = {
    "--admin-primary": branding?.primaryColor ?? "#234f40",
    "--admin-accent": branding?.accentColor ?? "#d2a85f",
  } as CSSProperties;

  return (
    <main className={styles.shell} style={theme}>
      <nav className={styles.floatingNav} aria-label="Owner administration">
        <Link className={styles.brand} href="/app">
          <span className={styles.brandMark}>E</span>
          <span>
            <b>{assistantName}</b>
            <small>{workspace.tenant.displayName}</small>
          </span>
        </Link>
        <div className={styles.navLinks}>
          <span className={styles.activeNav}>Overview</span>
          <Link href="/app/admin/users">People</Link>
          <Link href="/onboarding">Settings</Link>
          {canManagePlatform ? (
            <Link href="/app/platform">Platform</Link>
          ) : null}
        </div>
        <Link className={styles.exitLink} href="/app">
          Learning home
        </Link>
      </nav>

      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Owner overview</p>
          <h1>Your learning system, clearly.</h1>
          <p>
            A durable view of what is live, what is ready, and where your team
            needs attention—without fixture data or invented health signals.
          </p>
        </div>
        <div className={styles.identity}>
          <span>Current access</span>
          <strong>{roleLabel(context.identityRole ?? "")}</strong>
          <small>Selected tenant · {workspace.tenant.slug}</small>
        </div>
      </section>

      <section className={styles.metrics} aria-label="Learning library totals">
        <article>
          <span>Courses</span>
          <strong>{resolvedCourseCount.toLocaleString()}</strong>
          <small>
            {courseCount === null ? "Visible to this role" : "Durable records"}
          </small>
        </article>
        <article>
          <span>Published</span>
          <strong>{countLabel(publishedCourseCount)}</strong>
          <small>Available to learners</small>
        </article>
        <article>
          <span>Modules</span>
          <strong>{resolvedModuleCount.toLocaleString()}</strong>
          <small>
            {exactLearningStructure ? "Durable records" : "Visible structure"}
          </small>
        </article>
        <article>
          <span>Lessons</span>
          <strong>{resolvedLessonCount.toLocaleString()}</strong>
          <small>
            {exactLearningStructure ? "Durable records" : "Visible structure"}
          </small>
        </article>
      </section>

      <section className={styles.dashboard}>
        <article className={styles.readiness}>
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>Tenant readiness</p>
              <h2>
                {onboarding
                  ? onboarding.launch.ready
                    ? "Ready for launch review"
                    : "Launch gates remain"
                  : "Readiness is unavailable"}
              </h2>
            </div>
            <span
              data-ready={onboarding?.launch.ready === true}
              data-unavailable={onboarding === null}
            >
              {onboarding
                ? onboarding.launch.ready
                  ? "Ready"
                  : `${onboarding.launch.blockers.length} open`
                : "Not shown"}
            </span>
          </div>
          <p className={styles.sectionCopy}>
            {onboarding
              ? `${completedSteps} of ${onboarding.steps.length} durable setup steps are complete or not applicable.`
              : "The onboarding service did not return a tenant-safe snapshot. No local status was substituted."}
          </p>
          {onboarding?.launch.blockers.length ? (
            <ul className={styles.blockers}>
              {onboarding.launch.blockers.slice(0, 5).map((blocker) => (
                <li key={blocker}>{blocker.replaceAll("_", " ")}</li>
              ))}
            </ul>
          ) : null}
          <Link className={styles.textAction} href="/onboarding">
            Review setup and policy gates <span aria-hidden="true">→</span>
          </Link>
        </article>

        <article className={styles.knowledge}>
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>Grounded knowledge</p>
              <h2>Retrieval foundation</h2>
            </div>
            <span data-ready={chunkCount !== null}>
              {chunkCount === null ? "Restricted" : "Durable"}
            </span>
          </div>
          <div className={styles.knowledgeCounts}>
            <div>
              <strong>{countLabel(sourceCount)}</strong>
              <span>Sources</span>
            </div>
            <div>
              <strong>{countLabel(documentCount)}</strong>
              <span>Documents</span>
            </div>
            <div>
              <strong>{countLabel(chunkCount)}</strong>
              <span>Chunks</span>
            </div>
          </div>
          <p className={styles.boundaryNote}>
            Counts are queried through this signed-in tenant role. Restricted
            values stay hidden instead of falling back to sample data.
          </p>
        </article>
      </section>

      <section className={styles.actions} aria-label="Administration areas">
        <Link href="/app#courses">
          <span className={styles.actionIcon}>↗</span>
          <div>
            <p>Learning library</p>
            <h2>Shape courses and lessons</h2>
            <small>
              Review published learning, create drafts, upload sources, and
              move approved material live.
            </small>
          </div>
          <b aria-hidden="true">→</b>
        </Link>
        <Link href="/app/admin/users">
          <span className={styles.actionIcon}>◎</span>
          <div>
            <p>People and access</p>
            <h2>Manage the team</h2>
            <small>
              Create controlled accounts, issue one-time passwords, and see
              privacy-safe adoption totals.
            </small>
          </div>
          <b aria-hidden="true">→</b>
        </Link>
        <Link href="/app/conversation">
          <span className={styles.actionIcon}>✦</span>
          <div>
            <p>Conversation and voice</p>
            <h2>Test the learner experience</h2>
            <small>
              Ask a grounded question, inspect sources, or move into the same
              conversation by voice.
            </small>
          </div>
          <b aria-hidden="true">→</b>
        </Link>
        <Link href="/onboarding">
          <span className={styles.actionIcon}>◇</span>
          <div>
            <p>Workspace settings</p>
            <h2>Complete launch gates</h2>
            <small>
              Manage identity, brand, invitations, evidence, and human-owned
              privacy policy decisions.
            </small>
          </div>
          <b aria-hidden="true">→</b>
        </Link>
      </section>

      <footer className={styles.boundary}>
        <div>
          <span className={styles.boundaryDot} aria-hidden="true" />
          <strong>Durable tenant boundary</strong>
        </div>
        <p>
          This overview uses authenticated Supabase services and tenant-scoped
          database reads. It does not show fixture intelligence, infer policy
          approval, or expose provider credentials, learning content, prompts,
          passwords, or raw audio.
        </p>
        <Link href="/app/conversation?mode=voice">Open voice check</Link>
      </footer>
    </main>
  );
}

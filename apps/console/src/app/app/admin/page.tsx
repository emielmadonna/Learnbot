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

type PeopleSignal = {
  userId: string;
  name: string;
  role: string;
  status: string;
  progress: number | null;
  lessonsCompleted: number | null;
  lessonsTotal: number | null;
  courseTitle: string;
  questions: number;
  recentQuestion: string | null;
  lastActivityAt: string | null;
};

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

  const [{ data: profiles }, { data: memberships }, { data: progressRows }, { data: conversationRows }, { data: messageRows }] =
    await Promise.all([
      supabase
        .from("profiles")
        .select("user_id, display_name")
        .eq("tenant_id", context.tenantId)
        .is("deleted_at", null),
      supabase
        .from("memberships")
        .select("user_id, role_key, status")
        .eq("tenant_id", context.tenantId)
        .is("deleted_at", null),
      supabase
        .from("student_progress")
        .select("user_id, course_id, percent_complete, lessons_completed, lessons_total, last_activity_at")
        .eq("tenant_id", context.tenantId)
        .is("deleted_at", null)
        .order("last_activity_at", { ascending: false }),
      supabase
        .from("conversations")
        .select("conversation_id, subject_user_id, updated_at")
        .eq("tenant_id", context.tenantId)
        .is("deleted_at", null)
        .neq("status", "deleted")
        .order("updated_at", { ascending: false }),
      supabase
        .from("messages")
        .select("conversation_id, body, actor_type, created_at")
        .eq("tenant_id", context.tenantId)
        .is("deleted_at", null)
        .eq("actor_type", "student")
        .eq("status", "final")
        .order("created_at", { ascending: false }),
    ]);

  const profileByUser = new Map(
    (profiles ?? []).map((profile) => [
      profile.user_id as string,
      typeof profile.display_name === "string" && profile.display_name.trim()
        ? profile.display_name.trim()
        : "Unnamed learner",
    ]),
  );
  const membershipByUser = new Map(
    (memberships ?? []).map((membership) => [
      membership.user_id as string,
      { role: String(membership.role_key ?? "member"), status: String(membership.status ?? "active") },
    ]),
  );
  const progressByUser = new Map<string, Record<string, unknown>>();
  for (const progress of progressRows ?? []) {
    const userId = String(progress.user_id ?? "");
    if (userId && !progressByUser.has(userId)) progressByUser.set(userId, progress as Record<string, unknown>);
  }
  const questionCountByUser = new Map<string, number>();
  const questionByConversation = new Map<string, string>();
  const conversationOwnerById = new Map<string, string>();
  for (const conversation of conversationRows ?? []) {
    const conversationId = String(conversation.conversation_id ?? "");
    const userId = String(conversation.subject_user_id ?? "");
    if (conversationId && userId) conversationOwnerById.set(conversationId, userId);
  }
  for (const message of messageRows ?? []) {
    const conversationId = String(message.conversation_id ?? "");
    const userId = conversationOwnerById.get(conversationId);
    if (!userId) continue;
    questionCountByUser.set(userId, (questionCountByUser.get(userId) ?? 0) + 1);
    if (!questionByConversation.has(userId) && typeof message.body === "string" && message.body.trim()) {
      questionByConversation.set(userId, message.body.trim().replace(/\s+/gu, " ").slice(0, 160));
    }
  }
  const userIds = new Set<string>([
    ...Array.from(profileByUser.keys()),
    ...Array.from(membershipByUser.keys()),
    ...Array.from(progressByUser.keys()),
  ]);
  const peopleSignals: PeopleSignal[] = Array.from(userIds).map((userId) => {
    const progress = progressByUser.get(userId);
    const membership = membershipByUser.get(userId);
    const courseId = String(progress?.course_id ?? "");
    const course = workspace.courses.find((item) => item.courseId === courseId);
    return {
      userId,
      name: profileByUser.get(userId) ?? "Unnamed learner",
      role: roleLabel(membership?.role ?? "member"),
      status: membership?.status ?? "active",
      progress: typeof progress?.percent_complete === "number" ? progress.percent_complete : null,
      lessonsCompleted: typeof progress?.lessons_completed === "number" ? progress.lessons_completed : null,
      lessonsTotal: typeof progress?.lessons_total === "number" ? progress.lessons_total : null,
      courseTitle: course?.title ?? "No course activity yet",
      questions: questionCountByUser.get(userId) ?? 0,
      recentQuestion: questionByConversation.get(userId) ?? null,
      lastActivityAt: typeof progress?.last_activity_at === "string" ? progress.last_activity_at : null,
    };
  }).sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));

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
  const activePeopleCount = peopleSignals.filter((person) => person.status === "active").length;
  const trackedPeople = peopleSignals.filter((person) => person.progress !== null);
  const averageProgress = trackedPeople.length
    ? Math.round(trackedPeople.reduce((total, person) => total + (person.progress ?? 0), 0) / trackedPeople.length)
    : null;
  const completedPeopleCount = trackedPeople.filter((person) => (person.progress ?? 0) >= 100).length;
  const totalQuestions = peopleSignals.reduce((total, person) => total + person.questions, 0);
  const theme = {
    "--admin-primary": branding?.primaryColor ?? "#234f40",
    "--admin-accent": branding?.accentColor ?? "#d2a85f",
  } as CSSProperties;

  return (
    <main className={styles.shell} style={theme}>
      <nav className={styles.floatingNav} aria-label="Admin workspace">
        <Link className={styles.brand} href="/app">
          <span className={styles.brandMark}>E</span>
          <span>
            <b>{assistantName}</b>
            <small>{workspace.tenant.displayName}</small>
          </span>
        </Link>
        <div className={styles.navLinks}>
          <Link className={styles.activeNav} href="/app/admin" aria-current="page">
            Overview
          </Link>
          <Link href="/onboarding#client-access">Clients</Link>
          <Link href="/app#courses">Learning</Link>
          <Link href="#people-signals">Signals</Link>
          <Link href="/install/circle">Assistant</Link>
          <Link href="/onboarding">Settings</Link>
        </div>
        <Link className={styles.exitLink} href="/app">
          Learning home
        </Link>
      </nav>

      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Admin command center</p>
          <h1>Run every client’s learning workspace from one view.</h1>
          <p>
            Add clients, publish new learning, shape each assistant, and see the
            signals that tell you who needs help, who is ready to move up, and
            where the next opportunity is.
          </p>
        </div>
        <div className={styles.identity}>
          <span>Current access</span>
          <strong>{roleLabel(context.identityRole ?? "")}</strong>
          <small>Selected tenant · {workspace.tenant.slug}</small>
        </div>
      </section>

      <section className={styles.priorityGrid} aria-label="Primary admin actions">
        <Link className={styles.priorityCard} href="/onboarding#client-access" id="clients">
          <span className={styles.priorityNumber}>01</span>
          <div>
            <p>Clients</p>
            <h2>Add a client</h2>
            <small>Invite a client team, choose roles, and keep each workspace separate.</small>
          </div>
          <b aria-hidden="true">→</b>
        </Link>
        <Link className={styles.priorityCard} href="/app#add-learning">
          <span className={styles.priorityNumber}>02</span>
          <div>
            <p>Add learning</p>
            <h2>Build the next lesson</h2>
            <small>Create a draft or upload a source into the existing private learning flow.</small>
          </div>
          <b aria-hidden="true">→</b>
        </Link>
        <Link className={styles.priorityCard} href="/install/circle" id="bot-setup">
          <span className={styles.priorityNumber}>03</span>
          <div>
            <p>Configure assistant</p>
            <h2>Shape the assistant</h2>
            <small>Set the name, colors, voice, and client-facing workspace identity.</small>
          </div>
          <b aria-hidden="true">→</b>
        </Link>
        <Link className={styles.priorityCard} href="#people-signals" id="people">
          <span className={styles.priorityNumber}>04</span>
          <div>
            <p>People and signals</p>
            <h2>See who needs you next</h2>
            <small>Read progress, grounded questions, and follow-up opportunities by person.</small>
          </div>
          <b aria-hidden="true">→</b>
        </Link>
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

      <section className={styles.signalBoard} id="people-signals">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>People &amp; signals</p>
            <h2>See the whole person, then the next action.</h2>
          </div>
          <Link className={styles.textAction} href="/app/admin/users">
            Manage access <span aria-hidden="true">→</span>
          </Link>
        </div>
        {peopleSignals.length ? (
          <div className={styles.peopleGrid}>
            {peopleSignals.slice(0, 6).map((person) => (
              <Link className={styles.personCard} href="/app/admin/users" key={person.userId}>
                <span className={styles.personAvatar}>{person.name.split(/\s+/u).map((part) => part.slice(0, 1)).join("").slice(0, 2).toUpperCase()}</span>
                <div>
                  <strong>{person.name}</strong>
                  <small>{person.role} · {person.status}</small>
                </div>
                <span className={styles.personSignal}>{person.questions ? `${person.questions} learning ${person.questions === 1 ? "conversation" : "conversations"}` : "No questions recorded yet"}</span>
                {person.recentQuestion ? <span className={styles.personQuestion}>“{person.recentQuestion}”</span> : null}
                <span className={styles.personProgress}>{person.progress === null ? "—" : `${Math.round(person.progress)}%`}<small>{person.courseTitle}</small></span>
              </Link>
            ))}
          </div>
        ) : (
          <div className={styles.signalEmpty}>No learner activity has been recorded for this tenant yet. When people start learning, their progress and grounded questions will appear here.</div>
        )}
      </section>

      <section className={styles.analytics} aria-label="Learning analytics">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>Recorded signals</p>
            <h2>What the learning data says.</h2>
          </div>
          <span className={styles.analyticsSource}>Tenant-scoped · live records</span>
        </div>
        <div className={styles.analyticsGrid}>
          <article><span>Active people</span><strong>{activePeopleCount.toLocaleString()}</strong><small>Current tenant members</small></article>
          <article><span>Questions asked</span><strong>{totalQuestions.toLocaleString()}</strong><small>Student messages recorded</small></article>
          <article><span>Average progress</span><strong>{averageProgress === null ? "—" : `${averageProgress}%`}</strong><small>{trackedPeople.length ? `${completedPeopleCount} complete` : "No progress yet"}</small></article>
        </div>
        <div className={styles.momentumList}>
          <div className={styles.momentumHeader}><strong>Learning momentum by person</strong><span>Progress · grounded questions</span></div>
          {peopleSignals.slice(0, 6).map((person) => {
            const progress = Math.max(0, Math.min(100, person.progress ?? 0));
            return <div className={styles.momentumRow} key={`momentum-${person.userId}`}><span>{person.name}</span><div className={styles.momentumTrack}><span style={{ width: `${progress}%` }} /></div><strong>{person.progress === null ? "—" : `${Math.round(progress)}%`}</strong><small>{person.questions} Q</small></div>;
          })}
          {!peopleSignals.length ? <p className={styles.analyticsEmpty}>Progress and question signals will appear after the first learner activity.</p> : null}
        </div>
        <p className={styles.analyticsNote}>Question counts come from final student messages. Progress is read from tenant-scoped learning records; no completion or engagement is inferred when data is missing.</p>
      </section>

      <section className={styles.actions} id="learning-library" aria-label="Administration areas">
        <Link href="/app#courses">
          <span className={styles.actionIcon}>↗</span>
          <div>
            <p>Learning library</p>
            <h2>Open the whole learning library</h2>
            <small>
              Review courses, expand lessons, inspect grounded blocks, and see
              what is published or still private.
            </small>
          </div>
          <b aria-hidden="true">→</b>
        </Link>
        <Link href="/app#add-learning">
          <span className={styles.actionIcon}>＋</span>
          <div>
            <p>Add learning</p>
            <h2>Bring in a source in one step</h2>
            <small>
              Create a draft from notes or upload a PDF, text, Markdown, or
              Word source into private quarantine.
            </small>
          </div>
          <b aria-hidden="true">→</b>
        </Link>
        <Link href="/app/admin/users">
          <span className={styles.actionIcon}>◎</span>
          <div>
            <p>People and signals</p>
            <h2>Manage roles and access</h2>
            <small>
              Create controlled accounts, issue one-time passwords, and open
              the shared progress view without exposing raw private data.
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

import Link from "next/link";
import { redirect } from "next/navigation";
import type { CSSProperties } from "react";
import {
  getCurrentTenantContext,
  requireVerifiedUser,
} from "../../../lib/supabase/auth-boundary";
import { getLearningWorkspace } from "../../../lib/supabase/learning-rpc";
import { createServerSupabaseClient } from "../../../lib/supabase/server";
import styles from "./teacher.module.css";

type TeacherSignal = {
  userId: string;
  name: string;
  progress: number | null;
  courseTitle: string;
  questions: number;
  recentQuestion: string | null;
  lastActivityAt: string | null;
  signal: string;
};

type QuestionSignal = {
  userId: string;
  name: string;
  courseTitle: string;
  body: string;
  createdAt: string;
};

function roleLabel(role: string) {
  return role.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function initials(name: string) {
  return name
    .split(/\s+/u)
    .map((part) => part.slice(0, 1))
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function signalFor(progress: number | null, questions: number) {
  if (progress !== null && progress >= 80) return "Ready to advance";
  if (questions >= 3) return "Deep inquiry";
  if (progress !== null && progress < 25 && questions > 0) return "Needs clarity";
  return "Building momentum";
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Recent activity"
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default async function TeacherWorkspacePage() {
  let supabase;
  try {
    supabase = await createServerSupabaseClient();
    await requireVerifiedUser(supabase);
  } catch {
    redirect("/auth/sign-in?error=authentication_required&next=/app/teacher");
  }

  const context = await getCurrentTenantContext(supabase);
  if (!context.selected || !context.tenantId) redirect("/onboarding");
  if (!["creator", "teacher"].includes(context.identityRole ?? "")) {
    redirect("/app/entry");
  }

  let workspace;
  try {
    workspace = await getLearningWorkspace(supabase);
  } catch {
    redirect("/onboarding?error=selection_failed");
  }

  const [{ data: profiles }, { data: progressRows }, { data: conversationRows }, { data: messageRows }] =
    await Promise.all([
      supabase
        .from("profiles")
        .select("user_id, display_name")
        .eq("tenant_id", context.tenantId)
        .is("deleted_at", null),
      supabase
        .from("student_progress")
        .select("user_id, course_id, percent_complete, last_activity_at")
        .eq("tenant_id", context.tenantId)
        .is("deleted_at", null)
        .order("last_activity_at", { ascending: false }),
      supabase
        .from("conversations")
        .select("conversation_id, subject_user_id")
        .eq("tenant_id", context.tenantId)
        .is("deleted_at", null)
        .neq("status", "deleted"),
      supabase
        .from("messages")
        .select("conversation_id, body, created_at")
        .eq("tenant_id", context.tenantId)
        .is("deleted_at", null)
        .eq("actor_type", "student")
        .eq("status", "final")
        .order("created_at", { ascending: false }),
    ]);

  const profileByUser = new Map(
    (profiles ?? []).map((profile) => [
      String(profile.user_id),
      typeof profile.display_name === "string" && profile.display_name.trim()
        ? profile.display_name.trim()
        : "Unnamed learner",
    ]),
  );
  const progressByUser = new Map<string, Record<string, unknown>>();
  for (const progress of progressRows ?? []) {
    const userId = String(progress.user_id ?? "");
    if (userId && !progressByUser.has(userId)) {
      progressByUser.set(userId, progress as Record<string, unknown>);
    }
  }
  const conversationOwnerById = new Map<string, string>();
  for (const conversation of conversationRows ?? []) {
    const conversationId = String(conversation.conversation_id ?? "");
    const userId = String(conversation.subject_user_id ?? "");
    if (conversationId && userId) conversationOwnerById.set(conversationId, userId);
  }
  const questionCountByUser = new Map<string, number>();
  const recentQuestionByUser = new Map<string, string>();
  const latestQuestionAtByUser = new Map<string, string>();
  const questions: QuestionSignal[] = [];
  for (const message of messageRows ?? []) {
    const conversationId = String(message.conversation_id ?? "");
    const userId = conversationOwnerById.get(conversationId);
    const body = typeof message.body === "string" ? message.body.trim() : "";
    if (!userId || !body) continue;
    questionCountByUser.set(userId, (questionCountByUser.get(userId) ?? 0) + 1);
    if (!recentQuestionByUser.has(userId)) recentQuestionByUser.set(userId, body);
    if (!latestQuestionAtByUser.has(userId) && typeof message.created_at === "string") {
      latestQuestionAtByUser.set(userId, message.created_at);
    }
    if (questions.length < 6) {
      const progress = progressByUser.get(userId);
      const course = workspace.courses.find(
        (item) => item.courseId === String(progress?.course_id ?? ""),
      );
      questions.push({
        userId,
        name: profileByUser.get(userId) ?? "Unnamed learner",
        courseTitle: course?.title ?? workspace.courses[0]?.title ?? "Course conversation",
        body: body.replace(/\s+/gu, " ").slice(0, 220),
        createdAt: String(message.created_at ?? ""),
      });
    }
  }

  const userIds = new Set<string>([
    ...Array.from(profileByUser.keys()),
    ...Array.from(progressByUser.keys()),
    ...Array.from(questionCountByUser.keys()),
  ]);
  const signals: TeacherSignal[] = Array.from(userIds)
    .map((userId) => {
      const progress = progressByUser.get(userId);
      const progressValue =
        typeof progress?.percent_complete === "number" ? progress.percent_complete : null;
      const course = workspace.courses.find(
        (item) => item.courseId === String(progress?.course_id ?? ""),
      );
      const questionsAsked = questionCountByUser.get(userId) ?? 0;
      const progressActivity =
        typeof progress?.last_activity_at === "string" ? progress.last_activity_at : null;
      const questionActivity = latestQuestionAtByUser.get(userId) ?? null;
      return {
        userId,
        name: profileByUser.get(userId) ?? "Unnamed learner",
        progress: progressValue,
        courseTitle: course?.title ?? workspace.courses[0]?.title ?? "No course activity yet",
        questions: questionsAsked,
        recentQuestion: recentQuestionByUser.get(userId) ?? null,
        lastActivityAt:
          progressActivity && questionActivity
            ? progressActivity > questionActivity
              ? progressActivity
              : questionActivity
            : progressActivity ?? questionActivity,
        signal: signalFor(progressValue, questionsAsked),
      };
    })
    .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));

  const tracked = signals.filter((item) => item.progress !== null);
  const averageProgress = tracked.length
    ? Math.round(tracked.reduce((total, item) => total + (item.progress ?? 0), 0) / tracked.length)
    : null;
  const deepInquiryCount = signals.filter((item) => item.signal === "Deep inquiry").length;
  const firstCourse = workspace.courses[0];
  const brand = workspace.branding;
  const theme = {
    "--teacher-primary": brand?.primaryColor ?? "#164b70",
    "--teacher-accent": brand?.accentColor ?? "#caff5c",
  } as CSSProperties;

  return (
    <main className={styles.shell} style={theme}>
      <header className={styles.topbar}>
        <Link className={styles.brand} href="/app/teacher">
          <span className={styles.brandMark}>{(brand?.assistantName ?? "L").slice(0, 1)}</span>
          <span>
            <b>{brand?.assistantName ?? "LearningBot"}</b>
            <small>{workspace.tenant.displayName}</small>
          </span>
        </Link>
        <nav className={styles.nav} aria-label="Teacher workspace">
          <a className={styles.activeNav} href="#overview">Overview</a>
          <a href="#signals">Learners</a>
          <a href="#questions">Questions</a>
          <Link href="/app#courses">Course</Link>
          <Link href="/app/conversation">Assistant</Link>
          <a href="/dev/widget">Widget / snippet</a>
        </nav>
        <div className={styles.account}>
          <Link href="/app/conversation?mode=voice">Voice</Link>
          <Link href="/onboarding" aria-label="Account">{roleLabel(context.identityRole ?? "teacher").slice(0, 2).toUpperCase()}</Link>
        </div>
      </header>

      <section className={styles.hero} id="overview">
        <div>
          <p className={styles.eyebrow}>Teacher command center</p>
          <h1>See what your course is teaching people.</h1>
          <p>
            Read the questions behind the progress, spot who is ready for the
            next level, and improve the course from the same place you manage
            the learner experience.
          </p>
        </div>
        <div className={styles.contextCard}>
          <span>Teaching now</span>
          <strong>{firstCourse?.title ?? "No course published yet"}</strong>
          <small>{workspace.courses.length} course{workspace.courses.length === 1 ? "" : "s"} · {workspace.tenant.displayName}</small>
        </div>
      </section>

      <section className={styles.quickGrid} aria-label="Primary teacher actions">
        <a className={styles.quickCard} href="#signals">
          <span>01</span><div><p>Learners</p><h2>Review learners</h2><small>See momentum, progress, and who is ready for the next level.</small></div><b>→</b>
        </a>
        <a className={styles.quickCard} href="#questions">
          <span>02</span><div><p>Questions</p><h2>Triage questions</h2><small>Use real learner questions to spot where the course needs clarity.</small></div><b>→</b>
        </a>
        <Link className={styles.quickCard} href="/app#courses">
          <span>03</span><div><p>Course</p><h2>Edit the course</h2><small>Open lessons, add learning, and publish a clearer next version.</small></div><b>→</b>
        </Link>
        <Link className={styles.quickCard} href="/app/conversation">
          <span>04</span><div><p>Assistant</p><h2>Test the experience</h2><small>Ask the same grounded assistant your learners use, by text or voice.</small></div><b>→</b>
        </Link>
      </section>

      <section className={styles.metrics} aria-label="Teacher metrics">
        <article><span>Active learners</span><strong>{signals.length}</strong><small>People with a tenant record</small></article>
        <article><span>Questions asked</span><strong>{Array.from(questionCountByUser.values()).reduce((total, count) => total + count, 0)}</strong><small>Final learner messages</small></article>
        <article><span>Average progress</span><strong>{averageProgress === null ? "—" : `${averageProgress}%`}</strong><small>Only tracked learning</small></article>
        <article><span>Deep inquiry</span><strong>{deepInquiryCount}</strong><small>People asking 3+ questions</small></article>
      </section>

      <section className={styles.coursePanel} id="course">
        <div className={styles.sectionHeading}>
          <div><p className={styles.eyebrow}>Course health</p><h2>Your learning library</h2></div>
          <Link className={styles.textAction} href="/app#courses">Open course workspace <span>→</span></Link>
        </div>
        <div className={styles.courseGrid}>
          {workspace.courses.length ? workspace.courses.map((course) => (
            <article className={styles.courseCard} key={course.courseId}>
              <div><span>{course.status}</span><h3>{course.title}</h3><p>{course.description ?? "No course description yet."}</p></div>
              <strong>{Math.round(course.progress.percentComplete)}%</strong>
              <div className={styles.progressTrack}><span style={{ width: `${Math.max(0, Math.min(100, course.progress.percentComplete))}%` }} /></div>
              <small>{course.modules.length} modules · {course.progress.lessonsCompleted} of {course.progress.lessonsTotal} lessons complete</small>
            </article>
          )) : (
            <div className={styles.empty}><h3>No course is live yet.</h3><p>Add the first course and this view will start showing real learner signals.</p><Link href="/app#create-course">Add the first course →</Link></div>
          )}
        </div>
      </section>

      <section className={styles.signalPanel} id="signals">
        <div className={styles.sectionHeading}>
          <div><p className={styles.eyebrow}>Learner signals</p><h2>Who needs your attention next?</h2></div>
          <span className={styles.liveBadge}>Progress + final questions</span>
        </div>
        {signals.length ? (
          <div className={styles.signalGrid}>
            {signals.slice(0, 8).map((signal) => (
              <article className={styles.signalCard} key={signal.userId}>
                <div className={styles.signalTop}><span className={styles.avatar}>{initials(signal.name)}</span><div><strong>{signal.name}</strong><small>{signal.courseTitle}</small></div><span className={styles.signalTag} data-signal={signal.signal}>{signal.signal}</span></div>
                <p>{signal.recentQuestion ? `“${signal.recentQuestion.replace(/\s+/gu, " ").slice(0, 150)}”` : "No question has been recorded yet."}</p>
                <footer><span>{signal.progress === null ? "No progress yet" : `${Math.round(signal.progress)}% complete`}</span><span>{signal.questions} question{signal.questions === 1 ? "" : "s"}</span><span>{signal.lastActivityAt ? formatDate(signal.lastActivityAt) : "No activity date"}</span></footer>
              </article>
            ))}
          </div>
        ) : <div className={styles.empty}>Learner signals will appear as people start learning and asking questions.</div>}
      </section>

      <section className={styles.questionsPanel} id="questions">
        <div className={styles.sectionHeading}>
          <div><p className={styles.eyebrow}>Question inbox</p><h2>Teach from the questions people actually ask.</h2></div>
          <Link className={styles.textAction} href="/app/conversation">Open learner preview <span>→</span></Link>
        </div>
        {questions.length ? (
          <div className={styles.questionList}>
            {questions.map((question, index) => (
              <article key={`${question.userId}-${question.createdAt}-${index}`}><span className={styles.questionNumber}>{String(index + 1).padStart(2, "0")}</span><div><p>“{question.body}”</p><small>{question.name} · {question.courseTitle} · {formatDate(question.createdAt)}</small></div><Link href="/app#courses">Improve lesson →</Link></article>
            ))}
          </div>
        ) : <div className={styles.empty}>There are no learner questions yet. Start a preview conversation to see the experience yourself.</div>}
      </section>

      <section className={styles.footerActions} aria-label="Teacher tools">
        <Link href="/app#create-course"><span>＋</span><div><b>Add learning</b><small>Write or import the next lesson.</small></div></Link>
        <Link href="/onboarding#brand"><span>◌</span><div><b>Brand the assistant</b><small>Update its identity, colors, and learner-facing setup.</small></div></Link>
        <Link href="/dev/widget"><span>⌘</span><div><b>Install the widget</b><small>Open the existing preview and embed snippet flow.</small></div></Link>
      </section>
    </main>
  );
}

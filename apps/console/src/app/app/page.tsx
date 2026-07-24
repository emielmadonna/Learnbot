import Link from "next/link";
import { redirect } from "next/navigation";
import type { CSSProperties } from "react";
import {
  getCurrentTenantContext,
  requireVerifiedUser,
} from "../../lib/supabase/auth-boundary";
import {
  getLearningWorkspace,
  type LearningBlock,
} from "../../lib/supabase/learning-rpc";
import { createServerSupabaseClient } from "../../lib/supabase/server";
import styles from "./workspace.module.css";
import UploadLearning from "./upload-learning";
import { UsageSignal } from "./usage-signal";

const statusMessages: Record<string, string> = {
  course_created: "Draft created. Review it below, then publish when ready.",
  course_published: "Course published. Learners can now open it.",
  progress_saved: "Progress saved.",
};

const errorMessages: Record<string, string> = {
  request_failed: "That request could not be completed. Nothing was changed.",
  access_denied: "Your current role cannot perform that action.",
  invalid_request: "Check the values and try again.",
};

function blockText(block: LearningBlock) {
  const text = block.content.text;
  if (typeof text === "string") return text;
  const markdown = block.content.markdown;
  if (typeof markdown === "string") return markdown;
  const html = block.content.html;
  if (typeof html === "string") {
    return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
  return "This content block is available but does not have a text preview.";
}

function percent(value: number) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

export default async function AuthenticatedAppPage({
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
          <span className={styles.logo}>E</span>
          <h1>Production access is not configured.</h1>
          <p>Supabase configuration is missing. Access remains closed.</p>
        </section>
      </main>
    );
  }

  try {
    await requireVerifiedUser(supabase);
  } catch {
    redirect("/auth/sign-in?error=authentication_required&next=/app");
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
  const status =
    typeof parameters.status === "string" ? parameters.status : "";
  const error = typeof parameters.error === "string" ? parameters.error : "";
  const brand = workspace.branding;
  const assistantName = brand?.assistantName ?? "Estie";
  const theme = {
    "--brand-primary": brand?.primaryColor ?? "#234f40",
    "--brand-accent": brand?.accentColor ?? "#d2a85f",
    "--brand-surface": brand?.surfaceColor ?? "#f5f4ef",
    "--brand-text": brand?.textColor ?? "#14231d",
  } as CSSProperties;
  const firstCourse = workspace.courses[0];
  const firstLesson = firstCourse?.modules
    .flatMap((module) => module.lessons)
    .find((lesson) => lesson.progressState !== "completed");

  return (
    <main className={styles.shell} style={theme}>
      <UsageSignal eventName="learning.workspace_opened" />
      <aside className={styles.rail}>
        <Link className={styles.brand} href="/app">
          <span className={styles.logo}>E</span>
          <span>
            <b>{assistantName}</b>
            <small>{workspace.tenant.displayName}</small>
          </span>
        </Link>
        <nav aria-label="Learning workspace">
          <a className={styles.activeNav} href="#today">
            <span>⌂</span> Today
          </a>
          <a href="#courses">
            <span>◫</span> My learning
          </a>
          {workspace.identity.canAuthor ? (
            <a href="#create-course">
              <span>＋</span> Add learning
            </a>
          ) : null}
          {["tenant_owner", "tenant_admin"].includes(
            workspace.identity.role,
          ) ? (
            <Link href="/app/admin/users">
              <span>◉</span> People & access
            </Link>
          ) : null}
          <Link href="/onboarding">
            <span>◎</span> Workspace
          </Link>
        </nav>
        <div className={styles.railFooter}>
          <Link className={styles.askButton} href="/app/conversation">
            <span className={styles.orb} aria-hidden="true" />
            <span>
              <b>Ask {assistantName}</b>
              <small>Text or voice</small>
            </span>
            <span aria-hidden="true">⌁</span>
          </Link>
          <form action="/auth/sign-out" method="post">
            <button type="submit">Sign out</button>
          </form>
        </div>
      </aside>

      <section className={styles.content}>
        <header className={styles.topbar}>
          <div>
            <p>Learning workspace</p>
            <strong>{workspace.tenant.displayName}</strong>
          </div>
          <div className={styles.topActions}>
            {workspace.identity.canAuthor ? (
              <a className={styles.addButton} href="#create-course">
                <span aria-hidden="true">＋</span> Add learning
              </a>
            ) : null}
            <Link
              className={styles.voiceButton}
              href="/app/conversation?mode=voice"
            >
              <span aria-hidden="true">●</span> Start voice
            </Link>
            <Link className={styles.avatar} href="/onboarding" aria-label="Account">
              {workspace.identity.role.slice(0, 2).toUpperCase()}
            </Link>
          </div>
        </header>

        <div className={styles.body}>
          {statusMessages[status] ? (
            <p className={styles.success} role="status">
              {statusMessages[status]}
            </p>
          ) : null}
          {errorMessages[error] ? (
            <p className={styles.error} role="alert">
              {errorMessages[error]}
            </p>
          ) : null}

          <section className={styles.hero} id="today">
            <div>
              <p className={styles.eyebrow}>Your next step</p>
              <h1>
                {firstLesson
                  ? `Continue with ${firstLesson.title}`
                  : firstCourse
                    ? "You’re all caught up."
                    : "Build the first learning journey."}
              </h1>
              <p>
                {firstCourse?.description ??
                  `${assistantName} is ready for real course material. Add the first lesson or import Estie’s existing library.`}
              </p>
              <div className={styles.heroActions}>
                {firstLesson ? (
                  <a className={styles.primaryAction} href={`#${firstLesson.lessonId}`}>
                    Continue lesson <span aria-hidden="true">→</span>
                  </a>
                ) : workspace.identity.canAuthor ? (
                  <a className={styles.primaryAction} href="#create-course">
                    Add learning <span aria-hidden="true">→</span>
                  </a>
                ) : (
                  <Link className={styles.primaryAction} href="/app/conversation">
                    Ask {assistantName} <span aria-hidden="true">→</span>
                  </Link>
                )}
                <Link className={styles.secondaryAction} href="/app/conversation">
                  <span className={styles.miniOrb} aria-hidden="true" />
                  Ask a question
                </Link>
              </div>
            </div>
            <div className={styles.heroProgress}>
              <div>
                <span>
                  {firstCourse ? `${Math.round(percent(firstCourse.progress.percentComplete))}%` : "—"}
                </span>
                <small>Course progress</small>
              </div>
              <div className={styles.progressTrack}>
                <span
                  style={{
                    width: `${firstCourse ? percent(firstCourse.progress.percentComplete) : 0}%`,
                  }}
                />
              </div>
              <p>
                {firstCourse
                  ? `${firstCourse.progress.lessonsCompleted} of ${firstCourse.progress.lessonsTotal} lessons complete`
                  : "No published lessons yet"}
              </p>
            </div>
          </section>

          <section className={styles.courseSection} id="courses">
            <div className={styles.sectionTitle}>
              <div>
                <p className={styles.eyebrow}>My learning</p>
                <h2>Courses</h2>
              </div>
              <span>{workspace.courses.length} available</span>
            </div>

            {workspace.courses.length === 0 ? (
              <div className={styles.empty}>
                <span className={styles.emptyMark}>◎</span>
                <h3>No course has been added yet.</h3>
                <p>
                  Your workspace is ready. Add the first lesson to begin a
                  learning journey.
                </p>
                {workspace.identity.canAuthor ? (
                  <a href="#create-course">Create the first course</a>
                ) : null}
              </div>
            ) : (
              <div className={styles.courseList}>
                {workspace.courses.map((course) => (
                  <article className={styles.courseCard} key={course.courseId}>
                    <header>
                      <div>
                        <span className={styles.courseStatus}>{course.status}</span>
                        <h3>{course.title}</h3>
                        <p>{course.description}</p>
                      </div>
                      <strong>{Math.round(percent(course.progress.percentComplete))}%</strong>
                    </header>
                    <div className={styles.progressTrack}>
                      <span
                        style={{
                          width: `${percent(course.progress.percentComplete)}%`,
                        }}
                      />
                    </div>
                    <div className={styles.moduleList}>
                      {course.modules.map((module) => (
                        <section key={module.moduleId}>
                          <h4>{module.title}</h4>
                          {module.lessons.map((lesson) => (
                            <details
                              className={styles.lesson}
                              id={lesson.lessonId}
                              key={lesson.lessonId}
                            >
                              <summary>
                                <span
                                  className={styles.completion}
                                  data-complete={lesson.progressState === "completed"}
                                >
                                  {lesson.progressState === "completed" ? "✓" : lesson.position + 1}
                                </span>
                                <span>
                                  <b>{lesson.title}</b>
                                  <small>
                                    {lesson.blocks.length} learning{" "}
                                    {lesson.blocks.length === 1 ? "block" : "blocks"}
                                  </small>
                                </span>
                                <span aria-hidden="true">⌄</span>
                              </summary>
                              <div className={styles.lessonBody}>
                                {lesson.blocks.map((block) => (
                                  <div key={block.contentBlockId}>
                                    <p>{blockText(block)}</p>
                                  </div>
                                ))}
                                <div className={styles.lessonActions}>
                                  <form action="/app/progress" method="post">
                                    <input
                                      name="lessonId"
                                      type="hidden"
                                      value={lesson.lessonId}
                                    />
                                    <input
                                      name="state"
                                      type="hidden"
                                      value={
                                        lesson.progressState === "completed"
                                          ? "in_progress"
                                          : "completed"
                                      }
                                    />
                                    <button type="submit">
                                      {lesson.progressState === "completed"
                                        ? "Mark in progress"
                                        : "Mark complete"}
                                    </button>
                                  </form>
                                  <Link
                                    href={`/app/conversation?courseId=${course.courseId}&lessonId=${lesson.lessonId}`}
                                  >
                                    Ask {assistantName} about this
                                  </Link>
                                </div>
                              </div>
                            </details>
                          ))}
                        </section>
                      ))}
                    </div>
                    {workspace.identity.canAuthor && course.status !== "published" ? (
                      <form
                        className={styles.publish}
                        action="/app/course/publish"
                        method="post"
                      >
                        <input name="courseId" type="hidden" value={course.courseId} />
                        <button type="submit">Publish course</button>
                        <span>Publishes every current module and lesson.</span>
                      </form>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </section>

          {workspace.identity.canAuthor ? (
            <section className={styles.createSection} id="create-course">
              <div className={styles.sectionTitle}>
                <div>
                  <p className={styles.eyebrow}>Course creator</p>
                  <h2>Add learning</h2>
                </div>
                <span>Private draft</span>
              </div>
              <form action="/app/course/create" method="post">
                <label>
                  <span>Course title</span>
                  <input
                    name="title"
                    minLength={3}
                    maxLength={160}
                    placeholder="Marketing Magic"
                    required
                  />
                </label>
                <label>
                  <span>What learners will be able to do</span>
                  <textarea
                    name="description"
                    minLength={3}
                    maxLength={2000}
                    placeholder="A concise outcome-focused description."
                    required
                  />
                </label>
                <div className={styles.formGrid}>
                  <label>
                    <span>First module</span>
                    <input
                      name="moduleTitle"
                      minLength={3}
                      maxLength={160}
                      placeholder="Build your foundation"
                      required
                    />
                  </label>
                  <label>
                    <span>First lesson</span>
                    <input
                      name="lessonTitle"
                      minLength={3}
                      maxLength={160}
                      placeholder="Start with your vision"
                      required
                    />
                  </label>
                </div>
                <label>
                  <span>Lesson content</span>
                  <textarea
                    className={styles.editor}
                    name="lessonContent"
                    minLength={20}
                    maxLength={50000}
                    placeholder="Paste or write the first lesson. It stays a draft until you publish."
                    required
                  />
                </label>
                <footer>
                  <p>
                    Saved privately to this workspace. Publish when it is ready
                    for learners.
                  </p>
                  <button type="submit">Create draft</button>
                </footer>
              </form>
              <div className={styles.uploadSection}>
                <div>
                  <p className={styles.eyebrow}>Secure import</p>
                  <h3>Upload an existing source</h3>
                  <p>
                    The file is signed directly into this tenant’s private
                    quarantine. It cannot become learning until the security
                    and extraction pipeline clears it.
                  </p>
                </div>
                <UploadLearning
                  courses={workspace.courses.map((course) => ({
                    courseId: course.courseId,
                    title: course.title,
                  }))}
                />
              </div>
            </section>
          ) : null}
        </div>
      </section>

      <Link
        className={styles.mobileAssistant}
        href="/app/conversation"
        aria-label={`Ask ${assistantName} by text or voice`}
      >
        <span className={styles.orb} aria-hidden="true" />
        <b>Ask {assistantName}</b>
        <span aria-hidden="true">⌁</span>
      </Link>
    </main>
  );
}

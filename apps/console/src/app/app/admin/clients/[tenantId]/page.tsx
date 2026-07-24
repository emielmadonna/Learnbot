import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { requireVerifiedUser } from "../../../../../lib/supabase/auth-boundary";
import {
  getPlatformClientDetail,
  isTenantId,
} from "../../../../../lib/supabase/platform-admin-rpc";
import { createServerSupabaseClient } from "../../../../../lib/supabase/server";
import styles from "../clients.module.css";

function roleLabel(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function signalLabel(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function dateLabel(value: string | null) {
  if (!value) return "No activity";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Recent activity" : date.toLocaleDateString();
}

function surfaceHref(path: string, tenantId: string) {
  return `${path}?tenantId=${encodeURIComponent(tenantId)}`;
}

export default async function PlatformClientDetailPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  if (!isTenantId(tenantId)) notFound();

  let supabase;
  try {
    supabase = await createServerSupabaseClient();
    await requireVerifiedUser(supabase);
  } catch {
    redirect(`/auth/sign-in?error=authentication_required&next=/app/admin/clients/${tenantId}`);
  }

  const authorization = await supabase.rpc("platform_admin_is_authorized");
  if (authorization.error || authorization.data !== true) redirect("/app/admin");

  const detail = await getPlatformClientDetail(supabase, tenantId);
  if (!detail || detail.client.tenantId !== tenantId) notFound();

  const { client, counts } = detail;

  return (
    <main className={styles.shell}>
      <header className={styles.topbar}>
        <Link className={styles.brand} href="/app/admin/clients">
          <span className={styles.brandMark}>L</span>
          <span><b>LearningBot</b><small>Platform control</small></span>
        </Link>
        <nav aria-label="Platform administration">
          <Link href="/app/platform">Overview</Link>
          <Link className={styles.active} href="/app/admin/clients" aria-current="page">Clients</Link>
        </nav>
        <Link className={styles.backLink} href="/app/admin/clients">All clients</Link>
      </header>

      <section className={styles.canvas}>
        <div className={styles.detailIntro}>
          <div>
            <Link className={styles.backAction} href="/app/admin/clients">← All clients</Link>
            <p className={styles.eyebrow}>Client workspace</p>
            <h1>{client.displayName}</h1>
            <p>{client.assistantName} · {client.slug}{client.region ? ` · ${client.region}` : ""}</p>
          </div>
          <span className={styles.statusPill} data-status={client.status}>{client.status}</span>
        </div>

        <section className={styles.actionGrid} aria-label="Client workspace links">
          <Link href={surfaceHref("/app/conversation", tenantId)}><span>Test chat</span><small>Open the learner conversation</small><b aria-hidden="true">↗</b></Link>
          <Link href={surfaceHref("/app", tenantId)}><span>Learning</span><small>Open the client learning home</small><b aria-hidden="true">↗</b></Link>
          <Link href={surfaceHref("/onboarding", tenantId)}><span>Configure</span><small>Review workspace setup</small><b aria-hidden="true">↗</b></Link>
          <Link href={surfaceHref("/install/circle", tenantId)}><span>Circle install</span><small>Open the client launcher setup</small><b aria-hidden="true">↗</b></Link>
        </section>
        <p className={styles.actionNote}>These links preserve the client id in the URL and require the signed-in account to hold an active membership for that client surface.</p>

        <section className={styles.operationsGrid} aria-label="Client operating configuration">
          <article className={styles.configPanel} style={{ background: detail.branding.surfaceColor, color: detail.branding.textColor }}>
            <p className={styles.eyebrow}>Branding</p>
            <h2>{detail.branding.assistantName}</h2>
            <p className={styles.configCopy}>Client-facing assistant identity and presentation.</p>
            <div className={styles.colorRow} aria-label="Brand colors">
              <span title={`Primary ${detail.branding.primaryColor}`} style={{ background: detail.branding.primaryColor }} />
              <span title={`Accent ${detail.branding.accentColor}`} style={{ background: detail.branding.accentColor }} />
              <span title={`Text ${detail.branding.textColor}`} style={{ background: detail.branding.textColor }} />
              <small>Icon · {detail.branding.iconKey}</small>
            </div>
          </article>
          <article className={styles.configPanel}>
            <p className={styles.eyebrow}>Provider &amp; voice</p>
            <h2>{detail.providerVoice.provider}</h2>
            <div className={styles.configRows}>
              <span>Model <b>{detail.providerVoice.model}</b></span>
              <span>Voice <b>{detail.providerVoice.voiceId} · {detail.providerVoice.voiceEnabled ? "enabled" : "off"}</b></span>
              <span>Credentials <b>{detail.providerVoice.credentials.replaceAll("_", " ")}</b></span>
            </div>
          </article>
          <article className={styles.configPanel}>
            <p className={styles.eyebrow}>Feature availability</p>
            <h2>Tenant gates</h2>
            <div className={styles.featureList}>
              {Object.entries(detail.features).map(([feature, enabled]) => <span data-enabled={enabled} key={feature}><i aria-hidden="true" />{feature.replaceAll(/([A-Z])/gu, " $1")}</span>)}
            </div>
          </article>
        </section>

        <section className={styles.metrics} aria-label="Client counts">
          <article><span>Courses</span><strong>{counts.courses}</strong><small>{counts.publishedCourses} published</small></article>
          <article><span>Knowledge</span><strong>{counts.knowledgeChunks.toLocaleString()}</strong><small>{counts.documents} documents</small></article>
          <article><span>Sources</span><strong>{counts.sources}</strong><small>Durable source records</small></article>
          <article><span>People</span><strong>{counts.people}</strong><small>{counts.activePeople} active</small></article>
          <article><span>Questions</span><strong>{counts.questions}</strong><small>Final student messages</small></article>
        </section>

        <section className={styles.detailGrid}>
          <article className={styles.panel}>
            <div className={styles.panelHeading}><div><p className={styles.eyebrow}>Learning library</p><h2>Courses</h2></div><span>{counts.modules} modules · {counts.lessons} lessons</span></div>
            {detail.courses.length ? <div className={styles.courseList}>{detail.courses.map((course) => <div className={styles.courseRow} key={course.courseId}><div><strong>{course.title}</strong><small>{course.status} · updated {dateLabel(course.updatedAt)}</small></div><span>{course.modules} modules<br />{course.lessons} lessons · {course.sources} sources</span></div>)}</div> : <p className={styles.muted}>No course records have been returned for this client.</p>}
          </article>

          <article className={styles.panel}>
            <div className={styles.panelHeading}><div><p className={styles.eyebrow}>Signals</p><h2>People and questions</h2></div><span>{counts.questions} questions</span></div>
            {detail.people.length ? <div className={styles.peopleList}>{detail.people.map((person) => <div className={styles.personRow} key={person.personId}><div><strong>{person.name}</strong><small>{roleLabel(person.role)} · {person.status}</small></div><span className={styles.signal} data-signal={person.signal}>{signalLabel(person.signal)}</span><b>{person.percentComplete === null ? "—" : `${Math.round(person.percentComplete)}%`}<small>{person.questions} Q · {dateLabel(person.lastActivityAt)}</small></b></div>)}</div> : <p className={styles.muted}>No people records have been returned for this client.</p>}
            <p className={styles.panelNote}>Signals are derived from durable progress and question counts. Message text and source contents are not exposed in platform administration.</p>
          </article>
        </section>
      </section>
    </main>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";

import { requireVerifiedUser } from "../../../lib/supabase/auth-boundary";
import { createServerSupabaseClient } from "../../../lib/supabase/server";
import styles from "./platform.module.css";

type TenantSummary = {
  tenantId: string;
  slug: string;
  displayName: string;
  status: string;
  region: string | null;
  assistantName: string;
  courses: number;
  publishedCourses: number;
  members: number;
  sources: number;
  knowledgeChunks: number;
  updatedAt: string;
};

type PlatformOverview = {
  ok: true;
  dataMode: "durable";
  generatedAt: string;
  totals: {
    tenants: number;
    activeTenants: number;
    courses: number;
    members: number;
    sources: number;
    knowledgeChunks: number;
  };
  tenants: TenantSummary[];
};

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseOverview(value: unknown): PlatformOverview | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (source.ok !== true || source.dataMode !== "durable") return null;
  const totals =
    source.totals && typeof source.totals === "object"
      ? (source.totals as Record<string, unknown>)
      : {};
  const tenants = Array.isArray(source.tenants) ? source.tenants : [];
  return {
    ok: true,
    dataMode: "durable",
    generatedAt:
      typeof source.generatedAt === "string"
        ? source.generatedAt
        : new Date().toISOString(),
    totals: {
      tenants: number(totals.tenants),
      activeTenants: number(totals.activeTenants),
      courses: number(totals.courses),
      members: number(totals.members),
      sources: number(totals.sources),
      knowledgeChunks: number(totals.knowledgeChunks),
    },
    tenants: tenants
      .filter(
        (tenant): tenant is Record<string, unknown> =>
          Boolean(tenant && typeof tenant === "object"),
      )
      .map((tenant) => ({
        tenantId: String(tenant.tenantId ?? ""),
        slug: String(tenant.slug ?? ""),
        displayName: String(tenant.displayName ?? "Unnamed workspace"),
        status: String(tenant.status ?? "unknown"),
        region: tenant.region ? String(tenant.region) : null,
        assistantName: String(tenant.assistantName ?? "LearningBot"),
        courses: number(tenant.courses),
        publishedCourses: number(tenant.publishedCourses),
        members: number(tenant.members),
        sources: number(tenant.sources),
        knowledgeChunks: number(tenant.knowledgeChunks),
        updatedAt: String(tenant.updatedAt ?? ""),
      })),
  };
}

export default async function PlatformAdminPage() {
  let supabase;
  try {
    supabase = await createServerSupabaseClient();
    await requireVerifiedUser(supabase);
  } catch {
    redirect(
      "/auth/sign-in?error=authentication_required&next=/app/platform",
    );
  }

  const authorization = await supabase.rpc("platform_admin_is_authorized");
  if (authorization.error || authorization.data !== true) {
    redirect("/app/admin");
  }

  const result = await supabase.rpc("platform_admin_overview");
  const overview = result.error ? null : parseOverview(result.data);

  return (
    <main className={styles.shell}>
      <header className={styles.topbar}>
        <Link className={styles.brand} href="/">
          <span className={styles.brandMark}>L</span>
          <span>
            <b>LearningBot</b>
            <small>Platform control</small>
          </span>
        </Link>
        <nav aria-label="Platform administration">
          <Link className={styles.active} href="/app/platform">
            Overview
          </Link>
          <Link href="/app">Learning</Link>
        </nav>
        <form action="/auth/sign-out" method="post">
          <button type="submit">Sign out</button>
        </form>
      </header>

      <section className={styles.canvas}>
        <div className={styles.intro}>
          <div>
            <p className={styles.eyebrow}>Platform owner</p>
            <h1>The real operating view.</h1>
            <p>
              Every number below comes from the durable LearningBot database.
              Tenant content remains isolated; this overview exposes readiness
              counts, not learner conversations or source contents.
            </p>
          </div>
          <div className={styles.liveState} data-ready={Boolean(overview)}>
            <span aria-hidden="true" />
            {overview ? "Durable control plane online" : "Control plane unavailable"}
          </div>
        </div>

        {overview ? (
          <>
            <section className={styles.metrics} aria-label="Platform totals">
              <article>
                <span>Client workspaces</span>
                <strong>{overview.totals.tenants}</strong>
                <small>{overview.totals.activeTenants} active</small>
              </article>
              <article>
                <span>Courses</span>
                <strong>{overview.totals.courses}</strong>
                <small>Across isolated tenants</small>
              </article>
              <article>
                <span>Knowledge sources</span>
                <strong>{overview.totals.sources}</strong>
                <small>{overview.totals.knowledgeChunks.toLocaleString()} grounded chunks</small>
              </article>
              <article>
                <span>Managed people</span>
                <strong>{overview.totals.members}</strong>
                <small>Active memberships</small>
              </article>
            </section>

            <section className={styles.workspaceSection}>
              <div className={styles.sectionHeading}>
                <div>
                  <p className={styles.eyebrow}>Clients</p>
                  <h2>Live workspaces</h2>
                </div>
                <span>Updated {new Date(overview.generatedAt).toLocaleString()}</span>
              </div>
              <div className={styles.workspaceGrid}>
                {overview.tenants.map((tenant) => (
                  <article className={styles.workspaceCard} key={tenant.tenantId}>
                    <header>
                      <div className={styles.tenantMark}>
                        {tenant.displayName.slice(0, 1).toUpperCase()}
                      </div>
                      <div>
                        <span className={styles.status}>{tenant.status}</span>
                        <h3>{tenant.displayName}</h3>
                        <p>
                          {tenant.assistantName} · {tenant.slug}
                          {tenant.region ? ` · ${tenant.region}` : ""}
                        </p>
                      </div>
                    </header>
                    <dl>
                      <div>
                        <dt>Courses</dt>
                        <dd>
                          {tenant.publishedCourses}/{tenant.courses} published
                        </dd>
                      </div>
                      <div>
                        <dt>Knowledge</dt>
                        <dd>{tenant.knowledgeChunks.toLocaleString()} chunks</dd>
                      </div>
                      <div>
                        <dt>Sources</dt>
                        <dd>{tenant.sources}</dd>
                      </div>
                      <div>
                        <dt>People</dt>
                        <dd>{tenant.members}</dd>
                      </div>
                    </dl>
                    <div className={styles.cardActions}>
                      <Link href={`/app/admin/clients/${tenant.tenantId}`}>Open client detail</Link>
                      <Link href={`/app/conversation?tenantId=${encodeURIComponent(tenant.tenantId)}`}>Test learning</Link>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </>
        ) : (
          <section className={styles.error} role="alert">
            <span>!</span>
            <div>
              <h2>The durable platform summary could not be loaded.</h2>
              <p>
                No fixture data was substituted. Check the Supabase control
                plane before operating client workspaces.
              </p>
            </div>
          </section>
        )}

        <section className={styles.boundary}>
          <div>
            <p className={styles.eyebrow}>Data boundary</p>
            <h2>Operational visibility without surveillance.</h2>
          </div>
          <p>
            This platform view intentionally excludes prompt text, passwords,
            private exports, raw audio, and learning-source contents. Enter a
            client workspace through its authorized tenant context to perform
            tenant-scoped operations.
          </p>
          <div>
            <Link href="/app/admin/users">Manage client access</Link>
            <Link href="/api/health">Service health</Link>
          </div>
        </section>
      </section>
    </main>
  );
}

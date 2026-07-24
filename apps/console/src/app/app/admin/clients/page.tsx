import Link from "next/link";
import { redirect } from "next/navigation";

import { requireVerifiedUser } from "../../../../lib/supabase/auth-boundary";
import {
  getPlatformOverview,
  type PlatformClientSummary,
} from "../../../../lib/supabase/platform-admin-rpc";
import { createServerSupabaseClient } from "../../../../lib/supabase/server";
import styles from "./clients.module.css";

function formatUpdated(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "No update timestamp" : date.toLocaleDateString();
}

function ClientCard({ client }: { client: PlatformClientSummary }) {
  return (
    <article className={styles.clientCard}>
      <div className={styles.clientHeading}>
        <span className={styles.clientMark}>{client.displayName.slice(0, 1).toUpperCase()}</span>
        <div>
          <span className={styles.status} data-status={client.status}>{client.status}</span>
          <h2>{client.displayName}</h2>
          <p>{client.assistantName} · {client.slug}</p>
        </div>
      </div>
      <dl className={styles.cardStats}>
        <div><dt>Courses</dt><dd>{client.publishedCourses}/{client.courses}</dd></div>
        <div><dt>Sources</dt><dd>{client.sources}</dd></div>
        <div><dt>Knowledge</dt><dd>{client.knowledgeChunks.toLocaleString()}</dd></div>
        <div><dt>People</dt><dd>{client.members}</dd></div>
      </dl>
      <div className={styles.cardFooter}>
        <span>Updated {formatUpdated(client.updatedAt)}</span>
        <Link href={`/app/admin/clients/${client.tenantId}`}>Open client <span aria-hidden="true">→</span></Link>
      </div>
    </article>
  );
}

export default async function PlatformClientsPage() {
  let supabase;
  try {
    supabase = await createServerSupabaseClient();
    await requireVerifiedUser(supabase);
  } catch {
    redirect("/auth/sign-in?error=authentication_required&next=/app/admin/clients");
  }

  const authorization = await supabase.rpc("platform_admin_is_authorized");
  if (authorization.error || authorization.data !== true) redirect("/app/admin");

  const overview = await getPlatformOverview(supabase);

  return (
    <main className={styles.shell}>
      <header className={styles.topbar}>
        <Link className={styles.brand} href="/app/platform">
          <span className={styles.brandMark}>L</span>
          <span><b>LearningBot</b><small>Platform control</small></span>
        </Link>
        <nav aria-label="Platform administration">
          <Link href="/app/platform">Overview</Link>
          <Link className={styles.active} href="/app/admin/clients" aria-current="page">Clients</Link>
        </nav>
        <Link className={styles.backLink} href="/app">Learning</Link>
      </header>

      <section className={styles.canvas}>
        <div className={styles.intro}>
          <div>
            <p className={styles.eyebrow}>Platform administration</p>
            <h1>All clients, at a glance.</h1>
            <p>Open a client workspace for bounded operational detail. Content, messages, credentials, and audio remain outside this platform view.</p>
          </div>
          <span className={styles.liveState} data-ready={Boolean(overview)}><i aria-hidden="true" />{overview ? "Durable data" : "Data unavailable"}</span>
        </div>

        {overview ? (
          <>
            <section className={styles.metrics} aria-label="Client totals">
              <article><span>Clients</span><strong>{overview.totals.tenants}</strong><small>{overview.totals.activeTenants} active</small></article>
              <article><span>Courses</span><strong>{overview.totals.courses}</strong><small>Across client workspaces</small></article>
              <article><span>Sources</span><strong>{overview.totals.sources}</strong><small>{overview.totals.knowledgeChunks.toLocaleString()} chunks</small></article>
              <article><span>People</span><strong>{overview.totals.members}</strong><small>Active memberships</small></article>
            </section>
            <section className={styles.clientList} aria-label="Client workspaces">
              {overview.tenants.length ? overview.tenants.map((client) => <ClientCard client={client} key={client.tenantId} />) : <p className={styles.empty}>No client workspaces were returned by the durable control plane.</p>}
            </section>
          </>
        ) : (
          <section className={styles.error} role="alert"><strong>Client data is unavailable.</strong><span>No local or fixture data was substituted.</span></section>
        )}
      </section>
    </main>
  );
}

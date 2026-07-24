import Link from "next/link";
import {
  getCurrentTenantContext,
  requireVerifiedUser,
} from "../../../lib/supabase/auth-boundary";
import { getOnboardingSnapshot } from "../../../lib/supabase/onboarding-rpc";
import { createServerSupabaseClient } from "../../../lib/supabase/server";
import { CircleInstallationPanel } from "../../onboarding/circle-installation";
import {
  buildCircleSnippet,
  publicCircleAppUrl,
} from "../../../lib/circle-installation";
import styles from "./circle.module.css";

export default async function CircleInstallPage() {
  let installation = null;
  try {
    const supabase = await createServerSupabaseClient();
    await requireVerifiedUser(supabase);
    const context = await getCurrentTenantContext(supabase);
    if (context.selected && context.tenantId) {
      const snapshot = await getOnboardingSnapshot(supabase);
      installation = {
        tenantId: snapshot.tenant.tenantId,
        tenantSlug: snapshot.tenant.slug,
        assistantName: snapshot.branding.assistantName,
        primaryColor: snapshot.branding.primaryColor,
        accentColor: snapshot.branding.accentColor,
        welcomeMessage: snapshot.branding.welcomeMessage,
      };
    }
  } catch {
    installation = null;
  }
  const assistantName = installation?.assistantName ?? "your assistant";
  const genericSnippet = buildCircleSnippet({
    tenantId: "your-tenant-id",
    tenantSlug: "your-workspace",
    assistantName: "your assistant",
    primaryColor: "#205B46",
    accentColor: "#D8A653",
    welcomeMessage: "Ask about the published learning.",
  });
  return (
    <main className={styles.shell}>
      <section className={styles.hero}>
        <span className={styles.mark}>E</span>
        <p>Circle installation</p>
        <h1>Put {assistantName} inside your community.</h1>
        <span>
          Members get one calm launcher that opens the secure LearningBot
          conversation. Circle never receives a LearningBot password or
          impersonates a learner.
        </span>
        <div className={styles.actions}>
          <Link href="/auth/sign-in?next=/install/circle">Open LearningBot</Link>
          <a href="#install">View installation</a>
        </div>
      </section>

      <section className={styles.steps} id="install">
        <article>
          <span>1</span>
          <div>
            <h2>Keep the domains separate</h2>
            <p>
              Use <b>clone.stack-labs.ai</b> for LearningBot. Keep your Circle
              community on its current Circle or custom domain.
            </p>
          </div>
        </article>
        {installation ? (
          <article>
            <span>2</span>
            <div>
              <CircleInstallationPanel config={installation} />
            </div>
          </article>
        ) : null}
        <article>
          <span>{installation ? 3 : 2}</span>
          <div>
            <h2>Add the launcher to Circle</h2>
            <p>
              In Circle, open Site → Code snippets → JavaScript and paste this
              raw JavaScript. Do not add another script tag; Circle wraps the
              JavaScript field for you.
            </p>
            {installation ? (
              <p>Use the client-specific snippet above after signing in to the selected workspace.</p>
            ) : (
              <pre>
                <code>{genericSnippet}</code>
              </pre>
            )}
          </div>
        </article>
        <article>
          <span>{installation ? 4 : 3}</span>
          <div>
            <h2>Connect Circle identity</h2>
            <p>
              Configure Circle Custom SSO with LearningBot’s authorization,
              token, and user-info endpoints. After the one-time Circle
              client is created, Circle passes each member’s verified email to
              the tenant they belong to. Keep the Circle login option enabled
              while testing the connection.
            </p>
            <p>
              Circle admin path: community name → Settings → Single sign-on.
              Use OAuth 2.0, scope <b>openid email profile</b>, and map the
              user ID to <b>sub</b>, email to <b>email</b>, and name to
              <b>name</b>. The client secret is shown once by the LearningBot
              setup endpoint and is never recoverable.
            </p>
          </div>
        </article>
      </section>

      <aside className={styles.note}>
        <b>Mobile note</b>
        <p>
          Circle’s native mobile apps do not run every custom website snippet.
          Add a normal Circle navigation link to
          {publicCircleAppUrl().replace(/\/conversation$/u, "")} as the mobile fallback.
        </p>
      </aside>
    </main>
  );
}

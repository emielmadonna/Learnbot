import Link from "next/link";
import styles from "./circle.module.css";

const snippet = `(() => {
  const script = document.createElement("script");
  script.src = "https://clone.stack-labs.ai/integrations/circle-learningbot.js";
  script.dataset.appUrl = "https://clone.stack-labs.ai/app/conversation";
  script.dataset.label = "Ask Estie";
  script.dataset.primary = "#205B46";
  script.defer = true;
  document.head.append(script);
})();`;

export default function CircleInstallPage() {
  return (
    <main className={styles.shell}>
      <section className={styles.hero}>
        <span className={styles.mark}>E</span>
        <p>Circle installation</p>
        <h1>Put Estie inside your community.</h1>
        <span>
          Members get one calm launcher that opens the secure LearningBot
          conversation. Circle never receives a LearningBot password or
          impersonates a learner.
        </span>
        <div className={styles.actions}>
          <Link href="/auth/sign-in?next=/app">Open LearningBot</Link>
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
        <article>
          <span>2</span>
          <div>
            <h2>Add the launcher to Circle</h2>
            <p>
              In Circle, open Site → Code snippets → JavaScript and paste this
              raw JavaScript. Do not add another script tag; Circle wraps the
              JavaScript field for you.
            </p>
            <pre>
              <code>{snippet}</code>
            </pre>
          </div>
        </article>
        <article>
          <span>3</span>
          <div>
            <h2>Create member accounts</h2>
            <p>
              In LearningBot, open People &amp; access. Create each person’s
              email and one-time password, then have them change it on first
              sign-in.
            </p>
          </div>
        </article>
      </section>

      <aside className={styles.note}>
        <b>Mobile note</b>
        <p>
          Circle’s native mobile apps do not run every custom website snippet.
          Add a normal Circle navigation link to
          https://clone.stack-labs.ai/app as the mobile fallback.
        </p>
      </aside>
    </main>
  );
}

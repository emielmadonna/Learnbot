import Link from "next/link";
import { CorsoMark } from "../../../components/corso/corso-mark";
import styles from "./circle.module.css";

const publicOrigin = (
  process.env.NEXT_PUBLIC_APP_URL ??
  process.env.NEXT_PUBLIC_SITE_URL ??
  "https://YOUR-CORSO-DOMAIN"
).replace(/\/+$/, "");

const placeholderKey = "wk_REPLACE_WITH_YOUR_WIDGET_KEY";
const hostedExample = `${publicOrigin}/c/your-course`;
const snippet = `(() => {
  const script = document.createElement("script");
  script.src = "${publicOrigin}/widget.js";
  script.dataset.tenant = "${placeholderKey}";
  script.defer = true;
  document.head.append(script);
})();`;

export default function CircleInstallPage() {
  return (
    <main className={styles.shell}>
      <header className={styles.topbar}>
        <Link className={styles.brand} href="/">
          <CorsoMark size={31} />
          <span>Corso</span>
        </Link>
        <Link
          className={styles.backLink}
          href="/app?panel=widget&view=install"
        >
          Widget settings
        </Link>
      </header>

      <section className={styles.hero}>
        <p className={styles.eyebrow}>Circle installation</p>
        <h1>Put Corso inside your community.</h1>
        <p className={styles.lede}>
          One small launcher opens the course assistant in your name and
          colour. Circle never receives a Corso password or impersonates a
          learner.
        </p>
        <div className={styles.actions}>
          <a className={styles.primaryAction} href="#install">
            View installation
          </a>
          <Link
            className={styles.secondaryAction}
            href="/app?panel=widget&view=install"
          >
            Get widget key
          </Link>
        </div>
      </section>

      <section
        className={styles.steps}
        id="install"
        aria-label="Installation steps"
      >
        <article>
          <span className={styles.stepNumber}>1</span>
          <div>
            <h2>Copy the workspace key</h2>
            <p>
              In Corso, open Settings → Widget → Install &amp; domains and copy
              the public widget key. It starts with <code>wk_</code>. Your
              allowed Circle domain is checked again on every question.
            </p>
            <Link
              className={styles.inlineLink}
              href="/app?panel=widget&view=install"
            >
              Open widget settings
            </Link>
          </div>
        </article>

        <article>
          <span className={styles.stepNumber}>2</span>
          <div>
            <h2>Add the launcher to Circle</h2>
            <p>
              In Circle, open Site → Code snippets → JavaScript. Replace the
              placeholder key below with your real key, then paste the raw
              JavaScript. Circle wraps the field, so do not add another script
              tag.
            </p>
            <pre>
              <code>{snippet}</code>
            </pre>
          </div>
        </article>

        <article>
          <span className={styles.stepNumber}>3</span>
          <div>
            <h2>Test it on the real domain</h2>
            <p>
              Publish the snippet, open the Circle site at its allowed origin,
              and ask one course question. A missing key, blocked origin, or
              network failure makes the launcher stay hidden instead of
              breaking the community page.
            </p>
          </div>
        </article>
      </section>

      <section className={styles.hostedSection}>
        <div className={styles.hostedCopy}>
          <p className={styles.eyebrow}>Mobile fallback</p>
          <h2>A full-page assistant when snippets cannot run.</h2>
          <p>
            Circle&apos;s native mobile apps may not run custom website code.
            In Settings → Widget → Install &amp; domains, publish the
            workspace&apos;s hosted assistant and copy its permanent address.
            Add that address to Circle as a normal navigation link. It uses the
            friendly format <code>{hostedExample}</code> and follows the
            anonymous-access setting saved for the widget.
          </p>
          <Link
            className={styles.primaryAction}
            href="/app?panel=widget&view=install"
          >
            Create or copy hosted link
          </Link>
        </div>

        <div
          className={styles.hostedPreview}
          aria-label="Hosted assistant preview"
        >
          <div className={styles.previewHeader}>
            <span className={styles.previewMark}>
              <CorsoMark size={20} />
            </span>
            <div>
              <strong>Course Assistant</strong>
              <span>Answers only from your published course</span>
            </div>
          </div>
          <div className={styles.previewBody}>
            <span className={styles.previewHeroMark}>
              <CorsoMark size={35} />
            </span>
            <h3>What are you working on?</h3>
            <p>
              I&apos;ll point you at the exact lesson — or tell you when the
              course does not cover it yet.
            </p>
            <div className={styles.previewPrompts}>
              <span>Ask about the course</span>
              <span>Find a lesson</span>
            </div>
          </div>
          <div className={styles.previewComposer}>
            <span>Ask about the course…</span>
            <b>↑</b>
          </div>
        </div>
      </section>

      <aside className={styles.note}>
        <strong>Current connector boundary</strong>
        <p>
          This is an origin-allowlisted web widget. It does not use Circle
          member identity, sync Circle roles, or bypass Corso access controls.
        </p>
      </aside>
    </main>
  );
}

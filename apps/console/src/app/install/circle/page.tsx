import { headers } from "next/headers";
import Link from "next/link";
import { CorsoMark } from "../../../components/corso/corso-mark";
import styles from "./circle.module.css";

const placeholderKey = "wk_REPLACE_WITH_YOUR_WIDGET_KEY";

function firstHeaderValue(value: string | null) {
  return value?.split(",", 1)[0]?.trim() ?? "";
}

/**
 * `NEXT_PUBLIC_APP_URL` / `NEXT_PUBLIC_SITE_URL` if an operator set one —
 * neither is documented in `.env.example` and neither is set on this
 * deployment, which is exactly why this cannot be the only source.
 */
function configuredPublicOrigin() {
  const candidate = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
  ]
    .map((value) => value?.trim() ?? "")
    .find(Boolean);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      )
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The origin this page is actually being served from.
 *
 * This page used to read `NEXT_PUBLIC_APP_URL ?? NEXT_PUBLIC_SITE_URL ??
 * "https://YOUR-CORSO-DOMAIN"` at module scope. Neither variable exists in
 * `.env.example`, in `apps/console/.env.local`, or anywhere in `infra/`, so
 * the fallback was not a fallback — it was the value, and every customer who
 * followed these instructions pasted a snippet pointing at a domain that does
 * not exist. The sibling hosted page (`app/c/[slug]/page.tsx`) already derives
 * its origin from the request; this is the same derivation, and the
 * environment variables are kept only as an override for a deployment behind a
 * rewriting proxy.
 */
async function installPageOrigin() {
  const requestHeaders = await headers();
  const host =
    firstHeaderValue(requestHeaders.get("x-forwarded-host")) ||
    firstHeaderValue(requestHeaders.get("host"));
  if (!host || /[\s/\\]/u.test(host)) {
    return configuredPublicOrigin() ?? "https://YOUR-CORSO-DOMAIN";
  }
  const forwardedProtocol = firstHeaderValue(
    requestHeaders.get("x-forwarded-proto"),
  );
  const localHost = /^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/u.test(host);
  const protocol =
    forwardedProtocol === "https" || forwardedProtocol === "http"
      ? forwardedProtocol
      : localHost
        ? "http"
        : "https";
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return configuredPublicOrigin() ?? "https://YOUR-CORSO-DOMAIN";
  }
}

export default async function CircleInstallPage() {
  const publicOrigin = await installPageOrigin();
  const hostedExample = `${publicOrigin}/c/your-course`;
  const snippet = `(() => {
  const script = document.createElement("script");
  script.src = "${publicOrigin}/widget.js";
  script.dataset.tenant = "${placeholderKey}";
  script.defer = true;
  document.head.append(script);
})();`;
  // Optional, and pasted ABOVE the launcher snippet so the first render
  // already knows who is there. `CourseAiWidgetIdentity` is the host-agnostic
  // hook: any site that knows who its visitor is can define it, and Circle is
  // simply the example because `window.circleUser` is what Circle exposes to a
  // code snippet.
  const identitySnippet = `(() => {
  window.CourseAiWidgetIdentity = () => {
    const member = window.circleUser;
    if (!member || !member.id) return null;
    return { ref: "circle:" + member.id, displayName: member.name };
  };
})();`;

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
            <h2>Add your Circle domain, then turn the widget on</h2>
            <p>
              In Corso, open Settings → Widget → Install &amp; domains. Add your
              Circle community&apos;s domain to the allowed list first — the
              widget cannot be enabled with an empty list, and any origin that
              is not on it is refused on every request. Then turn the widget on
              and save.
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
            <h2>Copy the workspace key</h2>
            <p>
              The public widget key is issued by the server on that first save,
              so it does not exist until step 1 is done. It starts with{" "}
              <code>wk_</code>. Copy it from the same screen. Your allowed
              Circle domain is checked again on every question, so the key
              alone is not enough to use it from anywhere else.
            </p>
          </div>
        </article>

        <article>
          <span className={styles.stepNumber}>3</span>
          <div>
            <h2>Let signed-out visitors ask</h2>
            <p>
              On the same screen, turn on{" "}
              <strong>Let signed-out visitors ask</strong>. It is off by
              default, and Circle members are anonymous to Corso. Leaving it off
              is the one failure that looks like success: the launcher still
              appears and still opens, and then every question comes back
              unavailable.
            </p>
          </div>
        </article>

        <article>
          <span className={styles.stepNumber}>4</span>
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
          <span className={styles.stepNumber}>5</span>
          <div>
            <h2>Optional: tell Corso which member is asking</h2>
            <p>
              Without this, every widget question is anonymous and Corso can
              only report how many browsers asked. Paste this snippet{" "}
              <strong>above</strong> the launcher snippet and each question is
              attributed to the Circle member who asked it, so repeat questions
              and stuck learners can be spotted per person.
            </p>
            <pre>
              <code>{identitySnippet}</code>
            </pre>
            <p>
              Corso stores only a one-way, per-workspace hash of the id you
              pass, never the id itself and never an email address — an address
              is rejected outright. <code>displayName</code> is used for the
              widget header on the visitor&apos;s own screen and is not sent
              anywhere.
            </p>
            <p>
              <strong>This is a claim your page makes, not a login.</strong>{" "}
              <code>window.circleUser</code> is ordinary browser data with no
              signature, so anyone who opens developer tools can change it
              before Corso reads it. The widget therefore labels the visitor
              <em> Identity not verified</em>, and Corso records the identity as
              self-reported. It grants no access: an identified visitor sees
              exactly the published course material an anonymous one does.
            </p>
          </div>
        </article>

        <article>
          <span className={styles.stepNumber}>6</span>
          <div>
            <h2>Test it on the real domain</h2>
            <p>
              Publish the snippet, open the Circle site at its allowed origin,
              and ask one course question. If the key is missing or the origin
              is not allowed, the launcher appears in Corso&apos;s default
              colours for a moment and then removes itself — the community page
              is never broken, but a launcher that vanishes means step 1 is
              incomplete. A launcher that stays and refuses every question means
              step 3 is.
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
          This is an origin-allowlisted web widget. It does not sync Circle
          roles or bypass Corso access controls. Step 5 is the only place
          Circle member identity is used at all, it is opt-in, and what it
          passes is an unverified claim made by your page: Corso records it for
          attribution and never treats it as authentication or as a grant of
          access.
        </p>
      </aside>
    </main>
  );
}

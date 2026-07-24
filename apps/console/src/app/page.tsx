import Link from "next/link";

import { fixturePreviewEnabled } from "../lib/deployment-mode";

const modules = [
  {
    name: "Conversation",
    description: "Text, voice, files, rich answers and diagrams in one thread.",
    status: "Integrated fixture",
    href: "/dev/chat"
  },
  {
    name: "Courses & Learning",
    description: "Upload, clean, organize, preview, publish and roll back.",
    status: "Integrated fixture",
    href: "/dev/learning"
  },
  {
    name: "Creator Console",
    description: "This Week, questions, confusion, Students and opportunities.",
    status: "Interactive fixture",
    href: "/dev/creator"
  },
  {
    name: "Creator Intelligence",
    description: "Evidence, source health, unknown metrics and human review.",
    status: "Validated fixture",
    href: "/dev/intelligence"
  },
  {
    name: "Teacher Console",
    description: "Cohort pulse, learner questions, progress and safe follow-up.",
    status: "Interactive fixture",
    href: "/dev/teacher"
  },
  {
    name: "Owner & Client Onboarding",
    description: "Organization setup, assistant identity, invitations and client acceptance.",
    status: "Interactive fixture",
    href: "/dev/onboarding"
  },
  {
    name: "Platform Admin",
    description: "Tenants, providers, budgets, audit, policy and MCP controls.",
    status: "Interactive fixture",
    href: "/dev/admin"
  },
  {
    name: "Branding & Context",
    description: "Tenant identity, colors, voice, launcher and learning context.",
    status: "Integrated fixture",
    href: "/dev/branding"
  },
  {
    name: "Privacy Operations",
    description: "Access, export, deletion, retention, legal holds and audit.",
    status: "Validated fixture",
    href: "/dev/privacy"
  },
  {
    name: "Embeddable Widget",
    description: "Shadow-DOM assistant runtime, resize, theme and host events.",
    status: "Verified fixture",
    href: "/dev/widget"
  },
  {
    name: "Embedded Course Experience",
    description: "The companion running inside a realistic learning host page.",
    status: "Interactive fixture",
    href: "/dev/widget/host"
  },
  {
    name: "MCP Control Plane",
    description: "The same safe operations for Codex and authorized agents.",
    status: "36 fixture tools verified",
    href: "/dev/admin#mcp"
  }
];

export default function HomePage() {
  const isFixturePreview = fixturePreviewEnabled();
  const isProduction =
    process.env.NODE_ENV === "production" && !isFixturePreview;
  const environmentLabel = isFixturePreview
    ? "Protected fixture preview"
    : process.env.NODE_ENV === "production"
      ? "Production shell"
      : "Local development";
  const buildIdentity = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local";

  if (isProduction) {
    return (
      <main>
        <header className="topbar">
          <div className="brandMark">E</div>
          <div>
            <p className="eyebrow">Estie learning</p>
            <h1>Learn with clarity. Apply with confidence.</h1>
          </div>
          <div className="environment">
            <span aria-hidden="true" />
            Secure workspace
          </div>
        </header>
        <section className="hero">
          <div>
            <p className="eyebrow">Your learning companion</p>
            <h2>Course knowledge, ready when you are.</h2>
            <p className="lede">
              Continue your courses, ask grounded questions by text or voice,
              and keep your progress in one private workspace.
            </p>
            <div className="homeActions">
              <Link className="homePrimary" href="/app">
                Open my workspace
              </Link>
              <Link className="homeSecondary" href="/auth/sign-in">
                Sign in
              </Link>
            </div>
          </div>
          <aside className="sprint">
            <p className="eyebrow">For learning teams</p>
            <strong>One source of truth</strong>
            <p>
              Tenant-isolated course content, learner progress, grounded
              conversation and controlled publishing.
            </p>
          </aside>
        </section>
        <section className="launchStrip" aria-label="Product capabilities">
          <article><strong>Text + voice</strong><span>one learning conversation</span></article>
          <article><strong>Real progress</strong><span>course and lesson continuity</span></article>
          <article><strong>Grounded</strong><span>answers tied to source material</span></article>
          <article><strong>Private</strong><span>tenant-bound access controls</span></article>
        </section>
        <footer className="launchFooter">
          <div>
            <p className="eyebrow">Environment</p>
            <strong>Production · build {buildIdentity}</strong>
          </div>
          <div>
            <Link href="/api/health">Service status</Link>
          </div>
        </footer>
      </main>
    );
  }

  return (
    <main>
      <header className="topbar">
        <div className="brandMark">L</div>
        <div>
          <p className="eyebrow">Course AI Platform</p>
          <h1>Development control room</h1>
        </div>
        <div className="environment">
          <span aria-hidden="true" />
          {environmentLabel}
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">Estie launchpad</p>
          <h2>Every learning surface, in one place.</h2>
          <p className="lede">
            Open the Student experience, course operations, Creator and Teacher
            workspaces, tenant administration, privacy controls and the
            embeddable companion from this release environment.
          </p>
        </div>
        <aside className="sprint">
          <p className="eyebrow">Environment boundary</p>
          <strong>
            {isFixturePreview ? "Private preview · fixture data" : environmentLabel}
          </strong>
          <p>
            {isFixturePreview
              ? "The visual surfaces are integrated and testable with explicitly labeled fixture data."
              : "Durable Supabase identity and onboarding are live. Learning providers, storage operations and unresolved policy-dependent workflows remain labeled previews."}
          </p>
        </aside>
      </section>

      <section className="launchStrip" aria-label="Launch inventory">
        <article><strong>11</strong><span>visual product surfaces</span></article>
        <article><strong>36</strong><span>fixture-enabled MCP tools</span></article>
        <article><strong>42</strong><span>RLS-enabled tenant tables</span></article>
        <article>
          <strong>{isFixturePreview ? "Protected" : "Durable Auth"}</strong>
          <span>{isFixturePreview ? "preview access boundary" : "production access boundary"}</span>
        </article>
      </section>

      <section aria-labelledby="modules-heading">
        <div className="sectionHeading">
          <div>
            <p className="eyebrow">Surface directory</p>
            <h2 id="modules-heading">Open a workspace</h2>
          </div>
          <p>Status labels distinguish verified contracts from fixture-backed previews.</p>
        </div>
        <div className="moduleGrid">
          {modules.map((module) => {
            const content = (
              <>
              <div>
                <span className="status">{module.status}</span>
                <h3>{module.name}</h3>
                <p>{module.description}</p>
              </div>
              <span className="arrow" aria-hidden="true">
                ↗
              </span>
              </>
            );

            return module.href ? (
              <Link className="moduleCard" href={module.href} key={module.name}>
                {content}
              </Link>
            ) : (
              <article className="moduleCard" key={module.name}>
                {content}
              </article>
            );
          })}
        </div>
      </section>

      <footer className="launchFooter">
        <div>
          <p className="eyebrow">Runtime checks</p>
          <strong>Shared service boundary active · build {buildIdentity}</strong>
        </div>
        <div>
          <Link href="/api/health">Public health</Link>
          <Link href="/api/dev/health">Preview health</Link>
          <a href="https://github.com/emielmadonna/Learnbot" rel="noreferrer">
            Source
          </a>
        </div>
      </footer>
    </main>
  );
}

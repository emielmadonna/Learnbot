import Link from "next/link";

import { fixturePreviewEnabled } from "../lib/deployment-mode";

const developmentModules = [
  {
    name: "Conversation",
    description: "Text, voice, sources and rich learning responses in one thread.",
    status: "Fixture surface",
    href: "/dev/chat",
  },
  {
    name: "Courses & Learning",
    description: "Create, organize, review, publish and roll back learning.",
    status: "Fixture surface",
    href: "/dev/learning",
  },
  {
    name: "Creator Console",
    description: "Questions, confusion, learners and review opportunities.",
    status: "Fixture surface",
    href: "/dev/creator",
  },
  {
    name: "Creator Intelligence",
    description: "Evidence, source health, unknown metrics and human review.",
    status: "Fixture surface",
    href: "/dev/intelligence",
  },
  {
    name: "Teacher Console",
    description: "Cohort pulse, learner questions, progress and follow-up.",
    status: "Fixture surface",
    href: "/dev/teacher",
  },
  {
    name: "Onboarding",
    description: "Organization setup, assistant identity and invitations.",
    status: "Fixture surface",
    href: "/dev/onboarding",
  },
  {
    name: "Platform Admin",
    description: "Tenants, providers, budgets, audit, policy and MCP controls.",
    status: "Fixture surface",
    href: "/dev/admin",
  },
  {
    name: "Branding & Context",
    description: "Tenant identity, colors, voice and learning context.",
    status: "Fixture surface",
    href: "/dev/branding",
  },
  {
    name: "Privacy Operations",
    description: "Access, export, deletion, retention, holds and audit.",
    status: "Fixture surface",
    href: "/dev/privacy",
  },
  {
    name: "Embeddable Widget",
    description: "Assistant runtime, resize, theme and host events.",
    status: "Fixture surface",
    href: "/dev/widget",
  },
  {
    name: "Embedded Course",
    description: "The learning companion inside a realistic host page.",
    status: "Fixture surface",
    href: "/dev/widget/host",
  },
];

function LearningBotMark() {
  return (
    <span className="lbMark" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

function ProductPreview() {
  return (
    <div
      className="lbProductPreview"
      role="img"
      aria-label="LearningBot workspace showing a grounded learning conversation, course context and voice control"
    >
      <div className="lbPreviewGlow" aria-hidden="true" />
      <div className="lbPreviewWindow">
        <header>
          <div>
            <LearningBotMark />
            <span>LearningBot</span>
          </div>
          <p>Foundations of Leadership</p>
          <span className="lbPreviewAvatar">AM</span>
        </header>
        <div className="lbPreviewBody">
          <aside aria-hidden="true">
            <span className="active" />
            <span />
            <span />
            <span />
            <span />
          </aside>
          <section>
            <div className="lbPreviewContext">
              <span>MODULE 2</span>
              <strong>Leading through change</strong>
            </div>
            <div className="lbPreviewQuestion">
              How do I help a team move through uncertainty?
            </div>
            <div className="lbPreviewAnswer">
              <LearningBotMark />
              <div>
                <p>
                  Start by making the unknown visible. Separate what the team can
                  influence from what it cannot, then choose one concrete next
                  action.
                </p>
                <div className="lbPreviewSteps">
                  <span><b>1</b> Name the uncertainty</span>
                  <span><b>2</b> Find the controllable</span>
                  <span><b>3</b> Move together</span>
                </div>
                <small>2 grounded learning sources</small>
              </div>
            </div>
            <div className="lbPreviewComposer">
              <span>Ask about your learning…</span>
              <i aria-hidden="true">●</i>
              <b aria-hidden="true">↑</b>
            </div>
          </section>
        </div>
      </div>
      <div className="lbVoiceCard">
        <span className="lbVoiceCloud" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <div>
          <small>CONTINUOUS VOICE</small>
          <strong>Listening naturally</strong>
          <p>Grounded in the same conversation.</p>
        </div>
      </div>
    </div>
  );
}

function PlatformLanding() {
  return (
    <main className="lbLanding">
      <nav className="lbNav" aria-label="Primary navigation">
        <Link className="lbBrand" href="/" aria-label="LearningBot home">
          <LearningBotMark />
          <b>LearningBot</b>
        </Link>
        <div className="lbNavLinks">
          <a href="#product">Product</a>
          <a href="#workflow">How it works</a>
          <a href="#enterprise">Enterprise</a>
        </div>
        <div className="lbNavActions">
          <Link className="lbNavSignIn" href="/auth/sign-in">
            Sign in
          </Link>
          <Link className="lbNavPrimary" href="/app">
            Open workspace
          </Link>
        </div>
      </nav>

      <section className="lbHero">
        <div className="lbHeroCopy">
          <p className="lbKicker">
            <span aria-hidden="true" />
            Enterprise learning, made conversational
          </p>
          <h1>Learning that<br />answers back.</h1>
          <p className="lbHeroLede">
            Turn trusted course knowledge into a private learning companion
            people can talk to, learn with and return to—across every course,
            team and moment of work.
          </p>
          <div className="lbHeroActions">
            <Link className="lbPrimaryButton" href="/auth/sign-in">
              Enter LearningBot <span aria-hidden="true">→</span>
            </Link>
            <a className="lbTextButton" href="#product">
              Explore the platform <span aria-hidden="true">↓</span>
            </a>
          </div>
          <div className="lbHeroTrust" aria-label="Platform principles">
            <span>Grounded in your knowledge</span>
            <span>Private by design</span>
            <span>Built for every tenant</span>
          </div>
        </div>
        <ProductPreview />
      </section>

      <section className="lbProof" aria-label="LearningBot capabilities">
        <p>One learning system</p>
        <div>
          <span>Conversation</span>
          <i aria-hidden="true" />
          <span>Voice</span>
          <i aria-hidden="true" />
          <span>Course creation</span>
          <i aria-hidden="true" />
          <span>Progress</span>
          <i aria-hidden="true" />
          <span>Operations</span>
        </div>
      </section>

      <section className="lbProduct" id="product">
        <header className="lbSectionHeader">
          <p>THE LEARNING EXPERIENCE</p>
          <h2>Knowledge becomes useful<br />when it can meet you.</h2>
          <span>
            LearningBot brings the course, the conversation and the learner
            together without turning learning into another dashboard.
          </span>
        </header>

        <div className="lbBento">
          <article className="lbFeature lbFeatureConversation">
            <div className="lbFeatureCopy">
              <span className="lbFeatureNumber">01</span>
              <h3>One continuous learning conversation.</h3>
              <p>
                Text, rich answers, learning sources and progress stay together.
                Every response is grounded in published tenant knowledge.
              </p>
            </div>
            <div className="lbMiniThread" aria-hidden="true">
              <p>Can you explain this another way?</p>
              <div>
                <LearningBotMark />
                <span>
                  Think of momentum as evidence you can feel. A small completed
                  action makes the next action easier to trust.
                </span>
              </div>
              <small>Grounded in Lesson 4 · Building Momentum</small>
            </div>
          </article>

          <article className="lbFeature lbFeatureVoice">
            <div className="lbFeatureCopy">
              <span className="lbFeatureNumber">02</span>
              <h3>Voice that stays in the lesson.</h3>
              <p>
                Move naturally between text and low-latency voice. Interrupt,
                ask a follow-up and keep the same grounded thread.
              </p>
            </div>
            <div className="lbVoiceScene" aria-hidden="true">
              <span className="lbLargeCloud">
                <i />
                <i />
                <i />
              </span>
              <small>Listening</small>
            </div>
          </article>

          <article className="lbFeature lbFeatureCreate">
            <div className="lbFeatureCopy">
              <span className="lbFeatureNumber">03</span>
              <h3>Create learning at the speed of the work.</h3>
              <p>
                Shape courses, lessons and source material with clear drafts,
                controlled publishing and recoverable versions.
              </p>
            </div>
            <div className="lbCourseStack" aria-hidden="true">
              <div><span>01</span><b>Foundation</b><small>Published</small></div>
              <div><span>02</span><b>Practice</b><small>In review</small></div>
              <div><span>03</span><b>Application</b><small>Draft</small></div>
            </div>
          </article>

          <article className="lbFeature lbFeatureOperate">
            <div className="lbFeatureCopy">
              <span className="lbFeatureNumber">04</span>
              <h3>Operate the whole learning environment.</h3>
              <p>
                Give creators, teachers and administrators focused controls for
                learners, access, evidence, providers and privacy.
              </p>
            </div>
            <div className="lbOpsSignals" aria-hidden="true">
              <span><i /> Tenant isolated</span>
              <span><i /> Access controlled</span>
              <span><i /> Activity auditable</span>
              <span><i /> Providers adaptable</span>
            </div>
          </article>
        </div>
      </section>

      <section className="lbWorkflow" id="workflow">
        <header className="lbSectionHeader lbSectionHeaderLight">
          <p>FROM KNOWLEDGE TO LEARNING</p>
          <h2>A clear path from source<br />to understanding.</h2>
        </header>
        <div className="lbWorkflowSteps">
          <article>
            <span>01</span>
            <div>
              <h3>Bring the knowledge</h3>
              <p>
                Organize trusted courses, lessons and source material inside the
                tenant boundary.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <h3>Shape the experience</h3>
              <p>
                Set the learning structure, assistant identity, voice and
                publishing controls.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <h3>Learn in conversation</h3>
              <p>
                Learners ask, practice and check understanding with evidence
                close at hand.
              </p>
            </div>
          </article>
          <article>
            <span>04</span>
            <div>
              <h3>Improve with evidence</h3>
              <p>
                Use progress, questions and source health to strengthen the
                learning system over time.
              </p>
            </div>
          </article>
        </div>
      </section>

      <section className="lbEnterprise" id="enterprise">
        <div className="lbEnterpriseCopy">
          <p className="lbKicker">ENTERPRISE BY CONSTRUCTION</p>
          <h2>Private knowledge.<br />Clear boundaries.</h2>
          <p>
            LearningBot is designed around tenant-scoped identity, durable
            records and explicit authorization. Teams can choose providers and
            operating policies without changing the learner experience.
          </p>
          <Link className="lbTextButton" href="/auth/sign-in">
            Access your organization <span aria-hidden="true">→</span>
          </Link>
        </div>
        <div className="lbTrustGrid">
          <article>
            <span aria-hidden="true">◎</span>
            <h3>Tenant isolation</h3>
            <p>Identity, data and operations resolve inside the selected tenant.</p>
          </article>
          <article>
            <span aria-hidden="true">◇</span>
            <h3>Grounded responses</h3>
            <p>Published learning sources remain visible beside the answer.</p>
          </article>
          <article>
            <span aria-hidden="true">↻</span>
            <h3>Provider-neutral</h3>
            <p>Model, voice, embedding and storage choices stay behind contracts.</p>
          </article>
          <article>
            <span aria-hidden="true">⌁</span>
            <h3>Auditable operations</h3>
            <p>Consequential actions use bounded permissions and durable evidence.</p>
          </article>
        </div>
      </section>

      <section className="lbFinalCta">
        <LearningBotMark />
        <p>YOUR LEARNING SYSTEM, READY TO TALK</p>
        <h2>Make every course<br />a living conversation.</h2>
        <div>
          <Link className="lbPrimaryButton lbPrimaryButtonLight" href="/app">
            Open your workspace <span aria-hidden="true">→</span>
          </Link>
          <Link className="lbCtaSignIn" href="/auth/sign-in">
            Sign in
          </Link>
        </div>
      </section>

      <footer className="lbFooter">
        <Link className="lbBrand" href="/">
          <LearningBotMark />
          <b>LearningBot</b>
        </Link>
        <p>Enterprise learning that answers back.</p>
        <div>
          <Link href="/auth/sign-in">Sign in</Link>
          <Link href="/api/health">Service status</Link>
        </div>
      </footer>
    </main>
  );
}

function DevelopmentDirectory({
  protectedPreview,
  buildIdentity,
}: {
  protectedPreview: boolean;
  buildIdentity: string;
}) {
  return (
    <main className="launchPage">
      <header className="topbar">
        <div className="brandMark">L</div>
        <div>
          <p className="eyebrow">LearningBot</p>
          <h1>Development surface directory</h1>
        </div>
        <div className="environment">
          <span aria-hidden="true" />
          {protectedPreview ? "Protected fixture preview" : "Local development"}
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">Release lab</p>
          <h2>Every product surface, one place.</h2>
          <p className="lede">
            Fixture-backed developer surfaces are isolated from the production
            product. Use them to inspect visual and interaction contracts.
          </p>
          <div className="homeActions">
            <Link className="homePrimary" href="/app">Open durable workspace</Link>
            <Link className="homeSecondary" href="/auth/sign-in">Sign in</Link>
          </div>
        </div>
        <aside className="sprint">
          <p className="eyebrow">Environment boundary</p>
          <strong>{protectedPreview ? "Protected preview" : "Local only"}</strong>
          <p>Every card below uses explicitly labeled fixture data.</p>
        </aside>
      </section>

      <section aria-labelledby="modules-heading">
        <div className="sectionHeading">
          <div>
            <p className="eyebrow">Fixture surfaces</p>
            <h2 id="modules-heading">Open a workspace</h2>
          </div>
          <p>These routes are not linked from the production product.</p>
        </div>
        <div className="moduleGrid">
          {developmentModules.map((module) => (
            <Link className="moduleCard" href={module.href} key={module.name}>
              <div>
                <span className="status">{module.status}</span>
                <h3>{module.name}</h3>
                <p>{module.description}</p>
              </div>
              <span className="arrow" aria-hidden="true">↗</span>
            </Link>
          ))}
        </div>
      </section>

      <footer className="launchFooter">
        <div>
          <p className="eyebrow">Build</p>
          <strong>{buildIdentity}</strong>
        </div>
        <div>
          <Link href="/api/health">Public health</Link>
          <Link href="/api/dev/health">Preview health</Link>
        </div>
      </footer>
    </main>
  );
}

export default function HomePage() {
  const protectedPreview = fixturePreviewEnabled();
  const showDevelopmentDirectory =
    process.env.NODE_ENV !== "production" || protectedPreview;
  const buildIdentity =
    process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local";

  return showDevelopmentDirectory ? (
    <DevelopmentDirectory
      protectedPreview={protectedPreview}
      buildIdentity={buildIdentity}
    />
  ) : (
    <PlatformLanding />
  );
}

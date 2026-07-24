import Link from "next/link";

function LearningBotMark() {
  return (
    <span className="lbMark" aria-hidden="true">
      <i />
      <i />
    </span>
  );
}

function ProductSurface() {
  return (
    <div
      className="lbProductSurface"
      role="img"
      aria-label="LearningBot learner workspace showing course navigation, a grounded answer, learning sources, and continuous voice"
    >
      <div className="lbSurfaceBar">
        <div className="lbSurfaceBrand">
          <LearningBotMark />
          <strong>LearningBot</strong>
        </div>
        <span>Leadership Essentials</span>
        <span className="lbSurfaceAvatar">JD</span>
      </div>
      <div className="lbSurfaceBody">
        <aside className="lbSurfaceNav">
          <small>COURSE</small>
          <strong>Leadership Essentials</strong>
          <nav aria-label="Preview course modules">
            <span className="active"><b>01</b> Foundations</span>
            <span><b>02</b> Leading change</span>
            <span><b>03</b> Team practice</span>
          </nav>
          <div className="lbSurfaceProgress">
            <span><b /> Learning in progress</span>
          </div>
        </aside>
        <section className="lbSurfaceConversation">
          <header>
            <div>
              <small>MODULE 2 · LEADING CHANGE</small>
              <strong>Your learning conversation</strong>
            </div>
            <span className="lbVoiceStatus"><i /> Voice available</span>
          </header>
          <div className="lbSurfaceThread">
            <p className="lbLearnerMessage">
              How can I help my team move through uncertainty?
            </p>
            <div className="lbAssistantMessage">
              <LearningBotMark />
              <div>
                <p>
                  Start by separating what the team knows, what is still
                  uncertain, and what it can influence now. Then agree on one
                  small action that creates useful evidence.
                </p>
                <ol>
                  <li><b>1</b><span>Name the uncertainty clearly.</span></li>
                  <li><b>2</b><span>Identify what the team can influence.</span></li>
                  <li><b>3</b><span>Choose the next observable action.</span></li>
                </ol>
                <span className="lbGroundedLabel">Grounded in 2 course sources</span>
              </div>
            </div>
          </div>
          <div className="lbSurfaceComposer">
            <span>Ask a question about this course…</span>
            <button type="button" tabIndex={-1} aria-hidden="true">Voice</button>
            <i aria-hidden="true">↑</i>
          </div>
        </section>
        <aside className="lbSurfaceSources">
          <small>SOURCES</small>
          <article>
            <span>Lesson 2</span>
            <strong>Working with uncertainty</strong>
            <p>Published course content</p>
          </article>
          <article>
            <span>Guide</span>
            <strong>From clarity to action</strong>
            <p>Tenant learning library</p>
          </article>
          <div className="lbSurfaceVoice">
            <span aria-hidden="true"><i /><i /><i /></span>
            <div>
              <strong>Continuous voice</strong>
              <p>Same course. Same conversation.</p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function PlatformLanding() {
  return (
    <main className="lbLanding">
      <header className="lbHeader">
        <nav className="lbNav" aria-label="Primary navigation">
          <Link className="lbBrand" href="/" aria-label="LearningBot home">
            <LearningBotMark />
            <b>LearningBot</b>
          </Link>
          <div className="lbNavLinks">
            <a href="#product">Product</a>
            <a href="#voice">Voice</a>
            <a href="#platform">Platform</a>
            <a href="#security">Security</a>
          </div>
          <div className="lbNavActions">
            <Link className="lbNavSignIn" href="/auth/sign-in">Sign in</Link>
            <Link className="lbButton lbButtonSmall" href="/auth/sign-in">
              Get started
            </Link>
          </div>
        </nav>
      </header>

      <section className="lbHero">
        <div className="lbHeroCopy">
          <p className="lbEyebrow">The learning layer for your business</p>
          <h1>Make learning feel obvious.</h1>
          <p className="lbHeroLede">
            LearningBot turns your best knowledge into a living learning space—
            clean enough to trust, simple enough to use, and smart enough to
            show you what people need next.
          </p>
          <div className="lbHeroActions">
            <Link className="lbButton" href="/auth/sign-in">
              Start building <span aria-hidden="true">↗</span>
            </Link>
            <a className="lbButton lbButtonSecondary" href="#product">
              Explore the product
            </a>
          </div>
          <p className="lbHeroNote">
            Grounded in your knowledge. Private by default.
          </p>
        </div>
      </section>

      <section className="lbSurfaceSection" id="product">
        <div className="lbSectionIntro">
          <p className="lbEyebrow">One connected system</p>
          <h2>From source to signal, without the busywork.</h2>
          <p>
            Give creators, teachers, and admins the same view of what is being
            learned, what is unclear, and what to do next.
          </p>
        </div>
        <ProductSurface />
      </section>

      <section className="lbPillars" aria-labelledby="pillars-title">
        <div className="lbSectionIntro">
          <p className="lbEyebrow">One connected system</p>
          <h2 id="pillars-title">Built for everyone who makes learning work.</h2>
        </div>
        <div className="lbPillarGrid">
          <article>
            <span className="lbPillarIcon" aria-hidden="true">01</span>
            <h3>Learn</h3>
            <p>
              Give learners a focused place for courses, conversation, practice,
              evidence, and progress—without switching tools.
            </p>
            <ul>
              <li>Grounded text and voice conversation</li>
              <li>Course and module context</li>
              <li>Sources beside the answer</li>
            </ul>
          </article>
          <article>
            <span className="lbPillarIcon" aria-hidden="true">02</span>
            <h3>Create</h3>
            <p>
              Turn trusted material into structured learning, review it with
              collaborators, and publish controlled versions.
            </p>
            <ul>
              <li>Course and lesson authoring</li>
              <li>Source ingestion and review</li>
              <li>Publish and rollback controls</li>
            </ul>
          </article>
          <article>
            <span className="lbPillarIcon" aria-hidden="true">03</span>
            <h3>Operate</h3>
            <p>
              Manage organizations, people, providers, privacy, and learning
              operations from clear role-specific workspaces.
            </p>
            <ul>
              <li>Tenant and access administration</li>
              <li>Audit and privacy operations</li>
              <li>Provider-neutral infrastructure</li>
            </ul>
          </article>
        </div>
      </section>

      <section className="lbVoiceSection" id="voice">
        <div className="lbVoiceDemo" aria-hidden="true">
          <div className="lbVoiceOrb"><i /><i /><i /></div>
          <div>
            <span>LISTENING</span>
            <strong>“Can you give me an example?”</strong>
            <p>Leadership Essentials · Module 2</p>
          </div>
        </div>
        <div className="lbVoiceCopy">
          <p className="lbEyebrow">Continuous voice</p>
          <h2>A natural conversation, still grounded in the course.</h2>
          <p>
            Move between typing and speaking without starting over. Learners can
            interrupt, ask a follow-up, and return to the same conversation with
            course context and sources intact.
          </p>
          <div className="lbInlineChecks">
            <span>Text and voice in one thread</span>
            <span>Interruption and barge-in</span>
            <span>Tenant-selected assistant voice</span>
          </div>
        </div>
      </section>

      <section className="lbPlatformSection" id="platform">
        <div className="lbSectionIntro">
          <p className="lbEyebrow">Platform and organizations</p>
          <h2>One platform. A distinct learning environment for every client.</h2>
          <p>
            LearningBot supplies the shared product and operating controls.
            Each organization keeps its own identity, people, knowledge, and policy.
          </p>
        </div>
        <div className="lbPlatformGrid">
          <article className="lbPlatformCard">
            <span>LEARNINGBOT PLATFORM</span>
            <h3>Shared product foundation</h3>
            <p>
              Learning, authoring, administration, privacy, provider contracts,
              and operational tooling evolve as one managed platform.
            </p>
            <div>
              <small>Learning runtime</small>
              <small>Creator tools</small>
              <small>Enterprise controls</small>
              <small>Management MCP</small>
            </div>
          </article>
          <article className="lbTenantCard">
            <span>EACH ORGANIZATION</span>
            <h3>Private tenant environment</h3>
            <p>
              Every client configures its own brand, assistant, courses, members,
              providers, and policies inside an isolated tenant boundary.
            </p>
            <div>
              <small>Brand and assistant</small>
              <small>Courses and sources</small>
              <small>Members and roles</small>
              <small>Privacy and policy</small>
            </div>
          </article>
        </div>
      </section>

      <section className="lbSecuritySection" id="security">
        <div className="lbSecurityCopy">
          <p className="lbEyebrow">Enterprise foundations</p>
          <h2>Designed around clear boundaries and accountable operations.</h2>
          <p>
            Identity, content, conversations, and administrative actions resolve
            inside the selected organization. High-impact operations use explicit
            permissions and durable evidence.
          </p>
        </div>
        <div className="lbSecurityGrid">
          <article>
            <span aria-hidden="true">◎</span>
            <div>
              <h3>Tenant-scoped access</h3>
              <p>People and services act only within their authorized organization.</p>
            </div>
          </article>
          <article>
            <span aria-hidden="true">◇</span>
            <div>
              <h3>Grounded learning</h3>
              <p>Published course sources stay visible beside learning answers.</p>
            </div>
          </article>
          <article>
            <span aria-hidden="true">↻</span>
            <div>
              <h3>Provider flexibility</h3>
              <p>Model, voice, storage, and embedding choices remain behind contracts.</p>
            </div>
          </article>
          <article>
            <span aria-hidden="true">✓</span>
            <div>
              <h3>Auditable operations</h3>
              <p>Administrative and privacy workflows preserve durable evidence.</p>
            </div>
          </article>
        </div>
      </section>

      <section className="lbFinalCta" id="contact">
        <div>
          <p className="lbEyebrow">Start learning</p>
          <h2>Your organization&apos;s knowledge, ready to teach.</h2>
          <p>
            Enter your LearningBot workspace or explore how the platform brings
            learning, creation, and operations together.
          </p>
        </div>
        <div className="lbFinalActions">
          <Link className="lbButton lbButtonLight" href="/auth/sign-in">
            Sign in <span aria-hidden="true">→</span>
          </Link>
          <a className="lbButton lbButtonDarkSecondary" href="#product">
            Explore product
          </a>
        </div>
      </section>

      <footer className="lbFooter">
        <div className="lbFooterLead">
          <Link className="lbBrand" href="/">
            <LearningBotMark />
            <b>LearningBot</b>
          </Link>
          <p>Enterprise learning that stays connected to your knowledge.</p>
        </div>
        <div className="lbFooterColumn">
          <strong>Product</strong>
          <a href="#product">Learning workspace</a>
          <a href="#voice">Continuous voice</a>
          <a href="#platform">Platform</a>
        </div>
        <div className="lbFooterColumn">
          <strong>Enterprise</strong>
          <a href="#security">Security</a>
          <Link href="/api/health">Service status</Link>
          <Link href="/auth/sign-in">Sign in</Link>
        </div>
        <div className="lbFooterColumn">
          <strong>Get started</strong>
          <Link href="/auth/sign-in">Access your workspace</Link>
          <a href="#product">Explore the product</a>
        </div>
        <p className="lbFooterLegal">© {new Date().getFullYear()} LearningBot</p>
      </footer>
    </main>
  );
}

export default function HomePage() {
  return <PlatformLanding />;
}

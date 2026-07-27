import Link from "next/link";
import "./landing.css";

function LearningBotMark() {
  return (
    <span className="lbMark" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

function CourseDemo() {
  return (
    <div className="lbDemoFrame">
      <div className="lbCommunityBar">
        <div className="lbCommunityName">
          Freelance Pricing Lab <span>· Community</span>
        </div>
        <div className="lbCommunityTabs" aria-hidden="true">
          <span>Feed</span>
          <span data-active="true">Course</span>
          <span>Members</span>
        </div>
      </div>
      <div className="lbThread">
        <p className="lbThreadMeta">Module 3 · Pricing without flinching</p>
        <p className="lbThreadPost">
          How do I raise my rate with a client who&apos;s paid the old price
          for a year? I don&apos;t want to sound defensive.
        </p>
        <div className="lbReply">
          <span className="lbReplyAvatar" aria-hidden="true">
            <LearningBotMark />
          </span>
          <div className="lbReplyBody">
            <p>
              Lead with the value recap before you say the number. Lesson 3.2
              has you name three outcomes you&apos;ve delivered, then state
              the new rate once — no apology, no over-explaining.
              <span className="lbCitationMark">1</span>
            </p>
            <ol>
              <li>
                <b>1</b>
                <span>Recap: name three results from the last year.</span>
              </li>
              <li>
                <b>2</b>
                <span>State the new rate once. Don&apos;t soften it twice.</span>
              </li>
              <li>
                <b>3</b>
                <span>
                  Give the start date. The template mirrors this order.
                  <span className="lbCitationMark">2</span>
                </span>
              </li>
            </ol>
            <div className="lbGroundedRow">
              <span className="lbGroundedLabel">Grounded in 2 course sources</span>
              <span className="lbSourceCount">2 sources</span>
            </div>
          </div>
        </div>
        <div className="lbSources">
          <span className="lbSourceItem">
            <b>1</b> Lesson 3.2 — The value recap
          </span>
          <span className="lbSourceItem">
            <b>2</b> Client email pack — Rate increase template
          </span>
        </div>
      </div>
    </div>
  );
}

function PlatformLanding() {
  return (
    <main className="lbLanding">
      <header className="lbNav">
        <nav className="lbWrap lbNavInner" aria-label="Primary navigation">
          <Link className="lbBrand" href="/" aria-label="LearningBot home">
            <LearningBotMark />
            <b>LearningBot</b>
          </Link>
          <div className="lbNavLinks">
            <a href="#demo">See it work</a>
            <a href="#how-it-works">How it works</a>
            <a href="#foundation">Foundation</a>
          </div>
          <div className="lbNavActions">
            <Link className="lbSignIn" href="/auth/sign-in">
              Sign in
            </Link>
            <Link className="lbBtn lbBtnPrimary lbBtnSmall" href="/auth/sign-in">
              Get started
            </Link>
          </div>
        </nav>
      </header>

      <section className="lbHero">
        <div className="lbWrap lbHeroInner">
          <p className="lbEyebrow">For course creators on Circle</p>
          <h1 className="lbHeroTitle">
            An assistant for your course that only knows your course.
          </h1>
          <p className="lbHeroSub">
            Publish your lessons, and students can ask questions right where
            they&apos;re already learning. Every answer is grounded in what
            you actually taught — cited, or refused, never invented.
          </p>
          <div className="lbHeroActions">
            <Link className="lbBtn lbBtnPrimary" href="/auth/sign-in">
              Sign in <span aria-hidden="true">→</span>
            </Link>
            <a className="lbBtn lbBtnGhost" href="#demo">
              See it answer a question
            </a>
          </div>
          <p className="lbHeroNote">
            One private workspace per course. Nothing an assistant answers
            with came from outside what you published.
          </p>
        </div>
      </section>

      <section className="lbDemo" id="demo">
        <div className="lbWrap">
          <div className="lbDemoIntro">
            <h2>What a student sees, inside the course.</h2>
            <p>
              A question in the course thread, answered from the lesson you
              published — with the exact source named, the way it renders
              for a real student.
            </p>
          </div>
          <CourseDemo />
        </div>
      </section>

      <section className="lbFeatures" id="how-it-works">
        <div className="lbWrap">
          <div className="lbFeatureGrid">
            <article className="lbFeatureCard">
              <span className="lbFeatureIcon" aria-hidden="true">
                ◇
              </span>
              <h3>Grounded, or it says so</h3>
              <p>
                When your course doesn&apos;t cover something, the assistant
                refuses rather than guessing. Answers only ever draw from
                lessons you&apos;ve published.
              </p>
            </article>
            <article className="lbFeatureCard">
              <span className="lbFeatureIcon" aria-hidden="true">
                ¶
              </span>
              <h3>Answers that read like answers</h3>
              <p>
                Headings, lists, bold and code render properly in every
                reply — never a wall of raw markdown, and a learner&apos;s
                own words are never reinterpreted as formatting.
              </p>
            </article>
            <article className="lbFeatureCard">
              <span className="lbFeatureIcon" aria-hidden="true">
                ✎
              </span>
              <h3>Write once, answer from it immediately</h3>
              <p>
                Author your course in modules and lessons, publish, and the
                assistant can cite it the same moment — no separate
                ingestion step to wait on.
              </p>
            </article>
            <article className="lbFeatureCard">
              <span className="lbFeatureIcon" aria-hidden="true">
                ↻
              </span>
              <h3>Publish, roll back, publish again</h3>
              <p>
                Every course keeps its revision history. If a change goes
                out wrong, roll the whole course back to what students saw
                before.
              </p>
            </article>
          </div>
        </div>
      </section>

      <section className="lbFoundation" id="foundation">
        <div className="lbWrap lbFoundationInner">
          <div className="lbFoundationCopy">
            <h2>Built on real isolation, not a shared prompt.</h2>
            <p>
              Every course creator gets a private workspace. Roles come from
              the database on every request — never from a token a browser
              could hold onto or forge.
            </p>
          </div>
          <div className="lbFoundationList">
            <div className="lbFoundationItem">
              <span aria-hidden="true">◎</span>
              <div>
                <strong>One workspace per course</strong>
                <p>
                  Your students, your content, and your assistant&apos;s
                  answers stay inside your workspace — never mixed with
                  another creator&apos;s.
                </p>
              </div>
            </div>
            <div className="lbFoundationItem">
              <span aria-hidden="true">◐</span>
              <div>
                <strong>Your color, kept readable</strong>
                <p>
                  Pick a brand color for your assistant. It&apos;s checked
                  against WCAG contrast and corrected automatically — you
                  never see an error about a hex value.
                </p>
              </div>
            </div>
            <div className="lbFoundationItem">
              <span aria-hidden="true">✓</span>
              <div>
                <strong>Database-backed roles</strong>
                <p>
                  Every meaningful action runs through a database function
                  under row-level security, not a role claimed by the
                  client.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="lbFinalCta">
        <div className="lbWrap">
          <div className="lbFinalCtaInner">
            <div className="lbFinalCtaCopy">
              <h2>Your course, ready to answer for itself.</h2>
              <p>
                Sign in to set up your workspace, publish a course, and see
                the assistant answer from it.
              </p>
            </div>
            <div className="lbFinalActions">
              <Link className="lbBtn lbBtnPrimary" href="/auth/sign-in">
                Sign in <span aria-hidden="true">→</span>
              </Link>
              <a className="lbBtn lbBtnGhost" href="#demo">
                Watch it answer again
              </a>
            </div>
          </div>
        </div>
      </section>

      <footer className="lbFooter">
        <div className="lbWrap lbFooterInner">
          <Link className="lbBrand" href="/">
            <LearningBotMark />
            <b>LearningBot</b>
          </Link>
          <div className="lbFooterLinks">
            <a href="#demo">See it work</a>
            <a href="#foundation">Foundation</a>
            <Link href="/api/health">Service status</Link>
            <Link href="/auth/sign-in">Sign in</Link>
          </div>
          <p className="lbFooterLegal">© {new Date().getFullYear()} LearningBot</p>
        </div>
      </footer>
    </main>
  );
}

export default function HomePage() {
  return <PlatformLanding />;
}

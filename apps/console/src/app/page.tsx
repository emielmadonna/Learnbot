import Link from "next/link";
import { CorsoIcon } from "../components/corso/corso-icon";
import { CorsoMark } from "../components/corso/corso-mark";
import "./landing.css";

function CourseStill() {
  return (
    <div className="corsoStill" id="widget">
      <div className="corsoCommunityBar">
        <b>Freelance Pricing Lab</b>
        <span>Feed</span>
        <span data-active>Course</span>
        <span>Members</span>
      </div>
      <div className="corsoLesson">
        <p>Module 3</p>
        <h3>Pricing without flinching</h3>
        <div className="corsoLines" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </div>
        <div className="corsoVideo">lesson video</div>
      </div>
      <aside className="corsoWidget">
        <header>
          <span>
            <CorsoMark color="#fff" size={17} />
          </span>
          <div>
            <b>Pricing Lab Assistant</b>
            <small>Reads all 24 lessons</small>
          </div>
        </header>
        <div className="corsoMessages">
          <p data-person="student">
            How do I raise my rate after a year?
          </p>
          <div data-person="assistant">
            Lead with the value recap before the number. Name three results,
            state the rate <b>once</b>, give a start date.
            <span>
              <CorsoIcon name="learning" size={13} />
              Lesson 3.2 — The value recap
              <i>›</i>
            </span>
          </div>
        </div>
      </aside>
    </div>
  );
}

const plans = [
  {
    name: "Creator",
    description: "One course, one community.",
    price: "$39",
    note: "billed yearly · $49 monthly",
    features: [
      "1 workspace, unlimited lessons",
      "1,000 questions / month",
      "Full widget branding",
      "Insights and revision history",
    ],
    excludedFeatures: ["Signals"],
  },
  {
    name: "Studio",
    description: "Several courses, and the signals behind them.",
    price: "$99",
    note: "billed yearly · $124 monthly",
    featured: true,
    features: [
      "Up to 5 workspaces",
      "5,000 questions / month",
      "Signals and the students behind them",
      "Choose your AI model",
      "Circle and website installation",
    ],
    excludedFeatures: [] as string[],
  },
  {
    name: "Platform",
    description: "For agencies running assistants for clients.",
    price: "Talk to us",
    note: "from $600/month",
    features: [
      "Unlimited client workspaces",
      "Admin console and client preview",
      "Choose what each client sees",
      "Bring your own provider key",
      "Pooled volume across clients",
    ],
    excludedFeatures: [] as string[],
  },
];

export default function HomePage() {
  return (
    <main className="corsoLanding" data-ground="light">
      <header className="corsoNav">
        <nav className="corsoWrap" aria-label="Primary navigation">
          <Link className="corsoBrand" href="/" aria-label="Corso home">
            <CorsoMark size={21} />
            <b>Corso</b>
          </Link>
          <div className="corsoNavLinks">
            <a href="#how">How it works</a>
            <a href="#widget">The widget</a>
            <a href="#insights">Insights</a>
            <a href="#pricing">Pricing</a>
            <a href="#security">Security</a>
          </div>
          <div className="corsoNavActions">
            <Link href="/auth/sign-in">Sign in</Link>
            <Link className="corsoButton corsoPrimary corsoSmall" href="/auth/sign-in">
              Open Corso
            </Link>
          </div>
        </nav>
      </header>

      <section className="corsoHero">
        <div className="corsoHeroInner">
          <p className="corsoKicker">
            A course assistant for Circle communities
          </p>
          <h1>
            Your course,
            <br />
            answering.
          </h1>
          <p className="corsoHeroCopy">
            Corso reads the lessons you publish and answers your students
            inside your community — citing the exact lesson, or saying it
            doesn&apos;t know. You get back a running record of what everyone
            is stuck on.
          </p>
          <div className="corsoActions">
            <Link className="corsoButton corsoPrimary" href="/auth/sign-in">
              Open Corso
            </Link>
            <a className="corsoButton corsoSecondary" href="#widget">
              Watch it answer ›
            </a>
          </div>
          <p className="corsoNote">
            No card · one script tag · works with the course you already have
          </p>
        </div>
      </section>

      <div className="corsoWrap corsoStillWrap">
        <CourseStill />
      </div>

      <section className="corsoSection" id="how">
        <div className="corsoWrap">
          <div className="corsoSectionHead">
            <h2>Three things, in order</h2>
            <p>
              There is no fourth thing, and none of it happens outside your
              workspace.
            </p>
          </div>
          <div className="corsoSteps">
            <article>
              <span>
                <CorsoIcon name="learning" size={21} />
              </span>
              <h3>You publish your course</h3>
              <p>
                Write modules and lessons, or paste what you have. Publishing
                makes it answerable the same second — no ingestion queue.
                Every publish can be rolled back.
              </p>
            </article>
            <article>
              <span>
                <CorsoIcon name="conversation" size={21} />
              </span>
              <h3>Students ask, in your community</h3>
              <p>
                One script tag puts it on your Circle site in your name, your
                colour, your icon. It answers only from your lessons and names
                the ones it used. When you never covered it, it says so.
              </p>
            </article>
            <article>
              <span>
                <CorsoIcon name="results" size={21} />
              </span>
              <h3>You find out what they&apos;re stuck on</h3>
              <p>
                Every question is labelled as it lands. Repeats, refusals and
                unhelpful answers group into signals — the lesson to rewrite
                this week, and the student worth replying to yourself.
              </p>
            </article>
          </div>
        </div>
      </section>

      <section className="corsoSignals" id="insights">
        <div className="corsoWrap">
          <div>
            <p className="corsoMono">Signals</p>
            <h2>The questions are the product.</h2>
            <p>
              A support bot deflects tickets. Corso tells you what to teach
              next. Every refusal is a hole in your course; every repeated
              question is a lesson that isn&apos;t landing.
            </p>
            <p>
              And when one student asks eleven advanced questions in a week,
              you&apos;ll know before they churn — or before they&apos;d have
              said yes to your next offer.
            </p>
          </div>
          <div className="corsoSignalList">
            <article data-tone="alert">
              <h3>
                17 people wanted a rate-increase template you never wrote
              </h3>
              <p>
                Refused every time rather than invented. Six of them left
                instead of rephrasing.
              </p>
            </article>
            <article data-tone="good">
              <h3>Four students are asking past the end of your course</h3>
              <p>
                Retainers, hiring, when to stop doing the work. Your next
                product, described by the people who&apos;d buy it.
              </p>
            </article>
          </div>
        </div>
      </section>

      <section className="corsoPricing" id="pricing">
        <div className="corsoWrap">
          <div className="corsoSectionHead">
            <h2>Pricing</h2>
            <p>
              One workspace per course. Questions counted monthly, never cut
              off mid-answer.
            </p>
          </div>
          <div className="corsoPlans">
            {plans.map((plan) => (
              <article data-featured={plan.featured || undefined} key={plan.name}>
                {plan.featured ? <em>Most creators start here</em> : null}
                <h3>{plan.name}</h3>
                <p>{plan.description}</p>
                <div className="corsoPrice">
                  {plan.price}
                  {plan.name === "Platform" ? null : <span>/month</span>}
                </div>
                <small>{plan.note}</small>
                <Link
                  className={
                    plan.featured
                      ? "corsoButton corsoPrimary"
                      : "corsoButton corsoSecondary"
                  }
                  href="/auth/sign-in"
                >
                  {plan.name === "Platform" ? "Open platform" : "Sign in"}
                </Link>
                <ul>
                  {plan.features.map((feature) => (
                    <li key={feature}>✓ {feature}</li>
                  ))}
                  {plan.excludedFeatures.map((feature) => (
                    <li data-excluded key={feature}>
                      — {feature}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
          <p className="corsoPricingNote">
            Every plan includes the full security model. Overage is $0.02 a
            question — we never cut a student off mid-answer.
          </p>
        </div>
      </section>

      <section className="corsoFinal" id="security">
        <h2>Let the course answer for itself.</h2>
        <p>
          Publish one lesson and ask it a question. That&apos;s the whole
          evaluation.
        </p>
        <div className="corsoActions">
          <Link className="corsoButton corsoPrimary" href="/auth/sign-in">
            Open Corso
          </Link>
          <a className="corsoButton corsoSecondary" href="#how">
            See how it works
          </a>
        </div>
      </section>

      <footer className="corsoFooter">
        <div className="corsoWrap">
          <span>© {new Date().getFullYear()} Corso</span>
          <div>
            <span>Privacy</span>
            <a href="#security">Security</a>
            <Link href="/api/health">Status</Link>
            <Link href="/auth/sign-in">Sign in</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}

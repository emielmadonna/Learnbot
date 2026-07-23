import Link from "next/link";

const modules = [
  {
    name: "Conversation",
    description: "Text, voice, files, rich answers and diagrams in one thread.",
    status: "In progress",
    href: "/dev/chat"
  },
  {
    name: "Courses & Learning",
    description: "Upload, clean, organize, preview, publish and roll back.",
    status: "In progress",
    href: "/dev/learning"
  },
  {
    name: "Creator Console",
    description: "This Week, questions, confusion, Students and opportunities.",
    status: "Interactive",
    href: "/dev/creator"
  },
  {
    name: "Teacher Console",
    description: "Cohort pulse, learner questions, progress and safe follow-up.",
    status: "Interactive",
    href: "/dev/teacher"
  },
  {
    name: "Platform Admin",
    description: "Tenants, providers, budgets, audit, policy and MCP controls.",
    status: "Interactive",
    href: "/dev/admin"
  },
  {
    name: "Branding & Context",
    description: "Tenant identity, colors, voice, launcher and learning context.",
    status: "In progress",
    href: "/dev/branding"
  },
  {
    name: "MCP Control Plane",
    description: "The same safe operations for Codex and authorized agents.",
    status: "20 tools verified",
    href: "/dev/admin#mcp"
  }
];

export default function HomePage() {
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
          Local development
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">Shared integration surface</p>
          <h2>Build every learning experience against one trusted core.</h2>
          <p className="lede">
            This local console is the coordinated test surface for Student chat,
            course ingestion, Creator workflows, tenant administration and MCP.
          </p>
        </div>
        <aside className="sprint">
          <p className="eyebrow">Current sprint</p>
          <strong>Foundations + unified experience</strong>
          <p>One server · shared contracts · isolated module ownership</p>
        </aside>
      </section>

      <section aria-labelledby="modules-heading">
        <div className="sectionHeading">
          <div>
            <p className="eyebrow">Parallel modules</p>
            <h2 id="modules-heading">Build map</h2>
          </div>
          <p>Routes will appear here as each bounded module lands.</p>
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
    </main>
  );
}

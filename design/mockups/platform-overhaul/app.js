const directions = {
  health: {
    label: "Health",
    description: "One calm, useful summary",
  },
};

const screens = {
  landing: "Landing",
  portfolio: "Workspaces",
  admin: "Client admin",
  client: "Client view",
  brand: "Bot & brand",
};

const state = {
  direction: "health",
  screen: new URLSearchParams(location.search).get("screen") || "portfolio",
  theme: new URLSearchParams(location.search).get("theme") || "light",
};

function icon(name, size = 18) {
  const icons = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5M9 21v-7h6v7"/>',
    bot: '<rect x="4" y="6" width="16" height="13" rx="4"/><path d="M9 11h.01M15 11h.01M9 15h6M12 6V3"/><circle cx="12" cy="2.5" r=".5"/>',
    book: '<path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H11v18H7.5A3.5 3.5 0 0 0 4 23.5zM20 5.5A3.5 3.5 0 0 0 16.5 2H13v18h3.5a3.5 3.5 0 0 1 3.5 3.5z"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    signal: '<path d="M4 18v2M8 14v6M12 10v10M16 6v14M20 2v18"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.2 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2v-4h.5A1.7 1.7 0 0 0 4.2 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 8.6 4.2a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V2h4v.5A1.7 1.7 0 0 0 15 4.2a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 8.6a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.9v4h-.9a1.7 1.7 0 0 0-1.7 1z"/>',
    people: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 18v2h16v-2"/>',
    sparkle: '<path d="m12 3 1.1 3.9L17 8l-3.9 1.1L12 13l-1.1-3.9L7 8l3.9-1.1zM19 14l.7 2.3L22 17l-2.3.7L19 20l-.7-2.3L16 17l2.3-.7zM5 14l.6 1.7 1.7.6-1.7.6L5 19l-.6-2.1-1.7-.6 1.7-.6z"/>',
    eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    external: '<path d="M14 3h7v7M10 14 21 3"/><path d="M21 14v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h6"/>',
    moon: '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3 6.7 6.7 0 0 0 21 12.8z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/>',
    palette: '<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2a10 10 0 0 0 0 20h1.5a2 2 0 0 0 0-4H12a2 2 0 0 1 0-4h4a6 6 0 0 0 0-12z"/>',
    layers: '<path d="m12 2 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
    alert: '<path d="M12 3 2.5 20h19z"/><path d="M12 9v4M12 17h.01"/>',
    logout: '<path d="M10 17l5-5-5-5M15 12H3"/><path d="M14 3h7v18h-7"/>',
  };
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.sparkle}</svg>`;
}

function brandMark() {
  return `<span class="brand-mark"><i></i><i></i><i></i></span>`;
}

function avatar(initials, color = "") {
  return `<span class="avatar" ${color ? `style="--avatar:${color}"` : ""}>${initials}</span>`;
}

function prototypeBar() {
  return `
    <header class="prototype-bar">
      <div class="prototype-identity">
        ${brandMark()}
        <div>
          <strong>LearningBot</strong>
          <span>Health-inspired system</span>
        </div>
      </div>
      <div class="prototype-controls">
        <div class="control-group screen-control" aria-label="Screen">
          ${Object.entries(screens)
            .map(
              ([key, label]) => `
                <button data-screen="${key}" class="${state.screen === key ? "active" : ""}">${label}</button>`,
            )
            .join("")}
        </div>
        <button class="theme-toggle" data-theme-toggle aria-label="Toggle light or dark mode">
          ${state.theme === "light" ? icon("moon", 17) : icon("sun", 17)}
          <span>${state.theme === "light" ? "Dark" : "Light"}</span>
        </button>
      </div>
    </header>`;
}

function appHeader({ admin = true, clientView = false, simple = false } = {}) {
  if (simple) {
    return `
      <header class="public-nav">
        <a class="product-brand" href="#">
          ${brandMark()}<strong>LearningBot</strong>
        </a>
        <nav><a href="#product">Product</a><a href="#how">How it works</a><a href="#security">Security</a></nav>
        <div class="nav-actions"><button class="btn ghost">Sign in</button><button class="btn primary">Book a demo</button></div>
      </header>`;
  }
  return `
    <header class="app-topbar">
      <div class="product-brand">
        ${brandMark()}<strong>LearningBot</strong>
        ${admin ? '<span class="role-pill">Admin</span>' : ""}
      </div>
      <div class="topbar-context">
        ${admin ? '<button class="context-back" data-screen="portfolio">' + icon("back", 16) + "All workspaces</button>" : ""}
        <span class="context-client">${avatar("ES", "#ff6b4a")}<b>Estie Starr</b></span>
      </div>
      <div class="topbar-actions">
        ${admin ? `
          <div class="view-switch">
            <button class="${clientView ? "" : "active"}" data-screen="admin">Admin view</button>
            <button class="${clientView ? "active" : ""}" data-screen="client">${icon("eye", 15)}Client view</button>
          </div>` : ""}
        <button class="icon-button">${icon(state.theme === "light" ? "moon" : "sun", 18)}</button>
        ${avatar(admin ? "EM" : "ES")}
      </div>
    </header>`;
}

const navItems = [
  ["home", "Overview"],
  ["bot", "Bot"],
  ["book", "Learning"],
  ["chart", "Analytics"],
  ["signal", "Signals"],
];

function clientSidebar(active = "Overview", admin = true, clientView = false) {
  return `
    <aside class="client-sidebar">
      <div class="sidebar-client">
        <span class="client-logo">${avatar("ES", "#ff6b4a")}</span>
        <div><strong>Estie Starr</strong><small>estie-starr</small></div>
        ${icon("chevron", 16)}
      </div>
      <nav class="side-nav">
        <p>Workspace</p>
        ${navItems
          .map(([iconName, label]) => {
            const disabledForClient = clientView && label === "Signals";
            if (disabledForClient) return "";
            return `<a class="${active === label ? "active" : ""}" href="#">${icon(iconName, 18)}<span>${label}</span>${label === "Signals" && admin ? '<em>Off for client</em>' : ""}</a>`;
          })
          .join("")}
        ${admin && !clientView ? `
          <p>Manage</p>
          <a class="${active === "Workspace settings" ? "active" : ""}" data-screen="brand" href="#">${icon("settings", 18)}<span>Workspace settings</span></a>
        ` : ""}
      </nav>
      <div class="sidebar-foot">
        <div class="help-card">
          ${icon("sparkle", 18)}
          <div><strong>Need help?</strong><span>Talk to support</span></div>
        </div>
      </div>
    </aside>`;
}

function trendChart() {
  return `
    <div class="chart-wrap" aria-label="Questions over the last 30 days">
      <div class="chart-grid"><i></i><i></i><i></i><i></i></div>
      <svg viewBox="0 0 660 170" preserveAspectRatio="none" role="img">
        <defs>
          <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--accent)" stop-opacity=".26"/>
            <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path class="chart-area" d="M0 150 C60 145 70 115 120 122 S185 137 230 101 S300 78 345 94 S410 112 448 73 S525 42 560 63 S620 46 660 20 L660 170 L0 170 Z"/>
        <path class="chart-line" d="M0 150 C60 145 70 115 120 122 S185 137 230 101 S300 78 345 94 S410 112 448 73 S525 42 560 63 S620 46 660 20"/>
      </svg>
      <div class="chart-labels"><span>Jul 1</span><span>Jul 8</span><span>Jul 15</span><span>Jul 22</span><span>Jul 29</span></div>
    </div>`;
}

function landingScreen() {
  return `
    <div class="public-page">
      ${appHeader({ simple: true })}
      <main>
        <section class="hero">
          <div class="hero-copy">
            <span class="eyebrow">The AI learning layer for your business</span>
            <h1>Turn what you know into help that scales.</h1>
            <p>Give every client a beautifully branded AI guide—trained on your content, improving from every question, and simple enough to manage in minutes.</p>
            <div class="hero-actions"><button class="btn primary large">Book a demo ${icon("arrow", 18)}</button><button class="btn ghost large">See the product</button></div>
            <div class="trust-row"><span>${icon("check", 14)}Answers cite your material</span><span>${icon("check", 14)}Your data stays private</span><span>${icon("check", 14)}No code required</span></div>
          </div>
          <div class="hero-product">
            <div class="hero-glow"></div>
            <div class="mini-app">
              <div class="mini-top">${avatar("ES", "#ff6b4a")}<strong>Ask Estie</strong><span>Online</span><button>${icon("more", 16)}</button></div>
              <div class="mini-conversation">
                <div class="mini-bot">${avatar("ES", "#ff6b4a")}<p>Hi Maya—what are you working through today?</p></div>
                <div class="mini-user"><p>How should I price a brand strategy project?</p></div>
                <div class="mini-bot">${avatar("ES", "#ff6b4a")}<div><p>Start with the value of the decision, not the hours. For a strategy engagement, Estie recommends:</p><ol><li>Define the business outcome</li><li>Price the decision, not the deliverable</li><li>Offer 3 clear levels</li></ol><span class="source-chip">${icon("book", 13)}Pricing Masterclass · Lesson 4</span></div></div>
              </div>
              <div class="mini-composer"><span>Ask anything about the program…</span><button>${icon("arrow", 17)}</button></div>
            </div>
            <div class="floating-note note-one"><span class="note-icon">${icon("sparkle", 16)}</span><div><b>18 questions answered</b><small>this week</small></div></div>
            <div class="floating-note note-two"><span class="note-icon">${icon("signal", 16)}</span><div><b>New signal found</b><small>Pricing confidence</small></div></div>
          </div>
        </section>
        <section class="logo-strip"><span>Built for experts, educators, and communities</span><div><b>CURIOUS</b><b>Northstar</b><b>Fieldnotes</b><b>BRIGHT / CO</b><b>STUDIO NINE</b></div></section>
      </main>
    </div>`;
}

function portfolioScreen() {
  const clients = [
    { name: "Estie Starr", slug: "estie-starr", initials: "ES", color: "#ff6b4a", status: "Healthy", questions: "1,284", learning: "126", last: "12 min ago", modules: ["Bot", "Learning", "Analytics"] },
    { name: "Creator Accelerator", slug: "creator-accelerator", initials: "CA", color: "#7c5cff", status: "Healthy", questions: "842", learning: "94", last: "1 hr ago", modules: ["Bot", "Learning", "Analytics", "Signals"] },
    { name: "Pricing Lab", slug: "pricing-lab", initials: "PL", color: "#18a56d", status: "Needs review", questions: "309", learning: "42", last: "Yesterday", modules: ["Bot", "Learning"] },
    { name: "Launch School", slug: "launch-school", initials: "LS", color: "#3185ff", status: "Draft", questions: "—", learning: "8", last: "3 days ago", modules: ["Bot"] },
  ];
  return `
    <div class="app-page portfolio-page">
      <header class="app-topbar portfolio-topbar">
        <div class="product-brand">${brandMark()}<strong>LearningBot</strong><span class="role-pill">Admin</span></div>
        <div class="topbar-actions"><button class="icon-button">${icon("search", 18)}</button><button class="icon-button">${icon(state.theme === "light" ? "moon" : "sun", 18)}</button>${avatar("EM")}</div>
      </header>
      <main class="portfolio-main">
        <div class="page-heading portfolio-heading">
          <div><span class="eyebrow">Admin portfolio</span><h1>Client workspaces</h1><p>Open a client to manage their bot, content, access, and reporting.</p></div>
          <button class="btn primary">${icon("plus", 17)} Add client</button>
        </div>
        <div class="portfolio-toolbar">
          <div class="search-field">${icon("search", 17)}<span>Search clients</span><kbd>⌘ K</kbd></div>
          <div class="filter-group"><button class="chip active">All <b>4</b></button><button class="chip">Healthy <b>2</b></button><button class="chip">Needs attention <b>1</b></button><button class="chip">Draft <b>1</b></button></div>
        </div>
        <div class="workspace-list">
          <div class="workspace-list-head"><span>Client</span><span>Usage</span><span>Learning</span><span>Client sees</span><span>Last activity</span><span></span></div>
          ${clients
            .map(
              (client) => `
            <article class="workspace-row" data-screen="admin">
              <div class="workspace-client">${avatar(client.initials, client.color)}<div><strong>${client.name}</strong><span>${client.slug}</span></div><em class="status ${client.status.toLowerCase().replaceAll(" ", "-")}"><i></i>${client.status}</em></div>
              <div class="row-metric"><strong>${client.questions}</strong><span>questions</span></div>
              <div class="row-metric"><strong>${client.learning}</strong><span>items</span></div>
              <div class="module-stack">${client.modules.map((m) => `<span>${m}</span>`).join("")}</div>
              <div class="row-activity"><strong>${client.last}</strong><span>ago</span></div>
              <button class="row-open" aria-label="Open ${client.name}">${icon("chevron", 18)}</button>
            </article>`,
            )
            .join("")}
        </div>
        <div class="portfolio-summary"><span><i class="online-dot"></i>All systems operational</span><span>4 client workspaces</span><span>2,435 questions this month</span></div>
      </main>
    </div>`;
}

function adminScreen() {
  return `
    <div class="app-page client-page">
      ${appHeader({ admin: true })}
      <div class="workspace-shell">
        ${clientSidebar("Overview", true, false)}
        <main class="workspace-main">
          <div class="page-heading client-heading">
            <div><span class="eyebrow">Estie Starr · Admin view</span><h1>Good morning, Emiel.</h1><p>Here’s what’s happening across this client workspace.</p></div>
            <div class="heading-actions"><button class="btn ghost">${icon("external", 16)} Open bot</button><button class="btn primary" data-screen="brand">${icon("settings", 16)} Manage workspace</button></div>
          </div>
          <section class="health-strip">
            <div><span class="health-icon healthy">${icon("check", 17)}</span><p><strong>Bot is live</strong><small>Last checked 3 min ago</small></p></div>
            <div><span class="health-icon">${icon("book", 17)}</span><p><strong>126 learning items</strong><small>3 added this week</small></p></div>
            <div><span class="health-icon">${icon("people", 17)}</span><p><strong>384 active learners</strong><small>+12% this month</small></p></div>
            <div class="client-visibility"><span>Client access</span><strong>Bot, Learning, Analytics</strong><button data-screen="brand">Manage</button></div>
          </section>
          <section class="metric-grid">
            <article class="metric-card"><span>Questions answered</span><strong>1,284</strong><em class="up">↗ 18.4%</em><small>Last 30 days</small></article>
            <article class="metric-card"><span>Helpful answers</span><strong>91.8%</strong><em class="up">↗ 3.2%</em><small>From 428 ratings</small></article>
            <article class="metric-card"><span>Unanswered</span><strong>38</strong><em class="warn">Needs review</em><small>Potential learning gaps</small></article>
            <article class="metric-card"><span>Active learners</span><strong>384</strong><em class="up">↗ 12.1%</em><small>Last 30 days</small></article>
          </section>
          <section class="dashboard-grid">
            <article class="card activity-card">
              <div class="card-head"><div><span class="eyebrow">Usage</span><h2>Questions are growing steadily</h2></div><button class="text-button">View analytics ${icon("chevron", 15)}</button></div>
              ${trendChart()}
            </article>
            <article class="card attention-card">
              <div class="card-head"><div><span class="eyebrow">Needs attention</span><h2>3 things to review</h2></div></div>
              <div class="attention-list">
                <a><span class="attention-icon danger">${icon("alert", 17)}</span><div><strong>38 unanswered questions</strong><small>Most relate to pricing objections</small></div>${icon("chevron", 16)}</a>
                <a><span class="attention-icon">${icon("book", 17)}</span><div><strong>2 learning items are drafts</strong><small>Ready to publish</small></div>${icon("chevron", 16)}</a>
                <a><span class="attention-icon">${icon("signal", 17)}</span><div><strong>New learner signal</strong><small>“Confidence after the sales call”</small></div>${icon("chevron", 16)}</a>
              </div>
            </article>
          </section>
        </main>
      </div>
    </div>`;
}

function clientScreen() {
  return `
    <div class="app-page client-page">
      ${appHeader({ admin: true, clientView: true })}
      <div class="preview-banner">${icon("eye", 16)}You’re viewing exactly what this client sees.<button data-screen="admin">Return to admin view</button></div>
      <div class="workspace-shell client-preview-shell">
        ${clientSidebar("Overview", true, true)}
        <main class="workspace-main">
          <div class="page-heading client-heading">
            <div><span class="eyebrow">Estie Starr</span><h1>Welcome back, Estie.</h1><p>Your bot is learning, answering, and showing you where clients need more support.</p></div>
            <div class="heading-actions"><button class="btn ghost">${icon("external", 16)} Open bot</button><button class="btn primary">${icon("plus", 16)} Add learning</button></div>
          </div>
          <section class="client-hero-card">
            <div class="client-bot-profile">
              <span class="large-avatar">${avatar("ES", "#ff6b4a")}<i class="online-dot"></i></span>
              <div><span class="eyebrow">Your bot</span><h2>Ask Estie</h2><p>Live and answering from 126 approved learning items.</p></div>
            </div>
            <div class="client-bot-actions"><button class="btn inverse">${icon("bot", 17)} Configure bot</button><button class="btn subtle">${icon("eye", 17)} Preview</button></div>
            <div class="client-bot-stat"><strong>91.8%</strong><span>helpful</span></div>
          </section>
          <section class="client-action-grid">
            <article class="action-card learning-action"><span class="action-art">${icon("upload", 26)}</span><div><span class="eyebrow">Learning</span><h2>Teach your bot something new</h2><p>Add a document, video, link, or write directly in LearningBot.</p><button class="text-button">Add learning ${icon("arrow", 16)}</button></div></article>
            <article class="action-card"><span class="action-art">${icon("chart", 26)}</span><div><span class="eyebrow">Analytics</span><h2>1,284 questions answered</h2><p>Usage is up 18% from the previous 30 days.</p><button class="text-button">View analytics ${icon("arrow", 16)}</button></div></article>
          </section>
          <section class="card recent-card">
            <div class="card-head"><div><span class="eyebrow">Recent activity</span><h2>What your learners are asking</h2></div><button class="text-button">View all ${icon("chevron", 15)}</button></div>
            <div class="question-list">
              <div><span class="question-avatar">M</span><p><strong>How do I price a strategy engagement?</strong><small>Answered from Pricing Masterclass · 4 min ago</small></p><em>Helpful</em></div>
              <div><span class="question-avatar">J</span><p><strong>What should I say when a client pushes back?</strong><small>Answered from Objection Playbook · 18 min ago</small></p><em>Helpful</em></div>
              <div><span class="question-avatar">A</span><p><strong>Can you help me structure my discovery call?</strong><small>Answered from Sales Foundations · 34 min ago</small></p><em>Helpful</em></div>
            </div>
          </section>
        </main>
      </div>
    </div>`;
}

function toggleRow(label, copy, on = true, locked = false) {
  return `<div class="toggle-row"><div><strong>${label}</strong><span>${copy}</span></div><button class="switch ${on ? "on" : ""}" ${locked ? "disabled" : ""}><i></i></button></div>`;
}

function brandScreen() {
  return `
    <div class="app-page client-page">
      ${appHeader({ admin: true })}
      <div class="workspace-shell">
        ${clientSidebar("Workspace settings", true, false)}
        <main class="workspace-main settings-main">
          <div class="page-heading settings-heading">
            <div><span class="eyebrow">Estie Starr · Admin view</span><h1>Workspace settings</h1><p>Choose what this client can use and make their bot unmistakably theirs.</p></div>
            <div class="save-state">${icon("check", 15)}All changes saved</div>
          </div>
          <div class="settings-layout">
            <div class="settings-column">
              <section class="card settings-card">
                <div class="settings-card-head"><div><span class="eyebrow">Client access</span><h2>What the client sees</h2><p>Admin analytics remain available even when a section is hidden here.</p></div></div>
                ${toggleRow("Bot", "Configure and preview their assistant", true, true)}
                ${toggleRow("Learning", "Add, edit, and publish learning material", true)}
                ${toggleRow("Analytics", "See usage, helpfulness, and unanswered questions", true)}
                ${toggleRow("Signals", "See patterns and opportunities found in conversations", false)}
              </section>
              <section class="card settings-card">
                <div class="settings-card-head"><div><span class="eyebrow">Bot identity</span><h2>Make it theirs</h2></div><button class="text-button">Reset</button></div>
                <div class="identity-editor">
                  <button class="logo-upload">${avatar("ES", "#ff6b4a")}<span>${icon("upload", 15)}</span></button>
                  <div class="field-grid">
                    <label><span>Bot name</span><div class="input">Ask Estie</div></label>
                    <label><span>Workspace name</span><div class="input">Estie Starr</div></label>
                  </div>
                </div>
                <label class="full-field"><span>Welcome message</span><div class="textarea">Hi—I'm Estie's AI guide. Ask me anything about pricing, positioning, or building your creative business.</div></label>
                <div class="color-row">
                  <label><span>Brand color</span><div class="color-input"><i style="background:#ff6b4a"></i><b>#FF6B4A</b></div></label>
                  <label><span>Default appearance</span><div class="segmented"><button>System</button><button class="active">Light</button><button>Dark</button></div></label>
                </div>
              </section>
            </div>
            <aside class="preview-column">
              <div class="preview-head"><div><span class="eyebrow">Live preview</span><h2>Client bot</h2></div><div class="segmented mini"><button class="active">Light</button><button>Dark</button></div></div>
              <div class="bot-preview">
                <div class="bot-preview-top">${avatar("ES", "#ff6b4a")}<div><strong>Ask Estie</strong><span><i></i>Online</span></div><button>${icon("more", 17)}</button></div>
                <div class="bot-preview-body">
                  <div class="bot-preview-message"><span>${avatar("ES", "#ff6b4a")}</span><p>Hi—I'm Estie's AI guide. Ask me anything about pricing, positioning, or building your creative business.</p></div>
                  <div class="prompt-chips"><button>How do I raise my rates?</button><button>Help me price a project</button><button>What makes a strong offer?</button></div>
                </div>
                <div class="bot-preview-input"><span>Ask a question…</span><button>${icon("arrow", 17)}</button></div>
                <small class="powered">Powered by LearningBot</small>
              </div>
              <button class="btn ghost full">${icon("external", 16)} Open full preview</button>
            </aside>
          </div>
        </main>
      </div>
  </div>`;
}

/* -------------------------------------------------------------------------- */
/* Apple Health–inspired revision                                             */
/* -------------------------------------------------------------------------- */

function healthTopbar({ client = false, clientView = false } = {}) {
  return `
    <header class="health-topbar">
      <div class="health-wordmark">${brandMark()}<strong>LearningBot</strong></div>
      ${
        client
          ? `<button class="health-context" data-screen="portfolio">${icon("back", 16)}<span>Workspaces</span></button>`
          : `<span></span>`
      }
      <div class="health-top-actions">
        ${
          client
            ? `<div class="health-view-switch">
                <button class="${clientView ? "" : "active"}" data-screen="admin">Admin</button>
                <button class="${clientView ? "active" : ""}" data-screen="client">Client view</button>
              </div>`
            : `<button class="health-circle-button" aria-label="Search">${icon("search", 18)}</button>`
        }
        <button class="health-circle-button" data-theme-toggle-inner aria-label="Appearance">${icon(state.theme === "light" ? "moon" : "sun", 17)}</button>
        ${avatar("EM")}
      </div>
    </header>`;
}

function healthWorkspaceNav(active = "Summary", clientView = false) {
  const items = clientView
    ? ["Summary", "Bot", "Learning", "Analytics"]
    : ["Summary", "Bot", "Learning", "Analytics", "Signals"];
  return `
    <div class="health-workspace-bar">
      <div class="health-client-identity">${avatar("ES", "#ff6b55")}<div><strong>Estie Starr</strong><span>${clientView ? "Client view" : "Admin view"}</span></div></div>
      <nav class="health-tabs" aria-label="Workspace">
        ${items.map((item) => `<button class="${item === active ? "active" : ""}">${item}${item === "Signals" ? "<i>Off</i>" : ""}</button>`).join("")}
      </nav>
      <button class="health-settings-button ${active === "Settings" ? "active" : ""}" data-screen="brand" aria-label="Workspace settings">${icon("settings", 18)}</button>
    </div>`;
}

function healthMiniBars(values, color = "var(--health-blue)") {
  return `<div class="health-mini-bars" style="--bar-color:${color}">${values
    .map((value) => `<i style="height:${value}%"></i>`)
    .join("")}</div>`;
}

function healthLandingScreen() {
  return `
    <div class="health-page health-landing">
      <header class="health-public-nav">
        <div class="health-wordmark">${brandMark()}<strong>LearningBot</strong></div>
        <nav><a>Product</a><a>How it works</a><a>Privacy</a></nav>
        <div><button class="health-link-button">Sign in</button><button class="health-blue-button">Book a demo</button></div>
      </header>
      <main>
        <section class="health-hero">
          <p>AI guidance, grounded in what you teach.</p>
          <h1>Your knowledge.<br/>Always there.</h1>
          <div class="health-hero-copy">Give every client a private AI guide that answers from your work, learns from every question, and feels completely yours.</div>
          <div class="health-hero-actions"><button class="health-blue-button large">Book a demo</button><button class="health-text-cta">See how it works ${icon("chevron", 15)}</button></div>
          <div class="health-product-stage">
            <div class="health-product-glow"></div>
            <div class="health-product-window">
              <div class="health-product-header">${avatar("ES", "#ff6b55")}<div><strong>Ask Estie</strong><span><i></i> Available</span></div><button>${icon("more", 18)}</button></div>
              <div class="health-product-chat">
                <div class="health-chat-response"><span>${avatar("ES", "#ff6b55")}</span><p>Hi Maya. What are you working through today?</p></div>
                <div class="health-chat-question">How should I price a strategy engagement?</div>
                <div class="health-chat-response answer"><span>${avatar("ES", "#ff6b55")}</span><div><p>Start with the value of the decision, not the hours.</p><ol><li>Define the business outcome.</li><li>Price the decision.</li><li>Offer three clear levels.</li></ol><small>${icon("book", 13)} Pricing Masterclass · Lesson 4</small></div></div>
              </div>
              <div class="health-product-input"><span>Ask anything about the program</span><button>${icon("arrow", 17)}</button></div>
            </div>
            <div class="health-floating-card health-floating-left"><span>${icon("check", 17)}</span><div><strong>Grounded answer</strong><small>2 approved sources</small></div></div>
            <div class="health-floating-card health-floating-right"><span>${icon("chart", 17)}</span><div><strong>92% helpful</strong><small>Last 30 days</small></div></div>
          </div>
        </section>
      </main>
    </div>`;
}

function healthWorkspaceCard(client) {
  const statusClass = client.tone === "warning" ? "warning" : client.tone === "setup" ? "setup" : "live";
  return `
    <article class="health-workspace-card ${statusClass}" data-screen="admin" style="--client-color:${client.color}">
      <div class="health-workspace-card-top">
        ${avatar(client.initials, client.color)}
        <span class="health-status"><i></i>${client.status}</span>
        <button aria-label="Open ${client.name}">${icon("chevron", 18)}</button>
      </div>
      <div class="health-workspace-copy">
        <h2>${client.name}</h2>
        <p>${client.message}</p>
      </div>
      ${
        client.tone === "setup"
          ? `<div class="health-setup-progress"><span><i style="width:68%"></i></span><strong>68% complete</strong></div>`
          : `<div class="health-workspace-metric"><strong>${client.metric}</strong><span>${client.metricLabel}</span>${healthMiniBars(client.bars, client.color)}</div>`
      }
      <div class="health-workspace-footer"><span>${client.footer}</span><span>${client.updated}</span></div>
    </article>`;
}

function healthPortfolioScreen() {
  const clients = [
    {
      name: "Estie Starr",
      initials: "ES",
      color: "#ff6b55",
      status: "Live",
      message: "Everything is working.",
      metric: "1,284",
      metricLabel: "questions this month",
      bars: [30, 46, 39, 54, 48, 67, 73, 62, 79, 88],
      footer: "Ask Estie",
      updated: "Active 12m ago",
    },
    {
      name: "Creator Accelerator",
      initials: "CA",
      color: "#8a63e8",
      status: "Live",
      message: "Everything is working.",
      metric: "842",
      metricLabel: "questions this month",
      bars: [25, 30, 42, 39, 48, 55, 52, 61, 66, 72],
      footer: "Creator Coach",
      updated: "Active 1h ago",
    },
    {
      name: "Pricing Lab",
      initials: "PL",
      color: "#ff9f0a",
      status: "Review",
      tone: "warning",
      message: "12 questions need learning.",
      metric: "309",
      metricLabel: "questions this month",
      bars: [46, 40, 52, 45, 58, 39, 48, 43, 40, 36],
      footer: "Pricing Guide",
      updated: "Active yesterday",
    },
    {
      name: "Launch School",
      initials: "LS",
      color: "#0a84ff",
      status: "Setup",
      tone: "setup",
      message: "Finish the essentials to go live.",
      footer: "Launch Guide",
      updated: "Updated 3d ago",
    },
  ];
  return `
    <div class="health-page">
      ${healthTopbar()}
      <main class="health-portfolio-main">
        <div class="health-large-title">
          <div><p>Admin</p><h1>Workspaces</h1></div>
          <button class="health-blue-button">${icon("plus", 17)} Add client</button>
        </div>
        <div class="health-search">${icon("search", 18)}<span>Search workspaces</span></div>
        <div class="health-section-title"><h2>Clients</h2><span>4</span></div>
        <section class="health-workspace-grid">
          ${clients.map(healthWorkspaceCard).join("")}
        </section>
      </main>
    </div>`;
}

function healthAdminScreen() {
  return `
    <div class="health-page">
      ${healthTopbar({ client: true })}
      ${healthWorkspaceNav("Summary", false)}
      <main class="health-summary-main">
        <div class="health-summary-title"><div><p>Thursday, July 30</p><h1>Summary</h1></div><button class="health-edit-button">Edit</button></div>
        <section>
          <div class="health-section-title"><h2>Pinned</h2></div>
          <div class="health-summary-grid">
            <article class="health-summary-card health-bot-card">
              <div class="health-card-label"><span class="health-category-icon blue">${icon("bot", 18)}</span><b>Bot</b><button>${icon("chevron", 17)}</button></div>
              <div class="health-bot-status"><span><i></i>Live</span><h2>Ask Estie is ready.</h2><p>Answering from 126 approved learning items.</p></div>
              <div class="health-card-foot"><span>Checked 3 minutes ago</span><button>Open bot</button></div>
            </article>
            <article class="health-summary-card health-question-card">
              <div class="health-card-label"><span class="health-category-icon coral">${icon("chart", 18)}</span><b>Questions</b><button>${icon("chevron", 17)}</button></div>
              <div class="health-big-metric"><strong>1,284</strong><span>Last 30 days</span></div>
              ${healthMiniBars([28,42,35,48,43,61,70,58,77,88], "#ff6b55")}
              <p class="health-trend up">↑ 18% from the previous 30 days</p>
            </article>
            <article class="health-summary-card health-small-card">
              <div class="health-card-label"><span class="health-category-icon green">${icon("check", 18)}</span><b>Helpful answers</b><button>${icon("chevron", 17)}</button></div>
              <div class="health-big-metric"><strong>92%</strong><span>428 ratings</span></div>
              <p class="health-trend up">↑ 3% this month</p>
            </article>
            <article class="health-summary-card health-small-card">
              <div class="health-card-label"><span class="health-category-icon purple">${icon("book", 18)}</span><b>Learning</b><button>${icon("chevron", 17)}</button></div>
              <div class="health-big-metric"><strong>126</strong><span>approved items</span></div>
              <p class="health-trend">3 added this week</p>
            </article>
          </div>
        </section>
        <section class="health-highlights">
          <div class="health-section-title"><h2>Highlights</h2><button>Show All</button></div>
          <article class="health-highlight-card">
            <div><span class="health-category-icon orange">${icon("sparkle", 18)}</span><p>LEARNING OPPORTUNITY</p><h2>Clients are asking about pricing objections more often.</h2><span>38 questions could be answered by one new learning item.</span></div>
            <button>Review questions ${icon("chevron", 15)}</button>
          </article>
        </section>
      </main>
    </div>`;
}

function healthClientScreen() {
  return `
    <div class="health-page">
      ${healthTopbar({ client: true, clientView: true })}
      <div class="health-preview-notice">${icon("eye", 15)}You’re seeing exactly what Estie sees.<button data-screen="admin">Exit client view</button></div>
      ${healthWorkspaceNav("Summary", true)}
      <main class="health-summary-main client">
        <div class="health-summary-title"><div><p>Thursday, July 30</p><h1>Summary</h1></div></div>
        <section>
          <div class="health-section-title"><h2>Pinned</h2></div>
          <div class="health-client-grid">
            <article class="health-summary-card health-client-bot-card">
              <div class="health-card-label"><span class="health-category-icon coral">${icon("bot", 18)}</span><b>Your bot</b><button>${icon("chevron", 17)}</button></div>
              <div class="health-client-bot">
                <span class="health-large-client-avatar">${avatar("ES", "#ff6b55")}<i></i></span>
                <div><h2>Ask Estie</h2><p>Live and ready to help your clients.</p></div>
              </div>
              <div class="health-card-foot"><span>126 learning items</span><button>Configure</button></div>
            </article>
            <article class="health-summary-card health-add-learning">
              <div class="health-card-label"><span class="health-category-icon blue">${icon("book", 18)}</span><b>Learning</b><button>${icon("chevron", 17)}</button></div>
              <h2>Teach your bot something new.</h2>
              <p>Add a document, video, link, or write it here.</p>
              <button class="health-blue-button">${icon("plus", 16)} Add learning</button>
            </article>
            <article class="health-summary-card health-client-analytics">
              <div class="health-card-label"><span class="health-category-icon green">${icon("chart", 18)}</span><b>Questions</b><button>${icon("chevron", 17)}</button></div>
              <div class="health-big-metric"><strong>1,284</strong><span>Last 30 days</span></div>
              ${healthMiniBars([28,42,35,48,43,61,70,58,77,88], "#28a86b")}
              <p class="health-trend up">↑ 18% this month</p>
            </article>
          </div>
        </section>
        <section class="health-highlights">
          <div class="health-section-title"><h2>Highlights</h2><button>Show All</button></div>
          <article class="health-highlight-card client-highlight">
            <div><span class="health-category-icon purple">${icon("sparkle", 18)}</span><p>THIS WEEK</p><h2>Your bot helped 87 people.</h2><span>Pricing and discovery calls were the most common topics.</span></div>
            <button>View analytics ${icon("chevron", 15)}</button>
          </article>
        </section>
      </main>
    </div>`;
}

function healthSettingRow(iconName, tone, title, value, extra = "") {
  return `<button class="health-setting-row"><span class="health-category-icon ${tone}">${icon(iconName, 17)}</span><div><strong>${title}</strong>${extra ? `<small>${extra}</small>` : ""}</div><em>${value}</em>${icon("chevron", 16)}</button>`;
}

function healthBrandScreen() {
  return `
    <div class="health-page">
      ${healthTopbar({ client: true })}
      ${healthWorkspaceNav("Settings", false)}
      <main class="health-settings-main">
        <div class="health-summary-title"><div><p>Estie Starr</p><h1>Workspace settings</h1></div></div>
        <div class="health-settings-grid">
          <div class="health-settings-lists">
            <section>
              <div class="health-section-title"><h2>Client access</h2></div>
              <div class="health-settings-group">
                ${healthSettingRow("bot", "blue", "Bot", "On")}
                ${healthSettingRow("book", "purple", "Learning", "On")}
                ${healthSettingRow("chart", "green", "Analytics", "On")}
                ${healthSettingRow("signal", "orange", "Signals", "Off")}
              </div>
              <p class="health-settings-note">You always see every section. This only changes what the client sees.</p>
            </section>
            <section>
              <div class="health-section-title"><h2>Bot & appearance</h2></div>
              <div class="health-settings-group">
                ${healthSettingRow("bot", "coral", "Bot identity", "Ask Estie", "Name, avatar, and welcome message")}
                ${healthSettingRow("palette", "purple", "Brand color", "#FF6B55")}
                ${healthSettingRow("sun", "blue", "Appearance", "System")}
              </div>
            </section>
          </div>
          <aside class="health-live-preview">
            <div class="health-section-title"><h2>Preview</h2><button>Open</button></div>
            <div class="health-phone">
              <div class="health-phone-bar"><span></span><b>Ask Estie</b><button>${icon("more", 16)}</button></div>
              <div class="health-phone-body">
                <span>${avatar("ES", "#ff6b55")}</span>
                <p>Hi—I'm Estie's AI guide. Ask me anything about pricing, positioning, or building your creative business.</p>
                <button>How do I raise my rates?</button>
                <button>Help me price a project</button>
              </div>
              <div class="health-phone-input"><span>Ask a question</span><button>${icon("arrow", 16)}</button></div>
            </div>
          </aside>
        </div>
      </main>
    </div>`;
}

function render() {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.dataset.direction = state.direction;
  const body = {
    landing: healthLandingScreen,
    portfolio: healthPortfolioScreen,
    admin: healthAdminScreen,
    client: healthClientScreen,
    brand: healthBrandScreen,
  }[state.screen]();

  document.querySelector("#app").innerHTML = `
    ${prototypeBar()}
    <div class="mockup-stage">
      <div class="direction-caption">
        <div><span>Revised direction</span><strong>LearningBot</strong></div>
        <p>Modeled on Apple Health hierarchy and Apple product storytelling</p>
      </div>
      <div class="mockup-frame">${body}</div>
    </div>`;

  document.querySelectorAll("[data-direction]").forEach((button) => {
    button.addEventListener("click", () => update("direction", button.dataset.direction));
  });
  document.querySelectorAll("[data-screen]").forEach((button) => {
    button.addEventListener("click", () => update("screen", button.dataset.screen));
  });
  document.querySelectorAll("[data-theme-toggle], [data-theme-toggle-inner]").forEach((button) => {
    button.addEventListener("click", () => {
      update("theme", state.theme === "light" ? "dark" : "light");
    });
  });
}

function update(key, value) {
  state[key] = value;
  const params = new URLSearchParams(state);
  history.replaceState(null, "", `?${params.toString()}`);
  render();
}

render();

const screens = {
  system: "System",
  landing: "Landing",
  workspaces: "Workspaces",
  admin: "Admin home",
  client: "Client home",
  bot: "Bot",
  learning: "Learning",
  analytics: "Analytics",
  signals: "Signals",
  settings: "Settings",
  newClient: "New client",
};

const params = new URLSearchParams(location.search);
const state = {
  screen: params.get("screen") || "system",
  theme: params.get("theme") || "light",
};

const clients = [
  {
    name: "Estie Starr",
    initials: "ES",
    tone: "navy",
    status: "Live",
    metric: "1,284 questions",
    note: "Active 12 minutes ago",
  },
  {
    name: "Creator Accelerator",
    initials: "CA",
    tone: "violet",
    status: "Live",
    metric: "842 questions",
    note: "Active 1 hour ago",
  },
  {
    name: "Pricing Lab",
    initials: "PL",
    tone: "burgundy",
    status: "Review",
    metric: "12 items to review",
    note: "Active yesterday",
  },
  {
    name: "Launch School",
    initials: "LS",
    tone: "forest",
    status: "Setup",
    metric: "68% complete",
    note: "Active 3 days ago",
  },
];

function icon(name, size = 18) {
  const paths = {
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    bot: '<rect x="4" y="6" width="16" height="13" rx="4"/><path d="M9 11h.01M15 11h.01M9 15h6M12 6V3"/>',
    book: '<path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H11v18H7.5A3.5 3.5 0 0 0 4 23.5zM20 5.5A3.5 3.5 0 0 0 16.5 2H13v18h3.5a3.5 3.5 0 0 1 3.5 3.5z"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>',
    file: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 13h6M9 17h4"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19 15a2 2 0 0 0 .4 2l-2.4 2.4a2 2 0 0 0-2-.4 2 2 0 0 0-1.2 1.8V21h-3.6v-.2A2 2 0 0 0 9 19a2 2 0 0 0-2 .4L4.6 17a2 2 0 0 0 .4-2 2 2 0 0 0-1.8-1.2H3v-3.6h.2A2 2 0 0 0 5 9a2 2 0 0 0-.4-2L7 4.6A2 2 0 0 0 9 5a2 2 0 0 0 1.2-1.8V3h3.6v.2A2 2 0 0 0 15 5a2 2 0 0 0 2-.4L19.4 7a2 2 0 0 0-.4 2 2 2 0 0 0 1.8 1.2h.2v3.6h-.2A2 2 0 0 0 19 15z"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.7 9a2.4 2.4 0 1 1 3.2 2.3c-.9.4-.9 1-.9 1.7M12 17h.01"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1-1"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    moon: '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3 6.7 6.7 0 0 0 21 12.8z"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    refresh: '<path d="M20 6v5h-5M4 18v-5h5"/><path d="M6.1 9A7 7 0 0 1 18.4 6L20 11M4 13l1.6 5A7 7 0 0 0 17.9 15"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    signal: '<path d="M4 18v2M8 14v6M12 10v10M16 6v14M20 2v18"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  };
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.arrow}</svg>`;
}

function mark() {
  return '<span class="relay-mark" aria-hidden="true"><i></i><i></i></span>';
}

function avatar(initials, tone = "navy", size = "") {
  return `<span class="avatar avatar-${tone} ${size ? `avatar-${size}` : ""}">${initials}</span>`;
}

function status(label, tone = "neutral") {
  return `<span class="status status-${tone}"><i></i>${label}</span>`;
}

function button(label, options = {}) {
  const { kind = "primary", iconName = "", attrs = "" } = options;
  return `<button class="button button-${kind}" ${attrs}>${iconName ? icon(iconName, 16) : ""}<span>${label}</span></button>`;
}

function toggle(on = true, attrs = "") {
  return `<button class="toggle ${on ? "on" : ""}" role="switch" aria-checked="${on}" ${attrs}><i></i></button>`;
}

function prototypeBar() {
  return `
    <aside class="prototype-bar">
      <div class="prototype-brand">${mark()}<span><strong>Relay system</strong><small>Complete platform mockup</small></span></div>
      <div class="prototype-screens">
        ${Object.entries(screens)
          .map(
            ([key, value]) =>
              `<button data-screen="${key}" class="${state.screen === key ? "active" : ""}">${value}</button>`,
          )
          .join("")}
      </div>
      <button class="icon-button" data-theme-toggle aria-label="Switch to ${state.theme === "light" ? "dark" : "light"} mode">
        ${icon(state.theme === "light" ? "moon" : "sun", 17)}
      </button>
    </aside>`;
}

function brandLockup() {
  return `<span class="brand-lockup">${mark()}<strong>Relay</strong></span>`;
}

function accountMenu(initials = "EM") {
  return `<div class="account-actions"><button class="quiet-icon" aria-label="Help">${icon("help", 18)}</button>${avatar(initials, "ink", "sm")}</div>`;
}

function platformHeader({ workspace = false, clientView = false } = {}) {
  return `
    <header class="platform-header">
      <div class="platform-header-left">
        ${brandLockup()}
        ${workspace ? `<button class="text-button back-button" data-screen="workspaces">${icon("back", 15)}Workspaces</button>` : ""}
      </div>
      <div class="platform-header-right">
        ${
          workspace
            ? `<div class="view-switch" aria-label="Preview mode"><button class="${clientView ? "" : "active"}" data-screen="admin">Admin</button><button class="${clientView ? "active" : ""}" data-screen="client">${icon("eye", 14)}Client</button></div>`
            : ""
        }
        ${accountMenu()}
      </div>
    </header>`;
}

function workspaceNav(active = "Home", clientView = false) {
  const items = clientView
    ? [
        ["Home", "client"],
        ["Bot", "bot"],
        ["Learning", "learning"],
        ["Analytics", "analytics"],
      ]
    : [
        ["Home", "admin"],
        ["Bot", "bot"],
        ["Learning", "learning"],
        ["Analytics", "analytics"],
        ["Signals", "signals"],
      ];
  return `
    <div class="workspace-context">
      <div class="client-identity">${avatar("ES", "navy", "sm")}<span><strong>Estie Starr</strong><small>${clientView ? "Client view" : "Admin view"}</small></span></div>
      <nav class="workspace-nav">
        ${items
          .map(
            ([label, screen]) =>
              `<button data-screen="${screen}" class="${active === label ? "active" : ""}">${label}${label === "Signals" ? "<i>Off</i>" : ""}</button>`,
          )
          .join("")}
      </nav>
      ${
        clientView
          ? ""
          : `<button class="quiet-icon workspace-settings" data-screen="settings" aria-label="Workspace settings">${icon("gear", 18)}</button>`
      }
    </div>`;
}

function workspaceShell(content, active = "Home", clientView = false) {
  return `
    <div class="platform-page">
      ${platformHeader({ workspace: true, clientView })}
      ${workspaceNav(active, clientView)}
      ${
        clientView
          ? `<div class="preview-strip">${icon("eye", 15)}<span>You’re seeing exactly what Estie sees.</span><button data-screen="admin">Exit preview</button></div>`
          : ""
      }
      ${content}
    </div>`;
}

function pageHeading(eyebrow, title, description = "", actions = "") {
  return `
    <div class="page-heading">
      <div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1>${description ? `<p>${description}</p>` : ""}</div>
      ${actions ? `<div class="page-actions">${actions}</div>` : ""}
    </div>`;
}

function systemScreen() {
  return `
    <div class="system-page">
      <section class="system-intro">
        <div>${brandLockup()}<span class="system-label">Product language</span></div>
        <h1>Quiet structure.<br/>Clear decisions.</h1>
        <p>Relay should disappear behind the work. Every surface uses the same hierarchy, the same components, and the same language.</p>
      </section>

      <section class="system-section">
        <div class="system-section-head"><span>01</span><div><h2>Principles</h2><p>The rules that prevent the interface from drifting.</p></div></div>
        <div class="principle-grid">
          <article><strong>One clear next step</strong><p>Each page names the task and gives it one primary action.</p></article>
          <article><strong>Data earns its place</strong><p>Numbers appear only when they change what the user should do.</p></article>
          <article><strong>Color has a job</strong><p>Blue means action. Status colors only communicate state.</p></article>
          <article><strong>Complexity stays backstage</strong><p>Advanced controls live with admins, never in the client’s path.</p></article>
        </div>
      </section>

      <section class="system-section">
        <div class="system-section-head"><span>02</span><div><h2>Foundation</h2><p>Neutral by default, consistent in light and dark.</p></div></div>
        <div class="foundation-grid">
          <article class="foundation-card">
            <span class="component-label">COLOR</span>
            <div class="swatch-list">
              <div><i class="swatch swatch-ink"></i><span><strong>Ink</strong><small>#171719</small></span></div>
              <div><i class="swatch swatch-paper"></i><span><strong>Paper</strong><small>#F5F5F7</small></span></div>
              <div><i class="swatch swatch-blue"></i><span><strong>Action</strong><small>#0A63D8</small></span></div>
              <div><i class="swatch swatch-green"></i><span><strong>Healthy</strong><small>#157347</small></span></div>
            </div>
          </article>
          <article class="foundation-card type-scale">
            <span class="component-label">TYPE</span>
            <div><span>Display</span><strong>48 / 52</strong><h3>Workspaces</h3></div>
            <div><span>Title</span><strong>28 / 34</strong><h4>Ask Estie</h4></div>
            <div><span>Body</span><strong>15 / 22</strong><p>Answers grounded in approved learning.</p></div>
          </article>
          <article class="foundation-card">
            <span class="component-label">SPACING + SHAPE</span>
            <div class="spacing-demo"><i></i><i></i><i></i><i></i></div>
            <p>8px spacing rhythm. 12px controls. 18px cards. No ornamental geometry.</p>
          </article>
        </div>
      </section>

      <section class="system-section">
        <div class="system-section-head"><span>03</span><div><h2>Components</h2><p>A small kit used everywhere.</p></div></div>
        <div class="component-board">
          <article>
            <span class="component-label">ACTIONS</span>
            <div class="component-row">${button("Add client", { iconName: "plus" })}${button("Preview", { kind: "secondary", iconName: "eye" })}${button("Cancel", { kind: "tertiary" })}</div>
          </article>
          <article>
            <span class="component-label">STATUS</span>
            <div class="component-row">${status("Live", "positive")}${status("Review", "warning")}${status("Setup")}</div>
          </article>
          <article>
            <span class="component-label">CONTROLS</span>
            <div class="component-row">${toggle(true)}${toggle(false)}<div class="segmented"><button class="active">30 days</button><button>90 days</button></div></div>
          </article>
          <article>
            <span class="component-label">ACCESSIBLE IDENTITIES</span>
            <div class="component-row avatar-row">${avatar("ES", "navy")}${avatar("CA", "violet")}${avatar("PL", "burgundy")}${avatar("LS", "forest")}</div>
          </article>
        </div>
      </section>
    </div>`;
}

function landingScreen() {
  return `
    <div class="public-page">
      <header class="public-header">
        ${brandLockup()}
        <nav><a href="#product">Product</a><a href="#security">Security</a><a href="#company">Company</a></nav>
        <div><button class="text-button">Sign in</button>${button("Book a demo", { kind: "dark" })}</div>
      </header>
      <main class="landing-main">
        <section class="landing-hero">
          <span class="eyebrow">A private AI guide for every program</span>
          <h1>Your knowledge.<br/>Ready when they need it.</h1>
          <p>Relay turns the material you already have into clear answers—and shows you what your clients still need.</p>
          <div>${button("Book a demo", { kind: "dark", iconName: "arrow" })}<button class="text-button landing-link">See the product ${icon("chevron", 15)}</button></div>
        </section>
        <section class="product-window" id="product">
          <header><span><i></i><i></i><i></i></span>${brandLockup()}<small>Client home</small></header>
          <div class="window-content">
            <div class="window-sidebar">${avatar("ES", "navy")}<span>Ask Estie</span><i></i><i></i><i></i></div>
            <div class="window-main">
              <span class="eyebrow">GOOD MORNING, ESTIE</span>
              <h2>Your guide is ready.</h2>
              <article><div>${avatar("ES", "navy")}<span><strong>Ask Estie is on</strong><small>Grounded in 126 approved items</small></span></div>${status("Live", "positive")}</article>
              <div><article><small>Questions</small><strong>1,284</strong><span>Last 30 days</span></article><article><small>Helpful</small><strong>92%</strong><span>From 428 ratings</span></article></div>
            </div>
          </div>
        </section>
        <section class="landing-proof">
          <p>Built for programs where the quality of the answer matters.</p>
          <div><span>Private by design</span><span>Grounded in your material</span><span>Useful signals, not noise</span></div>
        </section>
      </main>
    </div>`;
}

function workspaceCard(client) {
  const tone = client.status === "Live" ? "positive" : client.status === "Review" ? "warning" : "neutral";
  return `
    <button class="workspace-card" data-screen="admin">
      <div class="workspace-card-top">
        ${avatar(client.initials, client.tone)}
        ${status(client.status, tone)}
      </div>
      <div class="workspace-card-copy"><h2>${client.name}</h2><p>${client.metric}</p></div>
      <div class="workspace-card-foot"><span>${client.note}</span>${icon("chevron", 17)}</div>
    </button>`;
}

function workspacesScreen() {
  return `
    <div class="platform-page">
      ${platformHeader()}
      <main class="content workspace-list">
        ${pageHeading("ADMIN", "Client workspaces", "Choose a client to manage their bot, learning, and results.", button("Add client", { iconName: "plus", attrs: 'data-screen="newClient"' }))}
        <div class="simple-toolbar"><div class="search-field">${icon("search", 17)}<input aria-label="Search clients" placeholder="Search clients" /></div><span>4 clients</span></div>
        <section class="workspace-grid">${clients.map(workspaceCard).join("")}</section>
      </main>
    </div>`;
}

function adminScreen(clientView = false) {
  if (clientView) return clientHomeScreen();
  return workspaceShell(
    `<main class="content home-content">
      ${pageHeading("THURSDAY, JULY 30", "Estie Starr", "The workspace is healthy. One signal is worth reviewing.")}
      <section class="home-grid">
        <article class="summary-card summary-wide">
          <div class="card-head"><span class="card-icon">${icon("bot", 18)}</span>${status("Live", "positive")}</div>
          <div class="card-body">
            <span class="eyebrow">BOT</span>
            <h2>Ask Estie is on.</h2>
            <p>It’s answering from 126 approved learning items.</p>
          </div>
          <button class="card-link" data-screen="bot">Manage bot ${icon("chevron", 16)}</button>
        </article>
        <article class="summary-card">
          <div class="card-head"><span class="card-icon">${icon("chart", 18)}</span><span class="change positive">+18%</span></div>
          <div class="card-body">
            <span class="eyebrow">QUESTIONS · 30 DAYS</span>
            <h2 class="metric">1,284</h2>
            <p>Up from 1,088 last period.</p>
          </div>
          <button class="card-link" data-screen="analytics">View analytics ${icon("chevron", 16)}</button>
        </article>
        <article class="summary-card">
          <div class="card-head"><span class="card-icon">${icon("check", 18)}</span><span class="change positive">+3 pts</span></div>
          <div class="card-body">
            <span class="eyebrow">HELPFUL</span>
            <h2 class="metric">92%</h2>
            <p>Based on 428 client ratings.</p>
          </div>
          <button class="card-link" data-screen="analytics">View feedback ${icon("chevron", 16)}</button>
        </article>
      </section>
      <section class="section-block">
        <div class="section-title"><div><h2>Needs your attention</h2><p>Relay found one useful pattern.</p></div><button class="text-button" data-screen="signals">View all</button></div>
        <button class="attention-row" data-screen="signals">
          <span class="signal-symbol">${icon("signal", 18)}</span>
          <span><strong>Pricing confidence is coming up more often</strong><small>38 related questions this week · Signals are hidden from the client</small></span>
          <span class="row-action">Review ${icon("chevron", 16)}</span>
        </button>
      </section>
    </main>`,
    "Home",
    false,
  );
}

function clientHomeScreen() {
  return workspaceShell(
    `<main class="content home-content">
      ${pageHeading("GOOD MORNING, ESTIE", "Your guide is ready.", "Everything your clients need is in one place.")}
      <section class="client-home-grid">
        <article class="summary-card summary-wide">
          <div class="card-head"><div class="bot-identity">${avatar("ES", "navy", "sm")}<span><strong>Ask Estie</strong><small>Your private guide</small></span></div>${status("Live", "positive")}</div>
          <div class="card-body"><h2>Ask Estie is on.</h2><p>It’s answering from 126 approved learning items.</p></div>
          <button class="card-link" data-screen="bot">Configure your bot ${icon("chevron", 16)}</button>
        </article>
        <article class="summary-card">
          <div class="card-head"><span class="card-icon">${icon("book", 18)}</span><span>126 items</span></div>
          <div class="card-body"><span class="eyebrow">LEARNING</span><h2>Keep it current.</h2><p>Add a file, page, or answer anytime.</p></div>
          <button class="card-link" data-screen="learning">Add learning ${icon("chevron", 16)}</button>
        </article>
      </section>
      <section class="section-block">
        <div class="section-title"><div><h2>How it’s helping</h2><p>A simple view of the last 30 days.</p></div><button class="text-button" data-screen="analytics">See all analytics</button></div>
        <div class="client-metrics">
          <div><span>Questions answered</span><strong>1,284</strong><small>+18% from last period</small></div>
          <div><span>Helpful</span><strong>92%</strong><small>From 428 ratings</small></div>
          <div><span>Answers found</span><strong>89%</strong><small>Without human follow-up</small></div>
        </div>
      </section>
    </main>`,
    "Home",
    true,
  );
}

function botScreen() {
  return workspaceShell(
    `<main class="content detail-content">
      ${pageHeading("BOT", "Ask Estie", "Control how your bot looks, introduces itself, and answers.", `${button("Preview", { kind: "secondary", iconName: "eye" })}${button("Save changes")}`)}
      <div class="settings-layout">
        <div class="settings-stack">
          <section class="form-card">
            <div class="form-card-head"><div><h2>Identity</h2><p>The name and appearance clients see.</p></div></div>
            <div class="identity-editor">${avatar("ES", "navy")}<div>${button("Change icon", { kind: "secondary" })}<small>Square image, at least 256px.</small></div></div>
            <label class="field"><span>Name</span><input value="Ask Estie" /></label>
            <label class="field"><span>Accent color</span><div class="color-field"><i></i><input value="#19324D" /></div></label>
          </section>
          <section class="form-card">
            <div class="form-card-head"><div><h2>Conversation</h2><p>Set the first impression and the boundaries.</p></div></div>
            <label class="field"><span>Welcome message</span><textarea>Hi — I’m Ask Estie. What would you like to work through?</textarea></label>
            <label class="field"><span>When an answer isn’t available</span><select><option>Be clear and suggest asking the team</option></select></label>
          </section>
        </div>
        <aside class="preview-card">
          <div class="preview-card-head"><span>Live preview</span><button class="quiet-icon">${icon("refresh", 17)}</button></div>
          <div class="bot-preview">
            <div class="bot-preview-brand">${avatar("ES", "navy")}<span><strong>Ask Estie</strong><small>${status("Online", "positive")}</small></span></div>
            <div class="chat-bubble">Hi — I’m Ask Estie. What would you like to work through?</div>
            <div class="prompt-field"><span>Ask a question</span>${icon("arrow", 17)}</div>
            <small>Answers are grounded in approved Estie Starr learning.</small>
          </div>
        </aside>
      </div>
    </main>`,
    "Bot",
    false,
  );
}

const learningItems = [
  ["Pricing Playbook.pdf", "File", "Approved", "24 pages", "Today"],
  ["Discovery call framework", "Answer", "Approved", "Edited by Estie", "Yesterday"],
  ["estiestarr.com/services", "Web page", "Approved", "12 pages", "Jul 28"],
  ["Objection handling notes", "File", "Draft", "6 pages", "Jul 26"],
  ["Program curriculum", "Collection", "Approved", "38 items", "Jul 24"],
];

function learningScreen() {
  return workspaceShell(
    `<main class="content detail-content">
      ${pageHeading("LEARNING", "What Ask Estie knows", "Add, review, and organize the source material behind every answer.", button("Add learning", { iconName: "plus" }))}
      <div class="library-summary">
        <div><span>126</span><small>Approved</small></div>
        <div><span>4</span><small>Drafts</small></div>
        <div><span>Today</span><small>Last updated</small></div>
      </div>
      <section class="table-card">
        <div class="table-toolbar">
          <div class="search-field">${icon("search", 17)}<input placeholder="Search learning" aria-label="Search learning" /></div>
          <div class="segmented"><button class="active">All</button><button>Files</button><button>Answers</button><button>Pages</button></div>
        </div>
        <div class="learning-table">
          <div class="table-row table-head"><span>Name</span><span>Type</span><span>Status</span><span>Details</span><span>Updated</span><span></span></div>
          ${learningItems
            .map(
              (item) => `<button class="table-row"><span class="item-name"><i>${icon(item[1] === "Web page" ? "link" : item[1] === "Answer" ? "bot" : item[1] === "Collection" ? "book" : "file", 17)}</i><strong>${item[0]}</strong></span><span>${item[1]}</span><span>${status(item[2], item[2] === "Approved" ? "positive" : "neutral")}</span><span>${item[3]}</span><span>${item[4]}</span><span>${icon("more", 18)}</span></button>`,
            )
            .join("")}
        </div>
      </section>
    </main>`,
    "Learning",
    false,
  );
}

function lineChart() {
  return `
    <svg class="line-chart" viewBox="0 0 720 220" role="img" aria-label="Questions increased steadily over the last 30 days">
      <g class="chart-grid"><line x1="45" y1="25" x2="700" y2="25"/><line x1="45" y1="85" x2="700" y2="85"/><line x1="45" y1="145" x2="700" y2="145"/><line x1="45" y1="205" x2="700" y2="205"/></g>
      <polyline class="chart-line" points="45,174 98,165 152,172 206,139 260,144 314,119 368,125 422,95 476,104 530,76 584,84 638,49 700,57"/>
      <circle class="chart-point" cx="700" cy="57" r="4"/>
      <g class="chart-labels"><text x="45" y="218">Jul 1</text><text x="352" y="218">Jul 15</text><text x="665" y="218">Jul 30</text></g>
    </svg>`;
}

function analyticsScreen() {
  return workspaceShell(
    `<main class="content detail-content">
      ${pageHeading("ANALYTICS", "How Ask Estie is helping", "Performance, behavior, and the questions clients ask.", `<div class="segmented"><button>7 days</button><button class="active">30 days</button><button>90 days</button></div>${button("Export", { kind: "secondary", iconName: "upload" })}`)}
      <section class="analytics-metrics">
        <article><span>Questions</span><strong>1,284</strong><small class="positive">↑ 18% from last period</small></article>
        <article><span>Helpful</span><strong>92%</strong><small class="positive">↑ 3 points</small></article>
        <article><span>Answer rate</span><strong>89%</strong><small class="positive">↑ 2 points</small></article>
        <article><span>Active clients</span><strong>318</strong><small>76% of enrolled clients</small></article>
      </section>
      <section class="chart-card">
        <div class="card-title"><div><h2>Questions over time</h2><p>Daily questions asked in the last 30 days.</p></div><div class="legend"><i></i>Questions</div></div>
        ${lineChart()}
      </section>
      <section class="split-section">
        <article class="list-card">
          <div class="card-title"><div><h2>Top topics</h2><p>What clients asked about most.</p></div></div>
          <div class="rank-list"><div><span>1</span><strong>Pricing strategy</strong><small>286</small></div><div><span>2</span><strong>Client discovery</strong><small>214</small></div><div><span>3</span><strong>Positioning</strong><small>183</small></div><div><span>4</span><strong>Sales objections</strong><small>141</small></div></div>
        </article>
        <article class="list-card">
          <div class="card-title"><div><h2>Answer quality</h2><p>Based on 428 ratings.</p></div></div>
          <div class="quality-score"><strong>92%</strong><span>Helpful</span></div>
          <div class="progress-row"><span><i style="width:92%"></i></span><small>394 helpful</small></div>
          <div class="progress-row muted"><span><i style="width:8%"></i></span><small>34 not helpful</small></div>
        </article>
      </section>
    </main>`,
    "Analytics",
    false,
  );
}

const signalRows = [
  ["Pricing confidence", "Questions about setting and defending prices increased 34%.", "38 questions", "New"],
  ["Sales objection follow-up", "Clients are asking what to send after a hesitant sales call.", "21 questions", "Open"],
  ["Strategy engagement scope", "Answers reference three different versions of the scope.", "16 questions", "Review"],
];

function signalsScreen() {
  return workspaceShell(
    `<main class="content detail-content">
      ${pageHeading("SIGNALS", "What clients need next", "Patterns pulled from questions, feedback, and unanswered moments.", button("Signal settings", { kind: "secondary", iconName: "gear", attrs: 'data-screen="settings"' }))}
      <div class="visibility-note">${icon("lock", 17)}<span><strong>Admin only.</strong> Signals are currently hidden from the client workspace.</span>${status("Client access off")}</div>
      <section class="signal-list">
        ${signalRows
          .map(
            (signal, index) => `<article class="signal-row">
              <div class="signal-index">0${index + 1}</div>
              <div class="signal-copy"><div>${status(signal[3], index === 0 ? "blue" : "neutral")}<span>${signal[2]}</span></div><h2>${signal[0]}</h2><p>${signal[1]}</p></div>
              <div class="signal-actions">${button("Review signal", { kind: index === 0 ? "primary" : "secondary" })}<button class="quiet-icon">${icon("more", 18)}</button></div>
            </article>`,
          )
          .join("")}
      </section>
      <div class="signals-footnote"><span>Updated from the last 30 days of activity.</span><button class="text-button">How signals work ${icon("chevron", 15)}</button></div>
    </main>`,
    "Signals",
    false,
  );
}

function settingRow(title, description, control) {
  return `<div class="setting-row"><div><strong>${title}</strong><p>${description}</p></div>${control}</div>`;
}

function settingsScreen() {
  return workspaceShell(
    `<main class="content settings-content">
      ${pageHeading("SETTINGS", "Workspace settings", "Control branding, client access, and who can manage this workspace.", button("Save changes"))}
      <div class="settings-nav-layout">
        <nav class="settings-side"><button class="active">Client access</button><button>Branding</button><button>People</button><button>Bot behavior</button><button>Danger zone</button></nav>
        <div class="settings-main">
          <section class="form-card">
            <div class="form-card-head"><div><h2>Client navigation</h2><p>Choose what Estie can see. Admins always retain full access.</p></div></div>
            ${settingRow("Home", "A simple overview of the bot and recent results.", toggle(true))}
            ${settingRow("Bot", "Bot identity, greeting, and live preview.", toggle(true))}
            ${settingRow("Learning", "Add and manage approved learning.", toggle(true))}
            ${settingRow("Analytics", "Questions, helpfulness, and answer quality.", toggle(true))}
            ${settingRow("Signals", "Patterns and opportunities found in client questions.", toggle(false))}
          </section>
          <section class="form-card">
            <div class="form-card-head"><div><h2>Workspace identity</h2><p>Applied to Ask Estie and client-facing surfaces.</p></div></div>
            <div class="brand-setting">${avatar("ES", "navy")}<div><strong>Estie Starr</strong><span>ask.estiestarr.com</span></div>${button("Edit branding", { kind: "secondary" })}</div>
            <div class="setting-row"><div><strong>Default appearance</strong><p>Clients can still switch between light and dark.</p></div><div class="segmented"><button class="active">${icon("sun", 15)}Light</button><button>${icon("moon", 15)}Dark</button><button>System</button></div></div>
          </section>
          <section class="form-card">
            <div class="form-card-head"><div><h2>People</h2><p>Two people can access this workspace.</p></div>${button("Invite", { kind: "secondary", iconName: "plus" })}</div>
            <div class="person-row">${avatar("ES", "navy", "sm")}<span><strong>Estie Starr</strong><small>Client · estie@example.com</small></span><button class="quiet-icon">${icon("more", 18)}</button></div>
            <div class="person-row">${avatar("EM", "ink", "sm")}<span><strong>Emiel Madonna</strong><small>Platform admin</small></span><button class="quiet-icon">${icon("more", 18)}</button></div>
          </section>
        </div>
      </div>
    </main>`,
    "Settings",
    false,
  );
}

function newClientScreen() {
  return `
    <div class="platform-page">
      ${platformHeader()}
      <main class="onboarding">
        <button class="text-button onboarding-back" data-screen="workspaces">${icon("back", 15)}Workspaces</button>
        <div class="onboarding-progress"><i class="complete"></i><i></i><i></i><span>Step 1 of 3</span></div>
        <section class="onboarding-card">
          <span class="eyebrow">NEW CLIENT</span>
          <h1>Create their workspace.</h1>
          <p>Start with the identity. You can add learning and configure access next.</p>
          <div class="onboarding-form">
            <div class="new-avatar"><span>ES</span><button>${icon("upload", 16)}Upload</button></div>
            <label class="field"><span>Client or program name</span><input value="Estie Starr" /></label>
            <label class="field"><span>Bot name</span><input value="Ask Estie" /></label>
            <label class="field"><span>Client email</span><input placeholder="name@example.com" /></label>
          </div>
          <div class="onboarding-actions"><button class="text-button" data-screen="workspaces">Cancel</button>${button("Continue to learning", { iconName: "arrow" })}</div>
        </section>
        <p class="onboarding-note">${icon("lock", 15)} Nothing is shared with the client until you invite them.</p>
      </main>
    </div>`;
}

function render() {
  document.documentElement.dataset.theme = state.theme;
  document.body.className = `screen-${state.screen}`;
  const renderers = {
    system: systemScreen,
    landing: landingScreen,
    workspaces: workspacesScreen,
    admin: adminScreen,
    client: clientHomeScreen,
    bot: botScreen,
    learning: learningScreen,
    analytics: analyticsScreen,
    signals: signalsScreen,
    settings: settingsScreen,
    newClient: newClientScreen,
  };
  document.querySelector("#app").innerHTML = `${prototypeBar()}<div class="prototype-canvas">${(renderers[state.screen] || workspacesScreen)()}</div>`;
  bind();
}

function update(key, value) {
  state[key] = value;
  const next = new URL(location.href);
  next.searchParams.set("screen", state.screen);
  next.searchParams.set("theme", state.theme);
  next.searchParams.delete("concept");
  next.searchParams.delete("direction");
  history.replaceState(null, "", next);
  render();
  window.scrollTo({ top: 0, behavior: "instant" });
}

function bind() {
  document.querySelectorAll("[data-screen]").forEach((element) => {
    element.addEventListener("click", () => update("screen", element.dataset.screen));
  });
  document.querySelectorAll("[data-theme-toggle]").forEach((element) => {
    element.addEventListener("click", () => update("theme", state.theme === "light" ? "dark" : "light"));
  });
  document.querySelectorAll(".toggle").forEach((element) => {
    element.addEventListener("click", () => {
      element.classList.toggle("on");
      element.setAttribute("aria-checked", String(element.classList.contains("on")));
    });
  });
  document.querySelectorAll(".segmented button").forEach((element) => {
    element.addEventListener("click", () => {
      element.parentElement.querySelectorAll("button").forEach((buttonEl) => buttonEl.classList.remove("active"));
      element.classList.add("active");
    });
  });
}

render();

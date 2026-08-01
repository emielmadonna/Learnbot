const concepts = {
  ever: {
    name: "Ever",
    note: "Personal · reassuring · intelligent",
    tagline: "What you know. Always within reach.",
  },
  kin: {
    name: "Kin",
    note: "Precise · quiet · product-led",
    tagline: "Your expertise. Made useful.",
  },
  relay: {
    name: "Relay",
    note: "Kinetic · bold · signal-led",
    tagline: "Knowledge that keeps moving.",
  },
};

const screens = {
  compare: "Compare",
  landing: "Landing",
  workspaces: "Workspaces",
  admin: "Client admin",
  client: "Client view",
};

const params = new URLSearchParams(location.search);
const state = {
  concept: params.get("concept") || "ever",
  screen: params.get("screen") || "compare",
  theme: params.get("theme") || "light",
};

function icon(name, size = 18) {
  const paths = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    moon: '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3 6.7 6.7 0 0 0 21 12.8z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    bot: '<rect x="4" y="6" width="16" height="13" rx="4"/><path d="M9 11h.01M15 11h.01M9 15h6M12 6V3"/>',
    book: '<path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H11v18H7.5A3.5 3.5 0 0 0 4 23.5zM20 5.5A3.5 3.5 0 0 0 16.5 2H13v18h3.5a3.5 3.5 0 0 1 3.5 3.5z"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    signal: '<path d="M4 18v2M8 14v6M12 10v10M16 6v14M20 2v18"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19 15a2 2 0 0 0 .4 2l-2.4 2.4a2 2 0 0 0-2-.4 2 2 0 0 0-1.2 1.8V21h-3.6v-.2A2 2 0 0 0 9 19a2 2 0 0 0-2 .4L4.6 17a2 2 0 0 0 .4-2 2 2 0 0 0-1.8-1.2H3v-3.6h.2A2 2 0 0 0 5 9a2 2 0 0 0-.4-2L7 4.6A2 2 0 0 0 9 5a2 2 0 0 0 1.2-1.8V3h3.6v.2A2 2 0 0 0 15 5a2 2 0 0 0 2-.4L19.4 7a2 2 0 0 0-.4 2 2 2 0 0 0 1.8 1.2h.2v3.6h-.2A2 2 0 0 0 19 15z"/>',
    eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  };
  return `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.arrow}</svg>`;
}

function mark(concept = state.concept) {
  if (concept === "ever") {
    return '<span class="mark mark-ever"><i></i><i></i><i></i><i></i></span>';
  }
  if (concept === "kin") {
    return '<span class="mark mark-kin"><i></i><i></i></span>';
  }
  return '<span class="mark mark-relay"><i></i><i></i><i></i></span>';
}

function avatar(initials, color = "") {
  return `<span class="person" ${color ? `style="--person:${color}"` : ""}>${initials}</span>`;
}

function prototypeBar() {
  return `
    <header class="proto">
      <div class="proto-title"><span>Rebrand study</span><strong>Three complete systems</strong></div>
      <div class="proto-controls">
        <div class="proto-group concept-picker">
          ${Object.entries(concepts).map(([key, value]) => `<button data-concept="${key}" class="${state.concept === key ? "active" : ""}">${mark(key)}<span><b>${value.name}</b><small>${value.note}</small></span></button>`).join("")}
        </div>
        <div class="proto-group screen-picker">
          ${Object.entries(screens).map(([key, value]) => `<button data-screen="${key}" class="${state.screen === key ? "active" : ""}">${value}</button>`).join("")}
        </div>
        <button class="proto-theme" data-theme-toggle aria-label="Toggle appearance">${icon(state.theme === "light" ? "moon" : "sun", 17)}<span>${state.theme === "light" ? "Dark" : "Light"}</span></button>
      </div>
    </header>`;
}

function brandLockup(concept = state.concept) {
  return `<span class="brand-lockup">${mark(concept)}<strong>${concepts[concept].name}</strong></span>`;
}

function appHeader({ workspace = false, clientView = false } = {}) {
  return `
    <header class="brand-header">
      ${brandLockup()}
      ${workspace ? `<button class="back-link" data-screen="workspaces">${icon("back", 16)} Workspaces</button>` : "<span></span>"}
      <div class="brand-actions">
        ${workspace ? `<div class="view-toggle"><button class="${clientView ? "" : "active"}" data-screen="admin">Admin</button><button class="${clientView ? "active" : ""}" data-screen="client">Client</button></div>` : `<button class="round">${icon("search", 17)}</button>`}
        <button class="round" data-theme-inner>${icon(state.theme === "light" ? "moon" : "sun", 17)}</button>
        ${avatar("EM")}
      </div>
    </header>`;
}

function tabs(clientView = false) {
  const values = clientView ? ["Home", "Bot", "Learning", "Analytics"] : ["Home", "Bot", "Learning", "Analytics", "Signals"];
  return `<nav class="workspace-tabs">${values.map((value, index) => `<button class="${index === 0 ? "active" : ""}">${value}${value === "Signals" ? "<i>Off</i>" : ""}</button>`).join("")}<button class="tab-settings">${icon("settings", 17)}</button></nav>`;
}

const clients = [
  { name: "Estie Starr", initials: "ES", color: "#ff6b55", status: "Live", metric: "1,284", note: "questions this month", active: "12m ago" },
  { name: "Creator Accelerator", initials: "CA", color: "#8567e8", status: "Live", metric: "842", note: "questions this month", active: "1h ago" },
  { name: "Pricing Lab", initials: "PL", color: "#ff9f0a", status: "Review", metric: "12", note: "questions need learning", active: "Yesterday" },
  { name: "Launch School", initials: "LS", color: "#1787f7", status: "Setup", metric: "68%", note: "setup complete", active: "3d ago" },
];

function compareScreen() {
  return `
    <div class="compare">
      <div class="compare-heading"><span>Brand systems</span><h1>Three different answers.</h1><p>Not palette swaps. Each option changes the identity, composition, hierarchy, and interaction character.</p></div>
      <div class="concept-grid">
        ${Object.keys(concepts).map((concept) => conceptPreview(concept)).join("")}
      </div>
    </div>`;
}

function conceptPreview(concept) {
  const value = concepts[concept];
  return `
    <article class="concept-preview ${concept}" data-concept="${concept}" data-screen="landing">
      <header>${brandLockup(concept)}<span>0${Object.keys(concepts).indexOf(concept) + 1}</span></header>
      <div class="concept-hero"><small>${value.note}</small><h2>${value.tagline}</h2><div class="preview-object">${mark(concept)}<span></span><span></span></div></div>
      <footer><div><strong>${value.name}</strong><span>Open full system</span></div>${icon("arrow", 18)}</footer>
    </article>`;
}

function landingScreen() {
  if (state.concept === "ever") return everLanding();
  if (state.concept === "kin") return kinLanding();
  return relayLanding();
}

function everLanding() {
  return `
    <div class="brand-page ever-page ever-landing">
      <header class="public-header inverse">${brandLockup("ever")}<nav><a>Product</a><a>Privacy</a><a>For teams</a></nav><button>Sign in</button></header>
      <main>
        <div class="ever-pattern"><i></i><i></i><i></i><i></i><i></i></div>
        <div class="ever-landing-copy">${mark("ever")}<span>Ever for learning</span><h1>What you know.<br/>Always within reach.</h1><p>A private guide for every person you teach.</p><button>See how Ever works ${icon("arrow", 17)}</button></div>
        <div class="ever-device"><div class="ever-device-head">${avatar("ES", "#ff6b55")}<b>Ask Estie</b><span>Available</span></div><p>How should I price a strategy engagement?</p><div><strong>Start with the value of the decision.</strong><span>Your program recommends three clear levels.</span></div></div>
      </main>
    </div>`;
}

function kinLanding() {
  return `
    <div class="brand-page kin-page kin-landing">
      <header class="public-header">${brandLockup("kin")}<nav><a>Overview</a><a>Security</a><a>Support</a></nav><div><button class="plain">Sign in</button><button class="primary">Book a demo</button></div></header>
      <main>
        <span class="kin-eyebrow">A better way to share what you know.</span>
        <h1>Your expertise.<br/>Made useful.</h1>
        <p>One private AI guide. Grounded in your work. Ready whenever your clients are.</p>
        <div class="kin-actions"><button class="primary">Book a demo</button><button class="text">Learn more ${icon("chevron", 16)}</button></div>
        <div class="kin-product">
          <div class="kin-orbit one"></div><div class="kin-orbit two"></div>
          <div class="kin-console"><header>${brandLockup("kin")}<span>Estie Starr</span></header><div><small>THIS MONTH</small><strong>1,284</strong><span>questions answered</span></div></div>
          <div class="kin-phone">${avatar("ES", "#111")}<b>Ask Estie</b><p>What would you like to work through?</p><span>Ask a question</span></div>
        </div>
      </main>
    </div>`;
}

function relayLanding() {
  return `
    <div class="brand-page relay-page relay-landing">
      <header class="public-header inverse">${brandLockup("relay")}<span>Knowledge infrastructure for modern programs.</span><button>Get started</button></header>
      <main>
        <div class="relay-motion"><i></i><i></i><i></i><i></i></div>
        <div class="relay-copy">${brandLockup("relay")}<h1>Knowledge that<br/>keeps moving.</h1><p>Turn every lesson into an answer. Turn every question into a signal.</p><button>Run your program ${icon("arrow", 18)}</button></div>
        <div class="relay-signal-card"><span>LIVE SIGNAL</span><strong>Pricing confidence</strong><p>Questions increased 34% this week.</p><div><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></div>
      </main>
    </div>`;
}

function workspaceCard(client, index) {
  return `
    <article class="client-card card-${index}" data-screen="admin" style="--client:${client.color}">
      <header>${avatar(client.initials, client.color)}<span class="client-status">${client.status}</span><button>${icon("chevron", 17)}</button></header>
      <div class="client-copy"><h2>${client.name}</h2><p>${client.status === "Live" ? "Everything is working." : client.status === "Review" ? "New learning is recommended." : "Ready to finish setup."}</p></div>
      <div class="client-metric"><strong>${client.metric}</strong><span>${client.note}</span></div>
      <footer><span>Active ${client.active}</span><span>${client.name === "Estie Starr" ? "Ask Estie" : "Open workspace"}</span></footer>
    </article>`;
}

function workspacesScreen() {
  return `
    <div class="brand-page ${state.concept}-page workspaces-page">
      ${appHeader()}
      <main class="workspaces-main">
        <div class="workspaces-title"><div><span>Admin</span><h1>${state.concept === "relay" ? "Clients" : "Workspaces"}</h1></div><button class="add-client">${icon("plus", 17)} Add client</button></div>
        <div class="workspace-search">${icon("search", 17)}<span>Search clients</span></div>
        <div class="client-cards ${state.concept}-cards">${clients.map(workspaceCard).join("")}</div>
      </main>
    </div>`;
}

function adminScreen(clientView = false) {
  if (state.concept === "ever") return everAdmin(clientView);
  if (state.concept === "kin") return kinAdmin(clientView);
  return relayAdmin(clientView);
}

function adminShell(content, clientView) {
  return `<div class="brand-page ${state.concept}-page admin-page">${appHeader({ workspace: true, clientView })}<div class="client-context">${avatar("ES", "#ff6b55")}<div><strong>Estie Starr</strong><span>${clientView ? "Client view" : "Admin view"}</span></div>${tabs(clientView)}</div>${clientView ? `<div class="preview-note">${icon("eye", 15)}You’re seeing exactly what Estie sees.<button data-screen="admin">Exit client view</button></div>` : ""}${content}</div>`;
}

function everAdmin(clientView) {
  const title = clientView ? "Good morning, Estie." : "Here’s what matters.";
  return adminShell(`
    <main class="ever-summary">
      <div class="admin-title"><span>Thursday, July 30</span><h1>${title}</h1></div>
      <section><div class="section-label"><h2>Pinned</h2><button>Edit</button></div>
        <div class="ever-pinned">
          <article class="ever-primary"><span>${icon("bot", 18)} ${clientView ? "Your guide" : "Bot"}</span><div>${avatar("ES", "#ff6b55")}<h2>Ask Estie is live.</h2><p>Answering from 126 approved learning items.</p></div><button>${clientView ? "Configure" : "Open bot"} ${icon("chevron", 15)}</button></article>
          <article><span>${icon("chart", 18)} Questions</span><strong>1,284</strong><small>Last 30 days</small><div class="soft-bars"><i></i><i></i><i></i><i></i><i></i><i></i></div></article>
          <article><span>${icon("check", 18)} Helpful</span><strong>92%</strong><small>428 ratings</small><em>↑ 3%</em></article>
        </div>
      </section>
      <section><div class="section-label"><h2>Highlights</h2><button>Show all</button></div><article class="ever-highlight"><span>${icon("signal", 18)}</span><div><small>NEW PATTERN</small><h2>Pricing confidence is coming up more often.</h2><p>38 questions could become one new learning item.</p></div>${icon("chevron", 18)}</article></section>
    </main>`, clientView);
}

function kinAdmin(clientView) {
  return adminShell(`
    <main class="kin-summary">
      <div class="admin-title"><span>ESTIE STARR</span><h1>${clientView ? "Your guide is ready." : "Everything is working."}</h1><p>${clientView ? "Ask Estie is helping clients find the right answer." : "One glance. Nothing needs your attention right now."}</p></div>
      <article class="kin-hero-card"><div><span class="live-dot"></span><small>ASK ESTIE</small><h2>Live</h2><p>126 approved learning items</p><button>${clientView ? "Configure bot" : "Open bot"}</button></div><div class="kin-bot-object">${mark("kin")}${avatar("ES", "#111")}</div></article>
      <div class="kin-data-row">
        <article><small>QUESTIONS</small><strong>1,284</strong><span>Last 30 days</span></article>
        <article><small>HELPFUL</small><strong>92%</strong><span>428 ratings</span></article>
        <article><small>LEARNING</small><strong>126</strong><span>Approved</span></article>
      </div>
      <article class="kin-callout"><span>One opportunity</span><strong>Clients need more help with pricing objections.</strong><button>Review ${icon("chevron", 15)}</button></article>
    </main>`, clientView);
}

function relayAdmin(clientView) {
  return adminShell(`
    <main class="relay-summary">
      <div class="relay-admin-head"><div><span>${clientView ? "YOUR PROGRAM" : "LIVE WORKSPACE"}</span><h1>${clientView ? "Ask Estie" : "Estie Starr"}</h1></div><div class="relay-live"><i></i>Live now</div></div>
      <section class="relay-hero-metric"><div><small>QUESTIONS · 30 DAYS</small><strong>1,284</strong><p>↑ 18% and accelerating</p></div><div class="relay-wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></section>
      <section class="relay-grid">
        <article class="relay-bot"><span>${icon("bot", 18)} BOT</span><h2>Ask Estie is on.</h2><p>126 learning items are live.</p><button>${clientView ? "Configure" : "Inspect"} ${icon("arrow", 16)}</button></article>
        <article class="relay-score"><span>HELPFUL</span><strong>92</strong><i>%</i><p>+3 this month</p></article>
        <article class="relay-alert"><span>NEW SIGNAL</span><h2>Pricing confidence</h2><p>34% more questions this week.</p><button>Open signal</button></article>
      </section>
    </main>`, clientView);
}

function update(key, value) {
  state[key] = value;
  history.replaceState(null, "", `?${new URLSearchParams(state).toString()}`);
  render();
}

function render() {
  document.documentElement.dataset.concept = state.concept;
  document.documentElement.dataset.theme = state.theme;
  const content =
    state.screen === "compare" ? compareScreen() :
    state.screen === "landing" ? landingScreen() :
    state.screen === "workspaces" ? workspacesScreen() :
    state.screen === "client" ? adminScreen(true) :
    adminScreen(false);

  document.querySelector("#app").innerHTML = `${prototypeBar()}<div class="stage"><div class="stage-label"><div><span>Option ${Object.keys(concepts).indexOf(state.concept) + 1}</span><strong>${concepts[state.concept].name}</strong></div><p>${concepts[state.concept].note}</p></div><div class="frame">${content}</div></div>`;

  document.querySelectorAll("[data-concept]").forEach((button) => button.addEventListener("click", () => update("concept", button.dataset.concept)));
  document.querySelectorAll("[data-screen]").forEach((button) => button.addEventListener("click", () => update("screen", button.dataset.screen)));
  document.querySelectorAll("[data-theme-toggle], [data-theme-inner]").forEach((button) => button.addEventListener("click", () => update("theme", state.theme === "light" ? "dark" : "light")));
}

render();

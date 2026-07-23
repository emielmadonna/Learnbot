# Course AI Platform — Product Addendum

**Authority:** supplied documentation brief, 2026-07-23
**Relationship to v3:** additive unless an explicit conflict is listed below
**Source limitation:** no separate full-form addendum file was found. This document preserves every addendum requirement available in the supplied brief; it does not claim verbatim preservation of an unavailable source.

## 1. Addendum intent

The platform is not only a course-grounded assistant. It is a provider-neutral, multi-tenant learning intelligence product that gives:

- Students a seamless, branded text or optional voice assistant embedded in the learning context.
- Creators a calm operating surface for questions, confusion, content gaps, student progress, wins, and evidence-backed commercial opportunities.
- Platform Owners a secure control plane for onboarding, ingestion, providers, costs, tenant health, margin, and audit.

The experience MUST be exceptionally polished, calm, precise, responsive, premium, and purpose-built. Generic dashboard templates are not an acceptable starting point.

## 2. Explicit changes to Product Specification v3

| v3 statement | Addendum ruling | Consequence |
|---|---|---|
| Voice/phone bot is retired and voice is revisited in Phase 6 | Voice mode is an optional first-class interaction channel, not a separate product | Architecture MUST support voice now; release sequencing remains an **open decision** |
| Named providers appear as stack defaults | Business logic depends only on capability interfaces | Named providers MAY be default adapters; no core chat, ingestion, intelligence, or tool logic may import their SDKs |
| Students have no tool-use surface in v1 | Students receive no tool access by default | Later access requires an explicit product decision, tenant policy and narrowly scoped capability grant |
| Widget conversation channel is `widget` | Text and voice share one conversation continuity model | Channel metadata distinguishes modalities without splitting the product or student history |

No other v3 decision is superseded.

## 3. Data tracking and intelligence

The platform MUST:

- capture a validated, versioned Event taxonomy;
- preserve event time, ingestion time, tenant, actor/subject, session, source and consent context;
- make raw events append-only and derived intelligence reproducible;
- distinguish observed facts from inferred scores;
- store evidence for every Student Opportunity and alert;
- expose freshness, identity confidence and data limitations;
- support confusion, content-gap, progress, engagement, intent, buying-language, win and stall analysis;
- support per-student export and deletion without corrupting aggregate reporting;
- prevent cross-tenant joins except through owner-only, audited aggregate operations;
- track data quality and provider degradation so missing data is never silently interpreted as negative behavior.

See [Data and Intelligence](04-DATA-AND-INTELLIGENCE.md) and [Student Opportunity Engine](05-STUDENT-OPPORTUNITY-ENGINE.md).

## 4. Opportunity intelligence

The Creator experience MUST include:

- a “Hot Student” or equivalent high-intent surface;
- offer-opportunity detail with score, label, evidence, data freshness and confidence;
- the course/offer relationship that made the opportunity relevant;
- recommended next action framed as assistance, not autonomous outreach;
- lifecycle state (`new`, `seen`, `actioned`, `dismissed`, `converted`, `expired`);
- false-positive feedback;
- suppression for insufficient consent, anonymous identity, stale evidence or permission limits;
- no claim that a Student is ready to buy without cited evidence.

Scores assist human judgment. They MUST NOT autonomously contact, price-discriminate, restrict learning access, or make consequential decisions.

## 5. COGS and unit economics

Every billable or materially variable operation MUST write cost telemetry with tenant, capability, provider, model, quantity, unit, provider cost, funding source, request/job reference and timestamp. The system MUST support:

- platform-funded and BYOK usage;
- ingestion and recurring runtime costs;
- voice minutes and realtime session costs;
- storage, bandwidth, queues, email, analytics, vector operations, tool calls and observability;
- cost allocation by tenant, feature, student and time period where technically feasible;
- plan price, discounts, credits, refunds and revenue;
- gross margin in dollars and percent;
- estimates explicitly separated from finalized provider invoices;
- budgets, thresholds, hard caps, graceful degradation and owner alerts.

Pricing remains **open**. See [COGS and Unit Economics](06-COGS-AND-UNIT-ECONOMICS.md).

## 6. White labeling

White labeling is per Tenant and MUST cover:

- product/assistant name, avatar, logo, primary/accent/surface colors;
- typography selection from an approved, performance-safe set;
- launcher position and style, greeting, tone and disclosure copy;
- voice selection and availability;
- email sender presentation where supported;
- links to tenant privacy policy, terms and support;
- optional custom domain and removal/replacement of platform attribution, subject to plan;
- accessible contrast validation and a safe default theme;
- preview, draft, publish and rollback;
- semantic design tokens rather than arbitrary CSS injection.

Tenant branding MUST NOT alter security boundaries, hide mandatory AI/recording/privacy indicators, or inject executable code.

## 7. Seamless Student experience

The Widget MUST:

- load without breaking or materially slowing the host;
- preserve one conversation across text/voice, panel/expanded/mobile, and page navigation where the host permits;
- understand current page/course/module/lesson context;
- stream useful feedback promptly;
- make sources and diagrams understandable and accessible;
- recover from refresh, network interruption, provider failure and permission denial;
- clearly indicate identity, AI, voice, recording and degraded states;
- provide keyboard, screen-reader, reduced-motion and touch behavior;
- avoid exposing dashboard, internal score, tool or tenant-administration concepts to Students.

## 8. Seamless Creator experience

The Creator surface MUST:

- open with “This Week,” not a generic dashboard;
- translate metrics into plain-language insight with evidence and drill-down;
- connect Questions, Confusion Map, Content Gaps, Students and Opportunities without dead ends;
- keep configuration safe through preview, drafts, versioning and rollback;
- provide a side-by-side Assistant Studio Playground;
- make diagram curation fast and visually trustworthy;
- make widget branding and installation guided and verifiable;
- expose permission and integration limitations honestly;
- preserve context and filters across navigation;
- never require SQL or code for ordinary tenant operation.

## 9. Provider-neutral architecture

Adapters and routers MUST exist for:

1. chat/completion LLMs;
2. embeddings;
3. reranking;
4. transcription/speech-to-text;
5. text-to-speech;
6. realtime voice transport;
7. vision/diagram analysis;
8. image or SVG generation;
9. storage;
10. queues;
11. email;
12. analytics;
13. authentication;
14. vector databases;
15. observability;
16. webhooks;
17. billing;
18. MCP servers and tools.

Every router supports per-Tenant selection, platform defaults, BYOK, capability detection, health, fallback, timeouts, retries, circuit breaking, cost telemetry, audit logging, provider metadata and graceful degradation. See [Provider Routers](12-PROVIDER-ROUTERS.md).

## 10. Voice

Voice requirements include push-to-talk, tap-to-start conversation, interruption/barge-in, partial transcription, streaming response and speech, text continuity, captions, mute/audio controls, permission handling, latency budgets, text fallback, tenant voice selection, explicit Creator consent for cloned voices, usage/cost tracking, recording/retention settings, mobile, accessibility, privacy indicators and graceful degradation.

Voice cloning MUST NOT be assumed. It is optional and requires explicit documented Creator consent. See [Voice Mode](13-VOICE-MODE.md).

## 11. MCP and tools

MCP servers are centrally registered. Tool access is scoped by Tenant and role; permissions and risk are declared; secrets remain in Vault. Students receive no tools by default. Creator tools require explicit enablement. Every invocation is authorized, rate-limited, logged, costed and auditable. Tool output is untrusted. Models cannot select tools outside the allowed set. Remote failures degrade safely. Adapters add servers without modifying chat logic.

See [MCP and Tools Architecture](14-MCP-AND-TOOLS-ARCHITECTURE.md).

## 12. Required mockups before dashboard implementation

The first prototype set MUST cover:

1. Student Widget launcher, panel, expanded view, mobile sheet, text and voice.
2. Creator Home / This Week.
3. Hot Student and offer-opportunity detail.
4. Questions, Confusion Map and Content Gaps.
5. Student profile and history.
6. Assistant Studio and side-by-side Playground.
7. Diagram Curation Gallery.
8. Widget branding and installation.
9. Tenant onboarding.
10. Ingestion operations.
11. Usage, COGS, revenue and margin.
12. Provider and key configuration.

Every screen MUST specify empty, loading, populated, error, degraded-integration and permission-limited states, plus responsive, keyboard, animation, success-feedback and failure-recovery behavior.

## 13. Execution constraints

Initial execution uses no more than three concurrent workers and starts with two until inspection is complete. Do not run local LLMs, multiple development servers, duplicate package installations, or parallel heavy builds/tests/browser/media work. Give workers narrow scopes, stop idle processes, record PIDs/ports, check memory pressure before intensive work, and serialize builds, test suites, browser automation and media processing.

See [Parallel Workstreams](17-PARALLEL-WORKSTREAMS.md).

## 14. Addendum acceptance

This addendum is satisfied only when:

- all capability categories have provider-neutral contracts;
- tenant selection/BYOK/fallback/telemetry are acceptance-tested;
- voice text-fallback, privacy and consent paths are tested;
- tools cannot escape Tenant/role/capability policy;
- Student Opportunities cite evidence and disclose confidence/freshness;
- COGS reconciles usage to costs and separates estimates from invoices;
- white-label themes pass accessibility and cannot inject code;
- all required mockups and their state matrices are approved before corresponding dashboard implementation is considered complete.

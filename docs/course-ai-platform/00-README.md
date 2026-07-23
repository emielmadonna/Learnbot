# Course AI Platform documentation

**Status:** source of truth for product and engineering work
**Repository:** `/Users/emielmadonna/Documents/LearningBot`
**Legacy input:** `/Users/emielmadonna/Estie Starr` (read-only; not a Git repository)
**Last reconciled:** 2026-07-23

## Authority and reading order

1. [Product Specification v3](01-PRODUCT-SPECIFICATION.md) is preserved verbatim from the legacy Estie project.
2. [Product Addendum](02-PRODUCT-ADDENDUM.md) adds the requirements supplied with this documentation task. Where it explicitly changes v3, the addendum wins.
3. Topic documents below turn those sources into implementation-ready contracts. They may clarify, organize, or cross-reference; they may not silently change a locked decision.
4. [Risks and Decisions](19-RISKS-AND-DECISIONS.md) is the canonical decision register. If a required choice is still open, an implementation agent must not invent it.
5. If code and these documents disagree, stop, record the mismatch, and resolve it before merging.

The separate full-form addendum referenced by the task was not found on disk. The only available addendum source is the supplied task brief. Its requirements are preserved in [02-PRODUCT-ADDENDUM.md](02-PRODUCT-ADDENDUM.md). This source gap is a **blocker to claiming that an unavailable document was preserved verbatim**, but it does not block architecture documentation.

## Document map

| Document | Purpose |
|---|---|
| [01 Product Specification](01-PRODUCT-SPECIFICATION.md) | Immutable v3 baseline |
| [02 Product Addendum](02-PRODUCT-ADDENDUM.md) | New scope, conflicts, white-labeling, experience and operational requirements |
| [03 System Architecture](03-SYSTEM-ARCHITECTURE.md) | Deployables, boundaries, runtime flows and degradation |
| [04 Data and Intelligence](04-DATA-AND-INTELLIGENCE.md) | Data model, event envelope, lineage, retention and intelligence jobs |
| [05 Student Opportunity Engine](05-STUDENT-OPPORTUNITY-ENGINE.md) | Evidence-backed intent, opportunities, alerts and human action |
| [06 COGS and Unit Economics](06-COGS-AND-UNIT-ECONOMICS.md) | Cost ledger, allocation, pricing inputs, margin and guardrails |
| [07 UX Information Architecture](07-UX-INFORMATION-ARCHITECTURE.md) | Roles, sitemap, navigation and end-to-end flows |
| [08 UI Design System](08-UI-DESIGN-SYSTEM.md) | Visual language, components, accessibility, motion and states |
| [09 Widget Experience](09-WIDGET-EXPERIENCE.md) | Student launcher, panel, expanded, mobile, text and voice behavior |
| [10 Creator Experience](10-CREATOR-EXPERIENCE.md) | This Week, Questions, Students, Studio, curation and setup |
| [11 Admin Experience](11-ADMIN-EXPERIENCE.md) | Tenants, onboarding, ingestion, providers, COGS and audit |
| [12 Provider Routers](12-PROVIDER-ROUTERS.md) | Capability interfaces, selection, fallback, BYOK and telemetry |
| [13 Voice Mode](13-VOICE-MODE.md) | Realtime voice lifecycle, consent, privacy, latency and fallback |
| [14 MCP and Tools Architecture](14-MCP-AND-TOOLS-ARCHITECTURE.md) | Registry, authorization, risk, isolation and safe invocation |
| [15 Security and Tenancy](15-SECURITY-AND-TENANCY.md) | Threat model, RLS, secrets, authorization and security tests |
| [16 Implementation Plan](16-IMPLEMENTATION-PLAN.md) | Dependency-ordered delivery phases and gates |
| [17 Parallel Workstreams](17-PARALLEL-WORKSTREAMS.md) | Three bounded workstreams and RAM-safe coordination |
| [18 Acceptance Tests](18-ACCEPTANCE-TESTS.md) | Traceable product, security, resilience and UX acceptance |
| [19 Risks and Decisions](19-RISKS-AND-DECISIONS.md) | Locked/open decisions, assumptions, blockers and risks |
| [Handoff Prompt](HANDOFF-PROMPT.md) | Copy-ready instructions for future engineering agents |

## Requirement language

- **MUST / MUST NOT:** acceptance-blocking requirement.
- **SHOULD / SHOULD NOT:** expected default; deviation requires a recorded decision.
- **MAY:** optional behavior.
- **Locked:** approved and not open to agent reinterpretation.
- **Open:** owner decision required.
- **Assumption:** working premise that must be validated.
- **Blocker:** work that cannot honestly be completed without missing authority, source, credential, or evidence.

## Change protocol

Any change to product behavior must:

1. name the source requirement and affected documents;
2. update the decision register;
3. update schemas/interfaces and acceptance tests together;
4. preserve historical source documents;
5. state migration and rollout implications;
6. be reviewed for tenant isolation, cost attribution, accessibility, and graceful degradation.

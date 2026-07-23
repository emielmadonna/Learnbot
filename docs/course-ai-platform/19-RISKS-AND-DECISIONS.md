# Risks, Decisions, Assumptions and Blockers

## Decision status rules

- **Locked:** implementation must follow it.
- **Open:** owner choice required; agents may research or prototype behind an interface but may not silently choose.
- **Assumption:** safe planning premise, to be validated before the affected release gate.
- **Blocker:** cannot honestly complete the named outcome without new source, authority or evidence.

## Locked decisions

| ID | Decision |
|---|---|
| L-01 | Supabase/Postgres is the system of record; pgvector, RLS, Storage, Vault and Auth are baseline capabilities. |
| L-02 | Cloudflare Worker is the Edge API target; one role-gated Next.js app serves Creator and Admin surfaces. |
| L-03 | Core business logic depends on capability interfaces, never named-provider SDKs. Named defaults live only in adapters/configuration. |
| L-04 | Every tenant-scoped record carries `tenant_id`; RLS and isolation tests are deployment gates. |
| L-05 | Widget is framework-free TypeScript, Shadow DOM, <50KB gzipped, fail-silent and host-safe. |
| L-06 | Identity has `verified`, `self_reported` and `anonymous` tiers; Circle client data is not trusted until server verification. |
| L-07 | Progress is received through Circle Workflows webhooks when available; degraded plans remain functional and visibly limited. |
| L-08 | Diagrams use vision-assisted SVG recreation with raster fallback and a mandatory human curation gate. |
| L-09 | Event facts are append-only; derived intelligence stores evidence, model/rule versions, freshness and confidence. |
| L-10 | Voice is optional, shares text conversation continuity, and falls back to text. Voice cloning requires explicit recorded Creator consent. |
| L-11 | Students have no tool access by default. Tool output is untrusted and every invocation is authorized, limited, logged, costed and audited. |
| L-12 | All variable cost is attributable from the first implementation phase. BYOK and platform-funded usage are distinct funding sources. |
| L-13 | Design system and approved mockups precede completion of dashboard UI. Every screen has the complete state/behavior matrix. |
| L-14 | No agent may weaken security, consent, accessibility or tenant isolation for speed. |
| L-15 | Text, voice and file attachments share one composer, ordered conversation and context model; voice is not a separate product or history. |
| L-16 | UI, API and first-party management MCP use the same tenant-aware application services, validation, job/version model and audit path. MCP is never a database/Vault bypass. |
| L-17 | Ordinary Creator/Teacher course create, edit, clean, selective re-ingest, preview, publish and rollback require no SQL or code. |

## Open decisions

| ID | Decision needed | Needed by | Safe work before decision |
|---|---|---|---|
| O-01 | Product name and domain | Dashboard auth/CDN production setup | Use neutral tokens and environment configuration |
| O-02 | Queue implementation: Supabase Queues/cron vs Cloudflare Queues | Foundation phase | Build `QueueProvider` contract and conformance tests |
| O-03 | Pricing, plans, included usage, setup fees and BYOK discount | Commercial beta | Build cost ledger and configurable plan model |
| O-04 | Digest email provider | Intelligence release | Build `EmailProvider`; use test adapter |
| O-05 | Creator access to model parameters | Creator Studio release | Default UI to Voice Guide only; retain policy-controlled capability |
| O-06 | Voice release phase and supported initial browsers | Prototype approval | Build contracts, state machine and text fallback |
| O-07 | Voice recordings: disabled by default vs opt-in default per tenant; retention durations | Voice pilot | Store no audio; retain transcripts only under existing policy |
| O-08 | Initial realtime/STT/TTS provider adapters and fallback matrix | Voice implementation | Provider-neutral contracts and fake adapters |
| O-09 | Opportunity score component weights, cohort window/minimum sample, thresholds beyond v3 labels, expiry and offer matching policy | Intelligence implementation | Build versioned policy schema and deterministic fixture tests |
| O-10 | Custom-domain and “powered by” plan entitlement | White-label release | Semantic theming and verified default domain |
| O-11 | Analytics and observability provider adapters | Production operations | Use interfaces and structured local/test sinks |
| O-12 | Initial MCP servers/tools and creator permissions | Tools pilot | Registry, deny-by-default policy and fake server tests |
| O-13 | Data retention by record class and region | Production privacy review | Minimize collection; configuration schema; deletion workflow |
| O-14 | Whether the legacy Estie code/assets are copied, archived, or migrated in place | Phase 0 migration | Treat `/Users/emielmadonna/Estie Starr` as read-only input |
| O-15 | Initial chat attachment types, per-file/conversation limits and attachment retention | Unified runtime implementation | Build validation/scanning/extraction contracts; use conservative configurable test limits and no silent KB promotion |

## Assumptions

| ID | Assumption | Validation |
|---|---|---|
| A-01 | `/Users/emielmadonna/Documents/LearningBot` is the intended new product repository. | Confirmed by workspace and creation timing; owner should confirm before legacy migration. |
| A-02 | `/Users/emielmadonna/Estie Starr/PLAN.md` is the authoritative v3 source. | Byte-compare preserved copy to source. |
| A-03 | Circle behavior recorded in v3 remains accurate enough for planning. | Revalidate in a staging community before implementation; do not silently rewrite the historical v3 source. |
| A-04 | Text chat is the baseline degraded mode for all voice failures. | Validate in voice prototypes and acceptance tests. |
| A-05 | Opportunity recommendations are human-assistive and never autonomous outreach. | Product/privacy review before release. |
| A-06 | The 14–18 week enterprise-beta range assumes three experienced full-time implementation lanes, timely decisions/accounts and no unknown legacy-data migration. | Reforecast after the first two-week contract/prototype gate and then at each vertical-slice gate. |

## Blockers

| ID | Blocker | Effect | Unblock condition |
|---|---|---|---|
| B-01 | The referenced separate full product addendum was not found in the repository, legacy project or supplied attachments. | Cannot claim verbatim preservation of that unavailable source. | Owner supplies the addendum text/file; reconcile it into `02` without deleting current provenance. |
| B-02 | No product name/domain decision. | Blocks production-facing auth email/CDN/custom-domain configuration, not foundations. | Owner decision O-01. |
| B-03 | Opportunity scoring weights and policy are not defined exactly in v3 or the brief. | Blocks production scoring; does not block data/event foundations. | Owner-approved, versioned scoring policy O-09. |
| B-04 | Voice consent/recording retention policy is incomplete. | Blocks recording and voice cloning; does not block non-recording prototype. | Legal/privacy and owner approval for O-07. |
| B-05 | Provider credentials, billing accounts and production infrastructure are absent from this empty repository. | Blocks live provider/deployment evidence, not interface design or fakes. | Authorized environment and secrets through Vault. |

## Risk register

| Risk | Mitigation / acceptance evidence |
|---|---|
| Circle changes unsupported custom-code behavior | Fail-silent widget, anonymous fallback, versioned connector, real-host smoke test and event-drop alert |
| Cross-tenant data leak | RLS on every tenant table, service authorization, negative isolation matrix, deploy gate |
| Inferred intent harms trust | Evidence, confidence/freshness, human review, dismiss feedback, no autonomous action |
| Provider outage or account limit | Health-aware router, bounded retries, circuit breaker, fallback and explicit degraded state |
| Cost runaway | Per-call ledger, budgets, 80% alert, hard cap, idempotency and BYOK distinction |
| Prompt injection/tool abuse | Retrieved/tool content treated as data, allowlisted tools, schema validation, output limits and audit |
| Voice privacy/consent failure | Always-visible indicators, no cloning without consent, configurable retention and immediate text fallback |
| Diagram misrepresentation | Side-by-side human curation, approval gate, raster fallback, source link |
| White-label theme harms accessibility | Semantic tokens, contrast checks, safe fallback theme, no arbitrary CSS/JS |
| Missing events appear as low engagement | Data-health/freshness flags; “unknown” instead of zero when integration is degraded |
| One-person operations overload | Idempotent jobs, loud queues, runbooks, auditability, bounded workstreams |
| Parallel lanes drift into three implementations of the same rule | One tenant-aware application-service layer; contract owner; UI/API/MCP parity fixtures at every integration gate |
| File upload becomes an injection, malware or data-leak path | Signed tenant-bound upload, validation/quarantine/extraction gate, content-as-data boundary, retention/deletion and negative isolation tests |
| “Fast ingestion” causes silent content corruption | Draft/active versions, low-confidence review queue, scope/diff preview, selective retry, atomic publish and rollback |
| Legacy secret or personal data migration | Inventory, secret scanning, explicit migration allowlist, never commit `.env`, recordings or raw private assets |

# Implementation Evidence

**Recorded:** 2026-07-23
**Scope:** local development repository represented by the commit containing
this file
**Environment:** Node 22, pnpm workspace, macOS local console on
`http://127.0.0.1:3100`

This ledger prevents a deterministic fake, package test, or local development
screen from being mistaken for live-host or production evidence.

## Evidence grades

| Grade | Meaning |
|---|---|
| A | Retained evidence from the intended live host/provider/infrastructure |
| B | Integrated local application evidence across real repository boundaries |
| C | Deterministic contract, unit, or fake-adapter evidence |
| Blocked | Required authority, policy, credential, host, or infrastructure is unavailable |

Passing at grade C does not satisfy an acceptance row that explicitly requires
a live host, production provider, database policy execution, usability study,
assistive-technology matrix, load test, restore, or legal policy.

## Current verified increment

| Acceptance | Grade | Expected and actual result | Evidence |
|---|---:|---|---|
| WID-01 | C | Framework-free Shadow DOM distribution is fail-silent, contains no dynamic-code primitive, and both outputs remain below 50KB gzip. Actual outputs are approximately 11.5KB gzip. | `pnpm --filter @course-ai/widget-runtime test`; `packages/widget-runtime/tests/widget-runtime.test.mjs` |
| WID-02, WID-08 | B / partial | The real custom element renders as a desktop panel and 390px mobile sheet, restores the same conversation after viewport changes, expands/restores, and passes deterministic pointer/keyboard/clamping fixtures. External host, assistive-technology, and browser-matrix evidence remains pending. | `pnpm --filter @course-ai/console smoke:widget`; Widget Lab browser QA; widget tests 3–4 |
| WID-04, WID-06, WID-07 | B / partial | The real host simulator changes identity tier, tenant branding, and resolved/stale/ambiguous/unknown context at runtime; deterministic tests ensure the runtime never guesses. Production identity/context adapters remain pending. | Widget Lab browser QA; widget test 5 |
| WID-05 | B / partial | Browser QA retains typed text/voice/evidence events and the conversation identifier across desktop/mobile/expanded changes; deterministic fixtures cover attachment/source/diagram/reconnect ordering. Live realtime media and signed uploads remain pending. | Widget Lab browser QA; widget tests 6–9 |
| VOI-01, VOI-02 | B / partial | The unified Student conversation binds voice lifecycle to the authenticated tenant and actor, preserves the mounted text composer during voice presentation, restores draft/scroll/focus on exit, acknowledges interruption, and supports safe cancellation and text fallback. The integrated presentation expands from the real microphone origin; stale animation frames are cancelled during rapid reversals and reduced-motion mode has no artificial delay. Live low-latency speech/realtime providers, measured latency budgets, actual audio-energy animation, reconnect/resume, and production browser evidence remain pending. | `pnpm --filter @course-ai/console test`; `apps/console/test/voice-transition-contract.test.ts`; `/dev/chat` browser QA |
| VOI-03–VOI-05 | Blocked / partial | Local controls do not retain raw audio by default and do not enable voice cloning. Approved O-07 recording policy, scope-specific cloning consent, live provider usage/cost telemetry, and production latency evidence remain unresolved; local fixtures are not evidence for these requirements. | Open decisions in `19-RISKS-AND-DECISIONS.md`; production adapter gap |
| INT-01 | C | Unknown/malformed event versions quarantine; event and delivery keys deduplicate; conflicting reuse quarantines without stopping the batch. | `pnpm --filter @course-ai/intelligence-core test`, cases 1–3 |
| INT-02 | C | Confusion, trailing-30-day content gap, stall, and same-tenant velocity fixtures match the documented formulas. | Intelligence core test, cases 5–9 |
| INT-03 | C | Missing, degraded, or incomplete sources produce partial/unknown rather than a false known zero. | Intelligence core test, case 10 |
| INT-01–INT-03 | B / partial | The Creator intelligence API and `/dev/intelligence` use the package runtime through a membership-derived tenant session, preserve known/partial/unknown semantics, expose source health/evidence/suppression, bound mutation input, and reject conflicting idempotency reuse. Durable event/warehouse sources and production identity remain pending. | `pnpm --filter @course-ai/console smoke:intelligence`; Creator intelligence browser QA |
| OPP-01, OPP-02 | C | Same-tenant evidence, identity, consent, coverage, freshness, policy, confidence, and expiry gates are required; ineligible cases suppress. | Intelligence core test, cases 11–14 |
| OPP-03 | C | Lifecycle and false-positive feedback require a human Creator/Owner and commit with an audit record; the package exposes no autonomous consequential action. | Intelligence core test, case 15 |
| OPP-01–OPP-03 | B / partial | The Creator operations surface supports audited human-only lifecycle review and feedback against same-tenant evidence. It exposes no autonomous outreach or consequential action. Production policy/calibration and durable audit storage remain pending. | `/dev/intelligence`; intelligence API smoke |
| OPP-04 | Blocked | No score, threshold, expiry duration, offer match, or calibration gate is invented. | Open decision O-09 in `19-RISKS-AND-DECISIONS.md` |
| SEC-08 | C / partial | Exact-grant subject access/export/delete and retention jobs are tenant-scoped, resumable, idempotent, legal-hold aware, tombstoned, and integrity-checked. Approved O-07/O-13 policy, real RLS/storage/vector deletion, archive delivery/expiry, tenant closure, and live production evidence remain pending. | `pnpm --filter @course-ai/privacy-lifecycle test`, 17 adversarial cases |
| SEC-08 | B / partial | `/api/dev/privacy` and `/dev/privacy` integrate exact-purpose previews, legal-hold-aware jobs, one-use exact confirmation for delete/retention, manifest verification, tombstones, and audit evidence. The UI clearly labels policy values as non-production fixtures and leaves O-07/O-13 unresolved. Durable queues/stores, real provider deletion, signed archives, approved policy, and tenant closure remain pending. | `pnpm --filter @course-ai/console smoke:privacy`; Privacy operations browser QA |
| MCP-02, MCP-03 | C | Default/cross-tenant/cross-actor/invalid/expired/over-budget/over-rate calls deny before invocation; replays are idempotent; output and errors are bounded and safe. | `pnpm --filter @course-ai/mcp-server test`, 12 cases |
| MCP-08 | C / partial | Invocation without the exact capability, budget, and unexpired grant denies. Per-principal tool-discovery filtering still requires a connection-bound production principal/registry adapter. | MCP authorization tests; production adapter gap |
| MCP-06, MCP-07 | B | Twenty-eight tools use shared console API boundaries, including intelligence review/feedback and separately permissioned privacy lifecycle operations. Smoke covers shared authoring/intelligence/privacy snapshots, authorized course, feedback and manifest operations, plus a denied write. Delete/retention still require one-use exact confirmation. Durable multi-replica grant/idempotency stores and production service-principal provenance remain pending. | `pnpm --filter @course-ai/mcp-server smoke` |
| Build/runtime isolation | B / partial | Next.js development output is isolated in `.next-dev` while optimized production output remains in `.next`, preventing a parallel production build from replacing the running development server manifests. This is local integration evidence only; production deployment, CI/CD, migration gates, and live-host operational evidence remain pending. | `apps/console/next.config.ts`; local development and production build verification |
| Durable execution | C / partial | Fingerprinted command receipts replay the same normalized JSON result or reject conflicting reuse; course revisions use a locked compare-and-swap head; telemetry uses tenant-scoped dedupe and bounded leases. The adapters require an injected transaction and have no process-memory fallback. They are not yet wired into every application service. | `pnpm --filter @course-ai/postgres-adapters test`; `packages/postgres-adapters` |
| Durable schema | C / partial | Migration 0007 defines four tenant-scoped durable-execution tables with forced RLS, immutable facts and a course/revision-number/ID head constraint. Structural verification covers 7 migrations and 29 tables. The SQL negative test exists but has not run against PostgreSQL on this machine because Docker is unavailable. | `pnpm supabase:verify`; `infra/supabase/migrations/0007_durable_execution_primitives.sql`; `infra/supabase/tests/durable_execution_primitives_verification.sql` |
| Private fixture preview | C / partial | Production builds deny fixture APIs by default. Two exact opt-in values are required to enable a non-production fixture preview; `/api/health` provides dependency-free liveness and the server binds on all interfaces. A hosting project, host-level private access and live deployment evidence remain pending. | `apps/console/test/deployment-mode.test.ts`; local production-mode start/curl checks; `.github/workflows/ci.yml` |

## Whole-repository gate

The root integration gate for this increment is:

```bash
pnpm install
pnpm check
pnpm build
COURSE_AI_CONSOLE_URL=http://127.0.0.1:3100 pnpm verify:dev
git diff --check
```

`verify:dev` includes the development API, authoring, intelligence, privacy,
Widget host, all 28 MCP tools, and the structural Supabase smoke suites. The
intelligence and privacy entry points are respectively:
`pnpm --filter @course-ai/console smoke:intelligence` and
`pnpm --filter @course-ai/console smoke:privacy`.

The final integration handoff must record the actual outcome. A structural
Supabase verifier is not equivalent to executing the PostgreSQL negative-policy
suite.

### 2026-07-23 integration outcome

- Before the final development-cache isolation and smoke environment/timeout
  changes, `pnpm check`: **passed** after the root integration typecheck corrected two
  Widget host ref initializers and one over-narrowed intelligence assertion.
- Before those final configuration changes, `pnpm build`: **passed**, including
  the optimized Next.js production build and all 27 application routes.
- Before those final configuration changes,
  `COURSE_AI_CONSOLE_URL=http://127.0.0.1:3101 pnpm verify:dev`: **passed** after
  warm-up, including authenticated/cross-tenant API fixtures, authoring restore,
  intelligence and privacy smoke, Widget host/assets, all 28 MCP tools, and the
  Supabase structural verifier.
- Fresh Widget Lab browser QA: **passed** at 1440px desktop and 390px mobile
  with the same conversation ID/item count restored; a fresh reload produced
  no new warning/error log. The post-build development server restarted
  successfully and `/api/dev/health` plus the Widget route smoke passed.
- Fresh `/dev/chat` browser QA at 1200×952 **passed** for the desktop text
  presentation, connecting-state voice entry, rapid connecting-state reversal,
  draft and nonzero-scroll preservation, textarea focus restoration, and the
  permission-failure recovery path, with no browser console warning or error.
  Chrome denied microphone access and the available browser could not emulate
  mobile geometry or reduced motion, so listening/thinking/speaking visuals,
  live audio-energy behavior, mobile geometry, and reduced-motion browser
  behavior remain unclaimed here; their deterministic transition contracts pass
  in the focused console suite.
- Post-configuration revalidation at port 3100 **passed**:
  `pnpm check`; `pnpm build`, including all 27 application routes;
  `COURSE_AI_CONSOLE_URL=http://127.0.0.1:3100 pnpm verify:dev`, including all
  28 MCP tools and the intelligence/privacy smoke suites; and
  `git diff --check`. These remain local grade-B/C integration and contract
  results, not live-host or production-provider evidence.
- Durable execution and private-preview preparation: focused console tests
  **passed 14/14**; PostgreSQL adapter tests **passed 6/6**; the optimized Next
  build **passed with 28 application routes**, including the new
  `/api/health`; default production mode returned 200 for `/api/health` and
  denied `/api/dev/health` with 403; explicit fixture-preview mode allowed the
  fixture health path. Supabase structural verification **passed** for 7
  migrations, 29 tables, 6 existing security controls and 3 durable controls.
  No hosting or live-PostgreSQL evidence is claimed.
- The post-integration whole-repository gate **passed**: `pnpm check`;
  `pnpm build`; `COURSE_AI_CONSOLE_URL=http://127.0.0.1:3100 pnpm verify:dev`;
  and `git diff --check`. The shared development server remained healthy after
  the isolated production build.

## Explicitly unproven

The repository does not yet claim grade-A evidence for:

- production OIDC/SAML/service-principal verification or durable authorization;
- live PostgreSQL RLS/storage negative tests on an approved database;
- live LLM, embedding, transcription, speech, realtime, storage, malware, or
  connector providers and their credentials;
- Circle/custom-code/CDN/CSP installation, browser matrix, screen-reader or
  usability acceptance;
- signed upload, malware quarantine, extraction, and retention execution;
- approved privacy retention periods, legal-hold policy, production
  export/delete/de-identification, voice recording, or voice cloning;
- O-09 opportunity scoring/calibration, billing reconciliation, load, restore,
  incident response, regional deployment, or production SLO evidence.

These are tracked as open decisions, blockers, production adapters, or later
implementation phases; they are not silently converted into local-development
claims.

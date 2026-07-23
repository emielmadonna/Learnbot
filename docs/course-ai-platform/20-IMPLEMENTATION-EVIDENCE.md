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
| INT-01 | C | Unknown/malformed event versions quarantine; event and delivery keys deduplicate; conflicting reuse quarantines without stopping the batch. | `pnpm --filter @course-ai/intelligence-core test`, cases 1–3 |
| INT-02 | C | Confusion, trailing-30-day content gap, stall, and same-tenant velocity fixtures match the documented formulas. | Intelligence core test, cases 5–9 |
| INT-03 | C | Missing, degraded, or incomplete sources produce partial/unknown rather than a false known zero. | Intelligence core test, case 10 |
| OPP-01, OPP-02 | C | Same-tenant evidence, identity, consent, coverage, freshness, policy, confidence, and expiry gates are required; ineligible cases suppress. | Intelligence core test, cases 11–14 |
| OPP-03 | C | Lifecycle and false-positive feedback require a human Creator/Owner and commit with an audit record; the package exposes no autonomous consequential action. | Intelligence core test, case 15 |
| OPP-04 | Blocked | No score, threshold, expiry duration, offer match, or calibration gate is invented. | Open decision O-09 in `19-RISKS-AND-DECISIONS.md` |
| SEC-08 | C / partial | Exact-grant subject access/export/delete and retention jobs are tenant-scoped, resumable, idempotent, legal-hold aware, tombstoned, and integrity-checked. Approved O-07/O-13 policy, real RLS/storage/vector deletion, archive delivery/expiry, tenant closure, and live production evidence remain pending. | `pnpm --filter @course-ai/privacy-lifecycle test`, 17 adversarial cases |
| MCP-02, MCP-03 | C | Default/cross-tenant/cross-actor/invalid/expired/over-budget/over-rate calls deny before invocation; replays are idempotent; output and errors are bounded and safe. | `pnpm --filter @course-ai/mcp-server test`, 12 cases |
| MCP-08 | C / partial | Invocation without the exact capability, budget, and unexpired grant denies. Per-principal tool-discovery filtering still requires a connection-bound production principal/registry adapter. | MCP authorization tests; production adapter gap |
| MCP-06, MCP-07 | B | Twenty tools use shared console API boundaries; smoke covers shared snapshots, authorized course create and authoring dry-run, and a denied write. Durable multi-replica grant/idempotency stores and production service-principal provenance remain pending. | `pnpm --filter @course-ai/mcp-server smoke` |

## Whole-repository gate

The root integration gate for this increment is:

```bash
pnpm install
pnpm check
pnpm build
pnpm smoke:dev
pnpm --filter @course-ai/console smoke:authoring
pnpm --filter @course-ai/console smoke:widget
pnpm --filter @course-ai/mcp-server smoke
pnpm supabase:verify
git diff --check
```

The final integration handoff must record the actual outcome. A structural
Supabase verifier is not equivalent to executing the PostgreSQL negative-policy
suite.

### 2026-07-23 integration outcome

- `pnpm check`: **passed** after the root integration typecheck corrected two
  Widget host ref initializers and one over-narrowed intelligence assertion.
- `pnpm build`: **passed**, including the optimized Next.js production build
  and all 23 application routes.
- `pnpm verify:dev`: **passed**, including authenticated/cross-tenant API
  fixtures, authoring restore, Widget host/assets, all 20 MCP tools, and the
  Supabase structural verifier.
- Fresh Widget Lab browser QA: **passed** at 1440px desktop and 390px mobile
  with the same conversation ID/item count restored; a fresh reload produced
  no new warning/error log. The post-build development server restarted
  successfully and `/api/dev/health` plus the Widget route smoke passed.

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

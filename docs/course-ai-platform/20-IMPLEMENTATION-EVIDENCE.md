# Implementation Evidence

**Recorded:** 2026-07-24
**Scope:** local development repository represented by the commit containing
this file
**Environment:** Node 22, pnpm workspace, macOS local console on
`http://127.0.0.1:3100`

This ledger prevents a deterministic fake, package test, or local development
screen from being mistaken for live-host or production evidence.

## Correction — 2026-07-26

**This ledger's own guard rail failed.** Grade C means "deterministic contract,
unit, or fake-adapter evidence", and several rows below correctly carried that
grade — but a grade-C row for a package that nothing imports is not evidence of a
*product* capability at all, and the rows read as if it were. The 2026-07-26
integration audit (`docs/INTEGRATION-AUDIT.md`) found ~23,000 lines across eleven
packages reaching production through zero import edges.

The following packages were **deleted** on 2026-07-26. Every row below that cites
them is retained as a historical record of what was tested, and is **void as a
statement about the product**:

`application-services`, `course-authoring`, `intelligence-core`,
`learning-pipeline`, `mcp-server`, `onboarding-core`, `postgres-adapters`,
`privacy-lifecycle`, `realtime-voice`.

Each had already been re-implemented in plpgsql, and the SQL version is the one
running. Specifically void:

- **SEC-08 (privacy).** There is no privacy or GDPR code path — no route, no
  table, no job. The `/dev/privacy` surface cited in those rows was deleted.
  See `docs/PRIVACY-DATA-LIFECYCLE-SPEC.md`.
- **MCP-02, MCP-03, MCP-06, MCP-07, MCP-08.** There is no MCP server. It was
  never deployed — no Dockerfile, no deploy config, no CI step — and 27 of its 36
  tools called the `/api/dev/*` routes deleted in the same session.
- **INT-01 – INT-03, OPP-01 – OPP-03 (package rows).** The durable
  implementations are `20260725121000_learning_analytics.sql` and
  `20260726091000_question_intelligence.sql`, which have FK integrity, severity
  ranking and server-side re-detection the package lacked. The `/dev/intelligence`
  surface those rows cite was deleted.
- **Durable execution, Durable identity, Durable uploads (adapter rows).** The
  `postgres-adapters` rows describe code that required an injected
  `PostgresExecutor` **that nothing in the repository ever constructed**. Those
  adapters never executed against this application. The migrations they refer to
  (0007, 0008, 0009, 0026) are real and remain.
- **Identity verification.** `packages/identity-access` survives, but only
  `src/oidc.ts`. It is a JWT verifier that nothing imports — not this
  application's authentication, which is Supabase Auth. SAML and SCIM never
  existed and their stubs were deleted.

Also void repo-wide: every reference below to a `/dev/**` route, to
`pnpm --filter @course-ai/console smoke:intelligence`, `smoke:privacy`,
`smoke:widget`, or to `verify:dev` covering an MCP tool surface. Those routes and
scripts do not exist. Migration and table counts stated in prose below are stale;
run `pnpm supabase:verify` instead.

Uploads still terminate in quarantine. Authored course content, however, *is* now
projected into `learning_documents`/`learning_chunks` at publish time
(`20260726095000_authored_content_retrieval.sql`) — the gap the audit identified
as the product's blocker.

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
| VOI-01, VOI-02 | A/B/C / partial | The authenticated `/app/conversation` now establishes a server-authorized WebRTC session with OpenAI Realtime, automatic semantic turn detection, partial/final captions, interruption, mute/end controls and an audio-energy-reactive presentation. Each final transcript is sent through the same tenant-selected durable retrieval/response path as text; only the persisted grounded answer is then spoken. The browser receives no long-lived provider credential and raw audio is not retained by LearningBot. A bounded push-to-talk transcription/speech path remains as an explicit fallback. Membership preflight runs before microphone activation; context is frozen for active turns; stale work is invalidated; and all streams, requests, playback and object URLs are released on exit. Live signed-in browser latency, reconnect and barge-in acceptance remain pending. | Hosted OpenAI configuration; `/api/learning/voice/realtime`; `managed-access-realtime-contract.test.ts`; `production-voice-turn-contract.test.ts`; console tests, 48 cases; production build |
| VOI-03–VOI-05 | Blocked / partial | LearningBot does not persist the raw voice-turn audio and does not enable voice cloning. Approved O-07 recording policy, scope-specific cloning consent, durable provider usage/cost telemetry, production latency evidence, and full signed-in browser acceptance remain unresolved. | Open decisions in `19-RISKS-AND-DECISIONS.md`; production acceptance gap |
| Identity verification | C / partial | The OIDC verifier enforces exact issuer, audience and algorithm policy; HTTPS local/remote JWKS selection and rotation; `exp`/`nbf`/`iat`/maximum-age/skew; bounded mapped identity claims; and stable non-leaking failures. Hostile tests prove that token tenant, role and scope claims never become authorization facts. Approved IdP registration, console wiring, SAML/client credentials and live login evidence remain pending. | `pnpm --filter @course-ai/identity-access test`; `packages/identity-access/src/oidc.ts` |
| Secure upload intake | A/B/C / partial | Authenticated authors can now create exact tenant/actor-bound upload intents, upload PDF/text/Markdown/DOCX files of at most 25MB through short-lived signed Supabase Storage grants into the private tenant quarantine prefix, and confirm exact object/size evidence. Confirmation creates a durable learning source, resumable ingestion job and pending malware checkpoint; learner visibility and promotion remain blocked. The provider-neutral package contracts still cover callback replay, magic-byte/malware results and clean-only promotion. Malware scanning, extraction/OCR/transcription workers and clean-object promotion remain pending and are not simulated. | Hosted migration 0026 and privilege inspection; `authenticated_quarantine_uploads_verification.sql`; `/api/learning/uploads`; `pnpm --filter @course-ai/learning-pipeline test` |
| LLM provider adapter | A/B / partial | The provider-neutral OpenAI Responses adapter is wired server-side to the durable learning conversation with `store: false`, bounded source-only prompting, deadlines, refusal/error handling, persisted citations and replay protection. A live request to `gpt-5.6-luna` succeeded and returned provider usage metadata. Signed-in browser quality/latency, durable cost-ledger writes and fallback-provider evidence remain pending. | Live provider adapter probe on 2026-07-24; `pnpm --filter @course-ai/provider-router test`; `apps/console/src/lib/learning-provider.ts` |
| Durable Estie learning | A/B / partial | The hosted Estie tenant contains 6 published courses, 28 modules, 126 lessons, 126 learning documents, 2,757 searchable chunks and 6 active knowledge versions. All 2,757 chunks have 384-dimensional OpenAI embeddings. Tenant/publication/version/course filters execute inside a hybrid lexical/vector RRF RPC; provider failure degrades honestly to lexical retrieval. Explain, Practice and Check-me modes use the same durable conversation, and selected-lesson grounding fails closed rather than citing a different lesson. Authenticated RPC suites continue to prove workspace reads, mutations, conversations, replay and cross-tenant/forged-assistant denial. Production extraction workers remain pending. | Hosted Supabase project inspection; migrations 0017–0025; authenticated `learning-embeddings` Edge Function v3; `semantic-learning-contract.test.ts`; hosted transactional suites |
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
| MCP-06, MCP-07 | B / partial | Production discovery exposes exactly nine tools: health plus eight durable bearer-authenticated operations for workspace, hybrid retrieval, persisted conversations, quarantine status and course draft/publish. The 27 legacy `/api/dev/*` and build-plan tools are undiscoverable unless the process receives the exact local fixture opt-in, which produces 36 tools only for explicit fixture smoke. Tenant/role selection comes from the authenticated control plane and callers cannot override it. Connection-bound remote identity, token refresh, durable multi-replica metering/idempotency and production service-principal provenance remain pending. | `pnpm --filter @course-ai/mcp-server test`, 18 cases; `packages/mcp-server/src/server-discovery.test.ts`; fixture smoke |
| Build/runtime isolation | B / partial | Next.js development output is isolated in `.next-dev` while optimized production output remains in `.next`, preventing a parallel production build from replacing the running development server manifests. This is local integration evidence only; production deployment, CI/CD, migration gates, and live-host operational evidence remain pending. | `apps/console/next.config.ts`; local development and production build verification |
| Production Auth/onboarding boundary | B / partial | The production `/auth/sign-in`, `/auth/callback`, `/app` and `/onboarding` routes use strict Supabase SSR clients and UID-bound database RPCs. Same-origin POST, verified non-anonymous users, durable tenant selection, exact membership checks and explicit failures replace any fixture fallback. Signed-in browser acceptance, production SMTP, invitation delivery, SSO/SCIM and deprovisioning remain pending. | `apps/console/AUTH.md`; `apps/console/src/lib/supabase`; `apps/console/src/app/onboarding`; console Auth/onboarding contract tests |
| Managed password access | A/B/C / partial | Public signup is disabled. The hosted Auth tenant contains the confirmed initial owner `emielmadonna@gmail.com`, linked by a one-use expiring claim to the Estie Starr tenant with an active `tenant_owner` membership. The generated temporary password is returned once, is not stored in application tables, and forces the first authenticated request to `/auth/change-password`. Owners/admins can create managed tenant accounts with bounded roles and one-time temporary passwords from `/app/admin/users`. SSO/SCIM, invitation delivery, credential recovery and deprovisioning remain pending. | Hosted Auth/RPC probe on 2026-07-24; migration 0027; `learning-bootstrap-owner`; `learning-admin-users`; managed-access contract tests |
| Privacy-bounded usage events | A/B/C / partial | Auth, workspace, course, conversation, voice and upload lifecycle facts are written to an append-only tenant-scoped table through a bounded allowlisted RPC. Event properties are filtered, idempotency is durable, raw audio/content is excluded, and retention remains nullable until O-13 is approved. Migration 0028 resolves the exact active membership from the verified tenant/principal/role context; a hosted application-API probe wrote a durable conversation event and the admin view returned the real account/30-day totals rather than fixture values. Provider token/cost accounting and approved retention execution remain pending. | Hosted migrations 0027–0028; `learning_usage_events`; `/api/learning/events`; `/app/admin/users`; managed-access contract tests |
| Circle installation handoff | B / partial | `/install/circle` provides a tenant-safe operator guide and a static self-contained launcher script that opens the authenticated LearningBot workspace without trusting `window.circleUser` as authorization. A mobile/app link fallback is explicit. Installation in Estie's real Circle community, server-verified Circle identity, CSP compatibility and workflow/webhook acceptance remain pending. | `/install/circle`; `public/integrations/circle-learningbot.js`; production build |
| Durable execution | C / partial | Fingerprinted command receipts replay the same normalized JSON result or reject conflicting reuse; course revisions use a locked compare-and-swap head; telemetry uses tenant-scoped dedupe and bounded leases. The adapters require an injected transaction and have no process-memory fallback. They are not yet wired into every application service. | `pnpm --filter @course-ai/postgres-adapters test`; `packages/postgres-adapters` |
| Durable identity | C / partial | Migration 0008 and injected Postgres repositories preserve opaque verified principal IDs without coercing them into the legacy UUID membership model. Exact membership bootstrap is server-only; every tenant operation retains its tenant predicate; `platform_admin` is not a tenant membership; service principals do not use human invitations; invitation and SCIM receipts are immutable and conflict-safe. Protocol-verified principal registration is an explicit prerequisite. The current service contract still needs an outer unit of work before multi-repository invitation/SCIM flows can claim workflow-level atomicity. | `pnpm --filter @course-ai/postgres-adapters test`; `packages/postgres-adapters/src/identity.ts`; `infra/supabase/migrations/0008_identity_and_provisioning.sql` |
| Durable uploads | A/B/C / partial | Migration 0009 and `PostgresUploadIntentRepository` persist tenant/actor-bound intents and immutable callback receipts with exact row locks, atomic callback/state commits, optimistic versions and protected terminal facts. Migration 0026 wires authenticated signed uploads to the private hosted `tenant-private` quarantine bucket and creates durable source/job/checkpoint state only after exact confirmation. The focused adapter and existing hosted upload-intent suite pass. Malware-scanner, extraction-worker and clean-object promotion execution remain unclaimed. | `pnpm --filter @course-ai/postgres-adapters test`; hosted migrations 0009/0026; hosted `durable_upload_intents_verification.sql`; upload API contracts |
| OpenAI embeddings | A/B/C / partial | The provider-neutral server adapter retains request-scoped models, injected asynchronous credentials, HTTPS-only endpoints, absolute deadlines, bounded batches/bodies/dimensions, exact response validation, finite vectors, usage and injected cost accounting. The authenticated hosted `learning-embeddings` Edge Function executed the configured OpenAI adapter and backfilled all 2,757 Estie chunks; the application query path uses the same provider behind the filtered hybrid RPC. Durable per-request cost-ledger writes and fallback-provider execution remain pending. | Hosted Edge Function v3 and corpus inspection; `pnpm --filter @course-ai/provider-router test`; `packages/provider-router/src/openai-embeddings.ts` |
| Surface launchpad | B / non-production | The root launchpad links every visual preview route, distinguishes fixture status, reports its protected environment/build, repairs dead navigation, and provides a universal return control. Desktop and 390px browser checks found all eleven visual routes reachable with no horizontal overflow after the Course Studio diagram fix. This is discoverability and responsive preview evidence only. | Browser route inventory and responsive geometry check; `apps/console/src/app/page.tsx`; `apps/console/src/app/preview-navigator.tsx` |
| Durable schema | A/C / partial | Twenty-eight ordered migrations define 43 RLS-enabled public tables plus private operation/claim state for execution, identity, upload, onboarding, durable learning, owner claims, grounded retrieval, conversations, hybrid vectors, quarantine uploads and managed access. Structural verification passes and the hosted ledger includes 0001–0028. Existing eleven hosted transactional suites pass with rolled-back fixtures; the latest managed-access/usage migrations have hosted execution and live account/RPC evidence but not a new full transactional-suite claim. The live security advisor reports only intentional signed-in `SECURITY DEFINER` warnings; performance indexing and policy-consolidation advisories remain operational backlog. Backup/PITR restore, load and failover evidence remain pending. | `pnpm supabase:verify`; hosted migration/advisor/privilege inspection; hosted SQL acceptance transcript |
| Private fixture preview | A / non-production | Production builds deny fixture APIs by default. The Vercel Preview deployment requires Vercel Authentication, uses two exact branch-scoped fixture values, and exposes dependency-free `/api/health`. Unauthenticated health access redirects to login; authenticated health, fixture health and Student chat checks pass. This is live-host evidence for the protected preview boundary only, not production identity/data/provider evidence. | Vercel deployment `dpl_FcTh71b8KCq4WrrvVhhHuaS5QUpb`; GitHub Preview deployment `5583998909`; `apps/console/test/deployment-mode.test.ts` |

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
Widget host, the explicitly opted-in 36-tool fixture-plus-durable MCP surface,
and the structural Supabase smoke suites. Production MCP discovery remains
limited to nine durable tools. The intelligence and privacy entry points are:
`pnpm --filter @course-ai/console smoke:intelligence` and
`pnpm --filter @course-ai/console smoke:privacy`.

The final integration handoff must record the actual outcome. A structural
Supabase verifier is not equivalent to executing the PostgreSQL negative-policy
suite.

### 2026-07-24 current release checkpoint

- The optimized local Next.js build generated **62 application entries**,
  including production Auth, authenticated onboarding, durable learning,
  grounded conversation and the two real voice-turn APIs. This is build
  evidence, not proof that every route has completed signed-in
  production-browser acceptance.
- Development and production compiler outputs remain isolated in `.next-dev`
  and `.next`. The development server therefore keeps its manifests while the
  optimized build runs.
- `verify:dev` continues to cover the development API, authoring, Creator
  intelligence, privacy operations, Widget host and all **36 explicitly
  fixture-enabled MCP tools**. Default production discovery is exactly nine
  tools and exposes no `/api/dev/*` operation. Intelligence and privacy remain explicitly exercised by
  `pnpm --filter @course-ai/console smoke:intelligence` and
  `pnpm --filter @course-ai/console smoke:privacy`.
- `pnpm supabase:verify` passes for **28 ordered migrations and 43 public
  tables**. The hosted migration ledger includes 0001–0028 and all **eleven
  hosted transactional SQL suites pass** against the dedicated LearningBot
  Supabase project. The suites roll back their fixed fixtures. The hosted
  Estie tenant contains 6 courses, 28 modules, 126 lessons, 126 documents,
  2,757 searchable chunks and 6 active knowledge versions. All 2,757 chunks
  have 384-dimensional embeddings behind the filtered hybrid-search RPC.
- The console test suite passes **48/48** and the MCP package passes **18/18**.
  The authenticated learner can choose Explain, Practice or Check me, while
  exact lesson selection fails closed if no matching source is available.
- Authenticated authors can upload through a short-lived signed URL into the
  private quarantine prefix. Confirmation creates a waiting ingestion job and
  pending malware checkpoint; no scanning, extraction or learner-visible
  promotion is claimed yet.
- The live OpenAI Responses adapter completed a `gpt-5.6-luna` request with
  usage metadata. The authenticated product path uses the same provider-neutral
  adapter, persists grounded source citations and replays completed turns.
  Signed-in browser latency/quality acceptance and durable cost-ledger writes
  remain pending.
- Authenticated voice establishes a server-authorized OpenAI Realtime WebRTC
  session with semantic turn detection, partial/final captions, interruption
  and a reactive audio-energy presentation. Final transcripts still pass
  through the durable grounded response path before the saved answer is spoken.
  `gpt-4o-mini-transcribe` and `gpt-4o-mini-tts` remain the bounded fallback,
  and LearningBot does not persist raw audio.
- Hosted Supabase password access is enabled only for managed accounts while
  public signup remains disabled. The first Estie owner is live, tenant-linked
  and required to replace the one-use temporary password before entering the
  workspace. Admin-created users and privacy-bounded usage events are durable.
- The `/dev/**` learning, onboarding, intelligence, privacy and administration
  surfaces return a non-discoverable 404 in production. The production
  `/auth/**`, `/app`, `/app/conversation` and `/onboarding` surfaces fail closed
  on missing environment, session, provider or durable RPC state and never
  silently substitute fixtures.
- Vercel production deployment `dpl_6mPoeexYP46V4RZ1DAj8LXy1EZPe` is READY
  and the stable public preview alias serves the managed sign-in, owner
  workspace, real Estie courses, grounded conversation, admin access and Circle
  installation guide. `clone.stack-labs.ai` is attached but cannot resolve
  until Porkbun receives the required DNS record; no custom-domain completion
  is claimed before that record exists.

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
- GitHub clean-runner CI for commit `a64bd5b` **passed** frozen install, full
  checks, Supabase structural verification and the optimized production build.
  Run `30067837040` retained the clean-workspace evidence that local generated
  declarations had previously masked.
- Protected Vercel Preview deployment `dpl_FcTh71b8KCq4WrrvVhhHuaS5QUpb`
  **reached Ready**. An unauthenticated `/api/health` request redirected to
  Vercel Authentication; authenticated checks returned healthy liveness,
  `mode: fixture-preview`, and HTTP 200 for `/dev/chat`. GitHub deployment
  `5583998909` records the Preview environment as successful. The earlier
  app-only host build failed before becoming usable and produced no positive
  evidence.
- Production-boundary checkpoint `f897564` **passed** clean GitHub CI run
  `30069599914` and protected Vercel Preview deployment
  `dpl_1hJjbpYRn6kpaHtRkqQkm3JEx6XB` reached Ready. This is live-host evidence
  for build/deployment and the access-controlled fixture boundary only; the
  OIDC, upload and LLM adapter tests remain no-network grade-C evidence.
- The identity persistence increment passed the final local repository gate:
  `pnpm check`; `pnpm build`;
  `COURSE_AI_CONSOLE_URL=http://127.0.0.1:3100 pnpm verify:dev`; and
  `git diff --check`. Postgres adapter tests passed 12/12 and structural
  verification covered 8 migrations, 36 tables, 6 existing security controls,
  3 durable-execution controls and 3 identity controls. The executable identity
  SQL suite was added but remains unexecuted because no approved PostgreSQL
  environment is available.
- The launchpad/upload/embeddings increment passed `pnpm check`, including
  provider-router tests **61/61** and Postgres-adapter tests **18/18**;
  `pnpm build`, including all 27 generated static pages and 28 route entries;
  `COURSE_AI_CONSOLE_URL=http://127.0.0.1:3100 pnpm verify:dev`; and
  `git diff --check`. Structural verification covered 9 migrations, 38 tables
  and 3 upload controls. Browser checks loaded all ten visual surface routes at
  desktop and 390px mobile widths with no horizontal overflow and a consistent
  launchpad return control. The only browser warning observed was a development
  Fast Refresh reload caused by editing during the check, not a production
  runtime warning. Live SQL/provider evidence remains unclaimed.

### 2026-07-24 Native Learning Canvas integration

- The production learner home, managed sign-in, mandatory password change,
  durable onboarding, People administration, unified conversation, continuous
  voice and embeddable Widget now share the approved Native Learning Canvas
  visual system. The redesign preserves the existing durable authorization,
  tenancy, learning, source, privacy and voice boundaries rather than replacing
  them with visual fixtures.
- The production conversation retains its unified thread, course and lesson
  grounding, Explain/Practice/Check modes, sources, draft/scroll/focus state,
  WebRTC voice, push-to-talk fallback, barge-in, mute/end and cancellation. It
  now renders bounded safe rich response structures for paragraphs, headings,
  lists, quotes, code, attachments and diagrams without injecting raw HTML.
- The Widget runtime retains Shadow DOM isolation, persistence, drag, resize,
  expansion, tenant switching, host events, context truthfulness, source and
  diagram events, and mobile-sheet behavior. Its redesigned ESM and IIFE
  bundles pass **10/10** tests at **13,098 bytes** and **13,197 bytes** gzip,
  respectively, below the 50 KB budget.
- The integrated repository gate passed `pnpm check`; the optimized
  `pnpm build` compiled **62 generated pages**; and
  `COURSE_AI_CONSOLE_URL=http://127.0.0.1:3100 pnpm verify:dev` passed the
  development API, authoring, intelligence, privacy, Widget, **36-tool MCP**
  and Supabase structural smoke suites. `git diff --check` also passed.
- Browser review confirmed the redesigned public entry, managed sign-in and
  embedded host/widget at desktop geometry. Focused lane review also covered
  390px sign-in geometry. These are local visual and integration results; they
  do not establish the live-provider, browser-matrix or screen-reader evidence
  listed below.

## Explicitly unproven

The repository does not yet claim grade-A evidence for:

- production SMTP,
  invitation delivery, SAML/service-principal verification, SCIM or
  deprovisioning;
- comprehensive live RLS/storage negative coverage beyond the eleven bounded
  transactional database suites, including signed object operations;
- signed-in production-browser LLM/transcription/speech/realtime quality,
  reconnect and latency acceptance, plus live storage malware or
  connector-provider execution;
- Circle/custom-code/CDN/CSP installation, browser matrix, screen-reader or
  usability acceptance;
- live signed storage, malware scanning, extraction, and retention execution;
- approved privacy retention periods, legal-hold policy, production
  export/delete/de-identification, voice recording, or voice cloning;
- O-09 opportunity scoring/calibration, billing reconciliation, load, restore,
  incident response, regional deployment, or production SLO evidence.

These are tracked as open decisions, blockers, production adapters, or later
implementation phases; they are not silently converted into local-development
claims.

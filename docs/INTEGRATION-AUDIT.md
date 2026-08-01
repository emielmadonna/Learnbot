# Integration audit — what is actually wired

*Read-only audit, 2026-07-26, branch `codex/platform-foundations`. Every claim below carries a file path or a line number. Nothing was modified.*

> **This is a dated snapshot, not a current-state document. Read the errata first.**

## Errata — verified 2026-07-31

The body below is preserved verbatim as the record of what was true on
2026-07-26, including the parts that were wrong to ship. It is **not** a
description of the repository today. Each item here was re-verified against the
working tree on 2026-07-31; anything not listed was not re-checked and should be
treated as unverified rather than as still true.

**Overtaken by work that has since landed:**

- *"Course content → retrievable knowledge — CLAIMED-NOT-BUILT — this is the
  blocker."* A producer exists. `apps/console/src/app/api/ingestion/publish/route.ts:30`
  calls `learning_ingestion_publish`, which projects approved cleaning revisions
  into `knowledge_versions` / `learning_documents` / `learning_chunks` via
  `app_private.knowledge_project_ingested_course`. The one-off
  `scripts/prepare-estie-import.mjs` is no longer the only writer.
- *"Embeddings — ORPHANED SCHEMA … zero callers repo-wide."* The loop is closed.
  `apps/console/src/app/api/learning/embeddings/route.ts` calls
  `learning_claim_embedding_batch` / `learning_commit_embedding_batch` under the
  `knowledge.embedding.worker` operation secret, and
  `infra/supabase/functions/learning-embedding-worker/` exists.
- *"File upload — every hop after quarantine [is missing]. No scanner, no
  extractor, no promotion RPC."* `api/ingestion/{scan,extract,clean,review,publish}`
  and `apps/console/src/lib/ingestion/` all exist. See `docs/PLAN.md` §2 for the
  live-apply caveats, which still stand.
- *"`telemetry_outbox` is write-only — nothing leases or drains it. Rows
  accumulate forever."* `apps/console/src/app/api/ops/telemetry-outbox/drain/route.ts`
  drains it with a retention policy.
- *"`public.cost_ledger` has zero writers repo-wide."* It has writers:
  `apps/console/src/lib/cost-metering.ts`, reached from
  `apps/console/src/lib/provider-runtime.ts:29`.
- *"Voice hardcoded `"marin"` while `tenant_branding.agent_voice` sits unread."*
  Resolved; `apps/console/src/lib/voice-runtime.ts` resolves the configured voice
  and there is no `"marin"` literal left under `api/learning/voice/`.
- *"Cost / COGS / margin / billing — CLAIMED-NOT-BUILT."* `api/billing/` and
  `apps/console/src/lib/billing/` exist (Phase 15, marked done in `docs/PLAN.md`).
- *"`packages/widget-runtime` (1521 lines, Shadow DOM) has never been loaded by
  anything"* and *"Current shipped artifact is `apps/console/public/integrations/circle-learningbot.js`
  — 38 lines that append a link opening `/app/conversation`."* Both false as of
  Phase 7. The runtime is served by `apps/console/src/app/widget.js/route.ts`. The
  `public/integrations/` artifacts were never updated, were referenced by nothing
  executable, and were **deleted on 2026-07-31**; by then `circle-learningbot.js`
  was 277 lines and mounted a stale bundled copy of the runtime, and it still
  documented the `data-widget-key` attribute that the shipped runtime does not
  read.
- **The P2 "delete, don't wire" table was executed.** `application-services`,
  `postgres-adapters`, `intelligence-core`, `onboarding-core`, `course-authoring`,
  `privacy-lifecycle`, `learning-pipeline`, `realtime-voice` and `mcp-server` are
  all gone. `packages/` now contains exactly `contracts`, `identity-access`,
  `provider-router`, `widget-runtime`. Consequently every line-number citation in
  this document that points into a deleted package is unresolvable, and the
  "11 packages / ~23,000 lines" figure in the Verdict no longer describes anything.

**Still true, re-verified 2026-07-31 — do not assume these were fixed too:**

- **Edge functions still have no deploy configuration anywhere.** There is no
  `supabase functions deploy` in `infra/supabase/scripts/hosted-release.mjs`, no
  step for it in `.github/workflows/ci.yml`, and no other deploy tooling in the
  repository. The eight functions under `infra/supabase/functions/` are pushed by
  hand, exactly as `CLAUDE.md` states. The only recorded invocation of the command
  is a transcript line in `infra/supabase/SCHEMA-DRIFT.md:531`.
- **Invitations still have no delivery hop.** No mailer in the dependency tree.
- **Privacy / GDPR export and deletion still have no code path.**
- **`packages/identity-access` is still orphaned**, and is now the last survivor of
  the P2 table. It is not even declared in `apps/console/package.json`, yet
  `pnpm check` builds and typechecks it on every run.

**Corrected in this document only, not in the code:** the P0/P1 remediation list
below is a 2026-07-26 plan. Items 1, 2, 7, 8 and 10 have since been done; items 3,
4, 5, 6 and 9 have not been re-verified here. A current, evidenced register lives
in [TECHNICAL-DEBT.md](TECHNICAL-DEBT.md).

---

## Verdict

The console is a genuinely wired, thin, well-secured client over 39 Supabase migrations: sign-in, tenant selection, onboarding, managed accounts, platform administration, agent configuration, course authoring, publishing, question intelligence and analytics all have a real UI → route → `SECURITY DEFINER` RPC → table path with no fixture. That work is good and it is done. But the one hop that turns a client's course content into something the assistant can answer from — content → `learning_documents`/`learning_chunks`/`knowledge_versions` — **has no producer anywhere in the repository except a one-off script hardwired to `/Users/emielmadonna/Estie Starr/scraper`** (`scripts/prepare-estie-import.mjs:7,256,349,396`). Because `learning-provider.ts:133-142` returns a canned refusal when zero sources are retrieved, a newly onboarded tenant can author and publish an entire course and its assistant will answer *"I couldn't find this in the published learning yet"* to every question, forever. Uploads are a one-way trip into a quarantine bucket with no scanner, no extractor and no promotion RPC. Around that working core sit 11 packages / ~23,000 lines that reach production through zero import edges, and a `README.md`/`DEVELOPMENT.md` pair that presents most of them as delivered capability. The gap is not quality — most of the orphaned code is careful — it is that the durable implementations were re-written in plpgsql and nobody deleted the TypeScript, and nobody built the two workers (extraction, embedding) that the whole product depends on.

---

## Capability map

| Capability | Status | Evidence | What's missing |
|---|---|---|---|
| **Sign-in / session** | WIRED | `app/auth/sign-in/sign-in-form.tsx:28` `signInWithPassword` → `lib/supabase/auth-boundary.ts:198-211` → `auth_current_access_state` → `app_private.user_access_accounts` (`0027:7`) | Nothing. Email+password only. |
| **Tenant selection / RBAC** | WIRED | `auth-boundary.ts:219,240,380` → `auth_list_tenant_memberships`/`auth_current_tenant_context`/`auth_select_tenant` (`0011:563,602,810`) → `public.identity_memberships` (`0008:34`) | Nothing. Roles are read from the DB, never from the JWT (`0011:3`); `learningbot_custom_access_token_hook` strips top-level `tenant_id`/`app_role` (`0011:917-921`). This is the strongest part of the system. |
| **Forced password change** | WIRED | `app/auth/change-password/password-form.tsx` → `auth_complete_password_change` (`0027`) | Nothing. |
| **Managed user accounts** | WIRED | `app/app/admin/users/user-access-manager.tsx:43,66` → `api/admin/users/route.ts:35,79` → edge fn `learning-admin-users/index.ts:130` → `admin_provision_auth_user` → `app_private.user_access_accounts` | Edge functions have **no deploy config anywhere** (no CI step, no `supabase functions deploy` in `infra/supabase/scripts/hosted-release.mjs`). They were pushed by hand. |
| **Onboarding workspace/steps** | WIRED | `app/onboarding/page.tsx` + `durable-workspace.tsx` → `app/onboarding/{step,profile}/route.ts` → `onboarding_get_snapshot`/`onboarding_update_step` (`0012:336,652`) → `public.onboarding_workspaces`/`onboarding_steps` (`0010:8,65`) | Nothing. |
| **Invitations** | PARTIAL | `app/onboarding/invitation/{create,revoke,accept}/route.ts` → `onboarding_create_invitation` (`0012:845`) → `public.identity_invitations` | **No delivery hop.** No SMTP, no mailer, no email template in the repo. The invitation code must be copy-pasted out of the UI by a human. |
| **Platform admin (tenants, sections, suspend, enter/exit)** | WIRED | `components/sections/platform-panel.tsx:105,113` → `api/platform/route.ts` → `lib/supabase/platform-rpc.ts:591-724` → `platform_admin_*` (`20260724182939`, `20260725123000`, `20260726090000`) → `app_private.platform_administrators`, `public.tenant_sections`, `app_private.platform_client_provisionings` | Nothing. Client provisioning + claim redemption now has a producer (`platform_mint_owner_claim` ← `20260726090000`; redeemed via `auth-boundary.ts` → `auth_claim_preprovisioned_tenant_owner`). |
| **Agent configuration (name, brand, persona, tone, voice, scope)** | WIRED | `components/sections/agent-panel.tsx:591,831` → `api/agent/route.ts:194,219` → `lib/supabase/agent-rpc.ts` → `tenant_update_agent_configuration` (`20260725120000`) → `public.tenant_branding` | Nothing — but see Voice: `agent_voice` is stored and then ignored. |
| **Brand asset upload / signed read** | WIRED | `agent-panel.tsx:732` → `api/agent/asset/route.ts:91,152` `createSignedUploadUrl`/`createSignedUrl` on `tenant-private` → storage RLS `20260725120000:106-130` | Nothing. |
| **Course authoring (course/module/lesson/block CRUD, reorder)** | WIRED | `components/sections/course-panel.tsx:118` → `api/authoring/route.ts` → `lib/supabase/authoring-rpc.ts` → 11 RPCs in `20260725122000_course_editing.sql:443-1537` → `public.courses/modules/lessons/content_blocks` | Nothing. Optimistic concurrency + immutable revisions are real. |
| **Revisions / rollback** | WIRED | `authoring-rpc.ts` → `learning_list_course_revisions` (`20260725122000:1776`), `learning_rollback_course` (`:1849`) → `public.course_revisions`/`course_revision_heads` (`0007:7,52`) | Nothing. |
| **Publish visibility** | WIRED | `course-panel.tsx` → `api/learning/courses/[courseId]/publish/route.ts` → `learning_publish_course` (`20260726092000:249`) | Nothing. Fixed today; see "Disagreements" for what it fixed. |
| **Learner conversation (text, grounded)** | PARTIAL | `app/app/conversation/conversation-client.tsx:691` → `api/learning/respond/route.ts` → `lib/learning-provider.ts` (OpenAI via `@course-ai/provider-router`) → `learning_record_user_message`/`learning_record_assistant_message` → `public.messages` | **Grounding sources.** `respond/route.ts:263` calls `searchPublishedLearning`, which reads `public.learning_chunks` (`0020`, `awk`-confirmed `from public.learning_chunks ch join public.knowledge_versions ... join public.learning_documents`). Nothing populates those three tables. `learning-provider.ts:133-142` then short-circuits with a fixed refusal and never calls the model. |
| **Course content → retrievable knowledge** | **CLAIMED-NOT-BUILT — this is the blocker** | Only writers of `knowledge_versions`/`learning_documents`/`learning_chunks` in the entire repo: `scripts/prepare-estie-import.mjs:256,349,396`, a manual script defaulting to `--source /Users/emielmadonna/Estie Starr/scraper` (`:7`) | Everything. Authoring writes `content_blocks`; retrieval reads `learning_chunks`. No RPC, route, worker or trigger bridges them. |
| **File upload** | PARTIAL | `app/app/upload-learning.tsx:27,57` → `api/learning/uploads/route.ts:139` signed PUT into `tenant-private/{tenant}/quarantine/...` → `learning_create_upload_intent` (`0026:7`) → confirm → `learning_confirm_quarantine_upload` (`0026:131`) writes `learning_sources`(`connecting`), `ingestion_jobs`(`waiting`), `ingestion_checkpoints`(`pending`), returns `promotionAllowed:false` (`0026:287`) | **Every hop after quarantine.** No scanner, no extractor, no promotion RPC. `upload_callback_receipts` (`0009:60`) has zero writers repo-wide. `upload_intents.status` never leaves `'quarantined'`. The UI says so verbatim (`upload-learning.tsx:104`). |
| **Embeddings** | ORPHANED SCHEMA | `learning_claim_embedding_batch` (`0023:225`) + `learning_commit_embedding_batch` (`0024:51`) exist and are `service_role`-only; **zero callers repo-wide** (only `tests/hybrid_semantic_retrieval_verification.sql:38,45` assert they exist) | The worker. The claim/commit pair is half a loop with no loop. |
| **Semantic / hybrid retrieval** | PARTIAL | `lib/semantic-learning-search.ts:41-59` → edge fn `learning-embeddings/index.ts:101-110` → `learning_search_chunks_hybrid` (`0023`); falls back to lexical `learning_search_chunks` with `retrievalMode:"lexical_degraded"` (`:78`) | Works only over the one-time Estie backfill. `20-IMPLEMENTATION-EVIDENCE.md:38` credits that backfill to "`learning-embeddings` Edge Function **v3**" — a version that is not in this repo; the committed function only embeds the *query*. New content will have `embedding IS NULL` and silently degrade. |
| **Question intelligence (labels, signals, review)** | WIRED | `respond/route.ts:338` → `lib/question-classification.ts:209` (OpenAI) → `learning_record_question_label` → `public.question_labels` (`20260726091000:49`); signals + review via `analytics_signals`/`analytics_signal_review` (`:1607,1807`) → `public.question_signals` (`:158`) | Nothing. This is the real "Opportunity lifecycle", renamed: `review_status in ('new','acknowledged','actioned','dismissed')` (`:189-190`). |
| **Analytics + Insights UI** | WIRED | `components/sections/insights-panel.tsx:2028,2075,2193` and `home-section.tsx:540` → `api/analytics/route.ts` + `api/analytics/question-intelligence/route.ts` → `lib/supabase/analytics-rpc.ts:379-419` → `analytics_tenant_overview/_question_distribution/_answer_quality/_learner_progress` (`20260725121000:164,440,807,1095`) | Nothing. Metrics carry a known/partial/unknown envelope computed in SQL (`analytics-rpc.ts:15-27`). |
| **Lesson progress** | WIRED | `app/app/progress/route.ts` → `learning_mark_lesson_progress` (`0017`) → `public.lesson_progress` | Nothing. |
| **Usage events** | PARTIAL | `app/app/usage-signal.tsx:10` → `api/learning/events/route.ts:30` → `learning_record_usage_event` (`0028`) → `public.learning_usage_events` **and** `public.telemetry_outbox` | `telemetry_outbox` (`0007:105`) is **write-only** — nothing in `apps/`/`services/` leases or drains it. Rows accumulate forever. |
| **Voice (realtime + push-to-talk)** | PARTIAL | Button `components/app-shell/app-shell.tsx:179` → `agent-panel.tsx:11` hosts `conversation-client.tsx`; `:993,1062,1074,1123` → `api/learning/voice/{realtime,transcribe,speak}/route.ts`. Grounding hop at `conversation-client.tsx:866-896` routes the transcript through `/api/learning/respond` so the realtime model never invents facts — genuinely good design. Persisted as `messages.modality='voice_transcript'` (`respond/route.ts:254`) | (a) `OPENAI_API_KEY` unset and **undocumented** — all three routes 503 (`realtime/route.ts:43`); (b) **zero cost attribution** — `public.cost_ledger` (`0005:51`) has zero writers repo-wide, so the most expensive SKU is unmetered; (c) rate limits are an in-process `Map` (`voice/rate-limit.ts:16-23`) — useless on serverless; (d) voice hardcoded `"marin"` (`realtime/route.ts:160`, `speak/route.ts:16`) while `tenant_branding.agent_voice` sits unread; (e) no partial captions, no latency telemetry; `conversations.channel_state` (`0004:123`) never written. |
| **Files in the student conversation** | CLAIMED-NOT-BUILT | `conversation-client.tsx:111-118,1846` *renders* an `attachment` part; there is no `<input type="file">` anywhere in the conversation UI, and `public.attachments` (`0004:184`) has zero writers | The whole feature. `README.md:7` claims "text, voice, files, rich text and diagrams". |
| **Diagrams** | CLAIMED-NOT-BUILT | `conversation-client.tsx:128-138,1797` renders a `diagram` part; `diagram_review` exists only as an onboarding checkbox (`0010:75`). No extraction, no curation gallery, no producer | Everything. |
| **Widget delivery** | IN-FLIGHT | `20260726093000_widget_delivery.sql` landed today (public `widget_bootstrap`/`widget_ask` with origin allowlisting). Current shipped artifact is `apps/console/public/integrations/circle-learningbot.js` — 38 lines that append a link opening `/app/conversation`. `packages/widget-runtime` (1521 lines, Shadow DOM) has never been loaded by anything. `apps/edge/` is a README | Being built by others — excluded from remediation below. **[Superseded 2026-07-31 — see Errata. The runtime is now served by `/widget.js`; the `public/integrations/` artifacts named here were deleted as orphans.]** |
| **MCP server** | ORPHANED / BROKEN | `packages/mcp-server` registers **36** tools (`src/server-discovery.test.ts:91`). 27 of them HTTP-call `/api/dev/*` (`src/server.ts:689…1868`) — **that directory was deleted this session** (`git status`: 19 staged deletions under `src/app/api/dev/`). Grants come from `COURSE_AI_MCP_GRANTS` env into a `Map` (`enterprise-control.ts:166`); `public.mcp_grants`/`mcp_invocations` (`0005:100,139`) are written only by `tests/security_verification.sql:61,174`. No Dockerfile/fly/wrangler/CI deploy. stdio transport, unhostable on Vercel | 75% of it points at a 404. The 9 durable tools are an HTTP proxy over console routes needing a hand-pasted user bearer token. |
| **Privacy / GDPR (export, delete, retention, legal hold)** | CLAIMED-NOT-BUILT | `packages/privacy-lifecycle` (2168 lines) — zero importers; every repository in `src/repositories.ts` is an interface whose only implementations are `Memory*` in `src/fakes.ts`. Zero API routes (grep for `erasure\|dsar\|legal.?hold\|gdpr\|retention` over `apps/console/src/app/api/` → 0 hits). Zero tables. Zero cron/`pg_cron`/`pg_net`/worker | All five hops. `0010:26` stores a nullable `retention_policy_ref` and `0012:230` still raises `O-13:retention_policy_decision_required`. **If a client asks to delete or export their data today, there is no code path at all.** |
| **SSO / SAML / SCIM** | CLAIMED-NOT-BUILT | `packages/identity-access` (1809) — zero importers from `apps/`. `src/oidc.ts` (376 lines, `jose`-backed) is real and unreachable. SAML exists only as a string literal in a union (`src/types.ts:15`); there is no SAML file. SCIM has no `/scim/v2/*` route, no schema/filter/PATCH parser; `identity_scim_bindings`/`identity_scim_receipts` (`0008:150,167`) are referenced by zero SQL functions and zero app code | Everything. An enterprise buyer asking for "Okta SSO" or "SCIM deprovisioning" gets neither. |
| **Cost / COGS / margin / billing** | CLAIMED-NOT-BUILT | `public.cost_ledger` (`0005:51`) — grep for `cost_ledger` across `apps/`, `services/`, `packages/` returns **zero**. No provider spend, no per-tenant cost, no budget enforcement | Everything. `11-ADMIN-EXPERIENCE.md` promises "Revenue, COGS, margin, budget, estimates/finals and ledger drill-down". |
| **Audit** | PARTIAL | `public.audit_ledger` (`0005:5`) is written by `20260725120000`, `20260725122000`, `20260725123000`, `20260726091000`, `20260726093000` — agent config, authoring, tenant sections, signal review, widget | Not written by: conversations, voice, uploads, onboarding, platform-admin tenant status, or account provisioning. `SEC-07` in `18-ACCEPTANCE-TESTS.md` requires "complete audit records" for impersonation/prompt/key/KB/tool/provider actions. There is no reader UI. |
| **Provider credentials / BYOK** | UNTRACKED DRIFT | `infra/supabase/SCHEMA-DRIFT.md:36-43`: `app_private.tenant_provider_credentials`, `learning_provider_runtime_credential`, `learning_provider_set_credential` exist **only in the live database**, applied by hand 2026-07-24, never committed. "The provider-credential vault is an entire subsystem that source control does not know about" (`:44-45`) | The source. A rebuild from `infra/supabase/migrations/` drops the vault and *downgrades* `admin_provision_auth_user` and `admin_list_access_accounts` to older revisions (`SCHEMA-DRIFT.md:52-57`). |
| **Ingestion ops console, Playground, Prompt Studio, webhooks, connectors, student memory, hot students** | CLAIMED-NOT-BUILT | Grep across `apps/console/src` and `infra/supabase/migrations`: `hot student` 0/0, `student memory` 0/0, `prompt studio` 0/0, `webhook` 0/0, `cogs` 0/0 | Everything. All are required areas in `10-CREATOR-EXPERIENCE.md` and `11-ADMIN-EXPERIENCE.md`. |
| **`application-services`, `course-authoring`, `intelligence-core`, `learning-pipeline`, `onboarding-core`, `postgres-adapters`, `privacy-lifecycle`, `realtime-voice`, `identity-access`, `widget-runtime`, `mcp-server`** | ORPHANED | `apps/` imports exactly two workspace packages, in two files: `lib/learning-provider.ts:5-6` and `lib/question-classification.ts:4-5` (`@course-ai/contracts`, `@course-ai/provider-router`). `apps/console/package.json:13-22` declares 10 workspace deps; 8 are never imported | See remediation §3. |

---

## Where two sources of truth disagree

These are the shape that reaches clients as a bug.

1. **`agent_voice` vs hardcoded `"marin"`.** `tenant_update_agent_configuration` (`20260725120000`) persists a per-tenant voice, `settings-panel.tsx:54-56` displays it, and `agent-panel.tsx` lets an owner edit it. All three voice routes ignore it — `realtime/route.ts:160` and `speak/route.ts:16` hardcode `"marin"`, and `tenant_branding.voice_configuration` (`0004:20`) is read by nothing. A white-label client configures a voice and hears a different one.

2. **`content_blocks` vs `learning_chunks`.** Authoring writes one table; retrieval reads another; nothing joins them. The console tells an author their course is published (`learning_publish_course` succeeds, `canAuthor` is true, the workspace shows the lessons) and the assistant then denies the content exists. Two subsystems both believe they are correct.

3. **`learning-pipeline`'s 8-dimension embedding vs the schema's 384.** `packages/learning-pipeline/src/legacy-chunker.ts:110-117` produces an 8-float sum-of-codepoints vector; `0023:8` declares `vector(384)`. If anyone ever wires the "reference" pipeline as-is, it will not insert.

4. **`public.memberships` vs `public.identity_memberships`.** Both are written together (`0011:444`, `0019:195`, `0027:529`). Only `identity_memberships` is read for authorization (`0011:86-92`). Editing a role in `public.memberships` — the obviously-named table, the one a human in Supabase Studio will find first — changes nothing and produces no error.

5. **`creator` and `teacher` collapse to the same RLS role.** `0011:74-78` maps both to `client_viewer`, while `app_private.authoring_rpc_context` (`20260725122000:52-59`) grants `creator` authoring and excludes `teacher`. Authoring is safe because it goes through `SECURITY DEFINER`. Storage is not: `tenant_private_owner_select` (`0006:447-457`) grants cross-user reads only to `owner`/`client_admin`, so a creator cannot read a file another creator uploaded.

6. **`canAuthor` vs `authoring_rpc_context`** — *already fixed today*, and the fix's own header is the best statement of this whole audit: "a teacher was shown the full editor and every action failed with 403. The RPC gate is the security boundary… the advertised capability is what was wrong" (`20260726092000:14-19`). Same failure mode as #1 and #2.

7. **MCP tool count: 28 vs 8+27 vs 36.** `README.md:93`, `packages/mcp-server/README.md:7,26,109,203`, and `src/server.ts:41-42`. The code says 36.

8. **Migration/table counts.** `README.md:102` says "nine ordered migrations, 38 schema tables"; `DEVELOPMENT.md:65` says "eight Supabase migrations with 36 schema tables". Actual: **39 files, 58 `create table` statements** — and per `SCHEMA-DRIFT.md`, the live database has nine more migrations than the repo does.

9. **`.env.example` documents variables nothing reads, and omits every variable the code requires.** Documented: `OPENAI_API_KEY_VAULT_REF`, `OIDC_*`, `PROVIDER_CREDENTIAL_VAULT_REF`, `LEARNINGBOT_FIXTURE_PREVIEW*` — zero readers (`lib/deployment-mode.ts` now has no importers at all). Actually read by the console: `OPENAI_API_KEY`, `LEARNINGBOT_CONVERSATION_OPERATION_TOKEN`, `LEARNINGBOT_LLM_MODEL`, `LEARNINGBOT_CLASSIFIER_MODEL` — none documented.

10. **The console-side sanitizer is a hand-copied fork.** `apps/console/src/components/ui/rich-text/markdown.ts:7,26,104` says "Mirrors `CONTROL_CHARACTERS` in course-authoring" / "Same regexes as `packages/course-authoring/src/sanitizer.ts`". Two divergent copies of an XSS-relevant regex set, one of which is in a package nothing imports.

---

## Ranked remediation — for onboarding paying clients next week

### P0 — the product does not work for a new tenant without these

**1. Build the content → chunk producer. (2–4 days)**
Without it every new client's assistant answers "I couldn't find this in the published learning yet" to every question. Cheapest correct shape: a `SECURITY DEFINER` RPC invoked by `learning_publish_course` that projects published `content_blocks` into `learning_documents` + `learning_chunks` under a new `knowledge_versions` row. Do **not** wire `packages/learning-pipeline` — its extractor is `paragraphizeText(intake.body)` (`src/pipeline.ts:507-515`), it has no PDF/DOCX/OCR, and its embedding is 8-dimensional.

**2. Build the embedding worker. (1 day)**
`learning_claim_embedding_batch` / `learning_commit_embedding_batch` already exist, are `service_role`-scoped, and are called by nothing. A ~60-line scheduled Supabase Edge Function closes the loop. Without it, item 1 gives you lexical-only retrieval and the HNSW index (`0023:11-14`) stays empty.

**3. Document and set the four required env vars, and seed the operation secret. (2 hours)**
`OPENAI_API_KEY` gates all chat, classification and voice. `LEARNINGBOT_CONVERSATION_OPERATION_TOKEN` gates `learning_get_agent_directive`; `respond/route.ts:205-208` throws `provider_not_configured` if it is under 32 chars, and it must hash-match a row in `app_private.learning_operation_secrets` (`0021:7`) that **no migration, seed or script inserts**. That row also has a mandatory `expires_at` (`0021:15`) with no documented rotation — chat will silently start returning `access_denied` on expiry. Add both to `.env.example`, delete the four vault-ref stubs nothing reads, and write down the seeding + rotation procedure.

**4. Recover the nine drifted migrations into source control. (half a day)**
`SCHEMA-DRIFT.md:19-24` — until this is done the repo cannot rebuild the live schema, and re-running committed migrations *downgrades* `admin_provision_auth_user` (the function that creates client users). This is the one item that can destroy a live tenant.

**5. Decide the upload story and make the UI honest. (2 hours, or 1 week to actually build)**
Uploads terminate in quarantine permanently. Either hide the uploader for new tenants, or accept it and keep `upload-learning.tsx:104`'s honest copy — but do not demo it to a buyer as "drag and drop your course".

### P1 — will be asked about in the first sales conversation

**6. Answer the GDPR question with a written manual runbook, not code. (2 hours)**
There is no export or deletion path and building one properly is weeks. What you can do this week is document exactly which tables hold personal data (`profiles`, `identity_principals`, `messages`, `conversations`, `question_labels`, `lesson_progress`, `learning_usage_events`, `user_access_accounts`, plus `tenant-private` storage) and a manual SQL procedure. Do not ship `packages/privacy-lifecycle` — its "deletion" mutates a JS `Map`.

**7. Meter voice and LLM spend. (1 day)**
`cost_ledger` (`0005:51`) has zero writers. The provider adapter already returns usage (`learning-provider.ts` → `answer.usage`); write it. Until then a single tenant can generate unbounded, invisible OpenAI spend — and voice rate limiting is a per-process `Map` (`voice/rate-limit.ts:16-23`) that serverless resets on every cold start.

**8. Make voice read `tenant_branding.agent_voice`. (1 hour)**
One-line-ish fix in `realtime/route.ts:160` and `speak/route.ts:16`. Currently the setting is a lie.

**9. Deliver invitations, or remove the invitation UI. (1 day either way)**
`onboarding_create_invitation` works; nothing emails the code.

**10. Drain or drop `telemetry_outbox`. (2 hours)**
Written by every usage event (`0028:90`), read by nothing. It will grow without bound.

### P2 — delete, don't wire

Deleting is the correct call for almost all of it. Every one of these has already been re-implemented in plpgsql, and the SQL version is the one running. Keeping both is not optionality, it is two competing definitions of the same invariant.

| Package | Lines | Do | Salvage first |
|---|---|---|---|
| `application-services` | 1972 | **Delete** — eleven in-memory `Map` repositories (`src/repository.ts:16`); every invariant it claims is enforced durably in SQL | Move `PlatformRole`/`PlatformPermission` (~20 lines) into `@course-ai/contracts` |
| `postgres-adapters` | 2033 | **Delete the TypeScript, keep migration 0007** — requires an injected `PostgresExecutor` (`src/database.ts:19-23`) that nothing constructs; there is no `pg` client in the repo. Unrunnable by construction. Its receipt/CAS/outbox protocol now lives in `0012:73`, `20260725122000:232-300` | Nothing |
| `intelligence-core` | 1979 | **Delete** — superseded by `20260725121000` + `20260726091000`, which have FK integrity, severity ranking and server-side re-detection the package lacks | Optionally the 29-member `EVENT_TYPES` union |
| `onboarding-core` | 1332 | **Delete** — `src/service.ts:377-387` throws `onboarding.durable_adapter_required` unless the repo reports `durability:"durable"`, and the only implementation is `src/fixture.ts:92` `"fixture"`. It can only throw in production | Nothing |
| `course-authoring` | 2225 | **Delete** — 11 authoring RPCs + rollback are live in `20260725122000` | `src/sanitizer.ts` + `src/validation.ts` — the console runs a hand-copied fork (`ui/rich-text/markdown.ts:7,26,104`). Resolve to one copy. |
| `privacy-lifecycle` | 2168 | **Delete** — in-memory fakes only; keeping it is worse than nothing because `README.md:99-102` reads as if the capability exists | Its `RetentionPolicy`/`ExportManifest` types are a decent spec for the eventual runbook |
| `learning-pipeline` | 2688 | **Delete** — regex EICAR "scanner", no real extractor, 8-dim embeddings against a 384-dim column | Nothing |
| `realtime-voice` | 1741 | **Delete**, but first port its reconnect/backoff into `conversation-client.tsx` — the shipped client has none (`:973-989` just gives up). Also delete the dead `lib/voice-session-scope.ts` (only importer is its own test) | Reconnect/backoff logic |
| `identity-access` | 1809 | **Keep on ice** — `src/oidc.ts` is 376 lines of real `jose`-backed verification and is the only asset here worth anything when an enterprise deal demands SSO. Delete `src/fakes.ts` and the SAML/SCIM stubs so nobody mistakes them for implementations | `src/oidc.ts` |
| `mcp-server` | 3431 | **Delete the 27 fixture tools + `demo-data.ts`** — they call `/api/dev/*`, deleted this session. Keep the 9 durable tools only if someone actually uses them; otherwise delete the package. Also drop `mcp_grants`/`mcp_invocations` or start writing them | The 9 durable tool definitions |
| `widget-runtime` | 1521 | **Keep** — the only orphan with no SQL replacement, and widget delivery is in flight | — |

Then remove the 8 dead workspace deps from `apps/console/package.json:13-22` and the unused one at `packages/mcp-server/package.json:17`. That alone stops the next reader from assuming they are used.

---

## False claims in README.md / DEVELOPMENT.md

The owner was misled by these. Quoted verbatim.

1. `README.md:57-66` — the entire **"Working development surfaces"** list (`/dev/chat`, `/dev/learning`, `/dev/creator`, `/dev/intelligence`, `/dev/teacher`, `/dev/branding`, `/dev/admin`, `/dev/privacy`, `/dev/widget`, `/dev/widget/host`). All ten route directories are staged-deleted. None resolve.

2. `README.md:68-70` — *"The UI, development APIs and management MCP share the same tenant-aware application services."* They share nothing. `apps/` imports `@course-ai/application-services` zero times; the console calls Supabase RPCs directly from route handlers.

3. `README.md:78-79` — `pnpm smoke:dev` and `pnpm --filter @course-ai/console smoke:authoring`. Neither script exists in `package.json` or `apps/console/package.json`. `pnpm verify:dev` does exist but runs the MCP smoke test against `/api/dev/*`, which is gone.

4. `README.md:92-93` — *"The management MCP exposes 28 shared-service tools."* It registers 36; 27 of them call a deleted API surface.

5. `README.md:99-102` — *"The privacy lifecycle adds tenant-safe, resumable access/export/delete/retention contracts with live legal-hold suppression, deletion tombstones and export integrity."* True of a package with zero importers, zero tables and zero routes. As a statement about the product, false.

6. `README.md:102-104` — *"Supabase has nine ordered migrations, 38 schema tables."* 39 files, 58 tables in the repo; nine further migrations live only in the database.

7. `README.md:114-116` — *"Postgres repositories now cover exact verified-principal registration, membership resolution, tenant context, service principals, invitations and SCIM replay without a memory fallback."* Those repositories are in `packages/postgres-adapters`, which requires a `PostgresExecutor` that nothing in the repo constructs. They have never executed against this application.

8. `DEVELOPMENT.md:26-70` — the whole **"Implemented vertical slice"** list is written in the present tense. Specifically false as product statements: *"a dedicated realtime voice canvas… with tenant tinting"* (voice is hardcoded `"marin"` and unkeyed); *"tenant-safe in-memory application services used by UI, APIs and MCP"* (`:43` — used by none of them, and "in-memory" is disqualifying either way); *"deterministic staged ingestion, selective reprocessing, atomic publish and rollback"* (`:45-46` — no ingestion stage executes); *"policy-driven, resumable privacy access/export/delete/retention workflows"* (`:60-62`); *"a 28-tool management MCP"* (`:63`); *"eight Supabase migrations with 36 schema tables"* (`:65`); *"injected PostgreSQL primitives… with no memory fallback"* (`:67-68` — never injected anywhere).

9. `README.md:7` — *"one Student conversation UI for text, voice, files, rich text and diagrams."* Files: no file input, `attachments` has zero writers. Diagrams: renderer only, no producer.

**The pattern.** `README.md:124-128` and `DEVELOPMENT.md:72-83` do carry an honest caveats section, and `docs/course-ai-platform/20-IMPLEMENTATION-EVIDENCE.md` is genuinely candid (`:36` states scanning, extraction and promotion "remain pending and are not simulated"). But the caveats are 700 words after the claims and are phrased as environment work. A reader who stops at `README.md:99` believes the privacy lifecycle ships. Both files should be rewritten to describe what a signed-in user can do, not what a package contains.

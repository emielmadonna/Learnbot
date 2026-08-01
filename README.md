# LearningBot

Multi-tenant learning assistants for course creators and their students.

**This file describes what a signed-in user can actually do.** Anything not yet
built is in [Not yet built](#not-yet-built) and is named there plainly. If you
change what ships, change both sections in the same commit — a README that
describes packages instead of behaviour is how this repository previously
convinced its own owner that eight unused packages were delivered features.

## What works, end to end

Each row below has a real UI → route → `SECURITY DEFINER` RPC → table path with
no fixture in it.

| Capability | Path |
|---|---|
| Sign-in and session | `app/auth/sign-in` → `lib/supabase/auth-boundary.ts` → `auth_current_access_state` → `app_private.user_access_accounts` |
| Forced password change | `app/auth/change-password` → `auth_complete_password_change` |
| Tenant selection and RBAC | `auth-boundary.ts` → `auth_list_tenant_memberships` / `auth_current_tenant_context` / `auth_select_tenant` → `public.identity_memberships` |
| Managed user accounts | `app/app/admin/users` → `api/admin/users` → edge fn `learning-admin-users` → `admin_provision_auth_user` |
| Onboarding workspace and steps | `app/onboarding` → `onboarding_get_snapshot` / `onboarding_update_step` |
| Platform administration | `components/sections/platform-panel.tsx` → `api/platform` → `platform_admin_*` → `app_private.platform_administrators`, `public.tenant_sections` |
| Client provisioning and owner claim | `platform_mint_owner_claim` → `auth_claim_preprovisioned_tenant_owner` |
| Agent configuration (name, brand, persona, tone, scope) | `agent-panel.tsx` → `api/agent` → `tenant_update_agent_configuration` → `public.tenant_branding` |
| Brand asset upload and signed read | `api/agent/asset` → signed URLs on the `tenant-private` bucket under storage RLS |
| Course authoring (course/module/lesson/block CRUD, reorder) | `course-panel.tsx` → `api/authoring` → 11 RPCs in `20260725122000_course_editing.sql` |
| Revisions and rollback | `learning_list_course_revisions`, `learning_rollback_course` → `public.course_revisions` |
| Publishing | `api/learning/courses/[courseId]/publish` → `learning_publish_course` |
| Authored content → retrievable knowledge | `learning_publish_course` projects published `content_blocks` into `knowledge_versions` / `learning_documents` / `learning_chunks` (`20260726095000_authored_content_retrieval.sql`) |
| Grounded learner conversation (text) | `conversation-client.tsx` → `api/learning/respond` → `lib/learning-provider.ts` → `public.messages`. Answers are refused rather than invented when retrieval returns nothing |
| Question intelligence | `api/learning/respond` → `lib/question-classification.ts` → `learning_record_question_label` → `public.question_labels`, `public.question_signals` |
| Analytics and insights | `insights-panel.tsx` → `api/analytics` → `analytics_tenant_overview` and friends. Metrics carry an explicit known/partial/unknown envelope computed in SQL |
| Lesson progress | `app/app/progress` → `learning_mark_lesson_progress` |
| Usage events | `usage-signal.tsx` → `api/learning/events` → `learning_record_usage_event` |

The strongest part of the system is the authorization boundary. Roles are read
from the database, never from a JWT: `learningbot_custom_access_token_hook`
deliberately strips top-level `tenant_id` and `app_role` from access tokens
(`0011:917-921`), and every mutation goes through a `SECURITY DEFINER` RPC over
forced RLS.

### Partially working

- **Voice.** Push-to-talk and a continuous WebRTC session exist
  (`api/learning/voice/{realtime,transcribe,speak}`). Every voice turn is routed
  back through `/api/learning/respond` so the realtime model reads a grounded,
  already-persisted answer rather than inventing one. All three routes return
  503 without `OPENAI_API_KEY`. Rate limiting is an in-process `Map`
  (`voice/rate-limit.ts`), which is close to useless on serverless.
- **File upload.** A signed PUT lands the file in
  `tenant-private/{tenant}/quarantine/…` and records `learning_sources` and an
  `ingestion_jobs` row. **That is the end of the road** — see below.
- **Invitations.** `onboarding_create_invitation` works and writes
  `public.identity_invitations`. Nothing emails the code; a human copies it out
  of the UI.
- **Widget delivery.** `20260726093000_widget_delivery.sql` provides public
  `widget_bootstrap` / `widget_ask` with origin allowlisting, and
  `packages/widget-runtime` is wired to it. The shipped artifact is the
  `/widget.js` route (`apps/console/src/app/widget.js/route.ts`), which serves
  the Corso host adapter concatenated with the built runtime IIFE; the customer
  pastes one `<script src=".../widget.js" data-tenant="wk_...">` tag, and
  `/install/circle` generates that snippet against the origin the page is
  served from. Two older generation artifacts under
  `apps/console/public/integrations/` were deleted on 2026-07-31: nothing
  executable referenced them and they documented a `data-widget-key` attribute
  the runtime does not read. Note `anonymousQuestions` defaults to `false`, so
  a freshly installed widget paints a launcher and refuses every question until
  it is switched on.
- **Audit.** `public.audit_ledger` is written by agent configuration, authoring,
  tenant sections, signal review and widget paths. It is **not** written by
  conversations, voice, uploads, onboarding, tenant status changes or account
  provisioning, and there is no reader UI.

## Not yet built

Named plainly, because each of these has been claimed before and none of them
ship.

- **Privacy, GDPR, export, deletion, retention, legal hold.** There is **no code
  path at all**. Zero API routes, zero tables, zero jobs. If a client asks to
  export or delete their data today, an operator runs SQL by hand. The design
  target and the manual procedure are in
  [docs/PRIVACY-DATA-LIFECYCLE-SPEC.md](docs/PRIVACY-DATA-LIFECYCLE-SPEC.md).
  The `packages/privacy-lifecycle` package that used to imply otherwise was
  deleted on 2026-07-26; its "deletion" mutated a JavaScript `Map`.
- **Upload processing.** Uploads **terminate in quarantine, permanently.** There
  is no malware scanner, no text extractor, no promotion RPC.
  `upload_intents.status` never leaves `'quarantined'` and
  `upload_callback_receipts` has zero writers. The uploader UI says so verbatim;
  do not demo it as "drag and drop your course". Authored content is retrievable;
  uploaded files are not.
- **Files and diagrams inside the student conversation.** The renderer handles an
  `attachment` part and a `diagram` part, but there is no file input anywhere in
  the conversation UI, `public.attachments` has zero writers, and nothing
  produces a diagram.
- **Management MCP.** `packages/mcp-server` was deleted on 2026-07-26. It
  registered 36 tools, 27 of which called the `/api/dev/*` routes removed in the
  same session; the remaining 8 were an HTTP proxy over console routes requiring
  a hand-pasted user bearer token, and nothing used them. It had **no Dockerfile,
  no deploy configuration and no CI step — it was never deployed anywhere**, and
  its stdio transport is not hostable on Vercel.
- **SSO, SAML, SCIM.** `packages/identity-access` is **a JWT verifier, not this
  application's authentication.** Nothing in `apps/` imports it. `src/oidc.ts` is
  real, `jose`-backed OIDC/JWKS verification, kept for the day an enterprise deal
  requires SSO. There is no SAML implementation and no `/scim/v2/*` route; those
  stubs were deleted on 2026-07-26 so nobody mistakes them for a feature. The
  console authenticates through Supabase Auth.
- **Ingestion operations console, playground, prompt studio, webhooks,
  connectors, student memory, hot students.** None of these exist in any form,
  despite appearing as required areas in the product documentation.
- **Invitation delivery.** No SMTP, no mailer, no template.
- **`telemetry_outbox` drain.** Every usage event writes a row; nothing reads
  them. The table grows without bound.

## Workspace

```text
apps/
  console/       the web application — this is the product
  edge/          a README, nothing more
services/
  learning/      a README, nothing more
packages/
  contracts/     provider-neutral domain types, platform role vocabulary
  provider-router/
                 provider-neutral routing with an OpenAI Responses adapter
  widget-runtime/
                 framework-free Shadow-DOM companion, being wired now
  identity-access/
                 an OIDC/JWKS verifier on ice. Not wired. See its README
infra/
  supabase/      ordered schema, forced RLS, storage policies, SQL security tests
docs/            product documentation and the integration audit
```

`apps/console` imports exactly two workspace packages: `@course-ai/contracts`
and `@course-ai/provider-router`. On 2026-07-26 eight further packages
(~23,000 lines) were deleted because they had zero import edges into `apps/` or
`services/` while `README.md` presented them as delivered capability. Every one
of them had already been re-implemented in plpgsql, and the SQL version is the
one that runs — with foreign-key integrity and audit trails the TypeScript
lacked. Keeping both was not optionality; it was two competing definitions of
the same invariant.

## Configuration

Every variable the console reads is documented in `.env.example`, and every
variable documented there has a named reader. `OPENAI_API_KEY` and
`LEARNINGBOT_CONVERSATION_OPERATION_TOKEN` are both required for chat to work at
all; the operation token must additionally hash-match a currently valid row in
`app_private.learning_operation_secrets`, and that row expires. The provisioning
and rotation procedure is in `.env.example` next to the variable.

## Database

`infra/supabase/migrations` holds the ordered schema. Verify its structure with
`pnpm supabase:verify` rather than trusting a count written in prose.

**Read `infra/supabase/SCHEMA-DRIFT.md` before rebuilding anything.** Several
functions and tables — including the provider-credential vault — exist only in
the live database and were applied by hand. Re-running the committed migrations
against the live project *downgrades* `admin_provision_auth_user`, the function
that creates client users. This is the one item in the repository that can
destroy a live tenant.

## Commands

```bash
pnpm install
pnpm --filter @course-ai/console dev --port 3100
pnpm --filter @course-ai/console typecheck
pnpm --filter @course-ai/console test
pnpm supabase:verify
pnpm docs:check
pnpm check          # everything above, plus package builds
```

Development-server and parallel-ownership rules are in
[DEVELOPMENT.md](DEVELOPMENT.md). Read
[the product documentation](docs/course-ai-platform/00-README.md) before
implementing, and [the integration audit](docs/INTEGRATION-AUDIT.md) before
believing any claim about what is wired.

## Legacy input

`/Users/emielmadonna/Estie Starr` is read-only legacy input until an explicit
migration plan is approved. Never commit its `.env`, recordings, provider
credentials, private course media or generated vector artifacts.

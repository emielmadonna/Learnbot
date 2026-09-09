# Testing LearningBot end to end

This is the complete test programme for the platform: every layer, every
persona, every journey, and the honest line between what a machine proves and
what a person must still do. It is written so that "we tested it" has one
meaning, and so that opening a client's domain on the widget allow-list is a
decision made on evidence.

Three rules carry through the whole document:

1. **Every automated assertion goes through a route a person uses.** No test
   reads or writes the database directly. A green run is evidence about the
   product, not about a fixture.
2. **A missing precondition skips with a reason.** Nothing passes vacuously.
   If a persona has no credentials, its journeys are reported as skipped and
   say why.
3. **Mutations are opt-in.** Journeys that create or change tenant state run
   only with `E2E_ALLOW_MUTATIONS=1`, and never against production.

## Layers

| Layer | What it proves | Command | Runs where |
|---|---|---|---|
| L0 Static | Types, docs links, contrast, migration structure | `pnpm check` (first half) | CI on every push |
| L1 Unit | Runtime behaviour in a fake DOM, provider adapters, contracts | `pnpm test` | CI |
| L2 Source contracts | Route source text asserts the SSE order, refusal shapes, header discipline (`apps/console/test/*-contract.test.ts`) | `pnpm test` | CI |
| L3 Database | RLS, `SECURITY DEFINER` grants, cross-tenant isolation (`infra/supabase/tests`) | `pnpm --filter … supabase:test` against Docker or an approved dev project | **Not yet executed on this machine** |
| L4 API | Every public and authenticated route through HTTP, no browser | `pnpm e2e` (request-based specs) | Against a deployment |
| L5 Browser | Real Chrome, real pages, three personas, streaming timing | `pnpm e2e` | Against a deployment |
| L6 Manual | Hand-applied migrations, edge deploys, voice with a microphone, Stripe, screen-reader passes | Checklists below | Release gate |

`pnpm check` is the only trustworthy local signal for L0–L2 (see CLAUDE.md on
why a bare typecheck lies). L4–L5 live in `apps/e2e` and are deliberately
**not** part of `pnpm check`: they need a running deployment and secrets.

## Running the browser and API suite

```bash
# Public surfaces only: no credentials, safe against production
E2E_BASE_URL=https://clone.stack-labs.ai E2E_HOSTED_SLUG=estie-starr pnpm e2e:public

# Everything, against a staging deployment, with mutations allowed
E2E_BASE_URL=https://staging.example \
E2E_WIDGET_KEY=wk_… E2E_HOSTED_SLUG=… \
E2E_TEACHER_EMAIL=… E2E_TEACHER_PASSWORD=… E2E_TEACHER_TENANT="Acme" \
E2E_LEARNER_EMAIL=… E2E_LEARNER_PASSWORD=… \
E2E_ADMIN_EMAIL=… E2E_ADMIN_PASSWORD=… \
E2E_ALLOW_MUTATIONS=1 pnpm e2e

pnpm --filter @course-ai/e2e e2e:report   # open the HTML report with traces and videos
```

| Variable | Needed by | Notes |
|---|---|---|
| `E2E_BASE_URL` | all | Defaults to `http://127.0.0.1:3000`. |
| `E2E_HOSTED_SLUG` | VIS-05 | A published `/c/<slug>`. |
| `E2E_WIDGET_KEY` | VIS-02d–f, VIS-03b–f, VIS-04b–d | Its allow-list must contain `E2E_BASE_URL`'s origin (the hosted assistant already requires this). |
| `E2E_<PERSONA>_EMAIL/_PASSWORD` | learner / teacher / admin projects | Real accounts on the target deployment. Accounts under forced password change are skipped, never rotated. |
| `E2E_TEACHER_TENANT` | teacher | Which membership to pick on `/onboarding` when the account belongs to several workspaces. |
| `E2E_ALLOW_MUTATIONS` | TCH-*, ADM-* write journeys | Off by default. |
| `E2E_ALLOW_RATE_LIMIT_PROBE` | VIS-03f | Locks that key's real visitors out for a minute. Staging only. |
| `E2E_BROWSER_CHANNEL` | all | `chrome` (system browser, default) or `chromium`. |

The GitHub workflow `.github/workflows/e2e.yml` runs the same suite on
`workflow_dispatch` and each weekday morning, taking secrets from the
repository. The public project needs only the URL.

Local behaviour proves nothing about provider-backed paths: `OPENAI_API_KEY`
is absent locally, so the authenticated conversation returns
`provider_not_configured` on a dev server while the widget path (which calls
the deployed edge function) works. Run L5 against a deployment.

## Persona journeys

The journeys below are the checklist. For an agent or a person to actually
*use* the product as each persona — with goals, not steps — use the briefs in
[PERSONA-WALKTHROUGH-PROMPTS.md](PERSONA-WALKTHROUGH-PROMPTS.md); those find
the confusion and dead ends a checklist cannot.

IDs are stable and appear in test titles and in evidence. `Auto` names the
spec that proves the row; `Manual` rows have their steps written out because
no machine can do them yet. `Gap` marks a journey the product does not yet
implement, kept here so it is not mistaken for tested.

### Anonymous visitor (VIS) — the customer's customer

| ID | Journey | Expected | Status |
|---|---|---|---|
| VIS-01 | Load `/widget.js` from any origin | 200, `text/javascript`, `ACAO: *`, `public, immutable`, ETag → 304, no secret/key/provider name in the body; `/install/circle` snippet uses the request origin | Auto `public/widget-delivery.spec.ts` |
| VIS-02 | Bootstrap `/api/widget/config` | No Origin, unknown key, malformed key and **unlisted origin** are the same opaque 404 with no CORS headers; a listed origin gets branding, `ACAO` echo, `Vary: Origin`, `private, no-store`, and no tenant id/persona/UUID; `www.`, `http://`, a port and a path do not match | Auto `public/widget-config.spec.ts` |
| VIS-03 | Ask `/api/widget/ask` | Same refusals; SSE order `sources → delta… → done` with a UUID `messageId`; buffered JSON when not opted in; no-source questions get the grounding refusal with `no-source-safe-answer` and no model call; a guessed message id cannot be rated; the 30/min cap engages with `Retry-After` | Auto `public/widget-ask.spec.ts` |
| VIS-04 | The embed on a customer page | A refused key **never paints** (display goes hidden → hidden); a listed key paints only after config, in the tenant's colour, without touching host styles; Enter sends; thinking indicator → answer → no indicator; rating control only when a server id exists; close/reopen keeps the transcript; phone gets a full-width sheet | Auto `public/widget-embed.spec.ts` |
| VIS-05 | The hosted assistant `/c/<slug>` | Unknown slug is the friendly opaque page; a published slug loads branded with suggestions; ask → indicator → prose → collapsed sources that expand; a follow-up naming no course is answered from history; Enter submits; New conversation clears; phone reflow with no horizontal scroll; the slug's ask route enforces Origin | Auto `public/hosted-assistant.spec.ts` |
| VIS-06 | Streaming feel | `ms-to-sources`, `ms-to-first-token`, `delta-count`, `ms-to-done` are recorded on every VIS-05c and VIS-03b run. **One delta means the deployed edge function is not streaming** and the report says so. Target once deployed: first token ≤ 3.5 s p50, ≥ 10 deltas on a paragraph answer | Auto (annotations) + Manual review |
| VIS-07 | Reduced motion, keyboard, screen reader | Launcher reachable by Tab, Escape closes, focus returns to launcher; `prefers-reduced-motion` stops the dots and orb; VoiceOver reads assistant turns as "<name> message" | Manual (L5 checks focus only) |
| VIS-08 | Self-reported identity via `window.CourseAiWidgetIdentity` | Header shows "Identity not verified"; an email-shaped ref is refused at the boundary; nothing but a peppered digest is stored | Manual on a Circle test space |
| VIS-09 | Circle install | Raw JS snippet under Site → Code snippets; launcher appears on web, not in native apps; the documented mobile fallback link exists | Manual |

### Signed-in learner (LRN)

| ID | Journey | Expected | Status |
|---|---|---|---|
| LRN-01 | Sign in, pick a tenant, land in the app | `/auth/sign-in` → `/app/entry` → (`/onboarding` to pick a membership) → `/app`; owners and admins land on Insights; a wrong password gives one non-enumerating error | Auto `auth.setup.ts`, `public/anonymous-security.spec.ts` SEC-A5 |
| LRN-02 | Forced password change | An account flagged for change cannot reach `/app` until it completes `/auth/change-password`; the new password must be ≥ 12 chars with upper, lower, digit and symbol | Manual (tests never rotate a real password) |
| LRN-03 | Grounded text conversation | Question → `awaiting-first-token` → streaming → done; sources listed and collapsed; a no-source question is refused with the tenant's own wording, not invented | Auto `learner/conversation.spec.ts` |
| LRN-04 | Conversation continuity | A follow-up with no course named is answered from history; "Start over" starts over | Auto `learner/conversation.spec.ts` |
| LRN-05 | Voice | Push-to-talk and continuous session speak the same already-persisted grounded answer; mic denied → stays in text with history intact; all three voice routes 503 without `OPENAI_API_KEY` | Manual with a microphone |
| LRN-06 | Lesson progress and usage events | Marking a lesson complete persists across reload; `usage_events` receives the row (Insights reflects it) | Auto `learner/progress.spec.ts` (mark) + Manual (Insights) |
| LRN-07 | Sign out | `/auth/sign-out` clears the session; `/app` redirects to sign-in; back button does not reveal the transcript | Auto `learner/session.spec.ts` |
| LRN-08 | Attachments and diagrams in the learner conversation | — | Gap: no file input, `attachments` has no writer |

### Teacher / tenant owner (TCH)

| ID | Journey | Expected | Status |
|---|---|---|---|
| TCH-01 | Onboarding workspace | Steps are durable across reload; completing them changes what Home shows | Auto (read) `teacher/onboarding.spec.ts` |
| TCH-02 | Agent configuration | Name, mark, colours, persona, tone, scope save as a draft; **Publish** creates a published `tenant_branding` row; the Widget panel's status flips from "Not published" to "Live" only after this; a brand asset uploads to private storage and reads back through a signed URL | Auto `teacher/agent.spec.ts` (mutations) |
| TCH-03 | Course authoring | Create course → module → lesson → content block; reorder; every edit is a revision; rollback restores the prior text; optimistic concurrency refuses a stale version | Auto `teacher/courses.spec.ts` (mutations) |
| TCH-04 | Publish a course | Publish projects blocks into knowledge; a learner question about the new block is answered with it cited within one minute; unpublishing removes it from answers | Auto `teacher/courses.spec.ts` + `learner/conversation.spec.ts` (paired, mutations) |
| TCH-05 | Widget setup | Enable → add the exact origin → anonymous questions on → Save; status badge "Live"; snippet shows the console origin and the issued key; an added origin is accepted by `/api/widget/config` at once and refused again once removed; the panel refuses `http://` on a public host, a path and credentials | Auto `teacher/widget.spec.ts` (mutations) |
| TCH-05b | Widget key rotation | — | Gap: `requested_rotate_key` is hard-coded `false` at both call sites and there is no control. A leaked key can only be handled by disabling the widget |
| TCH-06 | Hosted assistant publication | Set a slug → `/c/<slug>` serves; unpublish → opaque page; a reserved slug cannot be bypassed by the legacy `?key=` | Auto `teacher/hosted.spec.ts` (mutations) |
| TCH-07 | Client user accounts | Provision a user with a temporary password (edge function `learning-admin-users`); the user is forced through password change on first sign-in; roles come from `identity_memberships`, not the token | Auto (provision) `teacher/users.spec.ts` + Manual (first sign-in) |
| TCH-08 | Insights and question intelligence | Every metric carries known / partial / unknown; an empty tenant shows "not measured", never a zero; a question asked through the widget appears with a label | Auto (envelope) `teacher/insights.spec.ts` + Manual (label latency) |
| TCH-09 | Invitations | A code is created and shown; nothing emails it | Manual |
| TCH-10 | Upload | A file lands in quarantine and the UI says exactly that | Manual; Gap beyond quarantine |
| TCH-11 | Audit | Agent, authoring, widget and section changes write `audit_ledger` rows | Manual via SQL (no reader UI) |

### Platform admin (ADM)

| ID | Journey | Expected | Status |
|---|---|---|---|
| ADM-01 | Platform panel | Lists tenants with status and sections; a non-admin cannot see it (`access_denied`, nothing leaked) | Auto (read) `admin/platform.spec.ts` |
| ADM-02 | Provision a client and mint an owner claim | The four-step wizard (Who → The bot → Knowledge → Owner) ends in "Workspace created"; the knowledge step is cosmetic and the workspace starts empty; the owner's one-time link signs them in once and is refused the second time; the owner lands in onboarding | Auto (mutations, disposable `e2e-` tenant) `admin/platform.spec.ts` + Manual (claim in a fresh browser) |
| ADM-03 | Suspend / unsuspend | Suspended tenant's widget and hosted page refuse (VIS-02/05 opaque); its owner sees the suspension, not a crash; unsuspend restores both within a minute | Auto (mutations) `admin/lifecycle.spec.ts` |
| ADM-04 | Enter / exit a tenant | Entering pins the tenant in the header; nothing from the prior tenant survives (search, recents, deep links); exit returns to the platform view; both are audited | Auto (mutations) `admin/lifecycle.spec.ts` |
| ADM-05 | Sections | Toggling a section hides its navigation for the tenant and its routes return `access_denied` | Auto (mutations) |
| ADM-06 | Provider credentials | Setting a tenant BYOK key is write-only; it never reads back; the edge function refuses a caller the console would refuse | Manual (edge function `learning-provider-credentials` deploy state, see SCHEMA-DRIFT) |
| ADM-07 | Billing | Metered usage reaches Stripe; 80 % alert and hard cap | Manual; partly Gap |

### Security (SEC)

| ID | Journey | Expected | Status |
|---|---|---|---|
| SEC-A | Anonymous surface | Every console API refuses without a session and never 500s or leaks; cookie mutations refuse a foreign Origin (CSRF); `/app` redirects; nosniff, frame, referrer and HSTS headers present; **no CSP is recorded as a known gap** | Auto `public/anonymous-security.spec.ts` |
| SEC-B | Cross-tenant isolation | With teacher credentials for two tenants: every read of tenant A's course, conversation, analytics, widget settings and brand asset with tenant B's session returns `access_denied`/404 and no partial body | Auto when both credential sets exist `security/cross-tenant.spec.ts`; otherwise L3 SQL tests |
| SEC-C | Widget key abuse | A stolen key + the customer's domain string can ask (if anonymous questions are on) and rate, but cannot read another conversation, get persona text, forge assistant turns, or reach another tenant | Auto VIS-02/03 + Manual review of `docs/TESTING.md § Open findings` |
| SEC-D | Secrets in transit and at rest | No secret in `/widget.js`, in any anonymous payload, in the HTML of `/c/<slug>`, or in a client bundle (`grep` of `.next/static` for `sb_secret_`, `sk-`, operation token) | Auto (partial) + Manual grep at release |
| SEC-E | Database | RLS enabled and forced on every tenant table; anon revoked; every `SECURITY DEFINER` sets `search_path`; helper functions unreachable by client roles | L3 `infra/supabase/tests` (needs Docker) |

### Operations (OPS) — release gate

| ID | Check | How |
|---|---|---|
| OPS-01 | Migrations applied | Every file in `infra/supabase/migrations` newer than the last ledger entry is recorded as applied in `infra/supabase/SCHEMA-DRIFT.md`, in the same session it was run |
| OPS-02 | Edge functions deployed | `learning-provider-widget-complete` streams: VIS-05c reports `delta-count` > 1. `learning-provider-credentials` deployed per SCHEMA-DRIFT |
| OPS-03 | Supabase project awake | `curl https://<ref>.supabase.co/rest/v1/` returns 401, not NXDOMAIN (the project auto-pauses on the free plan) |
| OPS-04 | Production serves the current build | `/widget.js` ETag equals the local build's (`sha256(prelude + iife)`); the domain alias has served a stale build before |
| OPS-05 | Provider budget | `learning_reserve_provider_call` refuses past the cap; the cost ledger shows the day's spend |
| OPS-06 | Backups | None exist on the free plan. Any destructive migration is preceded by a manual export |
| OPS-07 | Emailed links work from any device | The Supabase email templates for Reset Password, Invite and Magic Link point at `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=<recovery\|invite\|magiclink>&next=…` rather than `{{ .ConfirmationURL }}`. The default PKCE link only works in the browser that requested it; opening it on a phone or another profile says "invalid or has expired". `/auth/callback` accepts both shapes |

## UX quality gates (every screen, every release)

From the universal screen contract in
`docs/course-ai-platform/07-UX-INFORMATION-ARCHITECTURE.md`. For each screen
in the app shell, the hosted page and the widget:

- [ ] Empty state explains why and offers one safe next action
- [ ] Loading is layout-stable (no jump when data lands)
- [ ] Error names scope, offers retry, preserves typed work
- [ ] Degraded integration says what is missing and what still works
- [ ] Permission-limited says so without leaking what is hidden
- [ ] 390 px, 768 px, 1280 px reflow; no hover-only action; no horizontal scroll
- [ ] Keyboard-only completes the journey; visible focus; Escape closes overlays
- [ ] `prefers-reduced-motion` honoured
- [ ] Contrast passes `pnpm check:contrast`
- [ ] Streaming: an indicator is visible from send until the first token; text never appears as an empty bubble; the reader is not scrolled while reading back

## Evidence

Each run records: commit, `E2E_BASE_URL`, command, which personas were
present, the Playwright HTML report (traces and videos for failures), the
VIS-06 timing annotations, and for manual rows the reviewer, timestamp and a
screenshot. The report lives with the release notes. "Live-host assertions
require live evidence; fakes prove contracts only" (18-ACCEPTANCE-TESTS).

## Before opening a client's domain

1. `pnpm check` green on the deployed commit.
2. `pnpm e2e:public` green against production, VIS-06 timings reviewed.
3. OPS-01 to OPS-04 confirmed.
4. In the client's workspace: agent configuration **published**; widget enabled; anonymous questions on if visitors are anonymous; the exact origin (scheme + host, no `www.` unless that is what the site uses) on the list; Widget panel status reads **Live**.
5. On the client's own site: launcher appears once (no flash), opens, answers a known question with sources, and a nonsense question is refused.
6. The Circle mobile fallback link exists if the community has native apps.

## Open findings tracked here

From the September 2026 security review of the public surface, unresolved:

- Per-key-only rate limiting lets one scripted caller lock a tenant's visitors out and spend its provider budget. Needs a per-client dimension checked before the shared cap.
- `conversationRef` is a transcript-read capability since conversation history landed, yet rides in visual URLs and shared `sessionStorage`. Needs a per-asset token.
- One shared operation token gates every privileged widget action across all tenants, including completions on tenants' own provider keys. Needs split capabilities and signed edge-function requests.
- No rate limit on bootstrap, feedback and the visual proxy.
- No Content-Security-Policy on the console or hosted page.

## Things the route map turned up that a tester must know

- There is no `data-testid` anywhere; every selector is role, label or text. The most stable handles are `nav[aria-label="Primary"] a[data-label="…"]`, the panel sub-navs (`Assistant settings`, `Widget settings`, `Learning sections`, `Analytics view`) and `section[aria-label="Add a client"]`.
- Owners and admins land on `?panel=insights`, but the tenant dock has no entry for it; once closed it is reachable only from Home links. Scripts must deep-link.
- Analytics reads check Origin only when the header is present; cookie mutations check it always; a bearer token bypasses the same-origin check by design on `authenticatedLearningClient` routes. Cross-origin tests must use cookies.
- `/api/billing/usage-report` and `/api/billing/dunning-sweep` are never scheduled; the only cron fans out to embeddings and the telemetry drain.
- Widget questions are never classified, so question-intelligence rows come only from signed-in questions.
- The Vercel project is `learningbot-estie-preview`; no preview URL is recorded in the repo, and only `https://clone.stack-labs.ai` exists as a target.

## What this programme cannot do yet

- L3 database tests have not run on this machine (Docker or an approved dev project required).
- There is no staging deployment; every mutating journey therefore has nowhere safe to run until one exists. Creating one is the single biggest unlock for this document.
- Voice, screen-reader and Circle-native checks remain human.
- Anything listed under "Not yet built" in README.md is a Gap row, not a test.

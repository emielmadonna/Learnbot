# Technical debt register

*Opened 2026-07-31. Every entry carries a `file:line` and was verified against
the working tree, not inferred from a name or a document.*

## How to read this

This project has been damaged more than once by a confident wrong theory, so
this register separates what was **verified** from what is **suspected**. An
entry marked *unverified* is a lead, not a finding — check it before acting on
it. A flagged unknown is worth more than a wrong answer.

Effort: **S** ≈ under an hour, **M** ≈ a half day, **L** ≈ multiple days.
Severity is *blast radius if left alone*, not how annoying it is.

Line numbers were correct on 2026-07-31 in a working tree with concurrent edits
in flight. Re-grep the identifier before acting on any entry.

### The theme

Nineteen of these entries are one bug wearing different clothes: **a surface
fetches data and renders less than it fetched.** `CLAUDE.md` already names this as
the codebase's characteristic failure. It is not a handful of oversights — it is
the dominant shape of debt here, and D-24 explains why the compiler never
objected.

### If only four things get done

**D-01** (a tenant's entire agent configuration is fetched and dropped),
**D-02** (Insights fetches eight analytics RPCs and renders three),
**D-03** (a rate-limited visitor is told the widget is reconnecting),
**D-24** (`noUnusedLocals` is off, which is why the rest went unseen).

| ID | Title | Severity | Effort | Status |
|---|---|---|---|---|
| [D-01](#d-01) | Agent directive: 16 fields fetched, 2 consumed | Critical | M | Open |
| [D-02](#d-02) | Insights fetches 8 analytics RPCs, renders 3 | High | M | Open |
| [D-03](#d-03) | Widget discards `retryAfterSeconds`, shows "Reconnecting…" | High | S | Open |
| [D-04](#d-04) | Home fetches `learnerProgress` every load, discards it | High | S | Open |
| [D-05](#d-05) | Hosted assistant drops the visual parts the widget renders | High | M | Open |
| [D-06](#d-06) | `/api/widget/feedback` fully built, zero callers | High | M | Open |
| [D-07](#d-07) | Two embedding workers, only one meters cost | High | M | Open |
| [D-08](#d-08) | 70 of 71 routes declare no `maxDuration` | High | M | Open |
| [D-09](#d-09) | 18 shipped RPCs with no caller anywhere | High | L | Open |
| [D-10](#d-10) | Agent revision rows: 9 fields fetched, 3 shown | Medium | S | Open |
| [D-11](#d-11) | Conversation discards already-signed brand images | Medium | S | Open |
| [D-12](#d-12) | Invitation expiry and account status fetched, dropped | Medium | S | Open |
| [D-13](#d-13) | Budget `enforcement` fetched, never shown | Medium | S | Open |
| [D-14](#d-14) | Signal detail drops its own deep-link ids | Medium | S | Open |
| [D-15](#d-15) | Smaller fetch-and-drop sites | Low | M | Open |
| [D-16](#d-16) | Brand foreground derived in console, hardcoded white publicly | Medium | M | Open |
| [D-17](#d-17) | Half the console suite asserts on source text | High | L | Open |
| [D-18](#d-18) | Vacuous assertions that pass when the code is deleted | High | S | **Partly fixed** |
| [D-19](#d-19) | A test that fails when its bug is fixed | Medium | S | Open |
| [D-20](#d-20) | Dead exports and unrendered components | Medium | M | Open |
| [D-21](#d-21) | Four brand-colour validators with four accept-sets | Medium | M | Open |
| [D-22](#d-22) | Hand-maintained duplicate prompt builder | Medium | M | Open |
| [D-23](#d-23) | RPC wrappers bypassed by inline `.rpc()` calls | Low | S | Open |
| [D-24](#d-24) | `noUnusedLocals` is off repo-wide | High | M | Open |
| [D-25](#d-25) | `packages/identity-access` — 421 lines, zero consumers | Medium | S | Open |
| [D-26](#d-26) | `lib/deployment-mode.ts` dead but cited as shipped evidence | Medium | S | Open |
| [D-27](#d-27) | Recursive `test` scripts rebuild during a parallel run | Medium | S | Open |
| [D-28](#d-28) | Error reporting exists, wired to one call site | Medium | M | Open |
| [D-29](#d-29) | Silent coverage carve-outs in the interaction audit | Medium | S | Open |
| [D-30](#d-30) | README-only workspace members and orphaned public SVGs | Low | S | Open |
| [R-01](#r-01) | Orphaned `public/integrations/` generation | — | — | **Resolved** |

---

<a id="d-01"></a>
## D-01 — The agent directive is fetched in full and two fields are consumed

**Verified.** Severity Critical. Effort M.

This is the largest instance of the pattern in the codebase, and it is the root
cause of several separately-reported symptoms.

`apps/console/src/app/api/learning/respond/route.ts:972` fetches the tenant's
agent directive:

```ts
executeLearningRpc(supabase, "learning_get_agent_directive", {
  operation_token: operationToken,
}),
```

The SQL returns **16 fields**
(`infra/supabase/migrations/20260726097000_agent_control_surface.sql:1124-1141`):
`assistantName, personaInstructions, extendedInstructions, tone, courseScope,
model, temperature, topP, maxOutputTokens, retrievalCount,
retrievalSimilarityFloor, noResultsMessage, escalationEnabled, escalationTrigger,
escalationMessage`.

**Two are read** (`route.ts:997-998`):

```ts
const personaInstructions = stringValue(directive.personaInstructions);
const tone = stringValue(directive.tone);
```

`answerGroundedLearningQuestion` **accepts the whole directive** —
`apps/console/src/lib/learning-provider.ts:187` declares `agentDirective?: unknown`
with a docstring explaining that every field is re-validated on read. The call
site at `route.ts:1030` passes sixteen arguments and **`agentDirective` is not
among them**. So `resolveAgentDirective(undefined)` at `learning-provider.ts:206`
returns platform defaults for every field, on every authenticated answer.

**The three symptoms this explains:**

1. **The tenant's refusal wording never appears.** `learning-provider.ts:210`
   returns `directive.noResultsMessage` — of the *default* directive. And the
   streaming branch does not even reach it: `route.ts:306` declares a module
   constant `NO_SOURCES_ANSWER` and emits it at `:615` and `:629`. Meanwhile the
   value is validated on write (`api/agent/route.ts:191`, 1–500 chars), edited
   under help text reading *"Shown whenever the search above comes back empty"*
   (`components/sections/agent-panel.tsx:2592-2601`), and **honoured by Preview**
   (`api/agent/preview/route.ts:186-189,217`). A tenant edits the wording, Preview
   confirms it, production shows the platform default forever.

2. **The chosen model is discarded.** `route.ts:639-640` uses
   `process.env.LEARNINGBOT_LLM_MODEL?.trim() || "gpt-5.6-terra"` while
   `directive.model` — constrained to `app_private.agent_allowed_models()` and
   chosen in the console's model picker — sits unread. `temperature` and
   `maxOutputTokens` are accepted by `ChatCompletionInput`
   (`packages/contracts/src/providers.ts:220`) but `learning-provider.ts:228`
   builds the request with only `model` and `messages`.

3. **Retrieval tuning and escalation never fire.** Four helpers exist and have
   **zero call sites** — each occurs exactly once in the file, at its own
   declaration: `route.ts:186` `applyRetrievalDirective` (would apply
   `retrievalSimilarityFloor` and `retrievalCount`), `:206` `isRepeatedQuestion`
   (whose own comment calls it *"the only signal `escalationTrigger:
   "after_repeated_question"` has to work with on this path"*), `:222`
   `escalationPayload`, and `lib/provider-runtime.ts:658` `resolveEscalationOffer`
   (whose only non-definition occurrence is an unused import at `route.ts:24`).
   The escalation feature is configured at `agent-panel.tsx:2615-2630`, persisted
   by `tenant_update_agent_configuration`, returned by the directive RPC — and
   never reaches an answer.

**Why it is debt.** `docs/PLAN.md` Phase 14 exists precisely because *"Phase 4
stores model, temperature, top-p, max tokens, retrieval count and similarity floor
— versioned and audited — but nothing consumes them."* This register confirms that
phase is still open, and adds that the helpers to close it have already been
written and left unwired — which is worse than not having written them, because it
reads as done.

**Blast radius if left.** Every agent control in the product is a form that does
nothing, on the primary authenticated path, while Preview actively confirms the
wrong belief. This is the same failure as the `agent_voice` bug that
`docs/INTEGRATION-AUDIT.md` recorded and that was fixed — repeated across fourteen
more fields.

**Recommended.** Pass `agentDirective: directive` at `route.ts:1030` first — one
argument, and it lights up `noResultsMessage`, `model` and the generation settings
on the non-streaming path. Then thread the directive into the streaming params so
`:615`/`:629` can use it, and wire the four dead helpers or delete them.

**Not fixed here, deliberately.** The one-argument change is small but it alters
model selection and refusal copy on the primary answer path, and the streaming
half is a multi-point change (params type, caller, two emit sites) inside a
`ReadableStream.start` that does not currently carry the directive. The file also
carries a scoping note at `:298-304` restricting what may touch it. This needs its
own change, its own test, and a deliberate decision about `model` — see the open
question below.

**Open question — do not guess.** Whether `directive.model` *should* override
`LEARNINGBOT_LLM_MODEL` is a policy call, not a cleanup. Cost, the margin policy
in `docs/PLAN.md` §10, and `app_private.agent_allowed_models()` all bear on it.
Settle that before wiring the model field.

---

<a id="d-02"></a>
## D-02 — Insights fetches eight analytics RPCs and renders three metrics

**Verified.** Severity High. Effort M.

`apps/console/src/components/sections/insights-panel.tsx:2166` passes only
`snapshot`, `intelligence` and `feedback` into `<V2InsightsView>`, and that view
reads exactly three numbers (`:550-552`): `overview.metrics.questionVolume`,
`overview.metrics.activeLearners`, `answerQuality.metrics.groundingCoverage`.

Fetched in the same request and never rendered anywhere in the panel:

- `snapshot.distribution` — the whole `analytics_question_distribution` result
  (courses / modules / lessons tree), parsed at `:1581-1583`
- `snapshot.learnerProgress` — the whole `analytics_learner_progress` result
  (`courseFunnel`, `stalledThresholdDays`)
- `snapshot.answerQuality.metrics.contentGapSignals`, `.retrievalConfidence`
- `snapshot.overview.metrics.channelSplit`, `.surfaceSplit`, `.answerLatencyMs`,
  `.turnRecordingIntervalMs`
- the entire `widget` snapshot — `:1779`, backed by **three** RPCs
  (`analytics_surface_breakdown`, `analytics_widget_engagement`,
  `analytics_widget_content_gaps`). It appears only inside the JSON/CSV export
  blob at `:1979-1988`. Zero pixels.
- `intelligence.labels.metrics.intentDistribution`, `.classificationCoverage` —
  the parser at `lib/supabase/question-intelligence-rpc.ts:404-411` **throws** if
  they are absent, which proves the server returns them
- `signals.metrics.detectedSignals.value.bySeverity`, `.omittedSignals`,
  `.classifiedQuestionsInRange`

The route handler returns all four sections explicitly
(`apps/console/src/app/api/analytics/route.ts:118-129`).

**The file says so itself.** Its own header comment at `:1759` still describes the
previous behaviour: *"Question distribution leads the surface, followed by volume
over time, answer grounding and the learner progress funnel."* The V2 rewrite
dropped three of those four and the comment was never updated.

**Why it is debt.** `docs/PLAN.md` Phase 8 — *"Signals readout … the data is
already written on every turn and read by nothing"* — was marked **done**. The
data is now read, transported, parsed by strict validators, and then dropped one
layer short of the screen.

**Blast radius if left.** Eight RPCs of database work and latency on every Insights
load for three numbers, and an operator who cannot see the question distribution,
the learner funnel, or any widget engagement at all — while the export they
download silently contains all of it.

**Recommended.** Decide per dataset: render it, or stop fetching it. Both are
improvements; continuing to fetch and drop is the only bad option.

---

<a id="d-03"></a>
## D-03 — A rate-limited widget visitor is told the widget is reconnecting

**Verified.** Severity High. Effort S.

`/api/widget/ask` returns a precise 429 carrying `retryAfterSeconds` plus a
`Retry-After` header (`apps/console/src/app/api/widget/ask/route.ts:358-372`), and
`apps/console/src/app/api/widget/cors.ts:45` deliberately exposes `Retry-After`
cross-origin so a browser can read it.

- The **hosted assistant** uses it —
  `apps/console/src/app/c/[slug]/hosted-assistant.tsx:148-155` renders *"Too many
  questions at once. Try again in about N seconds."*
- The **embedded widget** throws it away.
  `apps/console/src/app/widget.js/embed-prelude.ts:238-244` maps the payload to
  `{ type: "error", code: "rate_limited", recoverable: true }`, but the runtime's
  handler at `packages/widget-runtime/src/index.ts:1614-1615` reads only
  `event.recoverable` and never `event.code`. The status line renders
  `"Reconnecting…"` (`:1886`).

**Why it is debt.** The purest form of the pattern: produced correctly,
transported correctly, exposed through CORS *deliberately*, carried into the
browser — and dropped at the final step. It also breaks the project's own rule
that a surface must distinguish "the read failed" from "here is what happened".

**Blast radius if left.** A visitor on a paying customer's site is told there is a
connection problem when the truth is a quota, so they retry immediately — the worst
possible response to a rate limit — and the customer reports the widget as broken.

**Blocked here:** `packages/widget-runtime/**` and
`apps/console/src/app/api/widget/**` are owned by concurrent work.

---

<a id="d-04"></a>
## D-04 — Home fetches `learnerProgress` on every load and discards it

**Verified.** Severity High. Effort S.

`apps/console/src/components/sections/home-section.tsx:607` parses it:

```ts
progress: parseAnalyticsLearnerProgress(body.learnerProgress),
```

The only reader of `snapshot.progress` is `ActivityFigures` (`:1225`), which reads
`courseFunnel` at `:1234` and `stalledThresholdDays` at `:1362`. `ActivityFigures`
is reachable only from `ActivitySection` (`:1186`) — and `ActivitySection` is
**never rendered**. `tsc --noUnusedLocals` reports it as declared and never read.
The same is true of `PlatformHome` (`:1423`), a full component with its own
`useEffect` fetching `/api/platform`.

The live component, `OperatorActivityGrid` (`:923`), reads `overview`,
`answerQuality`, `distribution`, `questionLabels` and `signals` — never `progress`.

**Why it is debt.** Home is the exact surface where the known "fetched `labels`,
dropped `signals`" bug lived. That one was fixed. This is the same failure at file
scale: an analytics-backed section, complete and written, sitting unmounted beside
the live one, with its RPC still being paid for on every load.

**Blast radius if left.** `analytics_learner_progress` runs on every Home load for
nothing, and the learner funnel — which `docs/PLAN.md` calls *"highest payoff per
hour of work in the whole plan"* — is built and invisible.

**Recommended — with a caution.** Establish whether `ActivitySection` is
*abandoned* or *not yet mounted* before touching it. Deleting a section someone
intended to wire would repeat the original bug in the opposite direction. If it is
abandoned, stop fetching `learnerProgress` too.

---

<a id="d-05"></a>
## D-05 — The hosted assistant drops the visual parts the widget renders

**Verified.** Severity High. Effort M.

`/api/widget/ask` builds `parts` for diagrams and MP4
(`apps/console/src/app/api/widget/ask/route.ts:132-160`, returned at `:344`) after
recording the disclosure that authorises those reads at `:325`.

- The **embedded widget** consumes them —
  `apps/console/src/app/widget.js/embed-prelude.ts:248`.
- The **hosted assistant** does not. Its response type at
  `apps/console/src/app/c/[slug]/hosted-assistant.tsx:71-77` declares only
  `{ content, sources? }`, and the message it builds at `:334-339` reads
  `payload.message.content` and `parseSources(...)`. Grepping that file for
  `parts|diagram|video|visual` returns one hit — a CSS class named
  `visuallyHidden`.

**Why it is debt.** Same endpoint, same payload, two renderers — and the degraded
one is the *friendly public link* that `/install/circle` tells operators to give
mobile users. The disclosure record is written either way, so the audit trail says
a visual was disclosed to someone who never saw it.

**Blocked here:** `apps/console/src/app/c/**` is owned by concurrent work.

---

<a id="d-06"></a>
## D-06 — `/api/widget/feedback` is fully implemented and has zero callers

**Verified.** Severity High. Effort M.

`apps/console/src/app/api/widget/feedback/route.ts` is complete — origin-gated,
`helpful` / `not_helpful` validated at `:59`, re-rating backed by a unique index.
No client calls it. Neither `packages/widget-runtime/src/index.ts`, nor
`hosted-assistant.tsx`, nor `embed-prelude.ts` contains the string `helpful`,
`feedback` or `thumb`. Only the console rates answers, via `/api/learning/feedback`
(`conversation-client.tsx:337`).

**Why it matters downstream.** `insights-panel.tsx:1715` reads
`/api/analytics/answer-feedback` and presents a "Rated helpful" figure. That figure
therefore covers **signed-in console traffic only** — never anonymous widget or
hosted traffic — with nothing on the surface saying so.

That card was previously a hard-coded literal while its RPC went unread. It is now
real, and answering a narrower question than its label implies.

**Recommended.** Wire feedback into both public surfaces, or label the card with
the population it measures. The labelling fix is cheap and honest and should not
wait for the wiring.

---

<a id="d-07"></a>
## D-07 — Two competing embedding workers, and only one meters cost

**Verified.** Severity High. Effort M.

Two implementations run the same loop against the same three lease RPCs
(`learning_claim_embedding_work`, `learning_release_embedding_work`,
`learning_commit_embedding_work`):

- `infra/supabase/functions/learning-embedding-worker/index.ts:283,327,352` (Deno, 425 lines)
- `apps/console/src/app/api/learning/embeddings/route.ts:176,214,256` (Next route)

Both use `text-embedding-3-small` at 384 dimensions, truncating at 20,000
characters. They have drifted:

| | Edge function | Console route |
|---|---|---|
| Run budget | `RUN_BUDGET_MS = 50_000` (`:8`) | `RUN_BUDGET_MS = 45_000` (`:33`) |
| Batch cap | none | `MAX_BATCHES = 8` (`:32`) |
| Budget reservation | `learning_reserve_embedding_worker_call` (`:310`) | **none** |
| Cost accounting | `learning_record_embedding_worker_cost` (`:372`) | **none** |

**Why it is debt.** Which one a scheduler calls decides whether embedding spend is
metered and whether the tenant's durable budget is enforced.
`docs/INTEGRATION-AUDIT.md` records "zero cost attribution" as a past failure that
was fixed; it is half-fixed on this path.

**Open question — do not guess.** Which is actually scheduled in production is
**not determinable from this repository**. Edge functions are deployed by hand and
the repo is not the record of what runs. Settle it against the live schedule before
removing either.

**Related, unverified conclusion.** `apps/console/src/app/api/learning/respond/route.ts:15-18`
imports `estimateTextCostMicro`, `readTokenUsage`, `recordProviderCost` and
`reserveProviderCall` and **calls none of them** (each occurs once — the import
line). Taken at face value that says the busiest answer path is unmetered. Whether
metering happens indirectly inside the adapter or in the `after()` persistence at
`:760` was **not established**. The unused-import fact is HIGH confidence; the
conclusion is MEDIUM and must be checked **against `cost_ledger` rows grouped by
route**, not by reading more code. That is the lesson `CLAUDE.md` records.

---

<a id="d-08"></a>
## D-08 — 70 of 71 route handlers declare no `maxDuration`

**Verified.** Severity High. Effort M.

```
$ grep -rn "export const maxDuration" apps/console/src
apps/console/src/app/api/learning/respond/route.ts:876:export const maxDuration = 60;
```

No `vercel.json` anywhere. Zero `export const runtime`. One `revalidate`
(`c/[slug]/page.tsx:21`), 13 `dynamic = "force-dynamic"`. The other 58 handlers
export no segment config at all.

**Routes that hard-code their own budget while declaring no ceiling:**

| Route | Self-imposed budget |
|---|---|
| `api/agent/avatar/route.ts:62` | `generationDeadlineMs = 90_000`, then **five sequential** 1024×1024 image generations (`:436`, `:452`) |
| `api/learning/embeddings/route.ts:33` | `RUN_BUDGET_MS = 45_000`, up to `MAX_BATCHES = 8` |
| `api/billing/usage-report/route.ts:33` | `RUN_BUDGET_MS = 45_000`, `MAX_BATCHES = 10`, per-item Stripe call at `:190` |
| `api/ops/telemetry-outbox/drain/route.ts:41` | `RUN_BUDGET_MS = 45_000`, `MAX_BATCHES = 20` |

**The sharpest asymmetry:** `api/widget/ask/route.ts:269` makes a full grounded LLM
completion with the *same* 30-second provider deadline as `/api/learning/respond`
(`lib/learning-provider.ts:230`) and declares nothing, while `respond` declares 60.
`c/[slug]/ask/route.ts:75` invokes that same handler in-process, so both public
surfaces inherit it.

Voice adds a third shape: `lib/supabase/managed-voice.ts:44` hard-wires
`AbortSignal.timeout(50_000)`, and `api/learning/voice/transcribe/route.ts:197-200`
has a `"transcription_timeout"` 504 branch reachable only if the route outlives the
fetch.

`api/agent/avatar/route.ts:463` meters cost **per pose**, so a truncation leaves a
tenant charged for completed poses with no avatar delivered.

**Flagged unknown — do not assert a truncation.** The actual ceiling is **not in
version control**: it depends on the Vercel plan and on whether Fluid Compute is
enabled, both dashboard settings, and `.vercel/project.json` holds only ids. The
defensible statement is narrower and still actionable: *four routes hard-code 45–90
second budgets and one hard-codes a 30-second provider deadline, none declare the
ceiling that would honour them, and the single route that does declare one picked
60.*

**Recommended.** Establish the plan ceiling, then declare per-route or add a
`vercel.json` default. **A `maxDuration` above the plan ceiling is a deploy-time
failure**, which is why nothing was set here.

**On `after()`:** used by `respond/route.ts` (`:760`, `:1065`, `:1086`) and
`lib/observability/error-reporter.ts:207`. The comment at `respond/route.ts:864-875`
explicitly retires the old "`after()` is being killed" theory, and that retirement
checks out — `api/widget/ask/route.ts` contains no call into
`lib/question-classification.ts` at all, matching `CLAUDE.md` item 3. **Nothing
here reopens it.**

---

<a id="d-09"></a>
## D-09 — Eighteen shipped RPCs have no caller anywhere

**Verified.** Severity High. Effort L.

Every `create or replace function public.*` in `infra/supabase/migrations/` was
matched against all of `apps/`, `services/`, `packages/` and `supabase/`. These
have zero callers:

`platform_admin_cost_overview`, `platform_admin_error_readout`,
`platform_admin_telemetry_outbox_overview`, `platform_admin_operation_secret_status`,
`platform_admin_register_operation_secret`, `platform_admin_revoke_operation_secret`,
`platform_admin_resolve_error_group`, `platform_admin_set_tenant_cost_policy`,
`platform_admin_client_detail`, `learning_search_chunks_hybrid`,
`learning_search_chunks_hybrid_v`, `learning_record_conversation_surface`,
`learning_provider_set_credential`, `learning_widget_provider_runtime_credential`,
`observability_claim_error_digest`, `admin_provision_auth_user`,
`admin_record_auth_invitation_failure`, `admin_register_claimed_owner_access`.

Also unreachable from any UI: the `client.claims` and `client.revokeClaim` actions
of `POST /api/platform` (`apps/console/src/app/api/platform/route.ts:289-299`) —
`platform-panel.tsx` issues neither, so the claim list and revoke path exist only
for hand invocation.

**Two need individual attention rather than bulk treatment:**

- **`learning_record_conversation_surface`** is the *write* side of the
  surface-attribution dimension that `analytics_surface_breakdown` reads — and that
  read is itself unrendered (D-02). So `surfaceSplit` may be **structurally empty
  as well as invisible**. Check the rows before building a UI on it.
- **`admin_provision_auth_user`** is the function `CLAUDE.md` warns can destroy a
  live tenant if the wrong revision is re-run, and whose fingerprint must be
  checked before any apply. It has no *application* caller because it is invoked
  through the `learning-admin-users` edge function. **It is not dead. Do not treat
  it as such.** It is listed only because the mechanical sweep surfaced it, and
  removing it from the list quietly would be exactly the kind of silent omission
  this register exists to prevent.

**Blast radius if left.** Platform-admin observability — cost overview, error
readout, outbox status, operation-secret rotation — is fully implemented in SQL,
granted, and unreachable. The operator work of running this product is being done
by hand against a control plane that exists.

**Recommended.** Triage into *build the UI*, *call it from an operational script*,
and *drop it*. Do the operation-secret trio first: `docs/INTEGRATION-AUDIT.md`
already flagged that the conversation operation secret has a mandatory `expires_at`
with no documented rotation, and chat starts returning `access_denied` on expiry.
The rotation RPCs exist and nothing calls them.

---

<a id="d-10"></a>
## D-10 — Agent revision rows fetch nine fields and show three

**Verified.** Severity Medium. Effort S.

`apps/console/src/components/sections/agent-panel.tsx:1313-1320` renders `version`,
`status` and `updatedAt` per row.

The RPC returns six more —
`infra/supabase/migrations/20260726097000_agent_control_surface.sql:797-806`:
`assistantName`, `welcomeMessage`, `tone`, `model`, `publishedAt`, `createdAt`.
All six are typed in `RevisionSummary` (`agent-panel.tsx:93-103`) and in
`AgentConfigurationRevisionSummary` (`lib/supabase/agent-rpc.ts:120-129`), and none
is displayed.

**Why it is debt.** The user clicks **"Publish this version"** on a row identified
by a number and a timestamp, while the assistant name, tone and model that would
actually identify it arrived in the same response. This is a rollback control
operating on deliberately withheld information — and `docs/PLAN.md` §6.3 makes
draft → preview → publish → rollback a headline capability.

---

<a id="d-11"></a>
## D-11 — The conversation discards brand images that were already signed for it

**Verified discard; deferral claim disputed.** Severity Medium. Effort S.

`apps/console/src/app/app/conversation/conversation-client.tsx:790-791`:

```ts
logoUrl: null,
avatarUrl: null,
```

with a comment claiming an uploaded logo *"is Section 7 (Phase 9), out of scope
here"*.

But the work was already done. `apps/console/src/app/app/page.tsx:237-238`:

```ts
logoUrl: await signedBrandAsset(supabase, brand?.logoStorageKey),
avatarUrl: await signedBrandAsset(supabase, brand?.avatarStorageKey),
```

These land on `payload.agent` (typed at
`components/app-shell/contract.ts:20-21`) and are consumed by
`settings-panel.tsx:392`, `widget-panel.tsx:1297` and `agent-panel.tsx:847`.
`ConversationClient` is mounted from `agent-panel.tsx:676`, where `payload.agent` is
in scope — its prop list (`conversation-client.tsx:649-660`) simply has no slot for
them. The chat always falls back to an initial.

Separately, `/api/learning/workspace` is fetched at `:811` and only
`branding.accentColor` and `branding.iconGlyph` are read; the RPC also returns
`primaryColor`, `surfaceColor`, `textColor`, `welcomeMessage`, `logoStorageKey`,
`avatarStorageKey` (`infra/supabase/migrations/20260725120000_agent_configuration.sql:773-785`).

**Why it is debt.** A signed URL was minted, paid for, and thrown away, under a
comment saying the feature is out of scope. The comment may have been true when
written; it is not true now, and it is the kind of note that stops anyone looking
again.

**Blocked here:** `apps/console/src/app/app/conversation/**` is owned by concurrent
work.

---

<a id="d-12"></a>
## D-12 — Invitation expiry and account status are fetched and dropped

**Verified.** Severity Medium. Effort S.

`apps/console/src/app/app/admin/users/user-access-manager.tsx:241` renders a bare
`<small data-pending="true">Invitation pending</small>`, and account rows (`:224-227`)
show only `mustChangePassword` → *"Password setup required"* / *"Active"*.

The RPC returns more —
`infra/supabase/migrations/20260731054000_admin_people_invitation_visibility.sql:31-37,47-53`:
`sentAt`, `expiresAt`, `createdAt` per invitation; `status`, `createdAt`,
`passwordChangedAt` per account. All six are declared in the client's own
`Account` / `PendingInvitation` types (`:9-23`) and none reaches the DOM.

`expiresAt` is the load-bearing one, given
`infra/supabase/migrations/20260731055000_managed_invitation_expiry.sql`.

Also: `usage.last30Days` is a per-event-name count map, collapsed to a single sum at
`:143`; the breakdown is discarded.

**Blast radius if left.** `docs/INTEGRATION-AUDIT.md` records that invitations have
no delivery hop — a human copies the code out of this UI. That human cannot see
whether the invitation has expired, on the screen whose entire job is to manage it.

---

<a id="d-13"></a>
## D-13 — Budget `enforcement` is fetched and never shown

**Verified.** Severity Medium. Effort S.

`apps/console/src/components/sections/settings-detail-views.tsx:375-405` renders an
"Operating safeguards" block: `dailyBudgetMicro`, `monthlyBudgetMicro`,
`maxCallsPerDay`, `maxCallsPerMinute`, each falling back to the literal
`"Not configured"`.

Two fields are parsed and never rendered —
`lib/settings/tenant-settings-rpc.ts:213-214`, produced by
`tenant_get_billing_summary`
(`infra/supabase/migrations/20260731022153_tenant_privacy_and_usage_settings.sql:656-657`):
`limits.maxSubjectCallsPerMinute` and **`limits.enforcement`**. Neither identifier
appears in any `.tsx` repo-wide.

**Why `enforcement` is the important one.** It says whether the budgets shown
directly above it actually *block* or merely *warn*. A panel showing four budget
numbers while withholding whether they are enforced is showing a number and hiding
its meaning — the precise failure `CLAUDE.md` says this codebase prefers to avoid.

---

<a id="d-14"></a>
## D-14 — Signal detail drops the deep-link ids it fetched

**Verified.** Severity Medium. Effort S.

`apps/console/src/components/sections/insights-panel.tsx:1463-1465`:

```tsx
<a className={styles.v2PrimaryButton} href="/app?panel=course">
  Write this lesson
</a>
```

`selected` is in scope and carries `courseId`, `moduleId` and `lessonId` —
produced by `infra/supabase/migrations/20260726091000_question_intelligence.sql:1675-1677`
and typed at `lib/supabase/question-intelligence-rpc.ts:191-193`. Repo grep confirms
`signal.courseId` and `signal.lessonId` are read nowhere.

The panel already knows how to deep-link — `PanelLink` with `extra={{ id }}` is used
throughout `home-section.tsx` — so the mechanism exists.

**Blast radius if left.** The call to action on the highest-intent surface in the
product ("a learner is stuck here, go write this") drops the operator at the top of
the course panel to find the lesson themselves, using ids that were on screen.

---

<a id="d-15"></a>
## D-15 — Smaller fetch-and-drop sites

**Verified.** Severity Low. Effort M combined.

- **Hosted assistant drops `iconGlyph`.** `apps/console/src/app/c/[slug]/page.tsx:96-122`
  hand-picks branding fields and omits `iconGlyph` (and `voiceEnabled`), though the
  RPC returns it
  (`infra/supabase/migrations/20260731022131_widget_appearance_branding.sql:136`,
  typed at `lib/supabase/widget-rpc.ts:38`). `BrandAvatar`
  (`hosted-assistant.tsx:617-637`) therefore falls back to the generic `<CorsoMark>`
  instead of the tenant's configured glyph when no logo is uploaded. `iconGlyph` is
  consumed nowhere in the delivery path — only in the console's own editor preview.
  MEDIUM confidence that this is unintended: unlike its neighbours, no comment says
  it was deliberate.
- **Hosted publication timestamps.** `components/sections/hosted-publication-controls.tsx:162-164`
  copies `publishedAt`, `unpublishedAt` and `updatedAt` into the client snapshot and
  references them nowhere else; they are validated at `:145-147` and produced by
  `api/widget/hosted-publication/route.ts:113-119`. The UI shows published state with
  no "since when".
- **Course upload rows.** `components/sections/course-panel.tsx:3413-3428` shows
  `filename`, `mediaType`, `declaredSizeBytes`, `createdAt` and a canned
  `UPLOAD_COPY[processingState].detail`, discarding `nextCheckpoint` and `expiresAt`
  (`infra/supabase/migrations/0026_authenticated_quarantine_uploads.sql:315,319`,
  typed at `lib/supabase/authoring-rpc.ts:108,112`). `nextCheckpoint` is the
  server's own name for what the pipeline is waiting on — exactly what the generic
  status copy is standing in for — and `expiresAt` matters because quarantined
  objects expire.
- **Platform exit result.** `components/sections/platform-panel.tsx:1019-1035` parses
  `PlatformTenantExit.restoredPreviousTenant` and `.previousTenantId` and uses
  neither.

---

<a id="d-16"></a>
## D-16 — Readable foreground derived in the console, hardcoded white on both public surfaces

**Verified.** Severity Medium. Effort M.

The console derives it by WCAG contrast:
`apps/console/src/components/app-shell/brand.ts:67-72` (`readableOn()` picks
`#ffffff` or `#101614`), emitted as `--brand-on-primary` / `--brand-on-accent`
(`:86-87`), consumed by `components/ui/button.module.css:76,110`.

Neither public surface does:

- `apps/console/src/app/c/[slug]/hosted-assistant.tsx:218-219` emits
  `--brand-primary` and `--brand-accent` but **no `--brand-on-*`**;
  `c/[slug]/hosted.module.css` hardcodes `color: #ffffff` at `:70,201,233,304`.
- `packages/widget-runtime/src/index.ts:1129` sets only `--widget-primary` and
  hardcodes `color:#fff` on every primary-filled surface — launcher `:2084`, send
  button `:2111`, user message bubble `:2119`.

**Blast radius if left.** A tenant picks a light brand colour. The console stays
readable by choosing near-black text. The widget and hosted page render white on
light and become unreadable — on exactly the surfaces a paying customer's learners
use. `scripts/check-contrast.mjs` gates the token file, not these two stylesheets.

`docs/PLAN.md` §2 lists the contrast math under **Real**, which is true of one of
three surfaces.

---

<a id="d-17"></a>
## D-17 — Half the console suite asserts on source text, never on behaviour

**Verified.** Severity High. Effort L.

Of 36 files in `apps/console/test/`, **18 never import anything from `../src/`**.
They `readFileSync` a source file and match regexes against its text, carrying
**455** `assert.match` / `assert.doesNotMatch` calls between them.

`apps/console/test/circle-install.test.ts:82` asserts `next.config.ts` *contains a
literal path string* — it never loads the config, never resolves the path, never
checks the file exists.

`apps/console/test/widget-appearance-branding.test.ts:63-74`, titled *"console
controls and both public surfaces consume the complete appearance contract"*, does
`assert.ok(runtime.includes(field))` against the whole 2,224-line runtime source.
That passes if the identifier appears in a comment or in dead code — it does not
assert the runtime *applies* the setting. The widget-runtime suite has real DOM
helpers available, so a behavioural version is cheap. The same test claims "both
public surfaces" while checking the hosted one for 2 of 5 fields (`:76-77`).

**The counter-argument, which is real.** Several of these files test *copy* — that
the install page names a hard gate, that a panel does not promise a capability that
does not exist. Asserting on text is legitimate there, and this project's
honesty-of-surfaces discipline depends on it. The problem is the files asserting on
*wiring*, which is executable and could be executed.

**Genuinely behavioural, for contrast:** `packages/provider-router/tests/*`,
`packages/widget-runtime/tests/widget-runtime.test.mjs` (real DOM), and console-side
`ingestion-*`, `rich-text-round-trip`, `billing-webhook`, `error-reporter`,
`visual-media-security`.

**Blast radius if left.** "297 tests, 0 failures" overstates behavioural coverage,
and the suite is hostile to refactoring — which is how suites get deleted.

---

<a id="d-18"></a>
## D-18 — Vacuous assertions that pass when the code they guard is deleted

**Verified. Three fixed on 2026-07-31; the class remains.** Severity High. Effort S.

An unguarded `indexOf` returns `-1`, and both `-1 < realIndex` and
`slice(-1, smaller)` yield a passing assertion. Three were found and **fixed**:

| Site | Failure mode | Fix |
|---|---|---|
| `apps/console/test/platform-access-invitation-contract.test.ts:42` | Asserted an ordering around `platform_admin_is_authorized`; **passed if that check were deleted outright** | Both indices guarded `> -1`, with messages |
| `apps/console/test/insights-export-contract.test.ts:17` | End marker `const toolbar` **no longer exists** in the panel, so the slice silently ran to end-of-file instead of to the end of the memo | Re-bounded on `const exportAvailable`, both indices guarded |
| `apps/console/test/insights-v2-parity-contract.test.ts:35` | Unguarded bounds; a rename would make the fixture-data ban pass vacuously | Both indices guarded |

The middle one is the instructive case: it had **already** lost its bound and was no
longer testing the region it named, without ever failing.

**Worth crediting:** most ordering tests here guard correctly —
`semantic-learning-contract.test.ts:73-75`, `streaming-respond-contract.test.ts:100-101`,
`managed-access-realtime-contract.test.ts:67-69`, `widget-visual-answers.test.ts:92-93`,
and `platform-access-invitation-contract.test.ts:63` itself, twenty lines below the one
that did not.

**Still open:** `apps/console/test/console-interaction-audit.test.ts:32` bans
`disabled={true}`, a form occurring **nowhere** in `apps/console/src`. It has never
had anything to catch, and permits both bare `disabled` and `disabled={SOME_CONST}`.

**Recommended.** A shared `indexOfOrFail` helper, so the next region assertion
cannot lose a bound silently.

---

<a id="d-19"></a>
## D-19 — A test that fails the moment its bug is fixed

**Verified.** Severity Medium. Effort S.

`apps/console/test/answer-feedback-readout.test.ts:106-118` asserts that **no** SSE
`done` event carries a `messageId`, with a message explaining that if one ever does,
"this test should be replaced". It asserts a feature does *not* exist, so closing the
gap turns the suite red. Its preamble at `:90-100` is candid about that — more honest
than most codebases manage — but the effect is a ratchet, and the codebase already
ships the workaround (`reconcilePersistedMessageId`), so the negative test now guards
a workaround rather than a contract.

Same file `:141` pins the **exact source spelling** of a placeholder
(``/`assistant-\$\{crypto\.randomUUID\(\)\}`/``). Extracting it to a named constant —
a pure refactor — breaks the build. The invariant its own comment at `:140` describes
is *"a minted placeholder is not a persisted id"*, which is directly testable.

**Related, lower severity:** `talk-practice-contract.test.ts:21-24` bans two specific
demo question strings by name; any *other* hard-coded question passes. It should
assert the questions originate from the API payload. `:27-30` pins a TypeScript type
annotation including whitespace. `tenant-settings-data-contract.test.ts:117` pins an
exact English sentence — its sibling `doesNotMatch` on `>Purge<` at `:118` is a
genuine product invariant and should stay; the prose match should go.

---

<a id="d-20"></a>
## D-20 — Dead exports and unrendered components

**Verified.** Severity Medium. Effort M.

Beyond `ActivitySection` / `PlatformHome` (D-04):

**A dead cluster in `provider-runtime.ts`** — `:299` `conversationOperationToken`,
`:304` `OperationSecretHealth`, `:321` `readOperationSecretHealth`, `:358`
`operationSecretError`. Not indirection: all four real callers read the env var
**inline** instead — `api/widget/ask/route.ts:287`, `c/[slug]/page.tsx:137`,
`api/learning/respond/route.ts:889`, `c/[slug]/ask/route.ts:37`. The SQL side
(`learning_operation_capability_health`) exists and is covered by
`infra/supabase/tests/operational_safety_verification.sql`; only the TypeScript
wrapper is orphaned.

**Voice runtime**, zero consumers repo-wide: `lib/voice-runtime.ts:113`
`enforceVoiceQuota`, `:168` `meterVoiceUsage`, `:200` `voiceTraceId`. The file is
alive — the voice routes import *other* symbols from it. Given D-07, a dead
`meterVoiceUsage` on the most expensive SKU deserves checking against rows rather
than assumption.

**Other single-hit exports:** `lib/supabase/agent-rpc.ts:216` `agentExpectedVersion`;
`lib/supabase/authoring-rpc.ts:584` `authoringOperationKey`;
`lib/supabase/widget-rpc.ts:15` `widgetUnavailableCode`; `lib/cost-metering.ts:29`
`MICRO_UNITS_PER_MAJOR_UNIT`; `lib/supabase/analytics-rpc.ts:13` `AnalyticsMetricState`;
`components/sections/learning-format.ts:4` `blockText`;
`lib/question-classification.ts:267` `classifyLearnerQuestion` (deprecated in its own
docstring; both real callers already use `classifyLearnerQuestionOutcome`).

**Barrel-only** (re-exported, never imported): `components/ui/contrast.ts:17`
`isHexColor`; `rich-text/rich-text.tsx:109` `renderRichTextDocument`;
`rich-text/markdown.ts:644` `richTextToPlainText`; `rich-text/commands.ts:175`
`LINK_PLACEHOLDER_URL`; plus ~29 prop/variant types re-exported by
`components/ui/index.ts`.

**Deliberately excluded from the delete recommendation:** those ~29 prop types, and
the service-interface types in `packages/contracts/src/` (`StorageProvider`,
`EmailProvider`, `QueueProvider`, …). They are factually unreferenced, but exporting
prop types beside components is a normal UI-kit convention, and declaring interfaces
is what `packages/contracts` is *for*. The genuinely dead weight there is the handful
of runtime *functions*: `context.ts:80` `isSameTenant`, `:88` `remainingDeadlineMs`,
`events.ts:170` `isEventType`, `platform-roles.ts:57,61` `isPlatformRole` /
`isPlatformPermission`, and `provider-router/src/types.ts:163` `RecordedAttempt`.

**Checked and NOT dead**, recorded so nobody re-litigates: every React component
under `components/**` other than the two in D-04 is rendered; `apps/console/src/proxy.ts`
is the Next.js 16 middleware convention, not an orphan; and
`widgetRecordVisualDisclosure` — offered as a calibration example of a zero-call-site
function — **is alive**: imported at `api/widget/ask/route.ts:19`, called at `:330`
inside a live branch, asserted by `widget-visual-answers.test.ts:90-91`.

---

<a id="d-21"></a>
## D-21 — Four brand-colour validators with four accept-sets

**Verified divergence; current impact low.** Severity Medium. Effort M.

| Implementation | file:line | Accepts |
|---|---|---|
| Console shell | `components/app-shell/brand.ts:13` | 3 or 6 hex, expands 3→6 |
| Console contrast UI | `components/ui/contrast.ts:15` | 3 or 6 hex, **`#` optional** |
| Hosted assistant | `app/c/[slug]/hosted-assistant.tsx:87` | **6 only** |
| Widget runtime | `packages/widget-runtime/src/index.ts:346` | **3–8 hex plus `rgb()`/`hsl()`** |

**Honest scoping.** The write path enforces the strictest form —
`api/agent/route.ts:79-83` requires `/^#[0-9A-Fa-f]{6}$/` at exactly 7 characters — so
divergent values cannot be stored through the API. The divergence is **latent, not
firing**. Recorded because four validators for one concept is how the *next* one fires.

**Related (MEDIUM):** two `relativeLuminance` implementations use different thresholds
— `brand.ts:47` uses `0.03928` (WCAG 2.0), `contrast.ts:37` uses `0.04045` (the sRGB
spec value). Numerically negligible; behaviourally not. On unparseable input
`contrast.ts` returns `undefined` (*"rather than a made-up number"*) while
`brand.ts:36` substitutes a fallback — so `ColorField` can report "cannot compute
contrast" for a value the shell is simultaneously computing a confident foreground for.

---

<a id="d-22"></a>
## D-22 — A hand-maintained duplicate prompt builder

**Verified.** Severity Medium. Effort M.

`apps/console/src/app/api/learning/respond/route.ts:309-415` is a **byte-identical**
fork of the prompt builder in `apps/console/src/lib/learning-provider.ts:131-262`:
`streamToneDirections` ≡ `toneDirections`, `streamTenantPersonaLines` ≡
`tenantPersonaLines`, `streamSourceContext` ≡ `sourceContext`,
`streamConversationMessages` ≡ `conversationMessages` (same `slice(-8)`, same
`slice(0, 2_000)`), system-prompt array matching line for line.

The duplication is self-declared at `:297-304` — *"kept in sync by hand rather than
sharing a module"* — with a stated reason.

**They have not drifted** — with exactly one exception, and it is D-01. That is the
point: the arrangement held for the prompt text and failed for the values a tenant
can configure.

**Recommended.** Merge them, or add a test asserting the regions are identical so the
next divergence fails the build instead of shipping.

**Also noted:** `app/c/[slug]/ask/route.ts:15-26` hand-rolls `unavailable()` instead of
importing the shared `widgetRefusal()`, returning 404 where the widget path returns
`widgetRefusal(400)` for a malformed body (`api/widget/ask/route.ts:184`). CORS itself
*is* properly centralised in `api/widget/cors.ts`.

---

<a id="d-23"></a>
## D-23 — RPC wrappers bypassed by inline `.rpc()` calls

**Verified.** Severity Low. Effort S.

- `lib/supabase/platform-rpc.ts:808` `getTenantSections` wraps `tenant_get_sections`;
  `app/app/page.tsx:75` calls `supabase.rpc("tenant_get_sections")` inline.
- `lib/supabase/widget-rpc.ts:474` `updateWidgetSettings` wraps
  `tenant_update_widget_settings`; `api/widget/settings/route.ts:400` issues the RPC
  inline with its own argument object.

Every other wrapper in `lib/supabase/*-rpc.ts`, `lib/billing/billing-rpc.ts`,
`lib/settings/tenant-settings-rpc.ts` and `app/c/[slug]/hosted-rpc.ts` has a real caller.

**Why it is debt.** The wrapper is where argument names and result shape are typed
once. Two call sites now hand-spell the argument object, so a rename in SQL breaks
them at runtime rather than at `tsc`.

---

<a id="d-24"></a>
## D-24 — `noUnusedLocals` is off, which is why the rest of this register exists

**Verified.** Severity High. Effort M.

`tsconfig.base.json` is otherwise strict — `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
`useUnknownInCatchVariables`. It does **not** set `noUnusedLocals` or
`noUnusedParameters`.

Running `tsc --noEmit --noUnusedLocals --noUnusedParameters` against
`apps/console/tsconfig.json` surfaces D-01's four dead helpers and D-04's two
unrendered components **directly**, as compiler errors.

**Why this is the highest-leverage entry.** Most of this register is one bug —
something is fetched, assigned, and never read. That is exactly what
`noUnusedLocals` detects, and the compiler has been able to detect it all along. The
project gates every commit on `pnpm check`; this flag would have made most of these
findings impossible to merge.

**Blast radius if left.** The register regrows. Every future "fetched and dropped"
bug ships green.

**Recommended, in this order.** (1) Turn the flag on locally and get the true error
count. (2) Fix or explicitly `void` the findings. (3) Enable it in
`tsconfig.base.json`.

**Not enabled here, deliberately.** Turning it on now would fail `pnpm check` —
which must exit 0 — until every finding in this register is resolved. It is the
right last step of the cleanup, not the first.

---

<a id="d-25"></a>
## D-25 — `packages/identity-access` has zero consumers

**Verified.** Severity Medium. Effort S.

421 lines (`index.ts` 2, `oidc.ts` 376, `types.ts` 43). No file anywhere imports
`@course-ai/identity-access`; it is not even a declared dependency of `apps/console`.
Only its own `test/` consumes it. It is nevertheless built and typechecked on every
`pnpm check`, because `pnpm-workspace.yaml` globs `packages/*`.

It is the last survivor of the `docs/INTEGRATION-AUDIT.md` P2 "delete, don't wire"
table — the other nine are gone. That table's verdict was **"keep on ice"**, because
`oidc.ts` is real `jose`-backed verification and the only asset worth anything when an
enterprise deal demands SSO.

**Recommended.** Do not delete on this evidence alone. Either keep it deliberately and
say so in the package README in one sentence, or retire it. It is a product call.

---

<a id="d-26"></a>
## D-26 — `lib/deployment-mode.ts` is dead but cited as shipped evidence

**Verified.** Severity Medium. Effort S.

`apps/console/src/lib/deployment-mode.ts` (35 lines) exports `fixturePreviewEnabled`,
`developmentFixturesAllowed` and `fixturePreviewEnvironment`. Its **only** consumer is
its own test, `apps/console/test/deployment-mode.test.ts:6-7`. It guarded fixture APIs
under `/api/dev/*`, deleted on 2026-07-26. `docs/INTEGRATION-AUDIT.md:71` already
recorded that it has no importers.

**It cannot simply be deleted.** `docs/course-ai-platform/20-IMPLEMENTATION-EVIDENCE.md`
cites `deployment-mode.test.ts` as the evidence for the "Private fixture preview" row
(*"Production builds deny fixture APIs by default"*). Removing the module means
correcting that citation honestly in the same change — the rule that governed R-01.

**Blast radius if left.** Nobody is harmed today. The risk is inverted: someone
reintroduces a fixture route, assumes this still gates it, and does not wire it.

---

<a id="d-27"></a>
## D-27 — Recursive `test` scripts rebuild packages during a parallel run

**Verified mechanism; precise victim unverified.** Severity Medium. Effort S.

Root `"test": "pnpm -r --if-present test"` runs members concurrently. Three of four
packages prefix a build onto their test script — `identity-access`, `provider-router`,
`widget-runtime` — and `packages/widget-runtime/scripts/build.mjs:10` opens with
`rmSync(dist, { recursive: true, force: true })`. `apps/console` does not declare
`@course-ai/widget-runtime` as a dependency, so pnpm has no ordering edge and runs them
in parallel. This is the known flake recorded in `CLAUDE.md`.

**Explicitly unverified:** which reader races the `rm`. The console tests that mention
widget-runtime read `packages/widget-runtime/src/index.ts` (source), not `dist/` —
`widget-appearance-branding.test.ts:29`, `widget-visual-answers.test.ts:39`.
`app/widget.js/route.ts:31-33` and `next.config.ts:16` do read `dist/`, but only the
route at runtime. **Do not assume the above is the whole story.** It establishes that a
destructive build runs concurrently with tests, which is enough to be worth fixing; it
does not establish the failing read.

**Recommended.** Drop `pnpm build &&` from the `test` scripts — `pnpm check` already
runs `build:packages` first. It changes what `pnpm --filter <pkg> test` does standalone,
so it needs the owner's agreement rather than a drive-by edit.

---

<a id="d-28"></a>
## D-28 — Error reporting exists and is wired to one call site

**Verified.** Severity Medium. Effort M.

`apps/console/src/lib/observability/error-reporter.ts` is a complete, careful reporter
into `public.error_events` — swallows its own failures, authenticates with an operation
secret, refuses browser writes. Its only caller is
`apps/console/src/app/api/ingestion/shared.ts:52`.

`docs/PLAN.md` §2 still lists under **Absent**: *"Error tracking, monitoring, alerting.
No Sentry, no OpenTelemetry, nothing. Production failures surface only when a person
notices — which is exactly how the 2026-07-27 outage of the agent, insights and billing
panels was found."* The machinery now exists and covers ingestion only; the three panels
named as the motivating outage are still uninstrumented.

Note the interaction with D-09: `platform_admin_error_readout` and
`observability_claim_error_digest` — the read side of `error_events` — have no callers
either. So errors from one route are written and nothing displays them.

---

<a id="d-29"></a>
## D-29 — Silent coverage carve-outs in the interaction audit

**Verified.** Severity Medium. Effort S.

`apps/console/test/console-interaction-audit.test.ts:9-12` exempts
`source-connectors.tsx` and `visual-knowledge-manager.tsx` from the whole audit with
**no comment explaining why**. Both were checked against every banned pattern and
neither contains any — so the exclusions appear unnecessary and function as a silent
`.skip`.

Separately, the audit walks only `components/sections/` and `components/app-shell/`
while being titled for "authenticated console controls".
`app/app/conversation/conversation-client.tsx` — 2,921 lines, the primary authenticated
surface — is never audited.

**Clean on the usual axis, worth recording:** there is **no** `.skip`, `.todo`, `.only`,
`xit` or `xdescribe` anywhere in `apps/console/test` or `packages/*/tests`, and **no**
`TODO` / `FIXME` / `HACK` marker anywhere under `apps/console/src`, `packages/*/src` or
`infra/supabase/functions`.

---

<a id="d-30"></a>
## D-30 — README-only workspace members and orphaned public assets

**Verified.** Severity Low. Effort S.

`apps/edge/` and `services/learning/` contain a single `README.md` each and no
`package.json`, and both are matched by `pnpm-workspace.yaml`. Both READMEs are written
in the imperative present — `apps/edge` describes a "Cloudflare Worker boundary" for
session tokens, conversation orchestration, streaming and webhooks; `services/learning`
describes "queue-driven, idempotent workflows" for ingestion, transcription, chunking and
embeddings. Most of that was built, elsewhere: Supabase edge functions
(`infra/supabase/functions/`) and console routes (`api/ingestion/*`).
`docs/INTEGRATION-AUDIT.md` already flagged `apps/edge/` as "a README"; the observation
was made and never acted on.

`apps/console/public/widget/northstar-mark.svg` and `momentum-loop.svg` have zero
references across `apps/console/src`, `apps/console/test`, `packages/*/src`, `docs/`,
`infra/` and the root markdown. They arrived in commit `f35a32a` and are now the only
contents of `apps/console/public/`. Registered rather than deleted only because a public
URL can be referenced from outside the repository, which cannot be checked from here.

**Recommended.** Delete, or reduce each README to a signpost — *"implemented as X, see
Y"* — which costs two sentences and repays every new reader.

---

<a id="r-01"></a>
## R-01 — Orphaned `public/integrations/` generation — **resolved 2026-07-31**

Recorded because the *shape* is worth recognising again.

`apps/console/public/integrations/circle-learningbot.js` (277 lines) and
`widget-runtime.js` (1,270 lines — a frozen copy of `packages/widget-runtime`) were
referenced by nothing executable. The only mentions anywhere were their own docstrings,
one *negative* test assertion (`apps/console/test/circle-install.test.ts:16`) and four
documentation lines.

They were a live trap rather than dead weight:

- still publicly served from `apps/console/public/`;
- their paste-ready docstring instructed `data-widget-key`, while the shipped runtime
  auto-mounts from `data-tenant` (`packages/widget-runtime/src/index.ts:2062`) — so
  anyone following them got a silent no-op;
- the bundled runtime copy had drifted far from its source.

**What was done.** Both deleted. All four citations corrected in the same change rather
than removed:

| Citation | Correction |
|---|---|
| `README.md:57` | Now describes the `/widget.js` delivery route and the `data-tenant` snippet, and records the deletion. |
| `docs/PLAN.md:642` | Phase 7 prose annotated: the phase landed, the replaced artifact was left behind, and the "38 lines that append a link" description was itself stale by the time it was removed. |
| `docs/INTEGRATION-AUDIT.md:39` | Row marked superseded inline; a full dated errata added at the head of that document. |
| `docs/course-ai-platform/20-IMPLEMENTATION-EVIDENCE.md:108` | Evidence re-pointed at `/install/circle`, `widget.js/route.ts`, `embed-prelude.ts` and `circle-install.test.ts`, with an explicit note that the originally cited artifact was removed and why. The claim was **not** deleted — it was re-evidenced. |

**The lesson worth keeping.** A negative assertion
(`assert.doesNotMatch(pageSource, /integrations\/circle-learningbot\.js/)`) was in place
the whole time and stayed green, because it only ever read the install page. It could
not see the files it was named after. See D-18.

---

## Method and limits

Categories swept: dead code and unreferenced exports; surfaces that fetch data and
discard it; tests that pin a defect rather than a contract; logic duplicated and drifted
across console / widget runtime / hosted assistant; missing route segment configuration.

**Known limits, stated so nobody over-trusts this:**

1. **Concurrent edits.** Several files changed during the audit. Findings were
   re-verified on a final pass, but re-grep before acting.
2. **Dynamic references.** Identifiers reached through string keys,
   `panel-registry.ts`-style lookup tables, or `supabase.rpc("name")` dispatch are
   invisible to identifier grep. RPC wrappers and D-09 were cross-checked against SQL
   function names for this reason; other categories were not.
3. **Helpers nested inside functions or components were not scanned** — only column-0
   declarations. There is likely more dead code one indent level in.
4. **No unreachable-code claims are made.** `if (true)`, `if (false)`, `&& false`,
   `|| true` return zero matches; genuine flow-sensitive unreachability needs
   type-checker output, not grep, and is better reported as nothing than as a guess.
5. **The Vercel timeout ceiling is not in version control** and was not assumed — D-08.
6. **D-09 lists what has no caller, not what is unnecessary.** `admin_provision_auth_user`
   appears there and is emphatically live.

**Verified clean — no discard found**, recorded so these are not re-audited:
`/api/analytics/answer-feedback` → the "Rated helpful" card (fully consumed, three states
correctly separated — this is the already-fixed calibration case);
`learning_lesson_reception` → `lesson-workspace.tsx`; `/api/analytics/learner-signals` →
`V2StudentsView`; `home-section.tsx` question-intelligence `labels` **and** `signals`
(the earlier fix holds); `source-connectors.tsx`. No route handler in this repo does a
raw `.from(table).select(...)` — every read goes through an RPC.

**Two candidate findings were dropped after checking**, recorded because the near-misses
are the point:

- `.env.example` appeared to omit ten environment variables the code reads. Every one is
  in fact documented there, in prose rather than as a bare `NAME=` line. The first grep
  produced a clean, plausible, entirely wrong finding.
- `widgetRecordVisualDisclosure` was supplied as a confirmed zero-call-site function. It
  has a live call site (`api/widget/ask/route.ts:330`) and a test. Reported here rather
  than quietly dropped, because an audit that inherits its premises is not an audit.

Still true and re-verified, so nobody assumes otherwise: **edge functions have no deploy
configuration anywhere** — no `supabase functions deploy` in
`infra/supabase/scripts/hosted-release.mjs`, no step in `.github/workflows/ci.yml`. The
eight functions in `infra/supabase/functions/` are pushed by hand, as `CLAUDE.md` states.
D-07 depends on that fact.

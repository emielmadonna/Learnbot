# LearningBot — Build Plan

**Status: this is the single source of truth.** Where this document and anything in
`docs/course-ai-platform/` disagree, this document wins. That directory described a
platform nobody asked for and is the reason ~23,000 lines of unused code got written;
it is reference material now, not a specification. Do not implement from it.

Every claim about current state below was verified against the code on 2026-07-26, with
the file and line named. If you change what ships, change this file in the same commit.

---

## 1. What the product is

Three surfaces. Nothing else is the product.

| Surface | Who | What it does |
|---|---|---|
| **Assistant** | Student, inside a Circle course | Asks questions, gets answers grounded in that course — text, voice, formatting, and figures pulled from the material |
| **Studio** | Course creator (the buyer) | Manages their agent, brand, and course knowledge; reads signals about their students |
| **Control** | Platform admin (you) | Adds creators, flips per-tenant feature flags, sees everything across all tenants |

The business model is in the flags: a creator who doesn't pay for analytics has analytics
switched off, and the platform admin still sees their data.

---

## 2. Verified current state

### Real — works end to end, no fixture

- **Auth, tenancy, RBAC.** Roles read from the database, never from a JWT.
  `learningbot_custom_access_token_hook` deliberately strips `tenant_id` and `app_role`
  from access tokens. Every mutation goes through a `SECURITY DEFINER` RPC over forced
  RLS. This is the strongest part of the system — do not rebuild it.
- **Rich text in chat.** `components/ui/rich-text/markdown.ts` — 670 lines, sanitizing
  parser, tag allowlist, link-safety policy, and a deliberate rule that a learner's own
  words are never re-interpreted as formatting. Bold, headings, lists, code, quotes all
  render today. **No work needed.**
- **Course authoring + publishing.** Typed content projects into `knowledge_versions` /
  `learning_documents` / `learning_chunks` and becomes retrievable.
- **Grounded answers.** Refuses rather than inventing when retrieval returns nothing.
- **Signal capture.** Every turn writes `question_labels` and `question_signals`.
- **Per-tenant flags.** `platform_admin_*` over `public.tenant_sections`.
- **Brand contrast math.** `components/app-shell/brand.ts` — `relativeLuminance`,
  `contrastRatio`, `readableOn`. Correct, tested, and only imported by `agent-panel.tsx`.

### Hollow — the slot exists, nothing fills it

- **Figures and attachments in chat.** `conversation-client.tsx:1966` renders a `diagram`
  part as a `◇` character and a caption; attachments as `↥` and a label. No image, no
  chart, no SVG. `public.attachments` has zero writers and nothing produces a diagram.
- **Per-client chat branding.** The contrast math above is never called by the chat.
  The conversation surface ignores `tenant_branding` entirely.
- **Signals readout — per learner.** *(Corrected 2026-07-26: an earlier revision of this
  document claimed signals were "read by nothing." That was wrong.
  `api/analytics/question-intelligence/route.ts` and `insights-panel.tsx` already read
  them at the **cohort** level — topics, intents, important questions, and threshold
  signals like `topic_spike` / `post_lesson_stall` / `repeated_question_cluster`.)* What
  was missing is the **per-learner** view the product actually sells: who is escalating,
  who is stuck, who is ready for the next offer.
- **Voice rate limiting.** An in-process `Map` — meaningless on serverless.
- **Audit ledger.** Written by some paths, not by conversations, voice, uploads,
  onboarding, or provisioning. No reader UI.

### Absent — no code path at all

- **Upload processing.** Files land in `tenant-private/{tenant}/quarantine/` and stop
  there permanently. `upload_intents.status` never leaves `'quarantined'`.
  **Everything visual in chat is downstream of this.**
- **Knowledge cleaning.** Section 4. Does not exist in any form.
- **Privacy, export, deletion, retention.** Zero tables, zero routes. An operator runs
  SQL by hand.
- **Invitation delivery.** No mailer. A human copies the code out of the UI.
- **`telemetry_outbox` drain.** Writers, no readers, unbounded growth.

### The one thing that can destroy a live tenant

`infra/supabase/SCHEMA-DRIFT.md` — re-running committed migrations against the live
project *downgrades* `admin_provision_auth_user`. Read it before touching migrations.

---

## 3. Design system — Graphite

### 3.1 Tokens

Dark is the default ground. Light is the same token names, different values — never a
separate stylesheet.

```css
/* dark (default) */
--bg: #1c1c1e;  --surface: #2c2c2e;  --elev: #3a3a3c;
--ink: #ffffff;           /* 11.35:1 worst case */
--muted: #aeaeb2;         /*  5.13:1 worst case */
--hairline: #6c6c70;      /* NON-TEXT ONLY */
--good: #30d158;          /*  5.61:1 */
--warn: #ff8a80;          /*  4.97:1 */

/* light */
--bg: #f2f2f7;  --surface: #ffffff;  --elev: #f2f2f7;
--ink: #000000;           /* 18.82:1 */
--muted: #4a4a4f;         /*  7.90:1 */
--hairline: rgba(60,60,67,.38);   /* NON-TEXT ONLY */
--good: #1d7a33;  --warn: #c02617;
```

### 3.2 The two-gray rule

**If a user has to read it, it is `--ink` or `--muted`. There is no third text gray.**

This is not a preference. On a three-layer dark stack, a third gray that clears 4.5:1 on
`#3a3a3c` lands at `#a6a6ac` — optically identical to `--muted` at `#aeaeb2`. You get a
gray that fails contrast or a gray that fails to be distinct; there is no value that does
both. `--hairline` therefore names a *non-text* role: separators, disabled icon strokes,
decoration. The previous design used it for chart labels, figure captions and input
placeholders, which measured **2.01:1** on light ground.

### 3.3 Per-client branding is four values

`--accent`, `--accent-wash`, the mark, the assistant's name. Nothing else. Verified
accent pairs, both grounds:

| Client | Dark | Light |
|---|---|---|
| Estie Starr | `#ff9f0a` (5.52:1) | `#a85400` (4.78:1) |
| Nomad | `#64d2ff` (6.60:1) | `#0a6f9c` (5.00:1) |
| Rooted | `#d08cf7` (4.74:1) | `#8231ad` (6.29:1) |

A creator picking their own color goes through `readableOn()` from `brand.ts`, which
already exists. **A brand color that fails contrast gets corrected, not rejected** — the
creator should never see an error about hex values.

### 3.4 Responsive — container queries, not viewport

The assistant is embedded in someone else's page. Its width is set by the Circle column
it lands in, **not by the viewport**, so viewport media queries are the wrong tool and
will produce a desktop layout inside a 380px sidebar.

Every assistant component sizes off `@container`. Three named widths:

| Name | Width | Layout |
|---|---|---|
| `compact` | < 420px | Single column, sources collapse to a count, figures scroll horizontally |
| `regular` | 420–720px | Single column, sources inline, figures full-bleed |
| `wide` | > 720px | Answer + source rail side by side |

Type scales fluidly with `clamp()` against the container, not the viewport. Every figure
sits in its own `overflow-x: auto` container so the host page never scrolls sideways.

### 3.5 Motion

One curve: `cubic-bezier(0.32, 0.72, 0, 1)`. One sequence — question, thinking, answer
rises, figures draw, sources last. Everything behind `prefers-reduced-motion`, and
reduced motion means *final state immediately*, never a missing element.

---

## 4. The knowledge pipeline

This is the largest piece of missing work and everything else depends on it. A transcript
dumped into a vector store produces an assistant that quotes filler words back at
students, so **cleaning is not a nice-to-have; it is what makes retrieval worth doing.**

Six stages. Each is resumable and each writes provenance, because a citation must survive
every transformation — a student clicking `[2]` has to land on a real page of a real file.

**1 · Intake.** File lands in quarantine (this exists). Record type, size, checksum.

**2 · Extract.** Per source type — PDF text + embedded figures, DOCX, audio/video via
transcription, HTML. Output is raw text plus an asset list, each with a source location
(page, timestamp, heading).

**3 · Clean.** The module you asked for. Ordered, each step logged so a creator can see
what was removed:

- **Disfluencies** — `um`, `uh`, `like`, `you know`, `I mean` as filler. Never inside a
  quotation, never when the word is load-bearing ("I mean it").
- **False starts and stutters** — "the the", "we we should", abandoned clauses.
- **Transcription furniture** — timestamps, `[inaudible]`, `[crosstalk]`, speaker labels,
  auto-caption line breaks mid-sentence.
- **Boilerplate** — intros, outros, "smash that subscribe", housekeeping, promo reads.
  Detected by repetition across a creator's own library, not by a hardcoded list.
- **Sentence repair** — restore punctuation and casing Whisper drops.
- **Structure recovery** — infer headings and sections so chunks break on meaning rather
  than every 800 characters.

Cleaning is **non-destructive**. The raw text is retained; cleaning writes a new revision
with a diff. A creator can always see the original.

**4 · Review.** The creator sees the cleaned result beside the original, with removals
highlighted, and approves or edits. Nothing reaches students unreviewed. This is also the
honest answer to "how do we know the AI didn't mangle my course."

**5 · Publish.** Approved revision projects into `knowledge_versions` /
`learning_documents` / `learning_chunks` — the path authored content already uses. Reuse
it; do not build a second one.

**6 · Serve.** Chunks retrieve with their provenance. Extracted figures become real
`diagram` / `attachment` parts with a stored asset behind them, which is what finally
makes the renderer at `conversation-client.tsx:1966` draw something real.

---

## 5. Streaming

**The streaming engine already exists and is deliberately discarded.**

`packages/provider-router/src/openai-responses.ts` implements `streamChat()` — an async
generator over OpenAI's SSE transport with abort-signal linking, per-event size limits,
and malformed-event handling. It is real, and `provider-router` is one of only two
workspace packages the console actually imports.

Then `complete()` (line ~1100) does this:

```ts
for await (const event of this.streamChat(context, input)) {
  if (event.value.type === "text.delta") { text += event.value.text; }
}
```

It accumulates every delta into a string, and `respond/route.ts` returns
`NextResponse.json`. Tokens stream from OpenAI to the server and are then flattened into
a single blob. **No streaming needs to be built. The buffering needs to be removed.**

What the work actually is:

1. **Transport.** Return a `ReadableStream` from `respond/route.ts` instead of JSON.
   SSE, not WebSockets — it is one-directional and survives serverless.
2. **Persist after, not before.** The route currently persists the assistant message,
   records question classification and enforces the operation token *before* replying.
   With streaming, the answer must reach the browser first and persist on completion.
   `after()` is already imported on line 1 of the route — the mechanism is in place.
3. **Stream the citations too.** Sources resolve before generation. Send them as the
   first SSE event so the source chips render while text is still arriving, rather than
   appearing after.
4. **Don't break voice.** Every voice turn routes back through `/api/learning/respond`
   so the realtime model reads a grounded, persisted answer. The voice path needs the
   completed text, not the stream — keep a non-streaming mode rather than forcing every
   caller through SSE.
5. **Cancellation.** `streamChat` already links an `AbortSignal`. A student who closes
   the tab mid-answer should abort the provider call — that is live spend, metered into
   `cost_ledger`.

Failure mid-stream is the case to get right: a stream that dies after three sentences
must not persist a truncated answer as if it were complete.

---

## 6. Agent controls

The creator's agent is the product they think they bought. Today they get name, brand,
persona, tone and scope via `tenant_update_agent_configuration`. That is not enough
control, and it is the wrong shape — everything is a free-text field with no preview and
no way back.

### 6.1 What a creator controls

**Generation** — the exact model, temperature, top-p, max output tokens. Defaults must be
good enough that a creator never touches these.

Model selection is two-layered, because the model determines the cost and therefore the
margin (Section 10):

- **You** set which model identifiers exist and which are available to a given tenant.
  This is an exact model string, not a fixed enum baked into a migration — a new provider
  model must be usable the day it ships without a schema change.
- **The creator** picks from what their plan allows. A creator on a cheap plan cannot
  select an expensive model, because that would sell your margin away.

The price book in `src/lib/cost-metering.ts` must know a model before it can be offered.
An unpriced model is a model you cannot bill for correctly — that file already prices an
unrecognised model high on purpose, so spend is overstated rather than hidden. Keep that
behaviour and refuse to *offer* a model that has no price entry.

**Voice** — which voice, speaking rate, barge-in on/off, and whether voice is offered at
all. Voice selection is per tenant and belongs beside the text settings, not in a
separate surface.

**Instructions** — the persona, tone and scope fields, plus a longer free-form
instruction block.

**Grounding behaviour** — how many chunks to retrieve, the similarity floor, and what
happens when retrieval comes back empty. Today the assistant refuses, which is correct;
the *wording* of that refusal should be the creator's, and the *decision* to refuse
should not be.

**Escalation** — when to stop answering and hand off to a human, and what that looks like
to the student.

**Greeting and empty state** — the first thing a student sees.

### 6.2 What a creator must not control

The platform's base instruction — grounding rules, citation requirements, refusal
policy, safety — is **not editable and not visible as an editable field.** The creator's
instructions are layered on top of it, never in place of it. A creator who can overwrite
the base prompt can turn off grounding, and a grounded assistant that can be told to stop
being grounded was never grounded.

This also means creator instruction text is untrusted input to the model. It gets the
same treatment as any other untrusted content.

### 6.3 Versioning, preview, rollback

**A bad system prompt breaks every student conversation at once.** So agent configuration
is versioned exactly like course content already is:

- Edit against a draft, never live.
- Preview runs a real turn against the draft config in an isolated session.
- Publish promotes the draft; the previous version stays.
- One-click rollback, same as `learning_rollback_course`.

Every change writes to `audit_ledger` with who and when. Course content already has
revisions and rollback — reuse that pattern rather than inventing a second one.

---

## 7. Identity — avatars, marks, icons

The assistant should look like the creator's, not like ours.

**Assistant avatar.** Upload an image, or fall back to a generated mark from initials —
`brandInitial()` in `brand.ts` already does the fallback. Storage goes through the
existing signed-URL path at `api/agent/asset` on the `tenant-private` bucket under
storage RLS. Do not build a second upload path.

Constraints, enforced at upload and stated plainly in the UI: square, minimum 256px,
PNG/SVG/WebP, size cap, transparent background allowed. The avatar sits on `--surface`
in both grounds, so a dark logo on a dark ground needs the same `readableOn()` treatment
the accent gets — auto-plate it rather than reject it.

**Icon set.** Per-client icon selection for the composer controls and source chips.
Ships with one set; a client can supply their own. Not free-form SVG upload — that is a
script-injection surface. A curated set plus an uploaded avatar covers the real need.

### 7.1 Generated character avatars

The assistant gets a face: the creator supplies a photo, and we generate a stylized
bobblehead character that animates in response to what the assistant is actually doing.

**Consent is a designed step, not a checkbox to bury.** The photo must be of the person
uploading it, or someone who has given them permission. That affirmation is recorded in
`audit_ledger` with who and when. Creators generate their own avatar; there is no path
that generates a likeness of a student. If someone asks to remove their likeness, the
record is what makes that possible.

**Provider-neutral, like everything else here.** An `ImageProvider` contract in
`packages/provider-router` mirroring the existing chat provider pattern, with adapters
for Gemini (`nano-banana`) and OpenAI (`gpt-image-1`). Nothing calls a vendor SDK
directly. Generation is metered into `cost_ledger` and checked against the tenant budget
before the call, identical to every other provider call — this is live spend.

**A pose set, not one image.** Character consistency across edits is exactly what these
models are good at. Generate five poses, each mapped to a state the app already has:

| Pose | Fires when |
|---|---|
| `idle` | Nothing happening |
| `listening` | Voice input is active |
| `thinking` | Request sent, first token not yet received |
| `speaking` | Tokens streaming, or TTS playing |
| `unsure` | Retrieval came back empty and the assistant is refusing |

These are real states, which is what makes the character read as alive rather than
decorative. The `thinking` pose in particular is doing honest work — it appears exactly
during the gap that streaming (Section 5) exposes.

**Animation is CSS transforms, not generated video.** Idle head-bob, tilt into
`listening`, cross-fade between poses, a small squash-and-stretch on `speaking`.
Transform and opacity only, so it stays cheap enough to run inside someone else's page.
Under `prefers-reduced-motion` the character holds the `idle` pose and does not move —
no exceptions, and no missing avatar.

**Review before publish.** The creator sees all five poses and approves them. A generated
likeness never auto-publishes.

**Storage and fallback.** Poses go to the `tenant-private` bucket behind signed URLs on
the existing `api/agent/asset` path — do not build a second upload path. Store them as a
versioned set. The widget preloads `idle` and `speaking` and lazy-loads the rest.
`brandInitial()` already renders a monogram; that is the fallback, and **a failed or
absent avatar must never block the chat from rendering.**

---

## 8. Landing page

The current landing page has to be rebuilt in Graphite, but the copy is the bigger
problem. Two things are wrong with it beyond the visual direction:

**It sells to the wrong person.** "Turn company knowledge into learning people can use"
is enterprise-L&D positioning. The buyer is a course creator putting an assistant inside
their Circle course. The page should show that assistant, in a Circle course, answering
a real question with real citations — the product is demonstrable, so demonstrate it
instead of describing it.

**It advertises things that do not exist.** The live page lists **"Management MCP"** as a
platform capability — that package was deleted on 2026-07-26. It also lists "Source
ingestion and review," which is Section 4 and is not built. Marketing copy that names
deleted code is how this repository convinced its own owner that unused packages were
delivered features. Every claim on the page needs a working path behind it or it comes
off the page.

---

## 9. Management MCP

Wanted, and it needs rebuilding rather than restoring. `packages/mcp-server` was deleted
on 2026-07-26 for reasons that are all still true of any naive rebuild:

- 27 of its 36 tools called `/api/dev/*` routes that no longer exist.
- The remaining 8 were an HTTP proxy over console routes requiring a **hand-pasted user
  bearer token**.
- It had no Dockerfile, no deploy configuration and no CI step. **It was never deployed
  anywhere**, and stdio transport is not hostable on Vercel.

So the failure was not the idea. It was that the thing had no transport it could actually
run on, no authentication a human would tolerate, and no home.

### 9.1 What it is for

You, the platform admin, operating the platform through an AI client: add a course
creator, provision their owner account, flip feature flags, read signals and cost across
tenants, check operation-secret expiry. The work that is otherwise clicking through
Control, or running SQL by hand.

### 9.2 What it must be this time

**Remote transport, not stdio.** Streamable HTTP so it is hostable next to the console.
A local-only stdio server is what made the last one undeployable.

**Real authentication.** OAuth, or a scoped service credential that can be issued and
revoked. Never a hand-pasted user bearer token — that is what made the last one unusable
in practice.

**No new privilege path.** Every tool calls the same `SECURITY DEFINER` RPCs the console
calls, under the same RBAC boundary. An MCP tool must not be able to do anything its
caller could not do in the UI. **The authorization boundary is the strongest part of this
system (Section 2) and the MCP must not become a hole in it.**

**Injection-aware.** This is the part that needs care. An MCP that can provision users
and flip flags, driven by a model that reads tenant content, is a prompt-injection
target. Tenant data — course text, transcripts, student questions — is untrusted input,
never instruction. Irreversible tools (provisioning, revocation, deletion, flag changes
that cut off a paying client) require explicit confirmation and are never chained
automatically from something the model read.

**Deployed, with CI.** If it has no deploy configuration and no CI step, it will rot
exactly like the last one. That is the acceptance criterion, not the tool count.

### 9.3 Scope discipline

Thirty-six tools is how the last one became unmaintainable. Start with the handful that
map to work actually done weekly, and add a tool only when the manual version becomes
annoying.

---

## 10. Billing, margins and entitlements

This is how the platform makes money, and most of the substrate already exists.

- `src/lib/cost-metering.ts` holds a per-model price book in micro units and deliberately
  prices unknown models high.
- `public.cost_ledger` records the true provider cost of every call.
- `platform_admin_set_tenant_cost_policy` / `platform_admin_cost_overview` already enforce
  and report per-tenant budgets in SQL.
- `public.tenant_sections` already gates which sections a tenant can see.

What is missing is the money: a margin on top of metered cost, and Stripe collecting it.

### 10.1 Two revenue lines

**Subscription — access.** A plan decides which sections a creator gets: analytics,
signals, voice, custom branding. Section 1 says the business model is in the flags; this
makes that literally true. **A Stripe subscription state change is what sets
`tenant_sections`** — the flags stop being hand-flipped and become a projection of what
the customer pays for. You keep the manual override, because comping an account and
debugging both need it.

**Usage — margin on API calls.** Every provider call already writes its true cost. Add a
per-tenant margin policy — a multiplier, a fixed markup, or a floor — set by you, per
account. Billable amount = metered cost × margin. That amount is reported to Stripe as
metered usage and invoiced.

### 10.2 The rule that makes it a business

**A creator never sees the raw provider cost — only their price.** True cost, margin, and
billed amount are platform-admin-only. `platform_admin_cost_overview` shows all three;
anything a creator can reach shows one. If margin leaks into a creator-visible response,
the pricing model is gone. Treat it like a security boundary, because commercially it is
one.

### 10.3 Non-negotiables

**We never touch card data.** Stripe hosted Checkout and the Billing Portal only. No card
number, CVC or expiry enters this system, is logged, or is stored. There is no reason to
build a card form and every reason not to.

**Webhooks are idempotent.** Stripe retries. Dedupe on the Stripe event id, and verify
the webhook signature — an unsigned billing webhook is a way to grant yourself a free
plan.

**Usage reporting is idempotent.** `cost_ledger` rows carry a provider request reference.
Report each row at most once; double-reported usage means over-charging a customer, which
is worse than under-charging.

**Billing failure must not stop learning.** A Stripe outage, an expired card, a webhook
that never arrives — none of these should cut a student off mid-lesson. Degrade and
reconcile later. The failure mode of a payments integration should never be "the course
stopped working."

**Dunning is a sequence, not a switch.** Card fails, grace period, creator is told
clearly, then sections go dark. A creator whose analytics vanish overnight with no
warning is a support ticket and a refund request.

**Tax.** Stripe Tax. Do not hand-roll VAT.

### 10.4 What you see

Per account: true spend, margin applied, billed amount, plan, subscription state, budget
headroom, and the model tier they are on — because model choice is the biggest lever on
your margin.

---

## 11. Build order

Sequenced so each phase ships something usable and nothing blocks on ingestion.
Status is maintained here — update it in the same commit as the work.

| # | Phase | Size | Status |
|---|---|---|---|
| 1 | Token file | S | **done** |
| 2 | `globals.css` colour sweep | M | **done** |
| 3 | Streaming | S | **done** |
| 4 | Agent controls | M | **done** |
| 5 | Landing page | S | **done** |
| 6 | Brand the chat | S | **done** |
| 14 | Wire agent config into the answer path | S | **done** |
| 8 | Signals readout | M | in progress |
| 7 | The assistant / embeddable widget | XL | not started |
| 16 | `--ui-*` token consolidation | M | not started |
| 9 | Character avatars | M | not started |
| 15 | Billing, margins, Stripe | L | not started |
| 10 | Knowledge pipeline | XL | not started |
| 11 | Figures in chat | M | not started |
| 12 | Operational debt | M | not started |
| 13 | Management MCP | M | not started |

**Phase 1 — Token file.** ✅ Section 3 shipped as `apps/console/src/app/tokens.css`, with
`scripts/check-contrast.mjs` gating the build so a failing token cannot ship. `body` now
draws from `var(--canvas)` and `var(--font-ui)`; the radial lift derives from
`--accent-wash`, so it re-tints per client instead of being a fixed green.

**Phase 2 — `globals.css` colour sweep.** `globals.css` is **2,232 lines** and hardcoded
colours start again at line 87 and run to the end — `#d8b978`, `#2b8a61`, `#d6d1c7`,
`#f9f9f8` and many more. Phase 1 fixed `:root` and `body` only. Until this sweep is done
the app is two design systems wearing one token file. Convert every literal to a token,
delete what no rule uses, and split the `.lb*` landing rules into their own stylesheet so
this file stops being a dumping ground. *Do it before Phase 7, or the new widget inherits
the mess.*

**Phase 3 — Streaming.** Section 5. Unbuffer `complete()`, stream SSE from
`respond/route.ts`, persist in `after()`, keep a non-streaming mode for voice. *Small
relative to its impact — the engine already exists. Must land before Phase 7 so the
assistant is built against a streaming source rather than retrofitted onto one.*

**Phase 4 — Agent controls.** Section 6. Generation settings, voice selection, layered
instructions, draft → preview → publish → rollback. The base instruction stays
structurally uneditable.

**Phase 5 — Landing page.** Section 8. Graphite, repositioned for course creators, and
every claim without a working path behind it removed — the live page currently advertises
"Management MCP", a package deleted on 2026-07-26. *Small, and it is the first thing
anyone sees.* Shares `globals.css` with Phase 2 — sequence them, never parallel.

**Phase 6 — Brand the chat.** Wire `brand.ts` into the conversation surface so a
creator's colour actually reaches a student's screen, contrast-corrected. The math
already exists and is imported by exactly one settings preview. *Small.*

**Phase 7 — The assistant / embeddable widget.** Graphite, container-queried per §3.4,
the answer typeset as a document rather than a bubble, text arriving token by token, the
full motion sequence. Replace the 38-line `circle-learningbot.js` — which today only
appends a link — with a real embeddable widget. *This is the product, and the largest UI
phase. Depends on 1, 2, 3, 6.*

**Phase 8 — Signals readout.** Studio view over `question_labels` / `question_signals`:
depth, theme, who is escalating, who is stuck, who is ready for the next course. The data
is already written on every turn and read by nothing. *Medium, highest payoff per hour of
work in the whole plan.*

**Phase 9 — Character avatars.** Section 7.1. `ImageProvider` contract plus one adapter,
consent record, five-pose generation, CSS state animation, review before publish.
*Shares `agent-panel.tsx` and `api/agent/` with Phase 4 and `packages/provider-router`
with Phase 3 — must follow both, never run alongside them.*

**Phase 10 — Knowledge pipeline.** Section 4, stages 1–6, including the cleaning module.
*Largest phase overall. Take one file type through extract → clean → review end to end
before adding a second.*

**Phase 11 — Figures in chat.** Real assets behind the `diagram` / `attachment` parts, so
the renderer draws something instead of a `◇`. *Depends entirely on Phase 10.*

**Phase 12 — Operational debt.** Voice rate limiting off the in-process `Map`, audit
coverage on conversations / voice / uploads / onboarding / provisioning, `telemetry_outbox`
drain, invitation email.

**Phase 14 — Wire agent config into the answer path.** Phase 4 stores model, temperature,
top-p, max tokens, retrieval count and similarity floor — versioned and audited — but
**nothing consumes them.** `lib/learning-provider.ts` still hardcodes its own model and
refusal string, so a creator can move a slider today and the answer will not change. This
was scoped out of Phase 4 to avoid colliding with Phase 3; both have landed, so the files
are free. *Small, and until it is done the agent controls are a form that does nothing.*

**Phase 15 — Billing, margins, Stripe.** Section 10. Subscription state drives
`tenant_sections`; per-tenant margin over `cost_ledger` reported to Stripe as metered
usage; hosted Checkout and Billing Portal only, never a card field of our own; idempotent
webhooks and idempotent usage reporting; dunning as a sequence. *Large. Depends on Phase
14, because margin is priced off the model actually used.*

**Phase 13 — Management MCP.** Section 9. Remote HTTP transport, real revocable auth, a
small tool set over the existing `SECURITY DEFINER` RPCs, injection-aware confirmation on
irreversible actions, deployed with a CI step. *Can move earlier if operating the platform
by hand becomes the bottleneck — it depends on nothing except the RPCs, which exist. It is
placed late only because it serves you rather than a paying creator.* **The landing page
does not advertise it until it ships.*

Privacy, export and deletion stay out of scope until a contract requires them — but they
are **absent, not partial**, and nobody should be told otherwise.

**On "one shot":** phases 3, 5, 6 and 8 are genuinely a session each — wiring jobs over
machinery that already exists. Phases 2 and 4 are a session or two. Phase 7 is several.
Phase 10 is the multi-week one; transcript cleaning a creator will trust is not a weekend.
Sequenced this way you have a streaming, branded, demo-able product long before ingestion
lands.

---

## 12. What stops being true

- `docs/course-ai-platform/` is reference, not specification.
- Any surface described as required that isn't in Section 1 is not being built:
  ingestion ops console, playground, prompt studio, webhooks, connectors, student memory,
  hot students, SSO/SAML/SCIM, management MCP.
- The README's "Not yet built" list stays accurate or it gets fixed in the same commit.

---

## 13. Open decisions

1. **Transcription provider.** Whisper via OpenAI is the obvious default given
   `OPENAI_API_KEY` is already required. Confirm before Phase 5.
2. **Image provider for avatars.** Gemini (`nano-banana`) is the stronger choice for
   keeping one character consistent across a five-pose set. OpenAI (`gpt-image-1`) means
   no second vendor and no second key, since `OPENAI_API_KEY` is already required.
   Recommend building the `ImageProvider` contract with the OpenAI adapter first and
   adding Gemini behind the same interface if pose consistency disappoints — the contract
   makes that a swap, not a rewrite. A Gemini key becomes a new variable in
   `.env.example` with a named reader, per that file's existing rule.
3. **Figure extraction from PDFs.** Genuinely hard. Options range from "extract embedded
   raster images" (cheap, works today) to "re-render vector charts as data" (expensive).
   Recommend starting with embedded images and a caption.
4. **Does the creator review every file, or only low-confidence ones?** Affects whether
   Phase 5 needs a confidence score.
5. **Custom domain.** The product is live at `clone.stack-labs.ai`, a subdomain borrowed
   from another project, on a Vercel project named `learningbot-estie-preview`.

# Course AI Platform — Product Specification v3

*Last updated: 2026-07-23. This document is the single source of truth for the product.*
*It is written so that any engineer or AI agent can read it start-to-finish and understand exactly what to build, with no outside context.*

---

## 0. How to read this document

- **Section 1** says what the product is in plain English.
- **Section 2** defines every term used (glossary). If a word is capitalized in this doc, it is defined there.
- **Section 3** lists what already exists in this repo and what happens to it.
- **Section 4** contains verified research facts about Circle (the main host platform), with sources. Do not re-research these; they were verified 2026-07-23.
- **Sections 5–13** are the build spec: architecture, database, APIs, widget, ingestion, diagrams, analytics, dashboards, security.
- **Section 14** is the phased build plan. Each phase has acceptance criteria — a phase is done only when every criterion passes.
- **Section 15** is the decision log (what's locked, what's open).

Rules for agents working from this doc:
1. If this doc and code disagree, this doc wins; flag the mismatch.
2. If something is ambiguous, check Section 15; if still ambiguous, ask the Platform Owner — do not invent.
3. Never weaken anything in Section 13 (security/quality bar) for convenience.

---

## 1. What the product is (plain English)

**One sentence:** A platform that gives online course creators an AI assistant trained on their own course content, embedded as a chat widget inside their community/course site, and a dashboard that tells them what their students are asking, where they're confused, and which students are ready to buy more.

**The three people involved:**

| Person | Who they are | What they see |
|---|---|---|
| **Platform Owner** | Emiel — runs the whole platform, onboards clients | Admin Console: all tenants, API keys, costs, pipeline operations, system health |
| **Client** (also called **Creator**) | A course creator who pays for the product (first client: Estie Starr, a business coach who teaches on Circle) | Client Portal: insights about their students, knowledge base management, assistant settings, widget setup |
| **Student** (also called **End User**) | A member of the Client's course/community | The Chat Widget only. Never sees a dashboard. |

**The value for each:**
- Student: instant, accurate answers in the Creator's own voice and frameworks, with the actual diagrams from the course, available 24/7.
- Creator: an assistant that scales them, plus insights they cannot get anywhere else ("Module 3 confuses everyone", "Sarah is ready for your high-ticket offer").
- Platform Owner: a repeatable product — onboard any creator's content in under a day, charge setup + monthly fee.

**What it is NOT (v1):** not a voice/phone bot (retired), not an SMS bot (retired), not a general chatbot builder, not a course-hosting platform. It attaches to existing platforms (Circle first, generic websites second, Kajabi/Teachable later).

---

## 2. Glossary

| Term | Definition |
|---|---|
| **Tenant** | One Client's isolated workspace: their knowledge base, students, settings, keys. One row in `tenants`. Everything in the DB is scoped by `tenant_id`. |
| **Knowledge Base (KB)** | All processed content for one Tenant: Documents, Chunks, and Assets. |
| **Source** | A place content comes from (a Circle community, an uploaded file, a YouTube playlist). |
| **Document** | One logical content unit (one lesson transcript, one PDF, one slide deck), belonging to a course/module/lesson hierarchy. |
| **Chunk** | A ~220-word passage of a Document with a vector embedding. The retrieval unit. |
| **Asset** | An image extracted from teaching content — usually a **Diagram**. Has a raw version (screenshot) and optionally a **Vector Recreation** (clean SVG rebuilt by a vision model). |
| **Voice Guide** | A markdown document describing how a Creator talks and teaches (tone, catchphrases, named frameworks, boundaries). Injected into the system prompt so the assistant sounds like the Creator. |
| **Prompt Config** | A versioned per-Tenant record: Voice Guide + behavior instructions + model settings. Exactly one active version per Tenant. |
| **Widget** | The embeddable chat UI (a single JS file) that Students use. |
| **Widget Public Key** | A per-Tenant identifier in the embed snippet (`pk_...`). Identifies the Tenant; safe to expose; rate-limited. |
| **Session Token** | A short-lived JWT our backend issues to the Widget after identification; sent on every chat request. |
| **Identity Tier** | How confident we are in who a Student is: `verified` / `self_reported` / `anonymous` (Section 8.3). |
| **Event** | One tracked action (message sent, widget expanded, lesson completed…). Append-only log; foundation of all analytics. |
| **Signal** | A derived judgment about a Student (e.g. `high_intent`), computed by the Signals Engine from Events + Messages, always with stored evidence. |
| **Question Cluster** | A group of semantically similar Student questions, LLM-labeled (e.g. "pricing their first offer"). Powers "top questions" analytics. |
| **Confusion Map** | Per-lesson metric: questions asked per active student per lesson. High = the lesson isn't landing. |
| **Content Gap** | A Question Cluster where retrieval confidence is consistently low = students ask it, the course doesn't cover it. |
| **BYOK** | "Bring Your Own Key" — a Tenant supplies their own LLM API key so inference bills to them directly. |
| **Ingestion Pipeline** | The queued jobs that turn a Source into a KB: transcribe → clean → chunk → embed → extract assets. |
| **Curation Gallery** | Dashboard screen where extracted Diagrams are approved/rejected before Students can see them. |
| **Admin Console** | The Platform Owner's dashboard surface. |
| **Client Portal** | The Client's dashboard surface. Same Next.js app, different role. |

---

## 3. Current state of this repo (inventory + disposition)

| Path | What it is | Disposition |
|---|---|---|
| `scraper/bridge_server.py` | Local HTTP server; browser JS posts scraped Circle lesson JSON to it | Pattern survives as the Circle Connector's collection mode; code gets rewritten into the ingestion service |
| `scraper/clean_and_chunk.py` | VTT/Whisper → clean paragraphs → ~220-word chunks, 40-word overlap, pause-based paragraph breaks (1.8s) | **Keep the algorithm exactly** — port to the pipeline service |
| `scraper/build_embeddings.py`, `vector_index/` | Local embedding build (npy files) | Replaced by DB-stored vectors |
| `scraper/analysis/ESTIE_VOICE_AND_FRAMEWORKS_GUIDE.md` | Hand-written Voice Guide for Estie | Becomes Estie's `prompt_configs.persona_md`; the process of making it gets automated (Section 9.3) |
| `scraper/clean_transcripts/` (6 courses) | Estie's cleaned course content | Migrated into `documents`/`chunks` in Phase 0 |
| `worker/src/index.ts` | Cloudflare Worker: brute-force vector search over static files + hardcoded Estie prompt + GPT-4o | Rewritten in Phase 0–1 per Sections 5 & 7; retrieval trick to keep: +0.03 score boost for canonical-guide chunks |
| `worker/public/embeddings.f32`, `metadata.json`, `voice_guide.md` | KB shipped as static assets | Deleted after Phase 0 migration |
| ElevenLabs / Twilio / voice scripts in `scraper/` | Retired channel experiments | Archive; do not build on |

---

## 4. Research facts: Circle (verified 2026-07-23)

Circle (circle.so) is the community/course platform Estie teaches on and our first integration target.

### 4.1 Custom code injection (how our widget gets onto a Circle site)
- Circle has a **Code snippets** feature: community admin goes to **Site → Code snippets**. Two fields: **Head** (HTML/CSS/meta before `</head>`) and **JavaScript** (Circle wraps it in `<script>` tags automatically — including your own `<script>` tags causes errors).
- Custom code is self-serve and **unsupported by Circle support**; Circle explicitly does not guarantee custom code keeps working. → Our widget must be fully self-contained (Shadow DOM), defensive, and fail silent (never break the host page).
- Source: help.circle.so → "Custom code snippets" article (June 2026).

### 4.2 Student identity (the critical fact)
- Circle exposes a **global `window.circleUser` object** to custom JavaScript snippets for the signed-in member, with these fields: `email`, `name`, `firstName`, `lastName`, `isAdmin`, `isModerator`, `location`, `profileUrl`, `publicUid` (the member's unique Circle ID), `linkedinUrl`, `twitterUrl`, `facebookUrl`, `websiteUrl`.
- **Caveat:** this is client-side, unsigned data. Anything in the page can be spoofed by a technical user. → We treat it as `self_reported` identity by default and upgrade to `verified` by checking it against Circle's Admin API server-side (Section 8.3).
- Source: help.circle.so → "Access member information from your JavaScript code snippets" (Jan 2025).

### 4.3 APIs
- **Admin API v2** (recommended by Circle over v1): Bearer-token auth; token created at **Developers → Tokens** in the community. Endpoint categories include Community Members, Courses, Course Sections, Course Lessons, Spaces, Posts, Events, Member Tags, Access Groups, Advanced Search. Docs: api.circle.so; OpenAPI spec at api-headless.circle.so.
- **Headless Member API** exists for building full custom frontends (not needed for v1; noted for future).
- Admin API is available on Circle's **Business plan and above**.

### 4.4 Webhooks / progress events (native module-progress tracking — no scraping needed)
- Circle **Workflows** can "send to webhook": on a trigger, Circle POSTs event data to any URL you configure.
- Confirmed trigger events include: **member completes a lesson**, **member completes a section**, **member completes a course**, **new member joins**, **member RSVPs to an event**.
- → Our per-Tenant webhook endpoint (Section 7.4) receives these and writes `module_progress` Events. This powers module-velocity buying signals without any scraping.

### 4.5 Circle plans (affects client onboarding requirements)
- Professional ≈ $89/mo (core community + courses), Business ≈ $199/mo (**workflows + API** — what we need), Enterprise ≈ $419/mo, Circle Plus (custom, branded apps). 
- **Onboarding requirement:** full feature set (verified identity + progress webhooks) needs the client on **Circle Business or above**. On Professional, the widget still works with `self_reported` identity and no progress events — degraded but functional. The onboarding checklist must record which mode the client is in.

### 4.6 Sources
- [Custom code snippets](https://help.circle.so/p/administration/site-management/custom-code-snippets)
- [Access member information from JavaScript code snippets](https://help.circle.so/p/sso-and-integrations/api/access-member-information-from-your-javascript-code-snippets)
- [Circle Developer Platform overview](https://help.circle.so/p/sso-and-integrations/api/get-to-know-the-circle-developer-platform)
- [Admin API](https://api.circle.so/apis/admin-api) · [Admin API v2 OpenAPI](https://api-headless.circle.so/api/admin/v2/swagger.yaml) · [Headless Member API](https://api.circle.so/apis/headless/member-api)
- [Workflows → send webhooks](https://help.circle.so/p/workflows/workflow-setup/configure-automation-workflows-to-send-webhooks)
- Plan pricing cross-checked via [SchoolMaker's Circle pricing breakdown](https://www.schoolmaker.com/blog/circle-so-pricing) and [Circle reviews](https://www.learningrevolution.net/circle-review/)

---

## 5. Architecture

### 5.1 Components (five deployables)

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. WIDGET  widget.js on CDN — runs inside Circle / any website │
└──────────────┬──────────────────────────────────────────────────┘
               │ HTTPS + SSE
┌──────────────▼──────────────────────────────────────────────────┐
│ 2. EDGE API  Cloudflare Worker — /v1/* endpoints                │
│    identify, chat (streaming), events, webhooks, asset URLs     │
└──────────────┬──────────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────────┐
│ 3. DATABASE  Supabase: Postgres + pgvector + RLS + Storage      │
│              + Vault (secrets) + Auth (dashboard logins)        │
└──────────────┬──────────────────────────────────────────────────┘
               │
┌──────────────▼───────────────┐  ┌──────────────────────────────┐
│ 4. DASHBOARD  Next.js app    │  │ 5. PIPELINE  ingestion +     │
│    Admin Console (owner)     │  │    signals workers (queued   │
│    Client Portal (creators)  │  │    jobs; Supabase queues or  │
│                              │  │    CF Queues — Phase 0 pick) │
└──────────────────────────────┘  └──────────────────────────────┘
```

### 5.2 Stack (locked decisions)
- **Database/system of record:** Supabase — Postgres 15+, `pgvector`, Row-Level Security on every table, Supabase Storage for assets, Supabase Vault for secrets, Supabase Auth for dashboard users.
- **Edge API:** Cloudflare Worker (existing deploy target). Serves `widget.js` and all `/v1/*` endpoints.
- **Dashboard:** Next.js (App Router) + Tailwind + shadcn/ui + Lucide icons + Recharts/Tremor + Framer Motion (sparingly).
- **LLM:** Claude Sonnet (`claude-sonnet-5`) as platform default, behind a provider abstraction (`generate(messages, tenantModelConfig)`); per-Tenant model/params/keys.
- **Embeddings:** `bge-base-en-v1.5` via Cloudflare Workers AI (768-dim). `embedding_model` recorded on every vector row; re-embedding is a queued job.
- **Transcription:** OpenAI Whisper API.
- **Vision (diagram extraction/recreation):** Claude vision calls.

### 5.3 Multi-tenancy rules (non-negotiable)
1. Every table carries `tenant_id`. RLS policies enforce isolation at the database layer.
2. Dashboard users get JWTs with `tenant_id` + `role` claims; the Platform Owner role may set an "acting tenant" (impersonation, always audit-logged).
3. The Edge API always resolves Tenant from the Widget Public Key first, then scopes every query.
4. CI includes an **isolation test suite**: for every table, prove tenant A's credentials cannot read/write tenant B's rows. A failing isolation test blocks deploy.

---

## 6. Database schema

Conventions: all tables have `id uuid pk default gen_random_uuid()`, `created_at timestamptz default now()`; all tenant-scoped tables have `tenant_id uuid not null references tenants(id)` + RLS.

```sql
-- TENANCY ------------------------------------------------------------
tenants           name text, slug text unique, status text (active|suspended|onboarding),
                  plan text, branding jsonb, settings jsonb
                  -- branding: {primary_color, avatar_url, assistant_name, welcome_message, launcher_style}
                  -- settings: {circle_community_url, identity_mode, features jsonb}
dashboard_users   (Supabase Auth) + profile: tenant_id nullable (null = platform owner),
                  role text (owner|client_admin|client_viewer)
tenant_api_keys   tenant_id, kind text (widget_public|llm_provider|circle_admin),
                  provider text, key_prefix text, vault_secret_id uuid,
                  status text (active|rotating|revoked),
                  rotated_at, expires_at, last_used_at
prompt_configs    tenant_id, version int, persona_md text, instructions_md text,
                  model text, temperature float, max_output_tokens int,
                  is_active bool, created_by uuid, change_note text
                  -- UNIQUE (tenant_id, version); exactly one is_active per tenant (partial unique index)

-- KNOWLEDGE BASE ------------------------------------------------------
sources           tenant_id, type text (circle|upload|youtube|url|kajabi),
                  config jsonb, status text (pending|syncing|ready|error), last_synced_at
documents         tenant_id, source_id, course text, module text, lesson text,
                  title text, kind text (transcript|guide|pdf|slide_deck|article),
                  external_url text, raw_storage_path text,
                  status text (pending|processing|ready|error), error text,
                  content_hash text  -- idempotency: same hash = skip reprocessing
chunks            tenant_id, document_id, seq int, text text, start_hms text,
                  token_count int, embedding vector(768), embedding_model text,
                  asset_ids uuid[]
                  -- index: HNSW on embedding, btree (tenant_id, document_id)
assets            tenant_id, document_id, kind text (diagram|slide|photo),
                  raw_storage_path text, svg_storage_path text,
                  display_mode text (svg|raster),  -- what the widget actually shows
                  caption text, ocr_text text, source_timestamp_hms text,
                  curation_status text (pending|approved|rejected),
                  embedding vector(768), embedding_model text

-- STUDENTS & CONVERSATIONS --------------------------------------------
end_users         tenant_id, external_id text,      -- Circle publicUid, or email hash, or anon:<uuid>
                  identity_tier text (verified|self_reported|anonymous),
                  email text, display_name text, first_seen_at, last_seen_at, traits jsonb
                  -- UNIQUE (tenant_id, external_id)
conversations     tenant_id, end_user_id, channel text (widget), started_at,
                  page_context jsonb  -- {url, title, course, module, lesson} at start
messages          tenant_id, conversation_id, role text (user|assistant), content_md text,
                  sources jsonb,          -- [{document_id, chunk_id, score, lesson}]
                  asset_ids uuid[],
                  question_embedding vector(768),   -- user messages only; for clustering
                  retrieval_confidence float,        -- top-1 similarity score
                  rating smallint,                   -- -1 / null / +1 (widget thumbs)
                  model text, tokens_in int, tokens_out int, cost_usd numeric,
                  latency_ms int

-- TRACKING & INTELLIGENCE ----------------------------------------------
events            tenant_id, end_user_id nullable, conversation_id nullable,
                  type text, payload jsonb, ts timestamptz
                  -- type taxonomy in Section 11.1; partitioned by month when volume demands
user_profiles     tenant_id, end_user_id unique-per-tenant, memory_summary_md text,
                  topics jsonb, engagement_score float, intent_score float,
                  intent_label text (browsing|engaged|high_intent),
                  last_scored_at, memory_updated_at
signal_alerts     tenant_id, end_user_id, signal_type text
                  (went_high_intent|buying_language|win_detected|stalled),
                  evidence jsonb,   -- [{quote|behavior, source_message_id|event_id}]
                  status text (new|seen|actioned), notified_at
question_clusters tenant_id, period text (rolling_30d), label text,
                  representative_question text, member_count int,
                  linked_lessons jsonb, avg_retrieval_confidence float,
                  is_content_gap bool, trend jsonb, computed_at
context_mappings  tenant_id, url_pattern text, course text, module text, lesson text
                  -- maps host-page URLs to KB hierarchy for the Confusion Map

-- OPERATIONS -------------------------------------------------------------
pipeline_jobs     tenant_id, document_id nullable, type text
                  (transcribe|clean_chunk|embed|extract_assets|recreate_svg|
                   voice_guide|reembed|score_signals|cluster_questions|summarize_memory),
                  status text (queued|running|done|error), attempts int,
                  payload jsonb, error text, started_at, finished_at
usage_daily       tenant_id, date, messages int, tokens_in bigint, tokens_out bigint,
                  cost_usd numeric, active_users int, conversations int
audit_log         tenant_id nullable, actor_user_id, action text, target_type text,
                  target_id, diff jsonb, ip text, ts
```

---

## 7. Edge API contract (`/v1/*` on the Worker)

All endpoints: JSON, CORS locked to `*` for widget endpoints (tenant resolved by key, not origin), rate-limited per Widget Public Key. Errors: `{error: {code, message}}` with proper HTTP status.

### 7.1 `POST /v1/identify` — called by the widget on load
```jsonc
// Request
{ "tenant_key": "pk_live_abc123",
  "identity": {              // one of the three shapes:
    "provider": "circle",    // window.circleUser payload passthrough
    "public_uid": "abc123", "email": "s@x.com", "name": "Sarah K", "is_admin": false },
  // or {"provider": "custom", "external_id": "...", "email": "...", "hmac": "..."} (generic sites, Phase 6)
  // or {"provider": "anonymous", "anon_id": "anon:uuid-from-localstorage"}
  "page": { "url": "...", "title": "..." } }

// Response
{ "session_token": "<JWT, 24h, claims: tenant_id, end_user_id, identity_tier>",
  "identity_tier": "verified",
  "conversation": { /* most recent open conversation + last 20 messages, for resume */ },
  "branding": { /* tenants.branding — colors, name, avatar, welcome */ } }
```
Server logic: upsert `end_users`; if provider=circle and the Tenant has a `circle_admin` key stored → verify `email`→`publicUid` against Circle Admin API (cache result 24h) → tier `verified`, else `self_reported`. Anonymous → tier `anonymous`.

### 7.2 `POST /v1/chat` — SSE stream
```jsonc
// Request (Authorization: Bearer <session_token>)
{ "conversation_id": "uuid|null",   // null = start new
  "message": "How do I price my first offer?",
  "page": { "url": "...", "title": "..." } }
```
SSE event sequence: `meta` (conversation_id, message_id) → repeated `delta` (markdown text tokens) → optional `asset` ({asset_id, signed_url, caption}) → `sources` (citations) → `done` (tokens, latency). 

Server pipeline (every step logged):
1. Resolve tenant + active `prompt_config`.
2. Embed query (bge-base). 
3. Retrieve top-8 chunks: pgvector cosine, `WHERE tenant_id = $1`, +0.03 boost for `kind='guide'` documents, +0.05 boost for chunks whose document matches current page context (via `context_mappings`).
4. Collect approved Assets linked to retrieved chunks; list them in the prompt as `[[asset:<uuid>]] — <caption>`.
5. Assemble system prompt: `persona_md` + `instructions_md` + user memory (`user_profiles.memory_summary_md`, if any) + retrieved excerpts + asset list + the standing rule: *"If the excerpts don't cover the question, say so plainly rather than inventing an answer."*
6. Stream from the Tenant's configured model/key. Post-process `[[asset:uuid]]` → emit `asset` events with 1-hour signed URLs.
7. Write `messages` rows (incl. question_embedding, retrieval_confidence, cost); write `message_sent`/`response_streamed` Events; increment `usage_daily`.

### 7.3 `POST /v1/events` — widget telemetry batch
`{ "events": [{ "type": "widget_expanded", "payload": {...}, "ts": "..." }] }` — validated against the taxonomy (11.1), written to `events`.

### 7.4 `POST /v1/webhooks/circle/:tenant_webhook_id` — Circle Workflows receiver
Receives Circle's webhook POSTs (lesson/section/course completed, member joined). Maps member → `end_users` by email/publicUid; writes `module_progress` / `member_joined` Events. Unique URL per tenant (unguessable id) + optional shared-secret header check.

### 7.5 Misc
- `GET /widget.js` — the widget bundle (cached, versioned).
- `POST /v1/messages/:id/rating` — thumbs up/down.
- `GET /v1/assets/:id` — 302 to signed Storage URL (auth: session token; asset must be `approved` and same-tenant).

---

## 8. Widget specification

### 8.1 Embed
Circle: paste into **Site → Code snippets → JavaScript** (no `<script>` tags — Circle adds them):
```js
(function(){var s=document.createElement('script');s.src='https://cdn.<domain>/widget.js';
s.dataset.tenant='pk_live_abc123';document.head.appendChild(s);})();
```
Generic website: same snippet inside `<script>` tags.

### 8.2 Behavior requirements
1. **Shadow DOM root**; zero global CSS leakage either direction; total bundle < 50KB gzipped; no framework.
2. **Fail silent:** any internal error → widget hides itself; never breaks the host page (Circle explicitly doesn't guarantee custom-code compatibility — we own robustness).
3. **Three visual states:** launcher bubble → side panel (~400px) → expanded (drag-handle resize, up to 90vw/90vh, size persisted in localStorage). Mobile (<768px): full-screen sheet, no drag. All transitions transform-based, 60fps.
4. **Rich text:** progressive markdown rendering while streaming (markdown-it + DOMPurify): headings, bold/italic, lists, tables, links, code.
5. **Diagrams:** `asset` SSE events render inline (SVG or raster per `display_mode`), lazy-loaded, click → lightbox zoom.
6. **Identity flow on load:** poll for `window.circleUser` up to 5s → found: `/v1/identify` with circle payload → not found: anonymous flow with localStorage `anon_id`. Resume last conversation from the identify response.
7. **Telemetry:** batches Events (11.1) every 10s or on visibility change.
8. **Theming:** all colors/name/avatar/welcome from the identify response (`branding`) — never hardcoded.
9. **Rating:** thumbs up/down on each assistant message.
10. **Page context:** every chat request includes `location.href` + `document.title` (Circle lesson URLs contain course/lesson slugs → matched via `context_mappings`).

### 8.3 Identity tiers (exact semantics)
| Tier | How it happens | What it enables |
|---|---|---|
| `verified` | `window.circleUser` present AND tenant connected a Circle Admin API token AND server-side lookup confirms email↔publicUid | Full: per-student insights, memory, signals, webhook progress joins |
| `self_reported` | `window.circleUser` present, no Admin API token (e.g. client on Circle Professional) | Same features, flagged as unverified in the dashboard (technical users could spoof) |
| `anonymous` | No identity (logged out, or plain website without integration) | Chat works; analytics aggregate-only; no memory across devices |

---

## 9. Ingestion pipeline

### 9.1 Connector framework
Every connector outputs the same normalized shape per lesson/item:
```jsonc
{ "course": "Marketing Magic", "module": "Module 3", "lesson": "The Hourglass",
  "kind": "transcript|pdf|slide_deck",
  "media": {"video_url|file_path": "..."},
  "transcript_cues": [{"start_sec": 0.0, "end_sec": 4.2, "text": "..."}] | null }
```
Connectors, in build order: **(a) File upload** (video/audio → Whisper; PDF; docx; pptx) — universal fallback, build first. **(b) Circle** — generalized version of the existing scraper (config: community URL + section map; browser-assisted collection via the bridge pattern). **(c) YouTube/Vimeo playlist.** **(d) URL crawl.** Later: Kajabi, Teachable, Skool.

### 9.2 Processing jobs (all rows in `pipeline_jobs`; idempotent via `documents.content_hash`; every failure visible in Admin Console → Ingestion Ops)
1. `transcribe` — media without transcript → Whisper API → cues.
2. `clean_chunk` — port of `clean_and_chunk.py`: cues → paragraphs (pause break 1.8s) → chunks (target 220 words, 40 overlap), preserving exact wording and start timestamps.
3. `embed` — bge-base per chunk; store vector + model name.
4. `extract_assets` — Section 10.
5. `recreate_svg` — Section 10.
6. `voice_guide` — Section 9.3.

### 9.3 Auto Voice Guide (the onboarding moat)
Job: sample ~50k words across the Tenant's transcripts → LLM analysis pass producing a draft Voice Guide with fixed sections: *Tone & rhythm; Signature phrases & address style; Named frameworks (with definitions in the creator's own words); Teaching patterns; Boundaries (what they never say/promise)*. Saved as a draft `prompt_config`; the Platform Owner (or Client) edits it in Assistant Studio and activates. Estie's hand-built guide is the quality benchmark — the generated draft must reach "80% there, 20 minutes of edits."

### 9.4 Onboarding checklist (a tracked UI in Admin Console; every new Tenant walks these exact steps)
1. Create Tenant (name, slug, plan, branding).
2. Record client's Circle plan → sets expected identity mode (Business+ = verified; Professional = self_reported).
3. Connect Source(s) & run pipeline (status live: "42/68 lessons processed").
4. If Business+: store client's Circle Admin API token (Vault); configure Circle Workflows → webhook URL (we generate it + step-by-step instructions with screenshots).
5. Review auto Voice Guide → edit → activate Prompt Config.
6. Curate diagrams (approve/reject in gallery).
7. Set up `context_mappings` (auto-suggested from Circle lesson URLs).
8. Theme widget (live preview) → generate embed snippet.
9. Test in Playground (20 scripted QA questions per course; spot-check voice fidelity).
10. Client pastes snippet → verify events flowing → go live.
Target: **< 1 day of Platform Owner time per client.**

---

## 10. Diagram pipeline

**Decision (locked): extract raw frames → recreate as clean SVG via vision model → human curation gate → serve SVG (raster fallback).** Rationale: all LLM cost is one-time at ingestion (~$0.01–0.05/diagram; a 200-diagram course ≈ a few dollars); serving is free static files; SVG is crisp at any widget size and themeable.

Steps:
1. **Candidates.** Slide decks/PDFs: every page exported as PNG. Videos: ffmpeg scene-change detection (`select='gt(scene,0.3)'`) → candidate frames.
2. **Filter.** Vision call per candidate: "teaching diagram/slide with instructional content — or talking head/filler?" Keep diagrams with timestamp.
3. **Understand.** Vision call: caption (1–2 sentences, using the creator's terminology) + OCR text + classify (`framework_diagram|process_flow|worksheet|screenshot|decorative`). `decorative` → auto-reject.
4. **Recreate.** Vision+generation call: rebuild as clean, self-contained SVG (or Mermaid → SVG for flow shapes), tenant brand colors. Validation: SVG parses, no external refs, viewBox set. Failure → `display_mode='raster'` with auto-cropped/enhanced original.
5. **Link.** Asset attached to the chunk(s) covering its video timestamp (`chunks.asset_ids`); caption+OCR embedded into `assets.embedding` so diagrams are retrievable by meaning.
6. **Curate.** Gallery shows original vs. recreation side-by-side → approve / approve-as-raster / reject / edit caption. **Only `approved` assets can ever reach a Student.** Expected human effort: 20–30 min per course.

---

## 11. Tracking & intelligence

### 11.1 Event taxonomy (closed list; adding a type = update this table + validator)
| type | payload | emitted by |
|---|---|---|
| `widget_loaded / opened / closed / expanded / resized / minimized` | `{w,h}` where relevant | widget |
| `message_sent` | `{conversation_id, message_id}` | API |
| `response_streamed` | `{message_id, latency_ms, tokens_out}` | API |
| `response_rated` | `{message_id, rating}` | widget |
| `source_clicked` / `diagram_viewed` / `diagram_zoomed` | `{message_id, asset_id/source}` | widget |
| `conversation_resumed` | `{conversation_id}` | widget |
| `page_view` | `{url, title, course, module, lesson}` | widget |
| `session_start / session_end` | `{duration_s}` | widget |
| `module_progress` | `{course, module, lesson, action: lesson_completed\|section_completed\|course_completed}` | Circle webhook |
| `member_joined` | `{}` | Circle webhook |
| `low_confidence_answer` / `no_kb_coverage` | `{message_id, confidence}` | API |

### 11.2 Scheduled jobs
| Job | Cadence | What it does |
|---|---|---|
| `score_signals` | every 15 min (recent activity) + daily full pass | Computes per-student `engagement_score` (0–100: recency, frequency, session depth, expansion rate, return visits) and `intent_score` (0–100: behavioral velocity vs. cohort median + conversational classifier below). Maps to labels: <30 `browsing`, 30–70 `engaged`, >70 `high_intent`. Label transitions to `high_intent` → `signal_alerts` row **with evidence** (quoted messages, behavior facts). |
| conversational classifier (inside score_signals) | — | LLM call over the student's recent messages returning strict JSON: `{question_depth: surface\|applying\|implementing, buying_language: bool, buying_quotes: [], win_detected: bool, win_quote}`. Buying language = pricing questions, "what comes after this course," coaching/upsell mentions. Wins → `win_detected` alert (testimonial material). |
| `cluster_questions` | nightly | Embeddings of last 30 days of user messages → cluster (HDBSCAN or threshold-agglomerative) → LLM labels each cluster → upsert `question_clusters` with counts, trend vs. prior period, linked lessons (from page context + retrieval sources), avg retrieval confidence. Clusters with avg confidence < 0.55 → `is_content_gap = true`. |
| `summarize_memory` | nightly, for students active that day | Distill conversations into `memory_summary_md` (≤300 words: their business, goals, sticking points, progress). Injected into future prompts (7.2 step 5). |
| `weekly_digest` | Mondays | Per-tenant email: top 5 questions, biggest confusion lesson, new high-intent students, content gaps, wins. |

### 11.3 Insight definitions (exact formulas, so every surface agrees)
- **Confusion Map:** for each lesson, `questions_attributed / active_students`, where a question attributes to a lesson via page context at ask-time or top retrieval source. Displayed as heat by module/lesson with plain-English headline (e.g. "Module 3 · Lesson 2 gets 4× the average questions").
- **Content Gap:** `question_clusters.is_content_gap` — shown as "Students keep asking X; your course doesn't cover it," with example verbatim questions.
- **Stall:** student had ≥3 active days in a 14-day window, then 14+ days inactive with course <80% complete.
- **Module velocity:** lessons completed per week (needs `module_progress` events) vs. cohort median.

---

## 12. Dashboards (one Next.js app, two role surfaces)

### 12.1 Design system (built in Phase 0, before any screen)
Design tokens (type scale, spacing grid, radii, light+dark palettes, elevation, motion durations) documented in `DESIGN.md` + Tailwind config. Every screen must implement its **empty state, loading skeleton, and error state** — PR checklist item. Quality bar: Stripe-dashboard calm; insight cards lead with a plain-English headline, numbers second, drill-down on click.

### 12.2 Client Portal (role: client_admin / client_viewer)
| Page | Contents |
|---|---|
| **Home / This Week** | Insight cards: top questions, biggest confusion lesson, new high-intent students, content gaps, usage trend, wins. Each card → drill-down. |
| **Questions** | Question Clusters ranked by volume w/ trend arrows; Confusion Map (module/lesson heat); Content Gap feed; low-rated & low-confidence answers for review. |
| **Students** | List: name, identity tier badge, engagement, intent label, last seen; sortable/filterable. Detail: profile, memory summary, progress timeline, full conversation history, signal history. |
| **Signals** | Alert feed (new/seen/actioned) with evidence quotes; digest email settings. |
| **Knowledge Base** | Courses → documents w/ processing status; chunk viewer; Diagram Curation Gallery; "ask the KB" test box. |
| **Assistant Studio** | Voice Guide editor (markdown, sectioned), behavior instructions, model settings (if allowed), version list w/ one-click rollback, **Playground** (test chat against draft config, side-by-side with active). |
| **Widget Setup** | Live-preview theming; embed snippet generator; Circle setup guide (code snippet + workflows/webhook steps, generated per tenant); install verification ("events received ✓"). |

### 12.3 Admin Console (role: owner)
| Page | Contents |
|---|---|
| **Tenants** | List + provision wizard (= onboarding checklist 9.4); suspend; impersonate ("View as client", audit-logged banner). |
| **Keys & Providers** | Per-tenant key table (kind, prefix, status, last used); rotate (grace-window dual validity); revoke; BYOK entry (write-only into Vault); Circle Admin token entry. |
| **Usage & Margin** | `usage_daily` per tenant: messages, tokens, cost; vs. plan price → margin; token budget caps + alert thresholds. |
| **Ingestion Ops** | All `pipeline_jobs` across tenants; error queue loud at top; retry buttons; per-source sync status. |
| **System Health** | API p50/p95 latency, error rate, LLM provider status, queue depth, webhook delivery failures. |
| **Prompt Studio (full)** | Everything in client Studio + raw assembled-prompt viewer + retrieval debugger ("show the chunks + scores for this question"). |
| **Audit Log** | Filterable everything. |

---

## 13. Security & quality bar (never weakened)

1. RLS on every tenant-scoped table + CI isolation tests (5.3.4).
2. All secrets in Vault; keys shown once at creation, then prefix-only. BYOK keys write-only.
3. Key rotation with grace window; all key ops + impersonation + prompt changes + KB edits → `audit_log`.
4. Rate limits per Widget Public Key (default 60 msg/hr/user, 1000/day/tenant — tenant-configurable) + per-tenant monthly token hard cap with alert at 80%.
5. Signed URLs (1h) for all assets; `approved` + same-tenant enforced.
6. Widget: DOMPurify on all rendered markdown; no `eval`; no third-party calls except our API.
7. Structured logs w/ tenant_id + request_id; Sentry on API + dashboard; uptime monitor on `/v1/chat`.
8. Staging + production; CI/CD; Postgres PITR backups.
9. Per-tenant data export (JSON) and hard-delete; per-student delete (GDPR-shaped).
10. Webhook endpoints: unguessable per-tenant path + optional shared secret; idempotent on redelivery.
11. LLM cost telemetry on every call (`messages.cost_usd`, `usage_daily`) from day one.
12. Prompt-injection hygiene: retrieved content and student messages are data, not instructions; system prompt states this; no tool-use surface exposed to students in v1.

---

## 14. Build phases with acceptance criteria

**Phase 0 — Foundations (~2 wks)**
Build: Supabase project (staging+prod), full schema §6 + RLS + isolation tests, Vault, CI/CD, design tokens + `DESIGN.md`, Estie data migration (existing chunks/voice guide → `documents`/`chunks`/`prompt_configs`), Worker reads DB instead of static files, cost telemetry.
✅ Done when: existing Estie bot answers identically from the DB; isolation tests pass in CI; every LLM call writes cost; static KB files deleted.

**Phase 1 — Chat runtime + Widget (~3 wks)**
Build: §7 endpoints (identify, chat SSE, events, rating), §8 widget complete, Circle identity flow (incl. Admin-API verification path), event taxonomy flowing.
✅ Done when: widget runs inside Estie's real Circle community; a signed-in member is identified (tier recorded); markdown streams smoothly; three states + drag-resize work on desktop, sheet on mobile; a full conversation survives page reload; all §11.1 widget events appear in `events`; widget errors never break the host page (tested by forcing API downtime).

**Phase 2 — Dashboards shell + Admin Console (~3–4 wks)**
Build: Next.js app, auth + roles, Admin Console complete (tenants, keys+rotation, usage/margin, ingestion ops stub, audit log, impersonation), Client Portal shell (Home layout, KB status, Assistant Studio + Playground, Widget Setup).
✅ Done when: a second test tenant can be created, keyed, themed, and served entirely from the UI (no SQL, no code); key rotation works without dropping live widget sessions; Estie (or you as her) can log in and edit+rollback her prompt config from the browser; every admin action appears in audit log.

**Phase 3 — Ingestion service (~3 wks)**
Build: connector framework (§9.1: upload first, then Circle generalized, then YouTube), `pipeline_jobs` runner, auto Voice Guide job, onboarding checklist UI, `context_mappings` auto-suggestion.
✅ Done when: a brand-new tenant goes from zero → working themed assistant using only the dashboard, in under one day of owner effort; a killed job resumes idempotently; pipeline failures are visible in Ingestion Ops within 1 minute.

**Phase 4 — Intelligence (~3 wks)**
Build: §11 jobs (signals, classifier, clustering, memory, digest), Circle webhook receiver + setup guide, Client Portal insight pages (Questions, Students, Signals, This Week).
✅ Done when: on Estie's real data — top-question clusters have sensible LLM labels; Confusion Map renders per lesson; a seeded high-intent test student triggers an alert with correct quoted evidence; memory summary visibly personalizes a follow-up session; Monday digest email sends.

**Phase 5 — Diagrams (~2–3 wks)**
Build: §10 pipeline, Curation Gallery, `[[asset:]]` resolution, widget inline SVG + lightbox.
✅ Done when: ≥1 full Estie course processed; ≥70% of approved diagrams are SVG recreations (rest raster); an on-topic student question surfaces the right diagram inline; nothing unapproved can be served (tested).

**Phase 6 — Commercial hardening (ongoing)**
Billing/plans, generic-website identity (HMAC `provider:"custom"` flow), data export/delete UI, more connectors (Kajabi, Teachable, Skool), public KB site, voice channel revisit.

*Phases 4 ↔ 5 may swap; intelligence sells better, diagrams demo better.* Total honest estimate: **~14–18 weeks**.

---

## 15. Decision log

**Locked:**
1. Supabase + Cloudflare Worker hybrid (system of record vs. edge).
2. Claude Sonnet default; per-tenant model config; BYOK supported.
3. Diagram strategy: SVG recreation w/ raster fallback, human curation gate.
4. Identity: `window.circleUser` + server-side Admin-API verification; three explicit tiers.
5. Progress tracking via Circle Workflows webhooks (not scraping).
6. Widget: vanilla TS + Shadow DOM, <50KB, fail-silent.
7. Whisper API for transcription; bge-base (Workers AI) embeddings with recorded model per row.
8. Dashboard: one Next.js app, role-gated; design system before screens.

**Open (owner decision needed, none block Phase 0–1):**
1. Queue tech for pipeline jobs: Supabase cron+queues vs. Cloudflare Queues (pick during Phase 0; bias to whichever needs less infra).
2. Pricing (setup fee + monthly + usage vs. BYOK-discounted). Telemetry supports any answer.
3. Product name + domain (needed before Phase 2 dashboard, for auth emails and CDN).
4. Email provider for digests (Resend vs. Postmark) — pick in Phase 4.
5. Whether Clients get model-settings access or Voice-Guide-only editing (default: Voice-Guide-only; owner can grant more per tenant).

## 16. Risks & mitigations
| Risk | Mitigation |
|---|---|
| Circle changes custom-code/`circleUser` behavior (explicitly unsupported by them) | Widget fail-silent; identity degrades gracefully to anonymous; connector isolated; monitor via `widget_loaded` event drop alerts |
| Client on Circle Professional (no API/webhooks) | Documented degraded mode: self_reported identity, no progress signals; upsell path to Business noted in onboarding |
| Diagram recreations misrepresent teaching | Curation gate is mandatory; side-by-side review; raster fallback |
| Assistant invents teachings in creator's voice | Standing prompt rule + `low_confidence_answer` logging + surfaced in Questions page for review |
| Cross-tenant leak | RLS + CI isolation suite; deploy blocked on failure |
| Heavy tenant blows up LLM costs | Per-tenant hard token caps + 80% alerts; BYOK option |
| One-person ops | Idempotent jobs, loud error queue, uptime alerts to owner |

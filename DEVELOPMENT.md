# Development coordination

## Shared local stack

Only the root integrator starts or stops shared services.

| Service | URL / port | Owner | Purpose |
|---|---|---|---|
| Console | `http://127.0.0.1:3100` | root integrator | the entire application |

The current console process is recorded by PID at runtime; never hard-code a PID
into source control. Agents use hot reload on the shared server and must not
launch another copy.

`apps/edge/` and `services/learning/` are README files, not processes. Do not
create one server per module.

## Parallel ownership

| Lane | Owns | Does not edit |
|---|---|---|
| Control plane | tenancy/auth/RLS, providers, audit/cost | feature UI route internals |
| Learning pipeline | source intake, scanning, extraction, cleanup, structure, versions, jobs | chat/runtime and tenant auth |
| Product experience | conversation, course workspace, creator/admin screens, interaction/accessibility | provider SDKs, database access |
| Root integration | root config, shared dev server, shared navigation, dependency changes, integration tests, Git | agent-owned route internals while active |

One file has one owner at a time. A lane requests shared-contract changes from
the root integrator instead of editing across boundaries.

## What is implemented

**This section describes behaviour, not packages.** It previously listed the
contents of a `packages/` directory in the present tense, which is how the
repository came to claim a privacy lifecycle, a 28-tool MCP and durable
PostgreSQL repositories that no code path ever executed. If you cannot name the
route and the RPC, it does not go in this list.

The authoritative capability-by-capability breakdown, with the honest gaps, is
in [README.md](README.md). In short, a signed-in user can:

- sign in, be forced through a password change, and select among their tenant
  memberships — with roles resolved from `public.identity_memberships`, never
  from a token claim;
- complete a durable onboarding workspace;
- administer the platform: tenants, sections, suspension, enter/exit, client
  provisioning and owner-claim minting;
- provision and manage client user accounts through the `learning-admin-users`
  edge function;
- configure the agent's name, brand, persona, tone and scope, and upload brand
  assets to private storage under RLS;
- author courses, modules, lessons and content blocks with optimistic
  concurrency, immutable revisions and rollback;
- publish a course, which projects its published content blocks into
  `knowledge_versions` / `learning_documents` / `learning_chunks` so the
  assistant can retrieve them;
- hold a grounded text conversation whose answers are refused rather than
  invented when retrieval returns nothing, with every turn persisted;
- hold a voice conversation, push-to-talk or continuous, where the spoken answer
  is the same grounded, already-saved answer the text path produces;
- see question intelligence and analytics carrying an explicit
  known/partial/unknown envelope computed in SQL;
- record lesson progress and usage events.

Uploaded files stop in quarantine. There is no privacy or GDPR code path. See
[README.md § Not yet built](README.md#not-yet-built) for the full list; do not
restate capability claims here.

## Honest delivery boundary

The console is a thin, well-secured client over the Supabase schema. The gaps
that matter are product gaps, not quality gaps:

- **Uploads terminate in quarantine.** No scanner, no extractor, no promotion
  RPC. Authored content is retrievable; uploaded files are not.
- **Privacy and GDPR have no code path.** Not a partial one — none. See
  [docs/PRIVACY-DATA-LIFECYCLE-SPEC.md](docs/PRIVACY-DATA-LIFECYCLE-SPEC.md).
- **Nine migrations exist only in the live database.** Read
  `infra/supabase/SCHEMA-DRIFT.md` before rebuilding. Re-running committed
  migrations against the live project downgrades the function that creates
  client users.
- **Edge functions have no deploy configuration.** No CI step, no
  `supabase functions deploy` in `hosted-release.mjs`. They were pushed by hand.
- **`packages/identity-access` is a verifier, not authentication.** Nothing
  imports it. The console authenticates through Supabase Auth.
- **There is no management MCP.** The package was deleted on 2026-07-26; it was
  never deployed and 27 of its 36 tools pointed at a removed API surface.
- **PostgreSQL security tests require Docker or an approved Supabase development
  project**, and have not executed on this machine.

Production realtime transport, IdP wiring, object storage, secret management,
billing reconciliation, approved retention policies and load/recovery evidence
remain unstarted production milestones — not partially delivered ones.

## Agent completion contract

Every task names its file allowlist, dependency assumptions, acceptance rows and
non-goals. Handoff includes changed files, checks, screenshots/evidence when UI
is involved, known limitations and any shared-contract request. Root
independently reviews and runs shared checks before integration.

A capability claim in a handoff, a README or a commit message must cite the
route and the RPC that implement it. "The package supports X" is not a claim
that the product does X.

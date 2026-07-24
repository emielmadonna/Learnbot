# Production launch plan

**Status:** active execution plan  
**Updated:** 2026-07-23  
**Current branch:** `codex/platform-foundations`

## Launch truth

The protected Vercel deployment is a complete product-surface preview, not a
production tenant environment. All current console routes are visible and the
shared contracts are extensively tested, but `/dev/*` remains intentionally
fixture-backed. Production completion means replacing those fixture
compositions behind the existing screens without weakening tenant, privacy,
provider or audit boundaries.

Estimated remaining effort is 35–45% of the full production scope. The majority
is live infrastructure integration and evidence, not visual reconstruction.

## Surface conversion inventory

| Surface | Current state | Production conversion required |
|---|---|---|
| Student conversation | High-fidelity integrated fixture | Durable conversation/evidence repositories, live model/files/realtime providers, reconnect and cost telemetry |
| Embedded course experience | Verified Widget runtime and fixture host | Signed embed bootstrap, production API adapter, custom-domain and LMS installation evidence |
| Course Studio | Authoring and ingestion contracts over memory repositories | Signed storage, scanning, extraction workers, durable revisions/indexes, concurrency and resumability |
| Creator workspace | Interactive but substantially UI-only | Durable weekly signals, questions, learner drill-down, exports and authorization |
| Creator intelligence | Validated evidence-aware fixture | Durable event/query adapters, source freshness, approved policy and human-review operations |
| Teacher workspace | Interactive but substantially UI-only | Real cohorts, notes, follow-up, learner progress and scoped exports |
| Branding | Fixture service plus browser persistence | Durable tenant branding/versioning, asset storage, publish/rollback and cache invalidation |
| Platform Admin | Mixed fixture and UI-preview controls | Real provisioning, memberships, service principals, providers, budgets, grants, audit and tenant closure |
| Privacy operations | Validated reversible fixture | Storage/vector/provider connectors, encrypted exports, durable legal holds and approved retention policy |
| Widget Lab | Verified framework-free runtime | Production adapter, CSP/install generator, domain allowlists and browser/LMS matrix |
| Management MCP | 28 tools contract-tested | Remote authenticated transport if needed, durable grants/metering/idempotency and connection-bound identity |

## Parallel execution lanes

### Lane A — durable platform and identity

1. Provision an approved staging Postgres/Supabase project in the approved
   region.
2. Apply all ordered migrations and execute the SQL/RLS negative suites.
3. Wire principals, memberships, invitations, SCIM and service principals into
   the console session boundary.
4. Add workflow-level transactions for invitation and SCIM operations.
5. Move command receipts, grant meters, audit, outbox, branding, authoring,
   conversation and upload intents to durable repositories.
6. Prove migration rollback, backup and point-in-time restore.

### Lane B — providers, ingestion and realtime

1. Configure server-side secret resolution and tenant provider policy.
2. Execute live text and embedding adapter acceptance with bounded test
   credentials.
3. Add transcription, speech and realtime voice adapters behind the existing
   neutral contracts.
4. Connect signed object storage, malware scanning, extraction/OCR/transcription
   and versioned embedding workers.
5. Add provider routing, fallback, deadlines, cost and trace telemetry.
6. Prove barge-in, reconnect/resume and same-conversation text/voice handoff.

### Lane C — product workflow conversion

1. Replace Student fixture composition with production services.
2. Complete Creator questions, students, weekly overview and intelligence
   workflows.
3. Complete Teacher cohort, notes, intervention and export workflows.
4. Complete fast Course Studio CRUD, asset handling, diagram review,
   preview/publish/rollback and keyboard workflows.
5. Wire Admin provisioning, providers, budgets, grants, audit and closure.
6. Wire Branding and Widget installation to versioned durable tenant settings.

### Lane D — privacy, security and operations

1. Obtain approved O-07 voice-recording and O-13 retention decisions.
2. Implement production access/export/delete/retention connectors and encrypted
   expiring exports.
3. Complete OIDC/SAML, SCIM, invitations, deprovisioning, KMS/Vault and BYOK.
4. Add CI migration gates, CSP/signed assets, traces, alerts, cost accounting and
   incident correlation.
5. Execute load, failure, backup/restore and incident-response exercises.
6. Complete accessibility, screen-reader, browser/LMS and custom-domain
   acceptance.

## Dependency order

```text
approved region + database + IdP + secret store
                  ↓
live identity and durable repositories
                  ↓
storage/scanner/workers + model/embedding adapters
                  ↓
realtime voice + production surface compositions
                  ↓
privacy connectors + operational exercises
                  ↓
production domain and controlled rollout
```

Lanes may proceed in parallel, but no product surface may be marked production
until Lane A establishes verified identity and durable tenant isolation.
Provider UI configuration must not precede server-side secret storage. Privacy
retention execution must remain blocked until O-13 is approved.

## External inputs required for the production environment

- Approved hosting and database region.
- A dedicated non-production Supabase/Postgres project followed by a separate
  production project.
- IdP application registrations and SAML/SCIM configuration where required.
- Server-side provider, object-storage, scanner and email credentials through
  the approved secret store.
- O-07 and O-13 owner decisions.
- Production domain, support/privacy contacts and repository visibility choice.

No existing unrelated cloud project or credential may be reused by assumption.

## Acceptance gates

Production launch requires all of the following:

- Every route authenticates through verified identity and selects an authorized
  tenant membership.
- Every tenant table, object key, queue message and provider operation passes
  positive and negative isolation tests.
- No production screen silently falls back to fixture, memory or browser-local
  data.
- Database migrations, rollback, backup and restore are executed and recorded.
- Live provider tests prove deadline, cancellation, fallback, safe error and cost
  behavior without exposing credentials.
- Voice proves interruption, barge-in, reconnect and text handoff without
  default raw-audio retention.
- Privacy jobs prove hold suppression, export integrity, deletion propagation,
  tombstones and immutable audit.
- MCP discovery and execution are principal-filtered, tenant-bound, metered,
  idempotent and audit-correlated.
- Accessibility, browser/LMS, load, recovery, monitoring and incident gates pass.
- The production deployment contains no fixture-preview acknowledgement values.

## Immediate release sequence

1. Ship the truthful protected launchpad so every preview surface is directly
   accessible.
2. Land durable upload persistence and the next production provider adapter.
3. Re-run full checks, browser acceptance, CI and protected-preview deployment.
4. Start Lane A against the approved staging infrastructure as soon as its
   project, region and IdP inputs are available.
5. Promote to production only after all acceptance gates above have live
   evidence.

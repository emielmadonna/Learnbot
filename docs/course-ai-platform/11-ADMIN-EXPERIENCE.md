# Admin Experience

## Areas

| Area | Required outcome |
|---|---|
| Tenants / onboarding | Provision and take a tenant from zero to verified install in <1 owner-day |
| Ingestion Ops | Course/source/job search, live progress, per-stage counts, loud failures, diff/impact preview, selective or bulk retry/cancel, idempotency |
| Providers & Keys | Tenant routes, capabilities, health, BYOK write-only secrets, rotate/revoke/test |
| Usage & Margin | Revenue, COGS, margin, budget, estimates/finals and ledger drill-down |
| System Health | latency/error/queue/webhook/provider health and affected tenants/capabilities |
| Prompt Studio | Creator controls plus assembled-prompt/retrieval debugging with PII-aware access |
| Audit | actor, tenant, action, target, diff, result, IP/request/trace and time |

## Onboarding

The ten v3 steps are tracked, resumable and auditable. Add provider route/funding setup, data/voice/recording consent, retention policy and owner QA. Every integration test shows capability gained and degraded behavior if absent. Go-live requires widget event receipt, scripted course QA, approved diagrams and accessible branding.

The Platform Owner can create or copy a tenant/course template, bulk import courses, inspect extraction failures across tenants, replay only failed stages, and hand control to a Creator without SQL or direct database access. Tenant and course context remain pinned in the header and every bulk action previews exact targets, cost estimate and rollback behavior.

Ingestion is observable as a stage graph (`received`, `scanning`, `extracting`, `normalizing`, `structuring`, `chunking`, `embedding`, `diagram_analysis`, `validating`, `ready`, `publishing`, `published`), with typed failure reasons and counts. Jobs expose the same identifiers and states in UI, API, events and management MCP.

## Dangerous actions

Suspend, delete, rotate/revoke, impersonate, publish and retry bulk jobs require exact target, impact and confirmation proportional to risk. Deletion/export jobs are asynchronous, idempotent, observable and produce an audit record. Secrets are shown only at creation where applicable; BYOK is never read back.

Admin mockups must include tenant onboarding, ingestion operations, Usage/COGS/Revenue/Margin and provider/key configuration in all universal states.

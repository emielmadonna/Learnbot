# Security and Tenancy

## Invariants

1. Tenant is derived from authenticated/public-key context and authorized at every boundary.
2. RLS protects every tenant table, including cost, events, audit, tools and derived intelligence.
3. Service-role access is confined to server/workers and still requires explicit tenant predicates.
4. Secrets remain in Vault; client payloads receive no secret, Vault ID or sensitive provider metadata.
5. Student/retrieved/tool content is data, never higher-priority instruction.

## Authorization

Roles: owner, client_admin, client_viewer, student and system-worker. Owner acting-tenant sessions are time-bound, reasoned, visibly bannered and audited. Capability policy is deny-by-default. Object authorization checks Tenant plus lifecycle state (for example, asset approved) rather than UUID possession.

## Threat controls

| Threat | Controls |
|---|---|
| Cross-tenant IDOR/query | RLS, scoped repositories, negative matrix tests |
| Spoofed Circle identity | self-reported tier until server verification |
| XSS/host compromise | Shadow DOM, DOMPurify, CSP-compatible bundle, no eval |
| Prompt/tool injection | instruction/data boundaries, allowlist/grants, schema and output validation |
| Secret leakage | Vault handles, redaction, write-only BYOK, rotation |
| Webhook spoof/replay | unguessable tenant URL, secret/signature where supported, timestamp/idempotency |
| Cost/DoS abuse | per-user/tenant limits, budgets, size/deadline limits, circuit breakers |
| Data over-retention | class policies, consent, export/delete jobs, minimal audit retention |

## Required tests

For every tenant table and API: Tenant A cannot list/get/create/update/delete Tenant B data; guessed IDs and signed URLs fail; anonymous/self-reported scopes are limited; owner impersonation is audited. Test revoked/rotating keys, webhook replay, rate/cost caps, unapproved assets, malicious markdown/SVG, prompt injection, tool escalation, log redaction and delete/export.

## Operational baseline

Separate staging/production, least-privilege service identities, dependency/secret scanning, protected migrations, backups/PITR and restore drill, structured redacted logs, alerts, incident runbook and audit immutability. Security acceptance gates deployment; exceptions require owner sign-off, expiry and tracked remediation.

Retention periods, regions and voice recording policy are open O-07/O-13 and must be configured before affected production collection.

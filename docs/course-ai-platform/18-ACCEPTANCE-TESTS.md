# Acceptance Tests

No phase or screen is complete until its applicable rows pass with retained evidence.

## Documentation

| ID | Acceptance |
|---|---|
| DOC-01 | `01` byte-matches legacy `/Users/emielmadonna/Estie Starr/PLAN.md`. |
| DOC-02 | Every local Markdown link resolves; all required files exist. |
| DOC-03 | v3 and brief requirements map to a topic document or explicit blocker/open decision. |
| DOC-04 | Locked/open/assumption/blocker labels contain no silent product invention. |

## Tenancy, security and audit

| ID | Acceptance |
|---|---|
| SEC-01 | For every tenant table/API/object action, Tenant A credentials cannot read/write/delete Tenant B data. |
| SEC-02 | RLS is enabled and tested; service operations require an explicit authorized tenant context. |
| SEC-03 | Vault/BYOK secrets never appear in client response, logs, traces, errors or audit diffs. |
| SEC-04 | Key rotation grace and revoke work without unauthorized fallback. |
| SEC-05 | Malicious markdown/SVG/retrieved/tool content cannot execute or change instruction/tool authority. |
| SEC-06 | Webhook spoof/replay and signed-asset guessed/cross-tenant access fail safely. |
| SEC-07 | Impersonation/prompt/key/KB/tool/provider actions create complete audit records. |
| SEC-08 | Export/delete completes idempotently and removes or de-identifies all applicable personal/vector data. |

## Providers, cost and resilience

| ID | Acceptance |
|---|---|
| PRO-01 | Domain packages have no named-provider SDK import; each capability has contract + adapter conformance tests. |
| PRO-02 | Per-Tenant primary/default/BYOK routing selects only compatible enabled adapters. |
| PRO-03 | Timeout, bounded retry, circuit open, compatible fallback and graceful degradation pass deterministic fixtures. |
| PRO-04 | Funding source never changes implicitly during fallback. |
| COST-01 | Every billable attempt produces an idempotent cost entry, including fallback legs and BYOK usage. |
| COST-02 | Estimated and final costs reconcile without double counting; margin formulas match ledger fixtures. |
| COST-03 | 80% alert and hard cap behave per tenant without losing existing data. |

## Widget and voice

| ID | Acceptance |
|---|---|
| WID-01 | Bundle <50KB gzipped, Shadow DOM isolation, no eval, host unaffected under forced failure. |
| WID-02 | Launcher/panel/expanded/mobile, resize persistence, page navigation and reload resume work. |
| WID-03 | Streaming sanitized Markdown, sources, approved diagrams, rating and telemetry work keyboard/touch/screen reader. |
| WID-04 | Anonymous/self-reported/verified flows show correct capability and never overstate identity. |
| VOI-01 | Push-to-talk, tap-to-start, partial/final captions, streaming speech and barge-in satisfy state contract. |
| VOI-02 | Permission/STT/TTS/realtime/network failures preserve input/history and continue in text. |
| VOI-03 | Privacy/capture/recording indicators are accurate; raw audio retention follows policy. |
| VOI-04 | Cloned/custom voice cannot be selected without active scope-specific Creator consent. |
| VOI-05 | Voice usage/fallback legs are costed and latency budgets are measured. |

## Intelligence and opportunities

| ID | Acceptance |
|---|---|
| INT-01 | Event types/payload versions validate; duplicate webhooks/events are idempotent. |
| INT-02 | Confusion, content-gap, stall and velocity fixtures match documented formulas. |
| INT-03 | Degraded/missing data yields partial/unknown, not false zero. |
| OPP-01 | Every surfaced Opportunity has same-tenant evidence, identity tier, policy version, confidence, freshness and expiry. |
| OPP-02 | Anonymous, revoked-consent, stale or insufficient-coverage cases suppress individual Opportunities. |
| OPP-03 | Lifecycle and false-positive feedback are audited; no autonomous outreach or consequential action occurs. |
| OPP-04 | Approved O-09 scoring fixtures are deterministic and calibration/backtest results meet owner-set thresholds. |

## Ingestion, diagrams and Creator/Admin

| ID | Acceptance |
|---|---|
| ING-01 | Zero-to-themed assistant completes through UI in <1 owner-day; killed jobs resume idempotently; errors appear <1 minute. |
| ING-02 | Legacy chunk algorithm preserves 1.8s pause, ~220-word target, 40-word overlap, wording and timestamps. |
| DIA-01 | Full-course test yields approved assets; SVG validates; raster fallback works; unapproved assets are impossible to serve. |
| UX-01 | All 12 required prototype groups are approved before corresponding UI completion. |
| UX-02 | Every screen passes empty/loading/populated/error/degraded/permission, responsive, keyboard, motion, success and recovery review. |
| UX-03 | Studio draft/active comparison uses identical inputs; publish/version/rollback and audit work. |
| ADM-01 | Second tenant can be provisioned, keyed, themed, ingested and installed without SQL/code. |

## MCP/tools

| ID | Acceptance |
|---|---|
| MCP-01 | Students have zero tools by default; Creator tools require tenant enablement and role grant. |
| MCP-02 | Unregistered/disabled/cross-tenant/expired/schema-invalid/over-limit calls are denied before remote invocation. |
| MCP-03 | Output is bounded/untrusted and cannot cause chained unauthorized invocation. |
| MCP-04 | Invocation authorization, risk, hashes/refs, status, latency, cost and trace are audited without secrets. |
| MCP-05 | Remote failure degrades safely; a new adapter/server requires no core chat modification. |

## Evidence format

Each run records commit, environment, command/manual steps, fixture/tenant IDs (non-secret), expected/actual, result, artifact/log reference, reviewer and timestamp. Live-host/provider assertions require live evidence; fakes prove contracts only.

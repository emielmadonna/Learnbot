# Course AI Platform engineering handoff

You are continuing the Course AI Platform in:

`/Users/emielmadonna/Documents/LearningBot`

Before changing code:

1. Read [the documentation index](00-README.md), then [Product Specification v3](01-PRODUCT-SPECIFICATION.md), [the Product Addendum](02-PRODUCT-ADDENDUM.md), and [Risks and Decisions](19-RISKS-AND-DECISIONS.md).
2. Read the topic document(s) for your work and the linked acceptance tests.
3. Inspect Git status and preserve user changes.
4. Treat `/Users/emielmadonna/Estie Starr` as read-only legacy input unless the owner explicitly authorizes migration or modification.
5. State the exact requirement IDs/sections you will implement. Do not invent open decisions.

Non-negotiable rules:

- Business logic depends on capability interfaces, never named-provider SDKs.
- Every tenant data path is tenant-scoped and protected by RLS plus service authorization.
- Secrets remain in Vault; never log or commit them.
- Raw Events are append-only; inferred intelligence cites evidence, version, confidence and freshness.
- Students receive no tools by default. All tool calls are authorized, rate-limited, logged, costed and audited.
- Voice is optional, preserves text continuity, exposes privacy state and falls back to text. Never assume cloning consent.
- Every variable provider operation writes cost telemetry.
- No dashboard screen is complete before its approved mockup and full state/behavior matrix.
- Never weaken security, consent, accessibility or isolation to make a phase pass.

Execution:

- Start with at most two concurrent workers after repository inspection; never exceed three.
- Keep scopes narrow and files disjoint.
- Do not run local LLMs.
- Serialize installs, builds, test suites, browser automation and media processing.
- Do not run multiple development servers. Record any PID and port; stop it when finished.
- Check memory pressure before intensive work.

Completion evidence for any slice:

1. exact files changed;
2. commands/tests run and their results;
3. acceptance rows satisfied;
4. security, tenancy, cost and degraded-mode effects;
5. open decisions, assumptions or external blockers;
6. screenshots or artifacts for UI work;
7. no claim of production readiness without live evidence where required.

Do not implement beyond the authorized slice. If documentation and code conflict, stop and report the mismatch.

# Provider Router

Provider-neutral execution policy for Course AI. The package imports only
`@course-ai/contracts`; named provider SDKs belong in separate adapter packages.

## Guarantees

- Tenant policy wins over the platform default.
- Platform defaults apply only to platform-funded requests.
- BYOK requires an exact tenant/funding policy and an adapter-bound Vault handle.
- Disabled, unhealthy, open-circuit, funding-incompatible, capability-incompatible,
  and feature-incompatible adapters are skipped.
- One absolute request deadline bounds every attempt. An attempt also receives
  the smaller per-attempt timeout.
- A retry is permitted only when `idempotent: true`; retries and fallbacks share
  `maxAttempts`.
- Circuit state is isolated by tenant, funding source, capability, and adapter.
- Fallback never changes `ProviderRequestContext.fundingSource`.
- `maxEstimatedCost` is enforced against a side-effect-free adapter estimate
  before provider execution. Missing, invalid, wrong-currency, or over-cap
  estimates fail closed, while an affordable compatible fallback may proceed.
- Every estimated provider leg is reserved before execution and committed with
  its actual estimated cost afterward. The in-memory reservation service is a
  deterministic fixture; a shared transactional service is required in production.
- A funding-source change requires all three controls: the source policy enables
  it, the caller supplies a transition request, and an authorizer validates a
  tenant/capability/source/target/expiry/policy-version-scoped grant. The target
  route is resolved again under the target funding source.
- Each executed leg emits attempt telemetry and an estimated cost fact, including
  failed, timed-out, fallback, and BYOK legs.
- Attempt IDs are deterministic. Process-local dedupe prevents duplicate cost
  entries when an idempotent request is replayed through the same router.
- Outbox-backed cost and provider-attempt sinks provide cross-instance,
  replay-safe enqueue semantics through one atomic `TelemetryOutboxStore`.
- An optional product-owned degradation function can return a typed reduced
  result after compatible routes are exhausted.

## Production integration

Construct `ProviderRouter` with a durable policy resolver, adapter registry,
cost-reservation service, funding-transition authorizer, cost sink, and attempt
telemetry sink. Persist circuit state in a shared store.
The included in-memory implementations and scripted adapters are deterministic
test fixtures, not production infrastructure.

Implement `TelemetryOutboxStore.put` as an atomic insert with a unique
`idempotencyKey`, then dispatch its cost and attempt envelopes asynchronously.
The outbox row should be created in the same database transaction as the owning
application fact. Implement cost reservations with atomic budget increments and
expiry recovery. Raw credentials are never accepted; only opaque Vault handles
cross into an adapter.

## Evidence

The deterministic Node test suite maps directly to PRO-01/02/03/04 and COST-01.
It proves cap denial occurs before adapter execution, cheaper fallback remains
eligible, BYOK never changes funding implicitly, valid grants permit only their
scoped transition, expired grants fail closed, and independent telemetry
recorders dedupe through a shared outbox.

Remaining external integration work is infrastructure-specific: implement the
policy/grant store, distributed circuit state, atomic budget reservations,
transactional outbox persistence/dispatch, and real adapters' side-effect-free
pricing estimates. Request-level result idempotency remains the responsibility
of the application boundary or provider adapter; telemetry dedupe does not make
a repeated provider call free.

## OpenAI Responses text adapter

`OpenAIResponsesAdapter` implements the provider-neutral `LLMProvider` contract
for typed Responses API text streaming. Model selection is request-scoped; the
adapter does not define a global model. Construct it with an asynchronous
credential resolver and, where needed, an injected `fetch`:

```ts
const adapter = new OpenAIResponsesAdapter({
  id: "openai-responses",
  credentialResolver: async (context) =>
    vault.resolveOpenAIAccessToken(context.tenantId),
});
```

The credential exists only at the server-side adapter boundary. It is excluded
from errors and provider metadata. The resolver receives the same abort signal
as the network request. The adapter enforces HTTPS, `store: false`,
the shared absolute deadline, bounded request/response/event sizes, complete SSE
termination, and safe request-id correlation. It never retries; retry, fallback,
routing, and model policy remain router responsibilities. The current adapter
intentionally supports text messages only and rejects tools, structured output,
and other unsupported features instead of silently changing their semantics.

## Scoped validation

```sh
pnpm --filter @course-ai/provider-router typecheck
pnpm --filter @course-ai/provider-router test
```

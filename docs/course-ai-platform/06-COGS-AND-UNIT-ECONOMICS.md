# COGS and Unit Economics

## Cost event

```ts
interface CostEntry {
  id: string; tenantId: string; requestId?: string; jobId?: string;
  capability: string; provider: string; modelOrSku?: string;
  quantity: number; unit: "input_token"|"output_token"|"image"|"minute"|"gb_month"|"gb"|"job"|"email"|"invocation";
  unitPrice: number; cost: number; currency: string;
  valuation: "estimated"|"final"; priceVersion: string;
  fundingSource: "platform"|"tenant_byok"; occurredAt: string;
  metadata: Record<string, string|number|boolean>;
}
```

Every router emits a ledger entry even when cost is zero, BYOK-funded, failed after billable work, or estimated.

## Allocation

Track ingestion (transcription, embeddings, vision/SVG, storage), runtime (LLM, rerank, vector, bandwidth), voice (STT/TTS/realtime minutes), operations (queues, email, analytics, observability, webhooks) and tools. Shared infrastructure is allocated by an explicit versioned driver; unallocated cost remains visible.

## Formulas

```text
provider_cogs = sum(final cost entries) or sum(estimated entries not yet finalized)
tenant_cogs = provider_cogs + allocated_shared_infrastructure
net_revenue = subscription + setup + usage_charges - discounts - credits - refunds
gross_margin_dollars = net_revenue - tenant_cogs
gross_margin_percent = gross_margin_dollars / net_revenue * 100
cost_per_active_student = tenant_cogs / active_students
cost_per_answer = chat_runtime_cogs / completed_answers
```

Never mix estimated and final values without labeling. Reconciliation supersedes estimates without double counting.

## Controls and screens

Per-tenant monthly budget, alert threshold (v3 default 80%), hard cap and capability-specific limits are configuration. At a cap: preserve history, reject or degrade expensive new work with clear UI, and never route to an unauthorized funding source.

Admin Usage & Margin provides period, tenant, capability, provider, model, funding and valuation filters; revenue/COGS/margin; cost trend; largest drivers; budget status; drill-through to ledger. Creator views show plan-appropriate usage and limits, not platform-wide pricing or other tenants.

Pricing is O-03. Documentation and telemetry must support setup + subscription + included usage, overage, credits and BYOK discount without choosing them.

## Acceptance

- Reconcile a sampled provider invoice to ledger within a documented tolerance.
- Retry/idempotency tests prove no double charge.
- BYOK appears as usage with funding source and provider cost treatment defined, never as hidden zero activity.
- Currency/price versions are immutable.
- Degraded/fallback operations attribute each provider leg separately.

# Learning pipeline

A deterministic, dependency-free reference implementation of the tenant-scoped
learning ingestion lifecycle. It provides one canonical state model for future
UI, API and management MCP adapters.

## Included

- validated tenant/source intake and non-leaking cross-tenant denials;
- staged validate, scan, extract, clean, structure, chunk, embed and diagram
  processing with typed failures;
- idempotent starts and resume from the failed stage;
- reusable cleanup recipes;
- exact legacy transcript pause/chunk constants: 1.8 seconds, 220 words and a
  40-word overlap, while retaining wording and timestamps;
- immutable content payloads inside draft, active and retired knowledge
  versions, optimistic atomic publish, and rollback;
- exact selective-reprocess impact previews that leave active retrieval
  untouched until publish;
- safe diagram candidates that always begin pending and require explicit review.

This package uses an in-memory store and deterministic local embeddings. It is a
domain/reference implementation, not the production durable worker, malware
scanner, extractor, vector provider or authorization layer.

## Scoped checks

```sh
pnpm --filter @course-ai/learning-pipeline typecheck
pnpm --filter @course-ai/learning-pipeline test
```

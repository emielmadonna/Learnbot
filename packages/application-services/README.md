# Application services

Provider-neutral application-service layer for the Course AI platform.

This package deliberately contains no database client, web framework, provider
SDK, or transport. It establishes the production boundary that HTTP handlers,
workers, the admin UI, and MCP tools should call. The included repositories are
tenant-partitioned in-memory implementations for development and contract
testing; production adapters can replace them without changing service methods.

## Invariants

- `AuthorizedTenantContext` is created only after tenant and actor checks.
- Every repository operation requires a non-empty tenant ID.
- Cross-tenant identifiers behave as not found and never reveal ownership.
- Mutations require idempotency keys and append an audit record.
- Variable-cost facts are append-only and idempotent.
- Provider names are data in ledger entries, never imported SDKs.
- Branding publication and rollback create immutable versions.

## Integration

Create one `PlatformApplicationServices` instance per process, inject a durable
repository adapter later, and pass the same instance to API/MCP handlers.
Transport code must derive `RequestContext.tenantId` from trusted identity,
never from request bodies.

```ts
const services = new PlatformApplicationServices(seed);
const context = authorizeTenantContext(request, tenant, "tenant_admin");
const courses = await services.listCourses(context);
```

Run package checks from the repository root:

```sh
pnpm --filter @course-ai/application-services typecheck
pnpm --filter @course-ai/application-services test
```

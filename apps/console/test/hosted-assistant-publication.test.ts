import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  HostedAssistantResolutionError,
  normalizeHostedSlug,
  resolveHostedAssistant,
} from "../src/app/c/[slug]/hosted-rpc";

const migration = readFileSync(
  new URL(
    "../../../infra/supabase/migrations/20260731011206_hosted_assistant_publications.sql",
    import.meta.url,
  ),
  "utf8",
);
const verification = readFileSync(
  new URL(
    "../../../infra/supabase/tests/hosted_assistant_publications_verification.sql",
    import.meta.url,
  ),
  "utf8",
);
const vectorOperatorFix = readFileSync(
  new URL(
    "../../../infra/supabase/migrations/20260731041400_fix_widget_vector_operator_search_path.sql",
    import.meta.url,
  ),
  "utf8",
);
const pageSource = readFileSync(
  new URL("../src/app/c/[slug]/page.tsx", import.meta.url),
  "utf8",
);
const askRouteSource = readFileSync(
  new URL("../src/app/c/[slug]/ask/route.ts", import.meta.url),
  "utf8",
);
const publicationApiSource = readFileSync(
  new URL(
    "../src/app/api/widget/hosted-publication/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const widgetPanelSource = readFileSync(
  new URL("../src/components/sections/widget-panel.tsx", import.meta.url),
  "utf8",
);
const publicationControlsSource = readFileSync(
  new URL(
    "../src/components/sections/hosted-publication-controls.tsx",
    import.meta.url,
  ),
  "utf8",
);

const key = `wk_${"a".repeat(40)}`;
const operationToken = "hosted-test-operation-token-with-32-characters";
const bootstrap = {
  ok: true,
  dataMode: "durable",
  deliveryKey: key,
  widget: {
    presentation: "panel",
    launcherPosition: "bottom-right",
    launcherLabel: "Ask",
    greeting: "Hello",
    anonymousQuestions: true,
    courses: [],
  },
  branding: {
    assistantName: "Pricing Lab Assistant",
    iconGlyph: null,
    primaryColor: "#4A637F",
    accentColor: "#4A637F",
    surfaceColor: "#FFFFFF",
    textColor: "#1D1D1F",
    fontFamily: "system",
    welcomeCopy: "Ask about the course.",
    launcherLabel: "Ask",
    launcherPosition: "bottom-right",
    voiceEnabled: false,
    logoObjectPath: null,
    avatarObjectPath: null,
    privacyUrl: null,
    termsUrl: null,
    supportUrl: null,
  },
};

test("hosted slugs normalize to the durable lowercase route contract", () => {
  assert.equal(normalizeHostedSlug(" Pricing-Lab "), "pricing-lab");
  assert.equal(normalizeHostedSlug("ab"), null);
  assert.equal(normalizeHostedSlug("-pricing"), null);
  assert.equal(normalizeHostedSlug("pricing/lab"), null);
  assert.equal(normalizeHostedSlug("pricing_lab"), null);
});

test("server resolution binds slug, origin and operation token exactly", async () => {
  const calls: Array<{
    name: string;
    params: Record<string, unknown> | undefined;
  }> = [];
  const client = {
    rpc(name: string, params?: Record<string, unknown>) {
      calls.push({ name, params });
      return Promise.resolve({ data: bootstrap, error: null });
    },
  } as unknown as SupabaseClient;

  const result = await resolveHostedAssistant(client, {
    slug: "Pricing-Lab",
    origin: "https://corso.example.test",
    operationToken,
  });
  assert.equal(result.deliveryKey, key);
  assert.equal(result.bootstrap.branding.assistantName, "Pricing Lab Assistant");
  assert.deepEqual(calls, [
    {
      name: "hosted_assistant_bootstrap",
      params: {
        slug: "pricing-lab",
        origin: "https://corso.example.test",
        operation_token: operationToken,
      },
    },
  ]);
});

test("a browser-visible bootstrap without a delivery key is refused server-side", async () => {
  const client = {
    rpc() {
      const { deliveryKey: _deliveryKey, ...publicBootstrap } = bootstrap;
      return Promise.resolve({ data: publicBootstrap, error: null });
    },
  } as unknown as SupabaseClient;

  await assert.rejects(
    resolveHostedAssistant(client, {
      slug: "pricing-lab",
      origin: "https://corso.example.test",
      operationToken,
    }),
    /Widget request denied/u,
  );
});

test("server-only reservation state prevents legacy fallback from bypassing lifecycle", async () => {
  for (const slugReserved of [true, false] as const) {
    const client = {
      rpc() {
        return Promise.resolve({
          data: {
            ok: false,
            code: "widget_unavailable",
            slugReserved,
          },
          error: null,
        });
      },
    } as unknown as SupabaseClient;
    await assert.rejects(
      resolveHostedAssistant(client, {
        slug: "pricing-lab",
        origin: "https://corso.example.test",
        operationToken,
      }),
      (error) =>
        error instanceof HostedAssistantResolutionError &&
        error.slugReserved === slugReserved,
    );
  }
});

test("migration permanently reserves slugs and keeps lifecycle behind RPCs", () => {
  for (const required of [
    "create table public.hosted_assistant_publications",
    "unique (slug)",
    "status in ('published', 'unpublished', 'superseded')",
    "hosted_assistant_publications_one_current_uq",
    "alter table public.hosted_assistant_publications force row level security",
    "hosted_assistant_publications_admin_read",
    "hosted_assistant_publications_deny_anon",
    "app_private.hosted_assistant_resolve",
    "public.hosted_assistant_bootstrap",
    "public.tenant_get_hosted_assistant_publication",
    "public.tenant_update_hosted_assistant_publication",
    "app_private.widget_resolve(k.widget_key, candidate_origin)",
    "app_private.learning_operation_token_is_valid",
    "app_private.onboarding_begin_command",
    "app_private.onboarding_complete_command",
    "pg_advisory_xact_lock",
    "'slug_unavailable'",
    "'version_conflict'",
    "'widget_not_ready'",
  ]) {
    assert.ok(migration.includes(required), `missing migration control: ${required}`);
  }
  assert.match(
    migration,
    /revoke all on table public\.hosted_assistant_publications[\s\S]*from public, anon, authenticated, service_role/u,
  );
  assert.match(
    migration,
    /grant execute on function public\.hosted_assistant_bootstrap\(text, text, text\)[\s\S]*to anon/u,
  );
  assert.doesNotMatch(
    migration,
    /grant (?:select|insert|update|delete|all)[\s\S]{0,100}hosted_assistant_publications[\s\S]{0,80}to anon/iu,
  );
});

test("lexical hosted retrieval can still resolve pgvector operators", () => {
  assert.match(
    vectorOperatorFix,
    /alter function app_private\.learning_chunk_matches[\s\S]*set search_path = pg_catalog, extensions/iu,
  );
});

test("canonical route keeps the delivery key on the server", () => {
  assert.match(pageSource, /resolveHostedAssistant/u);
  assert.match(pageSource, /legacyWidgetKey=\{null\}/u);
  assert.match(pageSource, /askEndpoint=\{`\/c\/\$\{/u);
  assert.doesNotMatch(pageSource, /widgetKey=\{resolution\.deliveryKey\}/u);

  assert.match(askRouteSource, /resolveHostedAssistant/u);
  assert.match(askRouteSource, /key: resolution\.deliveryKey/u);
  assert.match(askRouteSource, /POST as askWithWidgetKey/u);
  assert.match(askRouteSource, /origin === null/u);
});

test("legacy key fallback remains origin-gated and secondary", () => {
  const resolverIndex = pageSource.indexOf("resolveHostedAssistant(");
  const legacyIndex = pageSource.indexOf("isWidgetKey(legacyWidgetKey)");
  assert.ok(resolverIndex >= 0 && legacyIndex > resolverIndex);
  assert.match(pageSource, /widgetBootstrap\(createWidgetSupabaseClient\(\)/u);
  assert.match(pageSource, /operationToken\.length >= 32/u);
  assert.match(pageSource, /error\.slugReserved !== false/u);
});

test("publication API is authenticated, same-origin on writes and tenant-opaque", () => {
  assert.match(
    publicationApiSource,
    /authenticatedLearningClient\(request, \{\s*mutation: true/u,
  );
  assert.match(
    publicationApiSource,
    /tenant_update_hosted_assistant_publication/u,
  );
  assert.match(
    publicationApiSource,
    /tenant_get_hosted_assistant_publication/u,
  );
  assert.match(publicationApiSource, /getWidgetSettings/u);
  assert.match(publicationApiSource, /origin_not_allowed/u);
  assert.doesNotMatch(publicationApiSource, /tenantId|tenant_id/u);
  assert.doesNotMatch(publicationApiSource, /deliveryKey|widgetKey|widget_key/u);
});

test("widget settings exposes the complete friendly publication lifecycle", () => {
  assert.match(widgetPanelSource, /HostedPublicationControls/u);
  assert.match(
    widgetPanelSource,
    /savedOrigins=\{server\.baseline\.allowedOrigins\}/u,
  );
  assert.match(
    widgetPanelSource,
    /savedAnonymousAccess=\{server\.baseline\.anonymousAccess\}/u,
  );
  assert.match(publicationControlsSource, /\/api\/widget\/hosted-publication/u);
  assert.match(publicationControlsSource, /action === "unpublish"/u);
  assert.match(publicationControlsSource, /runAction\("publish"\)/u);
  assert.match(publicationControlsSource, /runAction\("change_slug"\)/u);
  assert.match(publicationControlsSource, /runAction\("unpublish"\)/u);
  assert.match(publicationControlsSource, /crypto\.randomUUID\(\)/u);
  assert.match(publicationControlsSource, /snapshot\.expectedVersion/u);
  assert.match(publicationControlsSource, /Add to domains/u);
  assert.match(publicationControlsSource, /Changing the address takes effect/u);
  assert.match(publicationControlsSource, /Yes, unpublish/u);
  assert.doesNotMatch(
    publicationControlsSource,
    /deliveryKey|widgetKey|widget_key/u,
  );
});

test("database verification covers public, lifecycle, RLS and replay cases", () => {
  for (const tag of ["HAP-01", "HAP-02", "HAP-03", "HAP-04"]) {
    assert.ok(verification.includes(tag), `missing verification tag ${tag}`);
  }
  assert.match(verification, /wrong origin|disallowed origin|evil\.example/u);
  assert.match(verification, /slug_unavailable/u);
  assert.match(verification, /idempotency_conflict/u);
  assert.match(verification, /version_conflict/u);
});

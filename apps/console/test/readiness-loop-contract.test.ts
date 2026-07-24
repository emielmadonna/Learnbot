import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const circleBuilder = source("../src/lib/circle-installation.ts");
const circleRuntime = source(
  "../public/integrations/circle-learningbot.js",
);
const circlePage = source("../src/app/install/circle/page.tsx");
const conversationPage = source("../src/app/app/conversation/page.tsx");
const conversationResponse = source(
  "../src/app/api/learning/respond/route.ts",
);
const usageRoute = source("../src/app/api/learning/events/route.ts");
const progressRoute = source("../src/app/app/progress/route.ts");
const adminPage = source("../src/app/app/admin/page.tsx");
const teacherPage = source("../src/app/app/teacher/page.tsx");
const entryPage = source("../src/app/app/entry/page.tsx");
const adminUsersRoute = source("../src/app/api/admin/users/route.ts");
const providerRuntime = source("../src/lib/provider-runtime.ts");
const learningProvider = source("../src/lib/learning-provider.ts");
const semanticSearch = source("../src/lib/semantic-learning-search.ts");
const embeddingsFunction = source(
  "../../../infra/supabase/functions/learning-embeddings/index.ts",
);
const deploymentMode = source("../src/lib/deployment-mode.ts");
const proxy = source("../src/proxy.ts");
const envExample = source("../../../.env.example");
const healthRoute = source("../src/app/api/health/route.ts");
const onboardingPage = source("../src/app/onboarding/page.tsx");

test("Circle client context is branded and tenant-bound without becoming auth", () => {
  for (const field of [
    "tenantId",
    "tenantSlug",
    "assistantName",
    "assistantPrimary",
    "assistantAccent",
    "assistantWelcome",
  ]) {
    assert.match(circleBuilder, new RegExp(`dataset\\.${field}`));
  }
  for (const queryKey of [
    "tenantId",
    "tenantSlug",
    "assistant",
    "assistantAccent",
    "welcome",
  ]) {
    assert.match(circleRuntime, new RegExp(`searchParams\\.set\\("${queryKey}"`));
  }
  assert.match(circlePage, /getOnboardingSnapshot/);
  assert.match(circlePage, /snapshot\.tenant\.tenantId/);
  assert.match(circlePage, /snapshot\.branding\.assistantName/);
  assert.match(conversationPage, /requireVerifiedUser/);
  assert.match(conversationPage, /getCurrentTenantContext/);
  assert.match(conversationPage, /workspace\.tenant\.displayName/);
  assert.doesNotMatch(
    conversationPage,
    /parameters\.(tenantId|tenantSlug)\b/,
  );
  assert.doesNotMatch(
    `${circleBuilder}\n${circleRuntime}`,
    /OPENAI_API_KEY|authorization|password|secret/i,
  );
});

test("questions, answers, usage and progress remain durable and tenant-scoped", () => {
  assert.match(conversationResponse, /learning_record_user_message/);
  assert.match(conversationResponse, /learning_record_assistant_message/);
  assert.match(conversationResponse, /message_modality/);
  assert.match(usageRoute, /learning_record_usage_event/);
  assert.match(progressRoute, /learning_mark_lesson_progress/);
  for (const page of [adminPage, teacherPage]) {
    assert.match(page, /\.from\("student_progress"\)/);
    assert.match(page, /\.from\("conversations"\)/);
    assert.match(page, /\.from\("messages"\)/);
    assert.match(page, /\.eq\("tenant_id", context\.tenantId\)/);
    assert.match(page, /\.eq\("actor_type", "student"\)/);
    assert.match(page, /\.eq\("status", "final"\)/);
  }
  assert.match(conversationPage, /UsageSignal eventName="conversation\.started"/);
});

test("role routing is explicit at entry points and account mutations", () => {
  assert.match(entryPage, /identityRole === "tenant_owner"/);
  assert.match(entryPage, /identityRole === "creator"/);
  assert.match(entryPage, /redirect\("\/app"\)/);
  assert.match(adminPage, /\["tenant_owner", "tenant_admin"\]/);
  assert.match(teacherPage, /\["creator", "teacher"\]/);
  assert.match(adminUsersRoute, /getCurrentTenantContext/);
  assert.match(adminUsersRoute, /\["tenant_owner", "tenant_admin"\]/);
  assert.match(adminUsersRoute, /learning-admin-users/);
});

test("Estie is the durable-surface fallback while tenant branding remains runtime data", () => {
  assert.match(onboardingPage, /defaultValue="Estie"/);
  assert.match(onboardingPage, /Estie’s prepared workspace/);
  assert.match(conversationPage, /brand\?\.assistantName \?\? "Estie"/);
  assert.match(circleRuntime, /const label = .*Ask Estie/);
  assert.match(circlePage, /snapshot\.branding\.welcomeMessage/);
});

test("provider and embedding failures degrade safely without credential disclosure", () => {
  for (const marker of [
    "authentication_failed",
    "provider_unavailable",
    "provider_error",
    "response_invalid",
    "controller.abort",
    "store: false",
  ]) {
    assert.ok(providerRuntime.includes(marker), `missing provider marker: ${marker}`);
  }
  assert.match(learningProvider, /provider_not_configured/);
  assert.match(learningProvider, /provider_failed/);
  assert.match(semanticSearch, /retrievalMode: "lexical_degraded"/);
  assert.match(embeddingsFunction, /provider_not_configured/);
  assert.match(embeddingsFunction, /embedding_provider_failed/);
  assert.match(embeddingsFunction, /provider_authentication_failed/);
  assert.match(embeddingsFunction, /provider_rate_limited/);
  assert.match(embeddingsFunction, /provider_timeout/);
  assert.match(embeddingsFunction, /lexicalFallback/);
  assert.match(embeddingsFunction, /learning_search_chunks/);
  assert.doesNotMatch(
    `${providerRuntime}\n${embeddingsFunction}`,
    /console\.(log|error).*apiKey|return.*apiKey/i,
  );
});

test("production deployment stays closed to fixture APIs and public secret exposure", () => {
  assert.match(deploymentMode, /environment\.NODE_ENV !== "production"/);
  assert.match(proxy, /startsWith\("\/dev"\)/);
  assert.match(proxy, /status: 404/);
  assert.match(proxy, /x-robots-tag/i);
  assert.match(envExample, /OPENAI_API_KEY_VAULT_REF/);
  assert.doesNotMatch(envExample, /^OPENAI_API_KEY=/m);
  assert.doesNotMatch(envExample, /^NEXT_PUBLIC_OPENAI_API_KEY=/m);
  assert.match(healthRoute, /Cache-Control/);
  assert.match(healthRoute, /status: "healthy"/);
  assert.doesNotMatch(circleRuntime, /Bearer |sk-[A-Za-z0-9]/);
});

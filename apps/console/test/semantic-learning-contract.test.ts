import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const clientSource = readFileSync(
  new URL(
    "../src/app/app/conversation/conversation-client.tsx",
    import.meta.url,
  ),
  "utf8",
);
const responseSource = readFileSync(
  new URL("../src/app/api/learning/respond/route.ts", import.meta.url),
  "utf8",
);
const providerSource = readFileSync(
  new URL("../src/lib/learning-provider.ts", import.meta.url),
  "utf8",
);
const searchSource = readFileSync(
  new URL("../src/lib/semantic-learning-search.ts", import.meta.url),
  "utf8",
);
const uploadSource = readFileSync(
  new URL("../src/app/api/learning/uploads/route.ts", import.meta.url),
  "utf8",
);
const edgeSource = readFileSync(
  new URL(
    "../../../infra/supabase/functions/learning-embeddings/index.ts",
    import.meta.url,
  ),
  "utf8",
);

test("learner can deliberately switch between explanation, practice, and checks", () => {
  assert.match(clientSource, /type LearningIntent = "explain" \| "practice" \| "check"/);
  assert.match(clientSource, /\["practice", "Practice", "Work through a scenario"\]/);
  assert.match(clientSource, /\["check", "Check me", "Test understanding one step at a time"\]/);
  assert.match(clientSource, /intent: learningIntent/);
  assert.match(providerSource, /Practice mode: create one realistic, source-grounded scenario/);
  assert.match(providerSource, /Knowledge-check mode: ask or evaluate one precise question at a time/);
});

test("selected lesson scope fails closed instead of citing another lesson", () => {
  assert.match(responseSource, /limit: lessonId \? 12 : 6/);
  assert.match(
    responseSource,
    /retrievedSources\.filter\(\(source\) => source\.lessonId === lessonId\)/,
  );
  assert.match(providerSource, /Do not use evidence from another lesson/);
});

test("semantic retrieval is authenticated and has an honest lexical fallback", () => {
  assert.match(searchSource, /\/functions\/v1\/learning-embeddings/);
  assert.match(searchSource, /retrievalMode: "lexical_degraded"/);
  assert.match(edgeSource, /client\.auth\.getUser\(token\)/);
  assert.match(edgeSource, /text-embedding-3-small/);
  assert.match(edgeSource, /dimensions: 384/);
  assert.doesNotMatch(edgeSource, /service_role/i);
});

test("grounded response authenticates and resolves tenant before provider readiness", () => {
  const authenticationIndex = responseSource.indexOf(
    "const supabase = await authenticatedLearningClient",
  );
  const tenantContextIndex = responseSource.indexOf(
    "const tenantContext = await getCurrentTenantContext",
  );
  const operationTokenIndex = responseSource.indexOf(
    "const operationToken =",
  );
  assert.ok(authenticationIndex >= 0);
  assert.ok(tenantContextIndex > authenticationIndex);
  assert.ok(operationTokenIndex > tenantContextIndex);
});

test("signed quarantine upload is authorized before a storage grant is created", () => {
  const tenantContextIndex = uploadSource.indexOf(
    "const context = await getCurrentTenantContext",
  );
  const roleCheckIndex = uploadSource.indexOf(
    "authorRoles.has(context.identityRole)",
  );
  const signingIndex = uploadSource.indexOf(".createSignedUploadUrl(");
  assert.ok(tenantContextIndex >= 0);
  assert.ok(roleCheckIndex > tenantContextIndex);
  assert.ok(signingIndex > roleCheckIndex);
  assert.match(uploadSource, /sizeBytes > 26_214_400/);
});

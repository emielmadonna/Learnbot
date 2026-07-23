import assert from "node:assert/strict";
import test from "node:test";

import { voiceSessionScopeMatches } from "../src/lib/voice-session-scope";

const owner = {
  tenantId: "tenant_alpha",
  actorId: "student_alpha",
};

test("voice session ownership accepts the exact tenant and actor", () => {
  assert.equal(voiceSessionScopeMatches(owner, owner), true);
});

test("voice session ownership denies another tenant", () => {
  assert.equal(
    voiceSessionScopeMatches(owner, {
      tenantId: "tenant_beta",
      actorId: owner.actorId,
    }),
    false,
  );
});

test("voice session ownership denies another actor in the same tenant", () => {
  assert.equal(
    voiceSessionScopeMatches(owner, {
      tenantId: owner.tenantId,
      actorId: "student_beta",
    }),
    false,
  );
});

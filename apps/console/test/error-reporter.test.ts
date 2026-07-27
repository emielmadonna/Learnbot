import assert from "node:assert/strict";
import test from "node:test";

import {
  errorKindOf,
  errorMessageOf,
  normalizeStack,
  stackDigestOf,
} from "../src/lib/observability/error-reporter";

/**
 * The whole value of in-house error tracking rests on grouping. If two
 * occurrences of one bug produce two fingerprints, the readout becomes a log
 * and the digest threshold never fires. These cover the normalizer that
 * decides it.
 */

function stackWith(paths: readonly string[]): string {
  return ["Error: something broke", ...paths.map((p) => `    at ${p}`)].join(
    "\n",
  );
}

test("normalizeStack drops the message line and keeps only frames", () => {
  const normalized = normalizeStack(
    stackWith(["handler (/srv/apps/console/src/route.ts:10:5)"]),
  );
  assert.equal(normalized.includes("something broke"), false);
  assert.equal(normalized.startsWith("at handler"), true);
});

test("line and column numbers do not affect the digest", async () => {
  const a = new Error("boom");
  a.stack = stackWith(["handler (/srv/apps/console/src/route.ts:10:5)"]);
  const b = new Error("boom");
  b.stack = stackWith(["handler (/srv/apps/console/src/route.ts:42:19)"]);

  assert.equal(await stackDigestOf(a), await stackDigestOf(b));
});

test("absolute path prefixes do not affect the digest", async () => {
  const local = new Error("boom");
  local.stack = stackWith(["handler (/Users/dev/proj/apps/console/src/a.ts:1:1)"]);
  const deployed = new Error("boom");
  deployed.stack = stackWith(["handler (/var/task/apps/console/src/a.ts:1:1)"]);

  assert.equal(await stackDigestOf(local), await stackDigestOf(deployed));
});

test("build hashes do not affect the digest", async () => {
  const before = new Error("boom");
  before.stack = stackWith(["handler (/apps/console/.next/chunks/a1b2c3d4e5.js:1:1)"]);
  const after = new Error("boom");
  after.stack = stackWith(["handler (/apps/console/.next/chunks/9f8e7d6c5b.js:1:1)"]);

  assert.equal(await stackDigestOf(before), await stackDigestOf(after));
});

test("genuinely different call sites stay in different groups", async () => {
  const first = new Error("boom");
  first.stack = stackWith(["readTenant (/apps/console/src/a.ts:1:1)"]);
  const second = new Error("boom");
  second.stack = stackWith(["writeTenant (/apps/console/src/b.ts:1:1)"]);

  assert.notEqual(await stackDigestOf(first), await stackDigestOf(second));
});

test("the error kind participates in the digest", async () => {
  const typeError = new TypeError("boom");
  typeError.stack = stackWith(["handler (/apps/console/src/a.ts:1:1)"]);
  const rangeError = new RangeError("boom");
  rangeError.stack = stackWith(["handler (/apps/console/src/a.ts:1:1)"]);

  assert.notEqual(await stackDigestOf(typeError), await stackDigestOf(rangeError));
});

test("the message does not participate in the digest", async () => {
  // The common case this protects: `User 4823 not found`. Grouping on the
  // message would produce one group per user.
  const first = new Error("User 4823 not found");
  first.stack = stackWith(["handler (/apps/console/src/a.ts:1:1)"]);
  const second = new Error("User 9971 not found");
  second.stack = stackWith(["handler (/apps/console/src/a.ts:1:1)"]);

  assert.equal(await stackDigestOf(first), await stackDigestOf(second));
});

test("a stackless throw still yields a stable digest", async () => {
  assert.equal(await stackDigestOf("plain string"), await stackDigestOf("other"));
  assert.match(await stackDigestOf(undefined), /^[0-9a-f]{64}$/);
});

test("errorKindOf names every throw shape", () => {
  assert.equal(errorKindOf(new TypeError("x")), "TypeError");
  assert.equal(errorKindOf("x"), "StringThrow");
  assert.equal(errorKindOf(null), "NullThrow");
  assert.equal(errorKindOf({ a: 1 }), "ObjectThrow");
  assert.equal(errorKindOf(7), "numberThrow");
});

test("errorMessageOf survives a value that cannot be serialized", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(typeof errorMessageOf(cyclic), "string");
});

test("the digest is a lowercase sha256 hex string", async () => {
  assert.match(await stackDigestOf(new Error("boom")), /^[0-9a-f]{64}$/);
});

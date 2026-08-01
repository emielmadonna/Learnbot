import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sectionDir = new URL("../src/components/sections/", import.meta.url);
const shellDir = new URL("../src/components/app-shell/", import.meta.url);
const excluded = new Set([
  "source-connectors.tsx",
  "visual-knowledge-manager.tsx",
]);

const files = [
  ...readdirSync(sectionDir)
    .filter((name) => name.endsWith(".tsx") && !excluded.has(name))
    .map((name) => new URL(name, sectionDir)),
  ...readdirSync(shellDir)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => new URL(name, shellDir)),
];

const auditedSources = files.map((url) => ({
  name: basename(url.pathname),
  text: readFileSync(url, "utf8"),
}));

test("authenticated console controls contain no literal no-op handlers", () => {
  for (const { name, text } of auditedSources) {
    assert.doesNotMatch(text, /onClick=\{\s*\(\s*\)\s*=>\s*\{\s*\}\s*\}/u, name);
    assert.doesNotMatch(text, /onSubmit=\{\s*\(\s*\)\s*=>\s*\{\s*\}\s*\}/u, name);
    assert.doesNotMatch(text, /onClick=\{\s*undefined\s*\}/u, name);
    assert.doesNotMatch(text, /disabled=\{\s*true\s*\}/u, name);
  }
});

test("authenticated console links do not use empty or script placeholder destinations", () => {
  for (const { name, text } of auditedSources) {
    assert.doesNotMatch(text, /href=["']\s*["']/u, name);
    assert.doesNotMatch(text, /href=["']javascript:/iu, name);
    assert.doesNotMatch(text, /href=["']#["']/u, name);
  }
});

test("literal fragment links resolve to a target in their owning section", () => {
  for (const { name, text } of auditedSources) {
    const fragments = [...text.matchAll(/href=["']#([a-z][\w-]*)["']/giu)];
    for (const fragment of fragments) {
      const id = fragment[1];
      assert.ok(
        text.includes(`id="${id}"`) ||
          text.includes(`id={'${id}'}`) ||
          text.includes(`id={"${id}"}`),
        `${name}: #${id} has no local target`,
      );
    }
  }
});

test("static authenticated form actions resolve to implemented app routes", () => {
  const appRoot = new URL("../src/app/", import.meta.url);
  for (const { name, text } of auditedSources) {
    const actions = [
      ...text.matchAll(/<form[\s\S]*?action=["'](\/[^"']+)["'][\s\S]*?>/giu),
    ];
    for (const match of actions) {
      const pathname = match[1]?.split("?")[0] ?? "";
      const route = join(fileURLToPath(appRoot), pathname, "route.ts");
      assert.doesNotThrow(() => readFileSync(route, "utf8"), `${name}: ${pathname}`);
    }
  }
});

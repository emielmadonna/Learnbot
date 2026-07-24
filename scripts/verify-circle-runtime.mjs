#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import vm from "node:vm";

const scriptUrl =
  process.env.CIRCLE_SCRIPT_URL ??
  "https://clone.stack-labs.ai/integrations/circle-learningbot.js";
const appUrl =
  process.env.CIRCLE_APP_URL ?? "https://clone.stack-labs.ai/app/conversation";
const localMode = scriptUrl === "file://local";
const source = localMode
  ? await readFile("apps/console/public/integrations/circle-learningbot.js", "utf8")
  : await (await fetch(scriptUrl, { signal: AbortSignal.timeout(20_000) })).text();

class HTMLScriptElement {}

const currentScript = new HTMLScriptElement();
currentScript.dataset = {
  appUrl,
  tenantId: "tenant-estie-test",
  tenantSlug: "estie-starr",
  assistantName: "Estie",
  assistantAccent: "#D8A653",
  assistantWelcome: "Welcome",
  assistantPrimary: "#205B46",
  label: "Ask Estie",
};

const appended = [];
const document = {
  currentScript,
  querySelector: () => null,
  createElement: (tag) => ({
    tag,
    dataset: {},
    style: {},
    setAttribute(key, value) {
      this[key] = value;
    },
    textContent: "",
    href: "",
    target: "",
    rel: "",
  }),
  body: { append: (node) => appended.push(node) },
};

vm.runInNewContext(source, { document, HTMLScriptElement, URL });
if (appended.length !== 1) throw new Error("Circle launcher was not created.");

const launcher = appended[0];
const launcherUrl = new URL(launcher.href);
for (const [key, expected] of [
  ["tenantId", "tenant-estie-test"],
  ["tenantSlug", "estie-starr"],
  ["assistant", "Estie"],
]) {
  if (launcherUrl.searchParams.get(key) !== expected) {
    throw new Error(`Circle launcher omitted client parameter: ${key}`);
  }
}
if (launcher.textContent !== "✦ Ask Estie") {
  throw new Error("Circle launcher label did not carry the assistant identity.");
}
if (launcher.target !== "_blank" || launcher.rel !== "noopener noreferrer") {
  throw new Error("Circle launcher link safety attributes are incomplete.");
}

console.log(`Circle runtime passed: ${localMode ? "local" : scriptUrl}`);

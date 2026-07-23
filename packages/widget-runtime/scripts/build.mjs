import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(packageRoot, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

execFileSync("pnpm", ["exec", "tsc", "-p", "tsconfig.json"], {
  cwd: packageRoot,
  stdio: "inherit",
});

const esmPath = resolve(dist, "index.js");
copyFileSync(esmPath, resolve(dist, "widget.esm.js"));

const esm = readFileSync(esmPath, "utf8");
const iifeBody = esm
  .replace(/^export\s+/gm, "")
  .replace(/\n\/\/# sourceMappingURL=.*$/m, "");
const iife = `(()=>{"use strict";\n${iifeBody}\ntry{const api=typeof globalThis.CourseAiWidgetRuntime==="object"&&globalThis.CourseAiWidgetRuntime!==null?globalThis.CourseAiWidgetRuntime:{};Object.assign(api,{CourseAiWidgetElement,autoMountCourseAiWidget,registerCourseAiWidget});globalThis.CourseAiWidgetRuntime=api;registerCourseAiWidget();autoMountCourseAiWidget();}catch{}\n})();\n`;

writeFileSync(resolve(dist, "widget.iife.js"), iife);
rmSync(esmPath);

for (const filename of ["widget.esm.js", "widget.iife.js"]) {
  const bytes = readFileSync(resolve(dist, filename));
  const source = bytes.toString("utf8");
  const gzipBytes = gzipSync(bytes, { level: 9 }).byteLength;
  process.stdout.write(`${filename}: ${bytes.byteLength} bytes raw, ${gzipBytes} bytes gzip\n`);
  if (gzipBytes >= 50 * 1024) {
    throw new Error(`${filename} exceeds the 50KB gzip budget`);
  }
  if (/\beval\s*\(|\bnew\s+Function\b/.test(source)) {
    throw new Error(`${filename} contains a forbidden dynamic-code primitive`);
  }
}

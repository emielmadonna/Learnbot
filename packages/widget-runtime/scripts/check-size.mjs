import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

for (const filename of ["widget.esm.js", "widget.iife.js"]) {
  const bytes = readFileSync(resolve("dist", filename));
  const gzipBytes = gzipSync(bytes, { level: 9 }).byteLength;
  console.log(`${filename}: ${gzipBytes} bytes gzip`);
  if (gzipBytes >= 50 * 1024) {
    process.exitCode = 1;
  }
}

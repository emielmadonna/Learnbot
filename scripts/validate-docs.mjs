import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const docsDirectory = resolve("docs/course-ai-platform");
const expectedFiles = [
  "00-README.md",
  "01-PRODUCT-SPECIFICATION.md",
  "02-PRODUCT-ADDENDUM.md",
  "03-SYSTEM-ARCHITECTURE.md",
  "04-DATA-AND-INTELLIGENCE.md",
  "05-STUDENT-OPPORTUNITY-ENGINE.md",
  "06-COGS-AND-UNIT-ECONOMICS.md",
  "07-UX-INFORMATION-ARCHITECTURE.md",
  "08-UI-DESIGN-SYSTEM.md",
  "09-WIDGET-EXPERIENCE.md",
  "10-CREATOR-EXPERIENCE.md",
  "11-ADMIN-EXPERIENCE.md",
  "12-PROVIDER-ROUTERS.md",
  "13-VOICE-MODE.md",
  "14-MCP-AND-TOOLS-ARCHITECTURE.md",
  "15-SECURITY-AND-TENANCY.md",
  "16-IMPLEMENTATION-PLAN.md",
  "17-PARALLEL-WORKSTREAMS.md",
  "18-ACCEPTANCE-TESTS.md",
  "19-RISKS-AND-DECISIONS.md",
  "HANDOFF-PROMPT.md"
];
const preservedSpecificationSha256 =
  "47e522582828f28d343705ef076acd5bbfe264a6ecdd3fea7cdee4719c8b9ca1";

const errors = [];

for (const file of expectedFiles) {
  if (!existsSync(join(docsDirectory, file))) {
    errors.push(`Missing required document: ${file}`);
  }
}

const specification = readFileSync(
  join(docsDirectory, "01-PRODUCT-SPECIFICATION.md")
);
const specificationHash = createHash("sha256")
  .update(specification)
  .digest("hex");

if (specificationHash !== preservedSpecificationSha256) {
  errors.push(
    "01-PRODUCT-SPECIFICATION.md no longer matches the preserved v3 source"
  );
}

function headingSlug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

for (const file of readdirSync(docsDirectory).filter((name) =>
  name.endsWith(".md")
)) {
  const sourcePath = join(docsDirectory, file);
  const source = readFileSync(sourcePath, "utf8");
  const links = source.matchAll(/\[[^\]]*]\(([^)]+)\)/g);

  for (const match of links) {
    const href = match[1].replace(/^<|>$/g, "");
    if (/^(https?:|mailto:)/.test(href)) continue;

    const [relativePath, encodedAnchor] = href.split("#");
    const targetPath = relativePath
      ? resolve(dirname(sourcePath), decodeURIComponent(relativePath))
      : sourcePath;

    if (!existsSync(targetPath)) {
      errors.push(`${file}: missing local link target ${href}`);
      continue;
    }

    if (encodedAnchor) {
      const target = readFileSync(targetPath, "utf8");
      const headings = target
        .split(/\r?\n/)
        .filter((line) => /^#{1,6} /.test(line))
        .map((line) => headingSlug(line.replace(/^#{1,6} /, "")));
      const anchor = decodeURIComponent(encodedAnchor);

      if (!headings.includes(anchor)) {
        errors.push(`${file}: missing anchor ${href}`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(
  `Documentation valid: ${expectedFiles.length} required files, preserved v3 hash, and local links`
);

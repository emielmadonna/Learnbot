import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const read = (relativePath) => readFileSync(resolve(root, relativePath), "utf8");

const types = read("apps/console/src/lib/knowledge-ingestion/types.ts");
const cleaner = read("apps/console/src/lib/knowledge-ingestion/clean.ts");
const workbench = read("apps/console/src/app/app/learning/knowledge-workbench.tsx");
const prepareRoute = read("apps/console/src/app/api/learning/knowledge/prepare/route.ts");

const report = {
  agentAssistedIntake: {
    status: /export function agentAssistedStarter/.test(cleaner) ? "working" : "blocked",
    evidence: "Deterministic local starter exists; it does not call a model or publish content.",
  },
  youtubeUrl: {
    status: /youtube/i.test(`${types}\n${workbench}\n${prepareRoute}`) ? "implemented" : "blocked",
    evidence: "No YouTube source type, URL field, or server-side extraction path is present.",
  },
  providerBoundary: {
    status: /embeddingStatus: "not_requested"/.test(prepareRoute) && /retrievalStatus: "not_available"/.test(prepareRoute)
      ? "explicit"
      : "unclear",
    evidence: "Draft preparation reports that embeddings and retrieval were not requested/available.",
  },
};

console.log(JSON.stringify(report, null, 2));

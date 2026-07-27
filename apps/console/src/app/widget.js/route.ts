import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { widgetHostAdapterSource } from "./embed-prelude";

/**
 * GET /widget.js
 *
 * The single file a customer pastes into their page:
 *
 *   <script src="https://learning.example.com/widget.js"
 *           data-tenant="wk_..."></script>
 *
 * It is the LearningBot host adapter followed by the built
 * `@course-ai/widget-runtime` IIFE. The runtime registers
 * `<course-ai-widget>`, reads `globalThis.CourseAiWidgetAdapter` (which the
 * prelude has just defined) and auto-mounts against the `data-tenant` widget
 * key.
 *
 * The artifact is produced by `pnpm --filter @course-ai/widget-runtime build`.
 * It is read from the workspace rather than copied into `public/`, because a
 * file at `public/widget.js` would shadow this route and lose the cache and
 * content-type guarantees below.
 */
// Cached by the `Cache-Control` header below rather than by Next's route
// cache, so that a redeploy of the runtime is picked up without a rebuild of
// the route and the ETag stays the source of truth.
export const dynamic = "force-dynamic";

const runtimeCandidates = [
  "../../packages/widget-runtime/dist/widget.iife.js",
  "packages/widget-runtime/dist/widget.iife.js",
  "../../../packages/widget-runtime/dist/widget.iife.js",
];

type Bundle = { body: string; etag: string };

let cachedBundle: Bundle | null = null;

function loadBundle(): Bundle | null {
  if (cachedBundle) return cachedBundle;
  for (const candidate of runtimeCandidates) {
    try {
      const runtime = readFileSync(resolve(process.cwd(), candidate), "utf8");
      const body = `${widgetHostAdapterSource}\n${runtime}`;
      cachedBundle = {
        body,
        etag: `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`,
      };
      return cachedBundle;
    } catch {
      // Try the next layout.
    }
  }
  return null;
}

export function GET(request: Request) {
  const bundle = loadBundle();
  if (bundle === null) {
    // Honest failure: the runtime was never built. Serving an empty script
    // would leave a silent, invisible widget on a customer's page.
    return new Response(
      "/* course-ai widget runtime artifact is missing; run: pnpm --filter @course-ai/widget-runtime build */\n",
      {
        status: 503,
        headers: {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const headers = {
    "Content-Type": "text/javascript; charset=utf-8",
    // The bundle is immutable for a given deployment and identical for every
    // tenant — it carries no tenant data at all — so it is safe to cache
    // publicly and for a long time. Tenant configuration is fetched separately
    // by /api/widget/config, which is `private, no-store`.
    "Cache-Control": "public, max-age=3600, s-maxage=86400, immutable",
    // Loaded by <script> from arbitrary customer pages, and readable by
    // `crossorigin` script tags and integrity checks.
    "Access-Control-Allow-Origin": "*",
    ETag: bundle.etag,
  };

  if (request.headers.get("if-none-match") === bundle.etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(bundle.body, { status: 200, headers });
}

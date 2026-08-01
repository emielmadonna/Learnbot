import { join } from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `/widget.js` is the one route that reads a file the compiler never sees:
  // it `readFileSync`s the built widget runtime out of the workspace at
  // request time (src/app/widget.js/route.ts). Next's output file tracing
  // works by following static imports, so that artifact is invisible to it and
  // is dropped from a standalone/serverless bundle — where the route then
  // answers its honest 503 ("runtime artifact is missing") and every embedded
  // widget on every customer page silently fails to boot. The console also
  // does not depend on @course-ai/widget-runtime in package.json, so there is
  // no workspace edge pulling it in either. Naming it here is what puts it in
  // the deployed bundle.
  outputFileTracingIncludes: {
    "/widget.js": ["../../packages/widget-runtime/dist/widget.iife.js"],
  },
  // The include above reaches outside `apps/console`, so tracing has to be
  // rooted at the workspace rather than at this app.
  outputFileTracingRoot: join(import.meta.dirname, "..", ".."),
  // Keep the hot-reload compiler isolated from optimized builds. This lets the
  // shared UI dev server stay online while another agent runs `next build`
  // without either process replacing the other's manifests.
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value:
              "camera=(), geolocation=(), microphone=(self), payment=(), usb=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;

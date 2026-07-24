import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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

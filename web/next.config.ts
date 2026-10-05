import type { NextConfig } from "next";

/**
 * API_INTERNAL_URL (e.g. http://api.railway.internal:4000) makes the web server
 * forward /api/v1/* to the API, so the browser talks to one origin: the refresh
 * cookie stays first-party and no CORS is needed. It is read at build time.
 * Leave it unset only when NEXT_PUBLIC_API_BASE_URL points the browser at the API.
 */
const apiInternalUrl = process.env.API_INTERNAL_URL?.trim().replace(/\/+$/, "");
const apiOrigin = process.env.NEXT_PUBLIC_API_BASE_URL?.trim().replace(/\/+$/, "");
const production = process.env.NODE_ENV === "production";

const contentSecurityPolicy = [
  "default-src 'self'",
  // Next.js inlines its bootstrap scripts; nonces would make every page dynamic.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${apiOrigin ? ` ${apiOrigin}` : ""}`,
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  output: "standalone",
  // This app is self-contained: trace from its own folder even though the
  // repository root also has a package.json, so the standalone server is
  // always emitted at .next/standalone/server.js.
  outputFileTracingRoot: __dirname,
  turbopack: { root: __dirname },
  poweredByHeader: false,
  async rewrites() {
    return apiInternalUrl ? [{ source: "/api/v1/:path*", destination: `${apiInternalUrl}/api/v1/:path*` }] : [];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          ...(production
            ? [
                { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
                { key: "Content-Security-Policy", value: contentSecurityPolicy },
              ]
            : []),
        ],
      },
    ];
  },
};

export default nextConfig;

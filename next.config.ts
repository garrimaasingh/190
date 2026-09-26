import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Hide the floating dev-tools pill / "Rendering…" badge — in the live
  // preview these floating overlays read as visual glitches during
  // navigation. Dev-only; production build unaffected.
  devIndicators: false,
  webpack: (config, { dev }) => {
    if (dev) {
      // Runtime-written artifacts live inside the project root (log files,
      // agent worklog, tool output, generated downloads). Without this, every
      // write churned the dev file watcher into a Fast Refresh rebuild, which
      // Next.js sometimes escalates to a full document reload — observed as a
      // white flash + skeleton + lost client state when switching views or
      // signing in. Merge our ignores into the default ignore pattern rather
      // than replacing it (the default excludes node_modules/.next/.git).
      const base = config.watchOptions?.ignored as RegExp | string | string[] | undefined;
      const extra =
        /(^|[\\/])([^\\/]*\.log|worklog\.md|tsconfig\.tsbuildinfo)$|(^|[\\/])(tool-results|download|scripts|db)([\\/]|$)/;
      const merged =
        base instanceof RegExp
          ? new RegExp(`${base.source}|${extra.source}`, base.flags)
          : base
            ? [...(Array.isArray(base) ? base : [base]), extra]
            : extra;
      config.watchOptions = { ...config.watchOptions, ignored: merged };
    }
    return config;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          // SAMEORIGIN (not DENY): the secure document viewer renders the
          // authorized stream in a same-origin sandboxed iframe. Cross-origin
          // framing is still refused — clickjacking protection intact.
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        // API surface: no caching of authenticated responses
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;

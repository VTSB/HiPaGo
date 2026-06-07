import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  ...(process.env.NEXT_OUTPUT === 'export' ? { output: 'export' as const } : {}),
  serverExternalPackages: [
    '@capacitor-community/sqlite',
    '@hipago/bypass-napi',
  ],
  turbopack: {
    resolveAlias: {
      '@capacitor-community/sqlite': { browser: './src/lib/db/adapters/noop.js' },
    },
  },
};

export default nextConfig;

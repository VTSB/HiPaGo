import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  ...(process.env.NEXT_OUTPUT === 'export' ? { output: 'export' as const } : {}),
  serverExternalPackages: [
    '@tauri-apps/plugin-sql',
    '@capacitor-community/sqlite',
  ],
  turbopack: {
    resolveAlias: {
      '@tauri-apps/plugin-sql': { browser: './src/lib/db/adapters/noop.js' },
      '@capacitor-community/sqlite': { browser: './src/lib/db/adapters/noop.js' },
    },
  },
};

export default nextConfig;

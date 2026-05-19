import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 30000,
    retry: 2,
    // vitest 4 removed `poolOptions.forks.singleFork`. `fileParallelism: false`
    // is its replacement — it forces maxWorkers to 1, so every test file runs
    // in one forks process. Preserves the OOM guard from commit 8f773da and
    // cuts the concurrent worker-startup storm that caused the CI flakes.
    pool: 'forks',
    fileParallelism: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'scripts/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**'],
      exclude: ['src/lib/db/**', '**/*.md', '**/*.json'],
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});

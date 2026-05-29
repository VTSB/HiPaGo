import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 30000,
    retry: 2,
    // Serial was ~30min: each of ~85 files reconstructs a jsdom environment
    // (~29s/file on this WSL2 9p mounted FS), and that env-construction dominates
    // the wall (a single file: env 29s, import 8s, tests 16ms). vmForks reuses the
    // expensive jsdom environment PER WORKER while isolating each file's module
    // registry in its own VM context — so we pay env construction once per worker,
    // not once per file, without the mock-registry collisions that plain
    // isolate:false causes (many files mock @/lib/store/settings, useT, platform
    // with different shapes; a shared registry makes which file fails depend on
    // worker scheduling). maxForks:4 bounds 9p I/O contention so no worker hits
    // vitest's hardcoded 60s START_TIMEOUT. Result: ~75s, fully green, deterministic
    // (~25x faster). happy-dom would also work but is uninstallable on this FS.
    pool: 'vmForks',
    poolOptions: { vmForks: { maxForks: 4, minForks: 1 } },
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

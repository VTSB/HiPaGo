// @vitest-environment node
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BuildInterruptedError,
  HIDE_DIRS,
  cleanNextBuildState,
  restoreBuildBackup,
  runStaticBuild,
} from '../build-static.mjs';

const tempDirs: string[] = [];
const TEST_LOCK_OPTIONS = {
  stale: 5_000,
  update: 1_000,
  retries: {
    retries: 100,
    factor: 1,
    minTimeout: 20,
    maxTimeout: 20,
    randomize: false,
  },
};

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'hipago-build-static-'));
  tempDirs.push(root);
  return root;
}

function markerPath(root: string, hiddenDir: string): string {
  return join(root, hiddenDir, 'fixture.txt');
}

function writeSources(root: string, prefix: string): void {
  for (const [index, hiddenDir] of HIDE_DIRS.entries()) {
    const marker = markerPath(root, hiddenDir);
    mkdirSync(join(marker, '..'), { recursive: true });
    writeFileSync(marker, `${prefix}-${index}`);
  }
}

function expectSources(root: string, prefix: string): void {
  for (const [index, hiddenDir] of HIDE_DIRS.entries()) {
    expect(readFileSync(markerPath(root, hiddenDir), 'utf8')).toBe(`${prefix}-${index}`);
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('build-static source protection', () => {
  it('removes stale dev route types before hiding sources and starting the build', async () => {
    const root = makeFixture();
    writeSources(root, 'source');
    const staleValidator = join(root, '.next/dev/types/validator.ts');
    mkdirSync(join(root, '.next/dev/types'), { recursive: true });
    writeFileSync(staleValidator, 'import type T from "../../src/app/(main)/gallery/[id]/page";');

    await runStaticBuild({
      rootDir: root,
      log: () => {},
      signalEmitter: null,
      lockOptions: TEST_LOCK_OPTIONS,
      build: async () => {
        expect(existsSync(join(root, '.next'))).toBe(false);
        for (const hiddenDir of HIDE_DIRS) expect(existsSync(join(root, hiddenDir))).toBe(false);
      },
    });

    expect(existsSync(join(root, '.next'))).toBe(false);
    expectSources(root, 'source');
  });

  it('refuses to delete a non-directory .next path', () => {
    const root = makeFixture();
    writeFileSync(join(root, '.next'), 'not generated build state');

    expect(() => cleanNextBuildState(root, () => {})).toThrow(
      'Refusing to remove non-directory or linked Next.js state',
    );
    expect(readFileSync(join(root, '.next'), 'utf8')).toBe('not generated build state');
  });

  it('recovers an interrupted backup before taking the next build backup', async () => {
    const root = makeFixture();
    const backupRoot = join(root, '.build-backup');
    writeSources(backupRoot, 'original');
    const logs: string[] = [];

    await runStaticBuild({
      rootDir: root,
      log: (message: string) => logs.push(message),
      signalEmitter: null,
      lockOptions: TEST_LOCK_OPTIONS,
      build: async () => {
        for (const hiddenDir of HIDE_DIRS) {
          expect(existsSync(join(root, hiddenDir))).toBe(false);
          expect(existsSync(join(backupRoot, hiddenDir))).toBe(true);
        }
      },
    });

    expect(logs.findIndex((message) => message.startsWith('Restored:'))).toBeLessThan(
      logs.findIndex((message) => message.startsWith('Hidden:')),
    );
    expectSources(root, 'original');
    expect(existsSync(backupRoot)).toBe(false);
    expect(existsSync(join(root, '.build-static.lock'))).toBe(false);
  });

  it('fails closed and preserves both trees when backup recovery finds a conflict', () => {
    const root = makeFixture();
    const backupRoot = join(root, '.build-backup');
    const hiddenDir = HIDE_DIRS[0];
    mkdirSync(join(root, hiddenDir), { recursive: true });
    mkdirSync(join(backupRoot, hiddenDir), { recursive: true });
    writeFileSync(markerPath(root, hiddenDir), 'live-change');
    writeFileSync(markerPath(backupRoot, hiddenDir), 'saved-original');

    expect(() => restoreBuildBackup({ rootDir: root, log: () => {} })).toThrow(
      'both source and .build-backup contain different content',
    );
    expect(readFileSync(markerPath(root, hiddenDir), 'utf8')).toBe('live-change');
    expect(readFileSync(markerPath(backupRoot, hiddenDir), 'utf8')).toBe('saved-original');
  });

  it('serializes concurrent builds for the same repository', async () => {
    const root = makeFixture();
    writeSources(root, 'source');
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const order: string[] = [];

    const first = runStaticBuild({
      rootDir: root,
      log: () => {},
      signalEmitter: null,
      lockOptions: TEST_LOCK_OPTIONS,
      build: async () => {
        order.push('first-start');
        firstStarted.resolve();
        await releaseFirst.promise;
        order.push('first-end');
      },
    });
    await firstStarted.promise;

    const second = runStaticBuild({
      rootDir: root,
      log: () => {},
      signalEmitter: null,
      lockOptions: TEST_LOCK_OPTIONS,
      build: async () => {
        order.push('second-start');
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(order).toEqual(['first-start']);
    releaseFirst.resolve();

    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
    expectSources(root, 'source');
    expect(existsSync(join(root, '.build-backup'))).toBe(false);
    expect(existsSync(join(root, '.build-static.lock'))).toBe(false);
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'restores sources and releases the lock after %s',
    async (interruptSignal) => {
      const root = makeFixture();
      writeSources(root, 'source');
      const signalEmitter = new EventEmitter();
      const buildStarted = deferred();

      const build = runStaticBuild({
        rootDir: root,
        log: () => {},
        signalEmitter,
        lockOptions: TEST_LOCK_OPTIONS,
        build: ({ signal }: { signal: AbortSignal }) =>
          new Promise<void>((_resolve, reject) => {
            buildStarted.resolve();
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      });

      await buildStarted.promise;
      expect(existsSync(join(root, '.build-backup'))).toBe(true);
      for (const hiddenDir of HIDE_DIRS) expect(existsSync(join(root, hiddenDir))).toBe(false);

      signalEmitter.emit(interruptSignal);

      await expect(build).rejects.toMatchObject(new BuildInterruptedError(interruptSignal));
      expectSources(root, 'source');
      expect(existsSync(join(root, '.build-backup'))).toBe(false);
      expect(existsSync(join(root, '.build-static.lock'))).toBe(false);
      expect(signalEmitter.listenerCount('SIGINT')).toBe(0);
      expect(signalEmitter.listenerCount('SIGTERM')).toBe(0);
    },
  );
});

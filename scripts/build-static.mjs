#!/usr/bin/env node
// Cross-platform static export build for native platforms (Tauri/Capacitor).
// Temporarily hides API routes and dynamic pages incompatible with static export.
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = join(dirname(scriptPath), '..');

export const HIDE_DIRS = [
  'src/app/api',
  'src/app/(main)/gallery/[id]',
  'src/app/(reader)/gallery/[id]',
];

const DEFAULT_LOCK_OPTIONS = {
  realpath: false,
  // Source/backup verification and `.next` cleanup are intentionally
  // synchronous so crash recovery can fail closed. On a large Windows build
  // tree those operations can block the event loop long enough to delay the
  // lock heartbeat, so do not let another process steal a live build lock.
  stale: 600_000,
  update: 10_000,
  retries: {
    retries: 900,
    factor: 1,
    minTimeout: 1_000,
    maxTimeout: 1_000,
    randomize: true,
  },
};

/**
 * @typedef {{
 *   on: (signal: string, handler: () => void) => unknown,
 *   off?: (signal: string, handler: () => void) => unknown,
 *   removeListener: (signal: string, handler: () => void) => unknown,
 * }} SignalEmitter
 */

export class BuildInterruptedError extends Error {
  constructor(signal) {
    super(`Static export interrupted by ${signal}`);
    this.name = 'BuildInterruptedError';
    this.signal = signal;
  }
}

function backupPath(rootDir) {
  return join(rootDir, '.build-backup');
}

function lockTarget(rootDir) {
  // proper-lockfile appends `.lock`. Keeping the target inside the repository
  // avoids a sibling `<repo>.lock` path and makes the lock repository-scoped.
  return join(rootDir, '.build-static');
}

function normalizedRelative(rootDir, path) {
  return relative(rootDir, path).split(sep).join('/');
}

function isAllowedBackupEntry(relativePath, hideDirs, isDirectory) {
  return hideDirs.some((hiddenDir) => {
    if (relativePath === hiddenDir || relativePath.startsWith(`${hiddenDir}/`)) return true;
    return isDirectory && hiddenDir.startsWith(`${relativePath}/`);
  });
}

function validateBackupLayout(backupDir, hideDirs) {
  const rootStat = lstatSync(backupDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Static build backup is not a regular directory: ${backupDir}`);
  }

  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      const relativePath = normalizedRelative(backupDir, entryPath);
      const isDirectory = entry.isDirectory() && !entry.isSymbolicLink();
      if (!isAllowedBackupEntry(relativePath, hideDirs, isDirectory)) {
        throw new Error(`Unexpected path in static build backup: ${relativePath}`);
      }
      if (isDirectory) visit(entryPath);
    }
  };

  visit(backupDir);
}

function pathsAreEquivalent(left, right) {
  const leftStat = lstatSync(left);
  const rightStat = lstatSync(right);

  if (leftStat.isSymbolicLink() || rightStat.isSymbolicLink()) {
    return (
      leftStat.isSymbolicLink() &&
      rightStat.isSymbolicLink() &&
      readlinkSync(left) === readlinkSync(right)
    );
  }

  if (leftStat.isDirectory() || rightStat.isDirectory()) {
    if (!leftStat.isDirectory() || !rightStat.isDirectory()) return false;
    const leftEntries = readdirSync(left).sort();
    const rightEntries = readdirSync(right).sort();
    if (
      leftEntries.length !== rightEntries.length ||
      leftEntries.some((entry, index) => entry !== rightEntries[index])
    ) {
      return false;
    }
    return leftEntries.every((entry) => pathsAreEquivalent(join(left, entry), join(right, entry)));
  }

  if (!leftStat.isFile() || !rightStat.isFile() || leftStat.size !== rightStat.size) return false;
  return readFileSync(left).equals(readFileSync(right));
}

/**
 * Restore a previous interrupted build before taking a new backup. Moves are
 * atomic because `.build-backup` is on the same filesystem as the source tree.
 * A conflicting live source is never deleted: identical old copy/restore pairs
 * are deduplicated, while differing content fails closed with both copies kept.
 */
export function restoreBuildBackup({
  rootDir = defaultRoot,
  hideDirs = HIDE_DIRS,
  log = console.log,
} = {}) {
  const backupDir = backupPath(rootDir);
  if (!existsSync(backupDir)) return false;

  validateBackupLayout(backupDir, hideDirs);

  // Preflight every conflict before moving or deleting anything.
  for (const hiddenDir of hideDirs) {
    const saved = join(backupDir, hiddenDir);
    const source = join(rootDir, hiddenDir);
    if (existsSync(saved) && existsSync(source) && !pathsAreEquivalent(saved, source)) {
      throw new Error(
        `Cannot safely restore ${hiddenDir}: both source and .build-backup contain different content`,
      );
    }
  }

  for (const hiddenDir of hideDirs) {
    const saved = join(backupDir, hiddenDir);
    if (!existsSync(saved)) continue;

    const source = join(rootDir, hiddenDir);
    if (existsSync(source)) {
      // An older copy/delete implementation may have been interrupted after the
      // copy completed. The preflight proved these trees are byte-identical.
      rmSync(saved, { recursive: true, force: true });
    } else {
      mkdirSync(dirname(source), { recursive: true });
      renameSync(saved, source);
    }
    log(`Restored: ${hiddenDir}`);
  }

  // Layout validation proved any remaining entries are only empty ancestors of
  // HIDE_DIRS, so this cannot remove unrelated data.
  rmSync(backupDir, { recursive: true, force: true });
  return true;
}

export function hideStaticSources({
  rootDir = defaultRoot,
  hideDirs = HIDE_DIRS,
  log = console.log,
} = {}) {
  const backupDir = backupPath(rootDir);
  if (existsSync(backupDir)) {
    throw new Error('Static build backup still exists; refusing to overwrite it');
  }

  mkdirSync(backupDir, { recursive: true });
  for (const hiddenDir of hideDirs) {
    const source = join(rootDir, hiddenDir);
    if (!existsSync(source)) continue;

    const saved = join(backupDir, hiddenDir);
    mkdirSync(dirname(saved), { recursive: true });
    renameSync(source, saved);
    log(`Hidden: ${hiddenDir}`);
  }
}

/** Remove only Next.js-generated state so dev route types cannot pollute an export build. */
export function cleanNextBuildState(rootDir = defaultRoot, log = console.log) {
  const nextDir = join(rootDir, '.next');
  if (!existsSync(nextDir)) return false;

  const nextStat = lstatSync(nextDir);
  if (!nextStat.isDirectory() || nextStat.isSymbolicLink()) {
    throw new Error(`Refusing to remove non-directory or linked Next.js state: ${nextDir}`);
  }

  rmSync(nextDir, { recursive: true, force: true });
  log('Removed generated Next.js state: .next');
  return true;
}

export function createCleanUrlAliases(rootDir = defaultRoot, log = console.log) {
  const outDir = join(rootDir, 'out');
  if (!existsSync(outDir)) return;

  for (const entry of readdirSync(outDir)) {
    if (!entry.endsWith('.html')) continue;
    if (entry === 'index.html' || entry === '404.html' || entry === '_not-found.html') continue;

    const routeName = basename(entry, '.html');
    const routeDir = join(outDir, routeName);
    if (existsSync(routeDir) && !statSync(routeDir).isDirectory()) continue;
    mkdirSync(routeDir, { recursive: true });
    copyFileSync(join(outDir, entry), join(routeDir, 'index.html'));
    log(`Created clean URL alias: out/${routeName}/index.html`);
  }
}

function createSpaFallbacks(rootDir, log) {
  const indexHtml = join(rootDir, 'out/index.html');
  if (!existsSync(indexHtml)) return;

  for (const route of ['gallery', 'reader']) {
    const fallbackDir = join(rootDir, 'out', route);
    mkdirSync(fallbackDir, { recursive: true });
    copyFileSync(indexHtml, join(fallbackDir, 'index.html'));
    log(`Created SPA fallback: out/${route}/index.html`);
  }
}

function runNextBuild({ rootDir, signal }) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal.aborted) {
      rejectPromise(signal.reason);
      return;
    }

    const nextBin = join(rootDir, 'node_modules/next/dist/bin/next');
    const child = spawn(process.execPath, [nextBin, 'build'], {
      cwd: rootDir,
      stdio: 'inherit',
      env: { ...process.env, NEXT_OUTPUT: 'export' },
    });
    let settled = false;
    let forceKillTimer;

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      callback(value);
    };

    const onAbort = () => {
      if (!child.killed) child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 5_000);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error) => settle(rejectPromise, error));
    child.once('close', (code, childSignal) => {
      if (signal.aborted) {
        settle(rejectPromise, signal.reason);
      } else if (code === 0) {
        settle(resolvePromise);
      } else {
        settle(
          rejectPromise,
          new Error(
            `Next.js static build failed (exit ${code ?? 'unknown'}, signal ${childSignal ?? 'none'})`,
          ),
        );
      }
    });
  });
}

/**
 * @param {SignalEmitter | null} signalEmitter
 * @param {AbortController} abortController
 */
function installSignalHandlers(signalEmitter, abortController) {
  if (!signalEmitter) return () => {};

  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      if (!abortController.signal.aborted) {
        abortController.abort(new BuildInterruptedError(signal));
      }
    };
    handlers.set(signal, handler);
    signalEmitter.on(signal, handler);
  }

  return () => {
    for (const [signal, handler] of handlers) {
      if (typeof signalEmitter.off === 'function') signalEmitter.off(signal, handler);
      else signalEmitter.removeListener(signal, handler);
    }
  };
}

async function releaseAfterRestore(release, restoreOptions) {
  let cleanupError;
  try {
    restoreBuildBackup(restoreOptions);
  } catch (error) {
    cleanupError = error;
  }

  try {
    await release();
  } catch (error) {
    cleanupError = cleanupError
      ? new AggregateError(
          [cleanupError, error],
          'Static build restore and lock release both failed',
        )
      : error;
  }

  if (cleanupError) throw cleanupError;
}

/**
 * Run a static build under a repository-wide lock with crash-safe source restore.
 *
 * @param {{
 *   rootDir?: string,
 *   hideDirs?: string[],
 *   log?: (message: string) => void,
 *   build?: (options: { rootDir: string, signal: AbortSignal }) => Promise<void>,
 *   signalEmitter?: SignalEmitter | null,
 *   lockOptions?: object,
 * }} [options]
 */
export async function runStaticBuild({
  rootDir = defaultRoot,
  hideDirs = HIDE_DIRS,
  log = console.log,
  build = runNextBuild,
  signalEmitter = process,
  lockOptions = {},
} = {}) {
  mkdirSync(rootDir, { recursive: true });
  const release = await lockfile.lock(lockTarget(rootDir), {
    ...DEFAULT_LOCK_OPTIONS,
    ...lockOptions,
  });
  const abortController = new AbortController();
  const removeSignalHandlers = installSignalHandlers(signalEmitter, abortController);
  const restoreOptions = { rootDir, hideDirs, log };

  try {
    // A previous process may have died after hiding tracked sources. Recover it
    // under the lock before creating this build's fresh backup.
    restoreBuildBackup(restoreOptions);
    if (abortController.signal.aborted) throw abortController.signal.reason;

    cleanNextBuildState(rootDir, log);
    if (abortController.signal.aborted) throw abortController.signal.reason;

    hideStaticSources(restoreOptions);
    if (abortController.signal.aborted) throw abortController.signal.reason;

    await build({ rootDir, signal: abortController.signal });
    if (abortController.signal.aborted) throw abortController.signal.reason;

    log('Static export complete -> out/');
    await createSpaFallbacks(rootDir, log);
    await createCleanUrlAliases(rootDir, log);
  } finally {
    removeSignalHandlers();
    await releaseAfterRestore(release, restoreOptions);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath);
if (isMain) {
  try {
    await runStaticBuild();
  } catch (error) {
    if (error instanceof BuildInterruptedError) {
      console.error(error.message);
      process.exitCode = error.signal === 'SIGINT' ? 130 : 143;
    } else {
      console.error(error);
      process.exitCode = 1;
    }
  }
}

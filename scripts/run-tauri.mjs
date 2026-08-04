#!/usr/bin/env node

import { readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = join(dirname(scriptPath), '..');
const tauriCli = join(projectRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

function normalizeForClang(path) {
  return path.replaceAll('\\', '/');
}

function numericVersionParts(version) {
  if (!/^\d+(?:\.\d+){0,3}$/.test(version)) return null;
  const parts = version.split('.').map(Number);
  while (parts.length < 4) parts.push(0);
  return parts;
}

function compareVersionPartsDescending(left, right) {
  for (let index = 0; index < 4; index += 1) {
    if (left.parts[index] !== right.parts[index]) return right.parts[index] - left.parts[index];
  }
  return 0;
}

function isRegularFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function inspectWindowsLlvmRoot(llvmRoot) {
  const binDirectory = join(llvmRoot, 'bin');
  const clangPath = join(binDirectory, 'clang.exe');
  const libclangPath = join(binDirectory, 'libclang.dll');
  const clangResources = join(llvmRoot, 'lib', 'clang');

  if (!isRegularFile(clangPath) || !isRegularFile(libclangPath) || !isDirectory(clangResources)) {
    return null;
  }

  let resourceDirectories;
  try {
    resourceDirectories = readdirSync(clangResources, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, parts: numericVersionParts(entry.name) }))
      .filter((entry) => entry.parts !== null)
      .sort(compareVersionPartsDescending);
  } catch {
    return null;
  }

  for (const resourceDirectory of resourceDirectories) {
    const resourceInclude = join(clangResources, resourceDirectory.name, 'include');
    if (isDirectory(resourceInclude) && isRegularFile(join(resourceInclude, 'stddef.h'))) {
      return { binDirectory, clangPath, resourceInclude };
    }
  }

  return null;
}

function getWindowsEnvironmentValue(environment, name) {
  if (environment[name] !== undefined) return environment[name];
  const normalizedName = name.toLowerCase();
  return Object.entries(environment).find(([key]) => key.toLowerCase() === normalizedName)?.[1];
}

function setWindowsEnvironmentValue(environment, name, value) {
  const normalizedName = name.toLowerCase();
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === normalizedName) delete environment[key];
  }
  environment[name] = value;
}

function removeBindgenArgumentOverrides(environment) {
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase().startsWith('bindgen_extra_clang_args')) delete environment[key];
  }
}

function isAndroidToolchainPath(path) {
  return /android|(?:^|[\\/_.-])ndk(?:[\\/_.-]|$)/i.test(path);
}

function candidateWindowsLlvmRoots(environment) {
  const configuredRoot = getWindowsEnvironmentValue(environment, 'HIPAGO_LLVM_ROOT');
  if (configuredRoot) return [configuredRoot];

  const roots = [];
  const programFiles = getWindowsEnvironmentValue(environment, 'ProgramFiles');
  if (programFiles) roots.push(join(programFiles, 'LLVM'));
  roots.push('C:\\Program Files\\LLVM');

  const inheritedLibclangPath = getWindowsEnvironmentValue(environment, 'LIBCLANG_PATH');
  if (inheritedLibclangPath && !isAndroidToolchainPath(inheritedLibclangPath)) {
    const libclangDirectory = resolve(inheritedLibclangPath);
    roots.push(
      basename(libclangDirectory).toLowerCase() === 'bin'
        ? dirname(libclangDirectory)
        : libclangDirectory,
    );
  }

  const seen = new Set();
  return roots.filter((root) => {
    const key = resolve(root).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeWindowsPathKey(environment) {
  // Node sorts Windows environment keys lexicographically before spawning and
  // passes only one case-insensitive match. Preserve the value it would select
  // (`PATH` when present), but make the choice explicit and deterministic.
  const pathValue = getWindowsEnvironmentValue(environment, 'PATH');
  if (pathValue !== undefined) setWindowsEnvironmentValue(environment, 'PATH', pathValue);
}

function prependWindowsPath(environment, directory) {
  const normalizedDirectory = directory.replace(/[\\/]+$/, '').toLowerCase();
  const existingEntries = (environment.PATH ?? '')
    .split(';')
    .filter(Boolean)
    .filter(
      (entry) =>
        entry
          .replace(/^"|"$/g, '')
          .replace(/[\\/]+$/, '')
          .toLowerCase() !== normalizedDirectory,
    );
  setWindowsEnvironmentValue(environment, 'PATH', [directory, ...existingEntries].join(';'));
}

export function createTauriEnvironment({
  platform = process.platform,
  environment = process.env,
} = {}) {
  const childEnvironment = { ...environment };
  if (platform !== 'win32') return childEnvironment;

  normalizeWindowsPathKey(childEnvironment);

  let llvm = null;
  const candidates = candidateWindowsLlvmRoots(environment);
  for (const candidate of candidates) {
    llvm = inspectWindowsLlvmRoot(candidate);
    if (llvm) break;
  }

  if (!llvm) {
    const checked = candidates.map((candidate) => resolve(candidate)).join(', ');
    throw new Error(
      `Windows Tauri builds require host LLVM with clang.exe, libclang.dll, and a Clang resource include/stddef.h. Checked: ${checked}. ` +
        'Install LLVM or set HIPAGO_LLVM_ROOT to its installation directory.',
    );
  }

  removeBindgenArgumentOverrides(childEnvironment);
  setWindowsEnvironmentValue(childEnvironment, 'LIBCLANG_PATH', llvm.binDirectory);
  setWindowsEnvironmentValue(childEnvironment, 'CLANG_PATH', llvm.clangPath);
  setWindowsEnvironmentValue(
    childEnvironment,
    'BINDGEN_EXTRA_CLANG_ARGS',
    `-isystem "${normalizeForClang(llvm.resourceInclude)}"`,
  );
  prependWindowsPath(childEnvironment, llvm.binDirectory);
  return childEnvironment;
}

export function waitForTauriChild(child, { signalEmitter = process } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let forwardedSignal = null;

    const cleanup = () => {
      signalEmitter.off('SIGINT', onSigint);
      signalEmitter.off('SIGTERM', onSigterm);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const forwardSignal = (signal) => {
      try {
        if (forwardedSignal) {
          child.kill('SIGKILL');
          return;
        }
        forwardedSignal = signal;
        child.kill(signal);
      } catch (error) {
        settle(rejectPromise, error);
      }
    };
    const onSigint = () => forwardSignal('SIGINT');
    const onSigterm = () => forwardSignal('SIGTERM');
    const onError = (error) => settle(rejectPromise, error);
    const onExit = (code, signal) => {
      const effectiveSignal = forwardedSignal ?? signal;
      settle(
        resolvePromise,
        effectiveSignal ? (SIGNAL_EXIT_CODES[effectiveSignal] ?? 1) : (code ?? 1),
      );
    };

    signalEmitter.on('SIGINT', onSigint);
    signalEmitter.on('SIGTERM', onSigterm);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

export async function runTauri({
  args = process.argv.slice(2),
  platform = process.platform,
  environment = process.env,
  cwd = projectRoot,
  cliPath = tauriCli,
  spawnProcess = spawn,
  signalEmitter = process,
  log = console.log,
} = {}) {
  if (!isRegularFile(cliPath)) {
    throw new Error(`Tauri CLI was not found at ${cliPath}. Run pnpm install first.`);
  }

  const childEnvironment = createTauriEnvironment({ platform, environment });
  if (platform === 'win32') {
    log(`[tauri] LIBCLANG_PATH=${childEnvironment.LIBCLANG_PATH}`);
    log(`[tauri] BINDGEN_EXTRA_CLANG_ARGS=${childEnvironment.BINDGEN_EXTRA_CLANG_ARGS}`);
  }

  const child = spawnProcess(process.execPath, [cliPath, ...args], {
    cwd,
    env: childEnvironment,
    shell: false,
    stdio: 'inherit',
  });
  return waitForTauriChild(child, { signalEmitter });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath.toLowerCase() === resolve(scriptPath).toLowerCase()) {
  try {
    process.exitCode = await runTauri();
  } catch (error) {
    console.error(`[tauri] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

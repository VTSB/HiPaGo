#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = join(dirname(scriptPath), '..');
const androidDirectory = join(projectRoot, 'android');

function stripOuterQuotes(value) {
  return value.replace(/^"|"$/g, '');
}

export function createGradleInvocation({
  args,
  platform = process.platform,
  environment = process.env,
  cwd = androidDirectory,
}) {
  const javaHome = environment.JAVA_HOME?.trim();
  const javaExecutable = javaHome
    ? join(stripOuterQuotes(javaHome), 'bin', platform === 'win32' ? 'java.exe' : 'java')
    : platform === 'win32'
      ? 'java.exe'
      : 'java';
  const wrapperJar = join(cwd, 'gradle', 'wrapper', 'gradle-wrapper.jar');

  return {
    command: javaExecutable,
    commandArguments: [
      '-Xmx64m',
      '-Xms64m',
      '-Dorg.gradle.appname=gradlew',
      '-classpath',
      wrapperJar,
      'org.gradle.wrapper.GradleWrapperMain',
      ...args,
    ],
  };
}

export function runGradle({
  args = process.argv.slice(2),
  platform = process.platform,
  environment = process.env,
  cwd = androidDirectory,
  spawnProcess = spawnSync,
} = {}) {
  if (args.length === 0) {
    throw new Error('Usage: node scripts/run-gradle.mjs <gradle-task> [arguments]');
  }

  // Launch the wrapper main class directly. Passing arbitrary arguments through
  // `cmd.exe /c gradlew.bat` lets CMD reinterpret metacharacters and can both
  // execute unintended commands and mask Gradle's real exit status.
  const { command, commandArguments } = createGradleInvocation({
    args,
    platform,
    environment,
    cwd,
  });
  const result = spawnProcess(command, commandArguments, {
    cwd,
    env: environment,
    shell: false,
    stdio: 'inherit',
  });

  if (result.error) {
    throw new Error(`Unable to launch Gradle: ${result.error.message}`, { cause: result.error });
  }

  if (result.signal) {
    throw new Error(`Gradle terminated by signal ${result.signal}`);
  }

  return result.status ?? 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath.toLowerCase() === resolve(scriptPath).toLowerCase()) {
  try {
    process.exitCode = runGradle();
  } catch (error) {
    console.error(`[gradle] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

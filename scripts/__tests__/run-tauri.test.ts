// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTauriEnvironment,
  inspectWindowsLlvmRoot,
  runTauri,
  waitForTauriChild,
} from '../run-tauri.mjs';

const tempDirs: string[] = [];

function testEnvironment(values: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...values };
}

function asProcess(signalEmitter: EventEmitter): NodeJS.Process {
  return signalEmitter as unknown as NodeJS.Process;
}

function populateLlvm(root: string, ...versions: string[]): string {
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', 'clang.exe'), 'fixture');
  writeFileSync(join(root, 'bin', 'libclang.dll'), 'fixture');
  for (const version of versions) {
    const include = join(root, 'lib', 'clang', version, 'include');
    mkdirSync(include, { recursive: true });
    writeFileSync(join(include, 'stddef.h'), 'fixture');
  }
  return root;
}

function fakeLlvm(...versions: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'hipago-llvm-'));
  tempDirs.push(root);
  return populateLlvm(root, ...versions);
}

function fakeCli(): string {
  const root = mkdtempSync(join(tmpdir(), 'hipago-tauri-cli-'));
  tempDirs.push(root);
  const cli = join(root, 'tauri.js');
  writeFileSync(cli, 'fixture');
  return cli;
}

class FakeChild extends EventEmitter {
  killSignals: string[] = [];

  kill(signal = 'SIGTERM') {
    this.killSignals.push(signal);
    return true;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempDirs.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Windows Tauri LLVM environment', () => {
  it('selects the newest numeric Clang resource directory with stddef.h', () => {
    const llvmRoot = fakeLlvm('9', '17.0.6', '22', 'not-a-version');

    const llvm = inspectWindowsLlvmRoot(llvmRoot);

    expect(llvm?.resourceInclude).toBe(join(llvmRoot, 'lib', 'clang', '22', 'include'));
  });

  it('rejects an LLVM resource directory that cannot provide stddef.h', () => {
    const llvmRoot = fakeLlvm('22');
    rmSync(join(llvmRoot, 'lib', 'clang', '22', 'include', 'stddef.h'));

    expect(inspectWindowsLlvmRoot(llvmRoot)).toBeNull();
  });

  it('replaces global and target-specific Android bindgen arguments', () => {
    const llvmRoot = fakeLlvm('22');
    const environment = createTauriEnvironment({
      platform: 'win32',
      environment: testEnvironment({
        HIPAGO_LLVM_ROOT: llvmRoot,
        Bindgen_Extra_Clang_Args:
          '--target=aarch64-linux-android21 --sysroot=C:/Android/ndk/sysroot',
        BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android: '--target=aarch64-linux-android21',
        Libclang_Path: 'C:/Android/Sdk/ndk/toolchains/llvm/prebuilt/windows-x86_64/bin',
        clang_path: 'C:/Android/Sdk/ndk/toolchains/llvm/prebuilt/windows-x86_64/bin/clang.exe',
      }),
    });

    expect(environment.LIBCLANG_PATH).toBe(join(llvmRoot, 'bin'));
    expect(environment.CLANG_PATH).toBe(join(llvmRoot, 'bin', 'clang.exe'));
    expect(environment.BINDGEN_EXTRA_CLANG_ARGS).toBe(
      `-isystem "${join(llvmRoot, 'lib', 'clang', '22', 'include').replaceAll('\\', '/')}"`,
    );
    expect(
      Object.keys(environment).filter((key) =>
        key.toLowerCase().startsWith('bindgen_extra_clang_args'),
      ),
    ).toEqual(['BINDGEN_EXTRA_CLANG_ARGS']);
    expect(environment.BINDGEN_EXTRA_CLANG_ARGS).not.toContain('android');
  });

  it('prefers Program Files host LLVM over an inherited Android NDK LLVM', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'hipago-llvm-candidates-'));
    tempDirs.push(fixtureRoot);
    const programFiles = join(fixtureRoot, 'Program Files');
    const hostLlvm = populateLlvm(join(programFiles, 'LLVM'), '22');
    const ndkLlvm = populateLlvm(
      join(
        fixtureRoot,
        'Android',
        'Sdk',
        'ndk',
        '30',
        'toolchains',
        'llvm',
        'prebuilt',
        'windows-x86_64',
      ),
      '99',
    );

    const environment = createTauriEnvironment({
      platform: 'win32',
      environment: testEnvironment({
        ProgramFiles: programFiles,
        LIBCLANG_PATH: join(ndkLlvm, 'bin'),
      }),
    });

    expect(environment.LIBCLANG_PATH).toBe(join(hostLlvm, 'bin'));
  });

  it('passes one PATH key with host LLVM first', () => {
    const llvmRoot = fakeLlvm('22');
    const environment = createTauriEnvironment({
      platform: 'win32',
      environment: testEnvironment({
        HIPAGO_LLVM_ROOT: llvmRoot,
        PATH: 'effective-path',
        Path: 'shadowed-path',
      }),
    });

    expect(Object.keys(environment).filter((key) => key.toLowerCase() === 'path')).toEqual([
      'PATH',
    ]);
    expect(environment.PATH).toBe(`${join(llvmRoot, 'bin')};effective-path`);
  });

  it('leaves non-Windows environments unchanged', () => {
    const original = testEnvironment({
      BINDGEN_EXTRA_CLANG_ARGS: '--target=aarch64-linux-android21',
      CUSTOM_VALUE: 'preserved',
    });

    expect(createTauriEnvironment({ platform: 'linux', environment: original })).toEqual(original);
  });

  it('fails with an actionable error when an explicit LLVM root is incomplete', () => {
    const llvmRoot = mkdtempSync(join(tmpdir(), 'hipago-broken-llvm-'));
    tempDirs.push(llvmRoot);

    expect(() =>
      createTauriEnvironment({
        platform: 'win32',
        environment: testEnvironment({ HIPAGO_LLVM_ROOT: llvmRoot }),
      }),
    ).toThrow(/Install LLVM or set HIPAGO_LLVM_ROOT/);
  });
});

describe('Tauri child process lifecycle', () => {
  it('passes exact arguments and the corrected environment without a shell', async () => {
    const llvmRoot = fakeLlvm('22');
    const cliPath = fakeCli();
    const child = new FakeChild();
    const spawnProcess = vi.fn(
      (command: string, args: string[], options: Record<string, unknown>) => {
        void command;
        void args;
        void options;
        return child;
      },
    );
    const signalEmitter = new EventEmitter();

    const result = runTauri({
      args: ['build', '--config', 'local.json'],
      platform: 'win32',
      environment: testEnvironment({
        HIPAGO_LLVM_ROOT: llvmRoot,
        PATH: 'tool-path',
        BINDGEN_EXTRA_CLANG_ARGS: '--target=aarch64-linux-android21',
      }),
      cwd: 'D:/fixture',
      cliPath,
      spawnProcess: spawnProcess as unknown as typeof import('node:child_process').spawn,
      signalEmitter: asProcess(signalEmitter),
      log: () => {},
    });
    child.emit('exit', 7, null);

    await expect(result).resolves.toBe(7);
    expect(spawnProcess).toHaveBeenCalledOnce();
    const [command, args, options] = spawnProcess.mock.calls[0]!;
    expect(command).toBe(process.execPath);
    expect(args).toEqual([cliPath, 'build', '--config', 'local.json']);
    expect(options).toMatchObject({ cwd: 'D:/fixture', shell: false, stdio: 'inherit' });
    const spawnedEnvironment = options.env as Record<string, string>;
    expect(spawnedEnvironment.BINDGEN_EXTRA_CLANG_ARGS).not.toContain('android');
  });

  it('propagates spawn failures', async () => {
    const child = new FakeChild();
    const result = runTauri({
      args: ['build'],
      platform: 'linux',
      environment: testEnvironment(),
      cliPath: fakeCli(),
      spawnProcess: (() => child) as unknown as typeof import('node:child_process').spawn,
      signalEmitter: asProcess(new EventEmitter()),
    });
    child.emit('error', new Error('spawn failed'));

    await expect(result).rejects.toThrow('spawn failed');
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('forwards %s and preserves its conventional exit code', async (signal, exitCode) => {
    const child = new FakeChild();
    const signalEmitter = new EventEmitter();
    const result = waitForTauriChild(child, { signalEmitter: asProcess(signalEmitter) });

    signalEmitter.emit(signal);
    child.emit('exit', null, signal);

    await expect(result).resolves.toBe(exitCode);
    expect(child.killSignals).toEqual([signal]);
    expect(signalEmitter.listenerCount('SIGINT')).toBe(0);
    expect(signalEmitter.listenerCount('SIGTERM')).toBe(0);
  });

  it('forces termination when an interrupted child receives a second signal', async () => {
    const child = new FakeChild();
    const signalEmitter = new EventEmitter();
    const result = waitForTauriChild(child, { signalEmitter: asProcess(signalEmitter) });

    signalEmitter.emit('SIGINT');
    signalEmitter.emit('SIGINT');
    child.emit('exit', null, 'SIGKILL');

    await expect(result).resolves.toBe(130);
    expect(child.killSignals).toEqual(['SIGINT', 'SIGKILL']);
  });
});

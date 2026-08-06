// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAndroidBindingEnvironment,
  createAndroidBuildEnvironment,
  inspectAndroidNdk,
  resolveAndroidNdkRoot,
} from '../build-android.mjs';

const tempDirs: string[] = [];

function testEnvironment(values: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...values };
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function fakeWindowsNdk(root: string): string {
  const bin = join(root, 'toolchains', 'llvm', 'prebuilt', 'windows-x86_64', 'bin');
  mkdirSync(bin, { recursive: true });
  for (const file of ['clang.exe', 'llvm-config.exe', 'libclang.dll']) {
    writeFileSync(join(bin, file), 'fixture');
  }
  return root;
}

function fakeWindowsLlvm(root: string): string {
  const bin = join(root, 'bin');
  const resourceInclude = join(root, 'lib', 'clang', '22', 'include');
  mkdirSync(bin, { recursive: true });
  mkdirSync(resourceInclude, { recursive: true });
  writeFileSync(join(bin, 'clang.exe'), 'fixture');
  writeFileSync(join(bin, 'libclang.dll'), 'fixture');
  writeFileSync(join(resourceInclude, 'stddef.h'), 'fixture');
  return root;
}

afterEach(() => {
  for (const root of tempDirs.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Android NDK environment isolation', () => {
  it('uses one NDK LLVM toolchain and removes inherited compiler overrides', () => {
    const ndkRoot = fakeWindowsNdk(temporaryRoot('hipago-ndk-'));
    const cargoWrapperPath = join(temporaryRoot('hipago-wrapper-'), 'cargo-android.cmd');
    const environment = createAndroidBuildEnvironment({
      platform: 'win32',
      cargoWrapperPath,
      environment: testEnvironment({
        ANDROID_NDK_ROOT: ndkRoot,
        PATH: `tools;${join(ndkRoot, 'toolchains', 'llvm', 'prebuilt', 'windows-x86_64', 'bin')}`,
        Path: 'shadowed-path',
        CARGO: 'C:\\Rust\\cargo.exe',
        CLANG_PATH: 'C:\\Program Files\\LLVM\\bin\\clang.exe',
        Libclang_Path: 'C:\\Program Files\\LLVM\\bin',
        LLVM_CONFIG_PATH: 'C:\\Program Files\\LLVM\\bin\\llvm-config.exe',
        BINDGEN_EXTRA_CLANG_ARGS: '-isystem C:/Program Files/LLVM/include',
        BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android: '--target=stale',
        CC: 'host-cc',
        CC_aarch64_linux_android: 'stale-target-cc',
        aarch64_linux_android_CXX: 'stale-target-cxx',
        AR_x86_64_linux_android: 'stale-target-ar',
        RANLIB: 'host-ranlib',
        CFLAGS_armv7_linux_androideabi: '-Ihost',
        x86_64_linux_android_CXXFLAGS: '-Ihost-cxx',
        CUSTOM_VALUE: 'preserved',
      }),
    });

    const bin = join(ndkRoot, 'toolchains', 'llvm', 'prebuilt', 'windows-x86_64', 'bin');
    expect(environment.ANDROID_NDK_HOME).toBe(ndkRoot);
    expect(environment.ANDROID_NDK_ROOT).toBe(ndkRoot);
    expect(environment.LIBCLANG_PATH).toBe(bin);
    expect(environment.LLVM_CONFIG_PATH).toBe(join(bin, 'llvm-config.exe'));
    expect(environment.CLANG_PATH).toBe(join(bin, 'clang.exe'));
    expect(environment.HIPAGO_ANDROID_CLANG_PATH).toBe(join(bin, 'clang.exe'));
    expect(environment.HIPAGO_ANDROID_REAL_CARGO).toBe('C:\\Rust\\cargo.exe');
    expect(environment.CARGO).toBe(cargoWrapperPath);
    expect(environment.PATH).toBe(`${bin};tools`);
    expect(Object.keys(environment).filter((key) => key.toLowerCase() === 'path')).toEqual([
      'PATH',
    ]);
    expect(
      Object.keys(environment).filter((key) =>
        key.toLowerCase().startsWith('bindgen_extra_clang_args'),
      ),
    ).toEqual([]);
    expect(
      Object.keys(environment).filter((key) =>
        /^(?:cc|cxx|ar|ranlib|cflags|cxxflags)(?:_|$)|_(?:cc|cxx|ar|ranlib|cflags|cxxflags)$/i.test(
          key,
        ),
      ),
    ).toEqual([]);
    expect(environment.CUSTOM_VALUE).toBe('preserved');
  });

  it('does not mutate the inherited environment', () => {
    const ndkRoot = fakeWindowsNdk(temporaryRoot('hipago-ndk-'));
    const inherited = testEnvironment({
      ANDROID_NDK_HOME: ndkRoot,
      PATH: 'tools',
      CC: 'host-cc',
    });

    createAndroidBuildEnvironment({
      platform: 'win32',
      cargoWrapperPath: join(temporaryRoot('hipago-wrapper-'), 'cargo-android.cmd'),
      environment: inherited,
    });

    expect(inherited).toEqual({
      NODE_ENV: 'test',
      ANDROID_NDK_HOME: ndkRoot,
      PATH: 'tools',
      CC: 'host-cc',
    });
  });

  it('uses isolated host LLVM without Android target arguments for binding generation', () => {
    const llvmRoot = fakeWindowsLlvm(temporaryRoot('hipago-host-llvm-'));
    const bindingEnvironment = createAndroidBindingEnvironment({
      platform: 'win32',
      environment: testEnvironment({
        HIPAGO_LLVM_ROOT: llvmRoot,
        PATH: 'tools',
        LIBCLANG_PATH: 'C:\\Android\\ndk\\bin',
        CLANG_PATH: 'C:\\Android\\ndk\\bin\\clang.exe',
        BINDGEN_EXTRA_CLANG_ARGS: '--target=aarch64-linux-android21 --sysroot=stale',
        BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android: '--target=stale',
        CC: 'stale-cc',
        x86_64_pc_windows_msvc_CXX: 'stale-cxx',
      }),
    });

    expect(bindingEnvironment.LIBCLANG_PATH).toBe(join(llvmRoot, 'bin'));
    expect(bindingEnvironment.CLANG_PATH).toBe(join(llvmRoot, 'bin', 'clang.exe'));
    expect(bindingEnvironment.BINDGEN_EXTRA_CLANG_ARGS).toBe(
      `-isystem "${join(llvmRoot, 'lib', 'clang', '22', 'include').replaceAll('\\', '/')}"`,
    );
    expect(bindingEnvironment.BINDGEN_EXTRA_CLANG_ARGS).not.toContain('android');
    expect(bindingEnvironment.BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android).toBeUndefined();
    expect(bindingEnvironment.CC).toBeUndefined();
    expect(bindingEnvironment.x86_64_pc_windows_msvc_CXX).toBeUndefined();
  });

  it('rejects conflicting NDK environment aliases', () => {
    const first = fakeWindowsNdk(temporaryRoot('hipago-ndk-first-'));
    const second = fakeWindowsNdk(temporaryRoot('hipago-ndk-second-'));

    expect(() =>
      resolveAndroidNdkRoot({
        platform: 'win32',
        environment: testEnvironment({ ANDROID_NDK_HOME: first, ANDROID_NDK_ROOT: second }),
      }),
    ).toThrow(/point to different directories/);
  });

  it('falls back to the newest complete side-by-side NDK from local.properties', () => {
    const projectRoot = temporaryRoot('hipago-project-');
    const sdkRoot = join(projectRoot, 'Android SDK');
    fakeWindowsNdk(join(sdkRoot, 'ndk', '28.2.13676358'));
    fakeWindowsNdk(join(sdkRoot, 'ndk', '30.0.14904198'));
    const androidRoot = join(projectRoot, 'android');
    mkdirSync(androidRoot, { recursive: true });
    writeFileSync(
      join(androidRoot, 'local.properties'),
      `sdk.dir=${sdkRoot.replaceAll('\\', '\\\\').replace(':', '\\:')}\n`,
    );

    expect(
      resolveAndroidNdkRoot({ platform: 'win32', environment: testEnvironment(), projectRoot }),
    ).toBe(join(sdkRoot, 'ndk', '30.0.14904198'));
  });

  it('rejects an NDK that cannot provide all required LLVM tools', () => {
    const ndkRoot = temporaryRoot('hipago-incomplete-ndk-');
    const bin = join(ndkRoot, 'toolchains', 'llvm', 'prebuilt', 'windows-x86_64', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'clang.exe'), 'fixture');

    expect(inspectAndroidNdk(ndkRoot, 'win32')).toBeNull();
    expect(() =>
      resolveAndroidNdkRoot({
        platform: 'win32',
        environment: testEnvironment({ ANDROID_NDK_HOME: ndkRoot }),
      }),
    ).toThrow(/incomplete or missing/);
  });
});

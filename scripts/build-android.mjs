#!/usr/bin/env node
// Cross-compile bypass-uniffi for Android targets.
// Requires: cargo-ndk, Android NDK
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTauriEnvironment } from './run-tauri.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const root = join(dirname(scriptPath), '..');
const windowsCargoWrapper = join(dirname(scriptPath), 'cargo-android.cmd');

const HOST_TAGS = {
  darwin: 'darwin-x86_64',
  linux: 'linux-x86_64',
  win32: 'windows-x86_64',
};
const COMPILER_OVERRIDE_NAMES = ['CC', 'CXX', 'AR', 'RANLIB', 'CFLAGS', 'CXXFLAGS'];

function getEnvironmentValue(environment, name) {
  if (environment[name] !== undefined) return environment[name];
  const normalizedName = name.toLowerCase();
  return Object.entries(environment).find(([key]) => key.toLowerCase() === normalizedName)?.[1];
}

function setEnvironmentValue(environment, name, value) {
  const normalizedName = name.toLowerCase();
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === normalizedName) delete environment[key];
  }
  environment[name] = value;
}

function removeEnvironmentKeys(environment, predicate) {
  for (const key of Object.keys(environment)) {
    if (predicate(key.toUpperCase())) delete environment[key];
  }
}

function isCompilerOverride(name) {
  return COMPILER_OVERRIDE_NAMES.some(
    (base) => name === base || name.startsWith(`${base}_`) || name.endsWith(`_${base}`),
  );
}

function unescapeJavaProperty(value) {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\' || index + 1 >= value.length) {
      result += value[index];
      continue;
    }

    const escaped = value[(index += 1)];
    result +=
      escaped === 't'
        ? '\t'
        : escaped === 'r'
          ? '\r'
          : escaped === 'n'
            ? '\n'
            : escaped === 'f'
              ? '\f'
              : escaped;
  }
  return result;
}

function readLocalProperties(path) {
  if (!existsSync(path)) return {};

  const properties = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const separator = line.search(/(?<!\\)[=:]/);
    if (separator < 0) continue;
    properties[unescapeJavaProperty(line.slice(0, separator).trim())] = unescapeJavaProperty(
      line.slice(separator + 1).trim(),
    );
  }
  return properties;
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function normalizeComparablePath(path, platform) {
  const normalized = resolve(path).replace(/[\\/]+$/, '');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function configuredNdkRoot(environment, platform) {
  const configured = [
    getEnvironmentValue(environment, 'ANDROID_NDK_HOME'),
    getEnvironmentValue(environment, 'ANDROID_NDK_ROOT'),
  ]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim().replace(/^"|"$/g, ''));

  if (configured.length === 0) return null;
  const unique = new Map(
    configured.map((path) => [normalizeComparablePath(path, platform), resolve(path)]),
  );
  if (unique.size > 1) {
    throw new Error(
      `ANDROID_NDK_HOME and ANDROID_NDK_ROOT point to different directories: ${configured.join(', ')}`,
    );
  }
  return [...unique.values()][0];
}

function compareVersionNamesDescending(left, right) {
  return right.localeCompare(left, 'en', { numeric: true, sensitivity: 'base' });
}

function findNdkUnderSdk(sdkRoot, platform) {
  const sideBySideRoot = join(sdkRoot, 'ndk');
  if (isDirectory(sideBySideRoot)) {
    const installed = readdirSync(sideBySideRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersionNamesDescending);
    for (const version of installed) {
      const candidate = join(sideBySideRoot, version);
      if (inspectAndroidNdk(candidate, platform)) return candidate;
    }
  }

  const legacyRoot = join(sdkRoot, 'ndk-bundle');
  return inspectAndroidNdk(legacyRoot, platform) ? legacyRoot : null;
}

export function inspectAndroidNdk(ndkRoot, platform = process.platform) {
  const hostTag = HOST_TAGS[platform];
  if (!hostTag) return null;

  const toolchainRoot = join(ndkRoot, 'toolchains', 'llvm', 'prebuilt', hostTag);
  const binDirectory = join(toolchainRoot, 'bin');
  const executableSuffix = platform === 'win32' ? '.exe' : '';
  const clangPath = join(binDirectory, `clang${executableSuffix}`);
  const llvmConfigPath = join(binDirectory, `llvm-config${executableSuffix}`);
  const libclangNames =
    platform === 'win32'
      ? ['libclang.dll']
      : platform === 'darwin'
        ? ['libclang.dylib']
        : ['libclang.so', 'libclang.so.1'];
  const libclangDirectories = [
    binDirectory,
    join(toolchainRoot, 'lib64'),
    join(toolchainRoot, 'lib'),
  ];
  const libclangPath = libclangDirectories.find((directory) =>
    libclangNames.some((name) => existsSync(join(directory, name))),
  );

  if (!existsSync(clangPath) || !existsSync(llvmConfigPath) || !libclangPath) return null;
  return { ndkRoot: resolve(ndkRoot), binDirectory, clangPath, llvmConfigPath, libclangPath };
}

export function resolveAndroidNdkRoot({
  environment = process.env,
  platform = process.platform,
  projectRoot = root,
} = {}) {
  const explicitRoot = configuredNdkRoot(environment, platform);
  if (explicitRoot) {
    if (!inspectAndroidNdk(explicitRoot, platform)) {
      throw new Error(`Android NDK LLVM toolchain is incomplete or missing at ${explicitRoot}.`);
    }
    return explicitRoot;
  }

  const localPropertiesPath = join(projectRoot, 'android', 'local.properties');
  const properties = readLocalProperties(localPropertiesPath);
  const propertiesDirectory = dirname(localPropertiesPath);
  if (properties['ndk.dir']) {
    const ndkRoot = resolve(propertiesDirectory, properties['ndk.dir']);
    if (!inspectAndroidNdk(ndkRoot, platform)) {
      throw new Error(`Android NDK LLVM toolchain is incomplete or missing at ${ndkRoot}.`);
    }
    return ndkRoot;
  }

  if (properties['sdk.dir']) {
    const sdkRoot = resolve(propertiesDirectory, properties['sdk.dir']);
    const ndkRoot = findNdkUnderSdk(sdkRoot, platform);
    if (ndkRoot) return ndkRoot;
  }

  throw new Error(
    'Android NDK was not found. Set ANDROID_NDK_HOME/ANDROID_NDK_ROOT or configure sdk.dir/ndk.dir in android/local.properties.',
  );
}

function prependPath(environment, directory, platform) {
  const separator = platform === 'win32' ? ';' : delimiter;
  const currentPath = getEnvironmentValue(environment, 'PATH') ?? '';
  const comparableDirectory = normalizeComparablePath(directory, platform);
  const existing = currentPath
    .split(separator)
    .filter(Boolean)
    .filter(
      (entry) =>
        normalizeComparablePath(entry.replace(/^"|"$/g, ''), platform) !== comparableDirectory,
    );
  setEnvironmentValue(environment, 'PATH', [directory, ...existing].join(separator));
}

export function createAndroidBuildEnvironment({
  environment = process.env,
  platform = process.platform,
  projectRoot = root,
  cargoWrapperPath = windowsCargoWrapper,
} = {}) {
  const childEnvironment = { ...environment };
  const ndkRoot = resolveAndroidNdkRoot({ environment, platform, projectRoot });
  const ndk = inspectAndroidNdk(ndkRoot, platform);
  if (!ndk) throw new Error(`Android NDK LLVM toolchain is incomplete or missing at ${ndkRoot}.`);

  removeEnvironmentKeys(
    childEnvironment,
    (name) => name.startsWith('BINDGEN_EXTRA_CLANG_ARGS') || isCompilerOverride(name),
  );
  setEnvironmentValue(childEnvironment, 'ANDROID_NDK_HOME', ndk.ndkRoot);
  setEnvironmentValue(childEnvironment, 'ANDROID_NDK_ROOT', ndk.ndkRoot);
  setEnvironmentValue(childEnvironment, 'LIBCLANG_PATH', ndk.libclangPath);
  setEnvironmentValue(childEnvironment, 'LLVM_CONFIG_PATH', ndk.llvmConfigPath);
  setEnvironmentValue(childEnvironment, 'CLANG_PATH', ndk.clangPath);
  prependPath(childEnvironment, ndk.binDirectory, platform);

  if (platform === 'win32') {
    // cargo-ndk 4.1.2 overwrites CLANG_PATH with an extension-less path.
    // Route its Cargo child through a tiny wrapper that restores the verified
    // clang.exe path before bindgen/clang-sys run.
    const inheritedCargo = getEnvironmentValue(environment, 'CARGO');
    const realCargo =
      inheritedCargo &&
      normalizeComparablePath(inheritedCargo, platform) !==
        normalizeComparablePath(cargoWrapperPath, platform)
        ? inheritedCargo
        : 'cargo.exe';
    setEnvironmentValue(childEnvironment, 'HIPAGO_ANDROID_REAL_CARGO', realCargo);
    setEnvironmentValue(childEnvironment, 'HIPAGO_ANDROID_CLANG_PATH', ndk.clangPath);
    setEnvironmentValue(childEnvironment, 'CARGO', resolve(cargoWrapperPath));
  }

  return childEnvironment;
}

export function createAndroidBindingEnvironment({
  environment = process.env,
  platform = process.platform,
} = {}) {
  const bindingEnvironment = createTauriEnvironment({ environment, platform });
  removeEnvironmentKeys(bindingEnvironment, isCompilerOverride);
  return bindingEnvironment;
}

function ensureCargoNdk(environment) {
  const cargo = getEnvironmentValue(environment, 'HIPAGO_ANDROID_REAL_CARGO') ?? 'cargo';
  try {
    execFileSync(cargo, ['ndk', '--version'], { cwd: root, env: environment, stdio: 'pipe' });
  } catch {
    throw new Error(
      [
        'Android bypass build requires cargo-ndk.',
        'Install it with: cargo install cargo-ndk',
        'Also make sure Android NDK is installed and ANDROID_NDK_HOME or Android SDK local.properties is configured.',
      ].join('\n'),
    );
  }
}

export function buildAndroid({ environment = process.env } = {}) {
  const childEnvironment = createAndroidBuildEnvironment({ environment });
  const bindingEnvironment = createAndroidBindingEnvironment({ environment });
  const cargo = getEnvironmentValue(childEnvironment, 'HIPAGO_ANDROID_REAL_CARGO') ?? 'cargo';

  console.log('Building bypass-uniffi for Android...');
  console.log(`[android] ANDROID_NDK_HOME=${childEnvironment.ANDROID_NDK_HOME}`);
  console.log(`[android] LIBCLANG_PATH=${childEnvironment.LIBCLANG_PATH}`);
  ensureCargoNdk(childEnvironment);

  execFileSync(
    cargo,
    [
      'ndk',
      '-t',
      'arm64-v8a',
      '-t',
      'armeabi-v7a',
      '-t',
      'x86_64',
      'build',
      '--release',
      '-p',
      'bypass-uniffi',
    ],
    { cwd: root, env: childEnvironment, stdio: 'inherit' },
  );

  // Copy .so files to the generated jniLibs dir (outside src/, gitignored;
  // registered as a jniLibs srcDir in app/build.gradle).
  const jniLibs = join(root, 'android/app/generated/jniLibs');
  const targets = [
    ['aarch64-linux-android', 'arm64-v8a'],
    ['armv7-linux-androideabi', 'armeabi-v7a'],
    ['x86_64-linux-android', 'x86_64'],
  ];

  for (const [rustTarget, abi] of targets) {
    const destDir = join(jniLibs, abi);
    mkdirSync(destDir, { recursive: true });
    cpSync(
      join(root, `target/${rustTarget}/release/libbypass_uniffi.so`),
      join(destDir, 'libbypass_uniffi.so'),
    );
  }

  // Generate Kotlin bindings into the generated source dir (outside src/,
  // gitignored; registered as a java srcDir in app/build.gradle). This host
  // Cargo build still runs bindgen, so keep inherited desktop LLVM overrides
  // out of it and use the same verified NDK libclang/Clang tools.
  console.log('Generating Kotlin bindings...');
  execFileSync(
    cargo,
    [
      'run',
      '--release',
      '-p',
      'bypass-uniffi',
      '--bin',
      'uniffi-bindgen',
      'generate',
      '--library',
      'target/aarch64-linux-android/release/libbypass_uniffi.so',
      '--language',
      'kotlin',
      '--out-dir',
      'android/app/generated/java/',
    ],
    { cwd: root, env: bindingEnvironment, stdio: 'inherit' },
  );

  console.log('Android build complete!');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath.toLowerCase() === resolve(scriptPath).toLowerCase()) {
  try {
    buildAndroid();
  } catch (error) {
    console.error(`[android] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

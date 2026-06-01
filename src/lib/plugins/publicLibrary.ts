/**
 * Capacitor plugin wrapper for PublicLibraryPlugin (Android raw-file ops in
 * public external storage).
 *
 * All paths passed to these methods must be ABSOLUTE paths on the device
 * filesystem. The JS adapter layer (storage/adapters/capacitor.ts) resolves
 * relative gallery paths against the configured base before calling here.
 *
 * assertNoTraversal() is exported so the adapter can validate relative
 * sub-paths before they are joined to the base (defence in depth — the Java
 * layer also validates, but the JS check surfaces errors earlier).
 */
import { registerPlugin } from '@capacitor/core';

// -----------------------------------------------------------------------
// Interfaces
// -----------------------------------------------------------------------

export interface DirEntry {
  name: string;
  /** Size in bytes (0 for directories). */
  size: number;
}

export interface PublicLibraryPlugin {
  /**
   * Returns the absolute path of the public Downloads directory.
   * Called when no user-configured base path is set.
   *
   * DEVICE-PENDING: returns the real path only on Android.
   */
  defaultBaseDir(): Promise<{ path: string }>;

  /** Create directory and all parents if they do not exist. */
  mkdir(options: { path: string }): Promise<void>;

  /**
   * Write bytes to path atomically (write to path+".tmp", then rename).
   * Creates parent directories as needed.
   */
  writeFile(options: { path: string; dataBase64: string }): Promise<void>;

  /** Read file bytes as base64. */
  readFile(options: { path: string }): Promise<{ dataBase64: string }>;

  /** List directory entries. */
  readdir(options: { path: string }): Promise<{ files: DirEntry[] }>;

  /** Stat a path — works for files and directories. */
  stat(options: { path: string }): Promise<{ exists: boolean; size: number }>;

  /**
   * Copy src → dest atomically (write to dest+".tmp", then rename).
   * Creates parent directories as needed.
   */
  copy(options: { from: string; to: string }): Promise<void>;

  /** Delete a single file. No-op if file does not exist. */
  delete(options: { path: string }): Promise<void>;

  /** Recursively delete a directory and all its contents. */
  deleteDir(options: { path: string }): Promise<void>;

  /**
   * Return the file:// URI for an absolute path.
   * Use Capacitor.convertFileSrc on the result to get a WebView-loadable URL.
   */
  getUri(options: { path: string }): Promise<{ uri: string }>;

  /** Rename / move a file or directory. Creates dest parent dirs as needed. */
  rename(options: { from: string; to: string }): Promise<void>;

  /** Returns whether a path exists (file or directory). */
  exists(options: { path: string }): Promise<{ exists: boolean }>;
}

// -----------------------------------------------------------------------
// Registered plugin
// -----------------------------------------------------------------------

export const PublicLibrary = registerPlugin<PublicLibraryPlugin>('PublicLibrary');

// -----------------------------------------------------------------------
// JS-side traversal guard (defence-in-depth, mirrors Java normalizeAndCheck)
// -----------------------------------------------------------------------

/**
 * Throws a TypeError if relPath contains ".." segments or is an absolute path.
 * Call this on the RELATIVE portion of a path before joining it to a base.
 *
 * @example
 *   assertNoTraversal('12345 My Title/0001.webp'); // ok
 *   assertNoTraversal('../secret');                // throws
 *   assertNoTraversal('/etc/passwd');              // throws
 */
export function assertNoTraversal(relPath: string): void {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new TypeError('path must be a non-empty string');
  }
  // Reject absolute paths (start with / on Unix, or e.g. C:\ on Windows)
  if (relPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relPath)) {
    throw new TypeError(`path traversal: absolute path not allowed: ${relPath}`);
  }
  // Split on both forward- and back-slash and reject any ".." segment
  const segments = relPath.split(/[\\/]/);
  for (const seg of segments) {
    if (seg === '..') {
      throw new TypeError(`path traversal: ".." segment in path: ${relPath}`);
    }
  }
}

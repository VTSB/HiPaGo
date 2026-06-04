/**
 * Capacitor plugin wrapper for PublicLibraryPlugin (Android download library
 * backed by the Storage Access Framework).
 *
 * The user picks ONE parent folder via {@link PublicLibraryPlugin.openDocumentTree}
 * and we hold a persisted URI permission for just that tree. Every file method
 * below takes a RELATIVE path under that tree (e.g. "HiPaGo/12345 Title/0001.webp");
 * the native side resolves it to a content:// document URI. There are no
 * absolute filesystem paths and no MANAGE_EXTERNAL_STORAGE.
 *
 * assertNoTraversal() is exported so the adapter can validate relative
 * sub-paths before they are sent down (defence in depth — the Java layer also
 * rejects "..", but the JS check surfaces errors earlier).
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

export interface TreeInfo {
  /** The persisted tree URI, or null if none chosen. */
  treeUri: string | null;
  /** Human-readable folder name for display, or null when invalid/none. */
  displayName: string | null;
  /** Whether the tree URI still has a live, writable persisted permission. */
  valid: boolean;
}

export interface PublicLibraryPlugin {
  /**
   * Launch the system folder picker (ACTION_OPEN_DOCUMENT_TREE) and take a
   * persistable URI permission on the chosen tree. Rejects "cancelled" if the
   * user backs out.
   */
  openDocumentTree(): Promise<{ treeUri: string; displayName: string }>;

  /** Returns the currently persisted tree URI, its display name, and validity. */
  getTree(): Promise<TreeInfo>;

  /** Release the persisted permission and forget the chosen folder. */
  clearTree(): Promise<void>;

  /** Create directory and all parents (relative path under the tree). */
  mkdir(options: { path: string }): Promise<void>;

  /**
   * Write bytes to a relative path. Overwrites an existing file in place
   * (truncate), so repeated writes to the same name never pile up duplicates.
   * Creates parent directories as needed.
   */
  writeFile(options: { path: string; dataBase64: string }): Promise<void>;

  /** Read file bytes as base64 (relative path). */
  readFile(options: { path: string }): Promise<{ dataBase64: string }>;

  /** List directory entries (relative path). */
  readdir(options: { path: string }): Promise<{ files: DirEntry[] }>;

  /** Stat a relative path — works for files and directories. */
  stat(options: { path: string }): Promise<{ exists: boolean; size: number }>;

  /** Returns whether a relative path exists (file or directory). */
  exists(options: { path: string }): Promise<{ exists: boolean }>;

  /**
   * Copy a LOCAL source file (absolute or file:// path, e.g. the image cache)
   * into the tree at relative `to`. Only the destination is a content URI;
   * the source stays a normal file. Creates parent directories as needed.
   */
  copy(options: { from: string; to: string }): Promise<void>;

  /** Delete a single file (relative path). No-op if it does not exist. */
  delete(options: { path: string }): Promise<void>;

  /** Recursively delete a directory and all its contents (relative path). */
  deleteDir(options: { path: string }): Promise<void>;

  /**
   * Return the content:// document URI for a relative path (or null). Note:
   * content URIs do NOT load in the WebView via convertFileSrc — read the
   * bytes instead when you need a displayable image source.
   */
  getUri(options: { path: string }): Promise<{ uri: string | null }>;
}

// -----------------------------------------------------------------------
// Registered plugin
// -----------------------------------------------------------------------

export const PublicLibrary = registerPlugin<PublicLibraryPlugin>('PublicLibrary');

// -----------------------------------------------------------------------
// Tree (download folder) helper
// -----------------------------------------------------------------------

/**
 * Discriminated result of {@link ensureDownloadTree}:
 *  - `{ok:true}`  — a writable tree is available (existing or freshly picked).
 *  - `{ok:false, reason:'cancelled'}` — the user backed out of the picker;
 *    the caller should abort silently (no error surfaced, no failure recorded).
 *  - `{ok:false, reason:'error', message}` — a genuine failure with the real
 *    native reason; the caller should surface and record it.
 */
export type EnsureTreeResult =
  | { ok: true; treeUri: string; displayName?: string }
  | { ok: false; reason: 'cancelled' }
  | { ok: false; reason: 'error'; message: string };

/**
 * Ensure a valid download folder is selected. Returns the existing tree if it
 * is still valid; otherwise launches the SAF picker. Distinguishes a user
 * cancel from a genuine failure so the caller can stay silent on the former and
 * surface the real reason on the latter.
 */
export async function ensureDownloadTree(): Promise<EnsureTreeResult> {
  try {
    const cur = await PublicLibrary.getTree();
    if (cur.valid && cur.treeUri) {
      return { ok: true, treeUri: cur.treeUri, displayName: cur.displayName ?? undefined };
    }
  } catch {
    // getTree failed (non-Android or plugin missing) — fall through to picker.
  }
  try {
    const picked = await PublicLibrary.openDocumentTree();
    return { ok: true, treeUri: picked.treeUri, displayName: picked.displayName };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // The native side rejects with the literal "cancelled" when the user backs
    // out of the SAF picker (PublicLibraryPlugin.onTreePicked). That is a user
    // cancel; anything else is a real failure whose reason we propagate.
    if (/cancel/i.test(message)) return { ok: false, reason: 'cancelled' };
    return { ok: false, reason: 'error', message };
  }
}

// -----------------------------------------------------------------------
// JS-side traversal guard (defence-in-depth, mirrors Java safeSegments)
// -----------------------------------------------------------------------

/**
 * Throws a TypeError if relPath contains ".." segments or is an absolute path.
 * Call this on the RELATIVE portion of a path before sending it down.
 *
 * @example
 *   assertNoTraversal('HiPaGo/12345 My Title/0001.webp'); // ok
 *   assertNoTraversal('../secret');                       // throws
 *   assertNoTraversal('/etc/passwd');                     // throws
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

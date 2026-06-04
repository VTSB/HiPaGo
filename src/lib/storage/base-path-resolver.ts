/**
 * Base-path resolver for the Android public Downloads library.
 *
 * Provides:
 *  - sanitizeGalleryTitle  — strip FS-unsafe chars from a gallery title
 *  - galleryFolderName     — build the `<id> <title>` folder name
 *  - resolveLibraryDir     — `<base>/HiPaGo` (honours user override)
 *  - ensureLibraryDir      — mkdir + .nomedia sentinel
 */

import { sanitizeFilename } from '@/lib/utils/download-zip';
import { PublicLibrary } from '@/lib/plugins/publicLibrary';

/**
 * The library root is a RELATIVE path under the user-picked SAF tree, not an
 * absolute filesystem path. Files land at `<picked tree>/HiPaGo/<id title>/…`.
 */
export const LIBRARY_ROOT = 'HiPaGo';

// ── Title sanitization ────────────────────────────────────────────────────────

/**
 * Sanitize a gallery title for use as a folder-name component.
 * Reuses the same regex as sanitizeFilename (DRY — no duplicate regex).
 */
export function sanitizeGalleryTitle(title: string): string {
  return sanitizeFilename(title);
}

// ── Folder naming ─────────────────────────────────────────────────────────────

/**
 * Build the gallery folder name: `<galleryId> <sanitized title>`.
 * If the title sanitizes to an empty string, returns just `<galleryId>`.
 */
export function galleryFolderName(galleryId: number, title: string): string {
  const safe = sanitizeGalleryTitle(title).trim();
  if (!safe) return String(galleryId);
  return `${galleryId} ${safe}`;
}

// ── Library directory resolution ──────────────────────────────────────────────

/**
 * The HiPaGo library directory, as a relative path under the picked SAF tree.
 * Always `"HiPaGo"`. Does NOT create the directory or require a tree to exist.
 */
export async function resolveLibraryDir(): Promise<string> {
  return LIBRARY_ROOT;
}

/**
 * Ensure the HiPaGo library directory exists under the picked tree and that the
 * `.nomedia` sentinel is present (so the media scanner skips the folder and the
 * downloaded images do not show up in the photo Gallery).
 *
 * Returns the relative library directory path (`"HiPaGo"`). Requires a valid
 * SAF tree — callers gate on `store.ensureReady()` first; if no tree is
 * selected the underlying plugin rejects with `NO_TREE`.
 */
export async function ensureLibraryDir(): Promise<string> {
  const dir = LIBRARY_ROOT;
  await PublicLibrary.mkdir({ path: dir });
  const nomedia = `${dir}/.nomedia`;
  const { exists } = await PublicLibrary.exists({ path: nomedia });
  if (!exists) {
    await PublicLibrary.writeFile({ path: nomedia, dataBase64: '' });
  }
  return dir;
}

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
import { useSettingsStore } from '@/lib/store/settings';

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
 * Resolve the HiPaGo library directory path.
 *
 * Priority:
 *  1. `settings.downloadBasePath` (user-configured override) → `<override>/HiPaGo`
 *  2. `PublicLibrary.defaultBaseDir()` (device Downloads dir) → `<Downloads>/HiPaGo`
 *
 * Returns the absolute path string; does NOT create the directory.
 */
export async function resolveLibraryDir(): Promise<string> {
  const override = useSettingsStore.getState().downloadBasePath;
  const base = override ?? (await PublicLibrary.defaultBaseDir()).path;
  return `${base}/HiPaGo`;
}

/**
 * Resolve the HiPaGo library directory, create it if missing, and ensure the
 * `.nomedia` sentinel file exists (so Android media scanner ignores the folder).
 *
 * Returns the absolute library directory path.
 */
export async function ensureLibraryDir(): Promise<string> {
  const dir = await resolveLibraryDir();
  await PublicLibrary.mkdir({ path: dir });
  const nomedia = `${dir}/.nomedia`;
  const { exists } = await PublicLibrary.exists({ path: nomedia });
  if (!exists) {
    await PublicLibrary.writeFile({ path: nomedia, dataBase64: '' });
  }
  return dir;
}

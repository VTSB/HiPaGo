/**
 * DownloadStore — platform-agnostic interface for per-gallery loose-image
 * offline storage.
 *
 * Each gallery is stored as a folder of files:
 *   <galleryId>/0001.webp, <galleryId>/0002.jpg, …
 *
 * Factory: `createDownloadStore()` picks the right adapter at runtime via
 * the same isTauri() / isCapacitor() checks used by src/lib/db/adapters/.
 */

import { isTauri, isCapacitor } from '@/lib/utils/platform';

// ── Interface ──────────────────────────────────────────────────────────────

export interface DownloadStore {
  /**
   * Write one image into the gallery folder.
   * @param galleryId  Numeric gallery ID (used as folder name).
   * @param index      Zero-based page index (used to build the filename).
   * @param bytes      Raw image data.
   * @param ext        File extension without leading dot, e.g. "webp".
   */
  putImage(
    galleryId: number,
    index: number,
    bytes: Uint8Array,
    ext: string,
  ): Promise<void>;

  /**
   * Copy an existing file (e.g. a persistent image-cache file) into the gallery
   * folder natively — no image bytes pass through the JS heap. Returns the bytes
   * written. Optional: adapters without a native file copy (web) omit it, and
   * callers must feature-detect before using it.
   * @param srcPath  Native fs path/uri of the source file (from the image cache).
   */
  putImageFromFile?(
    galleryId: number,
    index: number,
    srcPath: string,
    ext: string,
  ): Promise<number>;

  /**
   * Read one image from the gallery folder.
   * Returns null when the file does not exist.
   */
  getImage(
    galleryId: number,
    index: number,
    ext: string,
  ): Promise<Uint8Array | null>;

  /** List all gallery IDs that have at least one stored image. */
  listGalleries(): Promise<number[]>;

  /** Delete a gallery folder and all its images. */
  deleteGallery(galleryId: number): Promise<void>;

  /** Total bytes stored for a specific gallery. */
  gallerySize(galleryId: number): Promise<number>;

  /** Total bytes stored across all galleries. */
  usage(): Promise<number>;
}

// ── Filename helpers ───────────────────────────────────────────────────────

/**
 * Build the file name for a page: zero-padded 4-digit index + extension.
 * e.g. index=0, ext="webp" → "0001.webp"
 */
export function imageFileName(index: number, ext: string): string {
  return String(index + 1).padStart(4, '0') + '.' + ext;
}

/** Folder name for a gallery (just the string form of the numeric ID). */
export function galleryFolderName(galleryId: number): string {
  return String(galleryId);
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Pick and instantiate the appropriate DownloadStore adapter for the current
 * runtime platform.  Mirrors the pattern used in src/lib/db/init.ts.
 */
export async function createDownloadStore(): Promise<DownloadStore> {
  if (isTauri()) {
    const { TauriDownloadStore } = await import('./adapters/tauri');
    return TauriDownloadStore.create();
  }

  if (isCapacitor()) {
    const { CapacitorDownloadStore } = await import('./adapters/capacitor');
    return CapacitorDownloadStore.create();
  }

  // Browser / Next.js web — OPFS preferred, IndexedDB-blob fallback.
  const { WebDownloadStore } = await import('./adapters/web');
  return WebDownloadStore.create();
}

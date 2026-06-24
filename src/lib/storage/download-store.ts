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

import { isTauri, isCapacitor, isAndroid } from '@/lib/utils/platform';

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown when the user backs out of a required step (e.g. declines the Android
 * SAF download-folder picker). Callers treat this like an AbortError: a silent
 * no-op — no error surfaced to the user, no 'failed' history row recorded.
 * Distinct from a genuine failure, which carries a real message and IS recorded.
 */
export class DownloadCancelledError extends Error {
  constructor(message = 'download cancelled by user') {
    super(message);
    this.name = 'DownloadCancelledError';
  }
}

// ── Interface ──────────────────────────────────────────────────────────────

export interface DownloadStoreLookupOptions {
  /** Exact Android public folder name from the DB row, e.g. "<id> <title>". */
  folderName?: string | null;
}

export interface DownloadStore {
  /**
   * Write one image into the gallery folder.
   * @param galleryId  Numeric gallery ID (used as folder name).
   * @param index      Zero-based page index (used to build the filename).
   * @param bytes      Raw image data.
   * @param ext        File extension without leading dot, e.g. "webp".
   */
  putImage(galleryId: number, index: number, bytes: Uint8Array, ext: string): Promise<void>;

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
    options?: DownloadStoreLookupOptions,
  ): Promise<Uint8Array | null>;

  /**
   * A WebView-loadable URL for one stored page. Implemented by adapters that can
   * expose native file URLs without copying bytes through JS. Returns null when
   * the page is missing. Adapters backed by SAF/content URIs may omit this and
   * callers should fall back to lazy getImage reads for visible pages only.
   */
  imageUrl?(galleryId: number, index: number, ext: string): Promise<string | null>;

  /**
   * Cheap existence check for a single stored page — true only when the file
   * exists AND has non-zero size. A zero-byte file (a torn/partial write) is
   * reported as MISSING so resume re-fetches it. Optional: adapters that omit
   * it force callers to fall back to `getImage(...) !== null`.
   *
   * Unlike getImage, this should NOT read the file bytes into the JS heap —
   * adapters use a stat/handle probe so resume stays cheap on large galleries.
   */
  imageExists?(
    galleryId: number,
    index: number,
    ext: string,
    options?: DownloadStoreLookupOptions,
  ): Promise<boolean>;

  /**
   * A WebView-loadable URL (convertFileSrc) for the gallery's first downloaded
   * page, to use as an offline cover — no image bytes pass through the JS heap.
   * Returns null when nothing is downloaded. Optional: adapters without a native
   * file URL (web) omit it, and callers fall back to the network thumbnail.
   */
  coverUrl?(galleryId: number, options?: DownloadStoreLookupOptions): Promise<string | null>;

  /**
   * Prepare the gallery folder in public storage with the known title, so the
   * folder is named `<id> <title>` from the start. Optional: adapters that use
   * numeric-only folder names (Capacitor/web) omit it; callers feature-detect.
   */
  ensureGallery?(galleryId: number, title: string): Promise<void>;

  /**
   * Ensure the store is ready to write — e.g. the Android SAF adapter prompts
   * the user to pick a download folder if none is selected yet. Throws if the
   * user declines (download should abort). Optional: adapters that need no
   * pre-write gate (web/iOS/desktop) omit it; callers feature-detect.
   */
  ensureReady?(): Promise<void>;

  /** List all gallery IDs that have at least one stored image. */
  listGalleries(): Promise<number[]>;

  /** Delete a gallery folder and all its images. */
  deleteGallery(galleryId: number, options?: DownloadStoreLookupOptions): Promise<void>;

  /** Total bytes stored for a specific gallery. */
  gallerySize(galleryId: number, options?: DownloadStoreLookupOptions): Promise<number>;

  /** Total bytes stored across all galleries. */
  usage(): Promise<number>;
}

// ── Filename helpers ───────────────────────────────────────────────────────

/**
 * Build the file name for a page: zero-padded 4-digit index + extension.
 * e.g. index=0, ext="webp" → "0001.webp"
 * Special case: index=-1 → "0000.<ext>" (manifest sentinel).
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
let downloadStorePromise: Promise<DownloadStore> | null = null;

export async function createDownloadStore(): Promise<DownloadStore> {
  if (downloadStorePromise) return downloadStorePromise;

  downloadStorePromise = createDownloadStoreUncached().catch((error) => {
    downloadStorePromise = null;
    throw error;
  });
  return downloadStorePromise;
}

async function createDownloadStoreUncached(): Promise<DownloadStore> {
  if (isTauri()) {
    const { TauriDownloadStore } = await import('./adapters/tauri');
    return TauriDownloadStore.create();
  }

  // Android public storage — must come before the generic isCapacitor() branch
  // so iOS keeps using CapacitorDownloadStore (Directory.Data).
  if (isAndroid()) {
    const { AndroidPublicDownloadStore } = await import('./adapters/android-public');
    return AndroidPublicDownloadStore.create();
  }

  if (isCapacitor()) {
    const { CapacitorDownloadStore } = await import('./adapters/capacitor');
    return CapacitorDownloadStore.create();
  }

  // Browser / Next.js web — OPFS preferred, IndexedDB-blob fallback.
  const { WebDownloadStore } = await import('./adapters/web');
  return WebDownloadStore.create();
}

export function __resetDownloadStoreForTests(): void {
  downloadStorePromise = null;
}

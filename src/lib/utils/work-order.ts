/**
 * Pure work-order resolution for a gallery download.
 *
 * Extracts the per-page URL + ext derivation that download-zip and the native
 * Android WorkManager worker both need: for each page, the 'auto' (avif > webp >
 * original) image URL and the extension that URL actually points at.
 *
 * For the native worker (Task C) it ALSO produces, per page, the target relative
 * path under the SAF tree (`HiPaGo/<id title>/NNNN.ext`) and the request headers
 * the Rust core must send (the same Referer/Origin the in-process fetch uses on
 * native, via getNativeHeaders) — so the worker re-derives nothing.
 *
 * This is intentionally side-effect-free so it can be unit-tested directly and
 * persisted for the native worker without re-deriving anything.
 */
import { getImageUrl } from './image-url';
import { getNativeHeaders } from '@/lib/api/url-resolver';
import { galleryFolderName, LIBRARY_ROOT } from '@/lib/storage/base-path-resolver';
import type { GalleryFile, GgConfig } from './types';

export interface WorkOrderItem {
  index: number;
  url: string;
  ext: string;
}

/**
 * A single page of the native worker's handoff work-order. Extends
 * {@link WorkOrderItem} with the SAF-relative destination path and the request
 * headers, so the worker can download + place each page with no further derivation.
 */
export interface WorkOrderPage extends WorkOrderItem {
  /** Relative path under the picked SAF tree, e.g. "HiPaGo/12345 Title/0001.webp". */
  relPath: string;
  /** Headers the native downloader must send (Referer/Origin on native, else {}). */
  headers: Record<string, string>;
}

/**
 * The full handoff work-order written to the Android handoff dir and read by the
 * native worker. Mirrors the worker's JSON contract exactly.
 */
export interface WorkOrder {
  galleryId: number;
  /** Opaque identity for this concrete attempt; changes on every rebuild/retry. */
  runId: string;
  title: string;
  folderName: string;
  /** UI locale used by native background surfaces such as Android notifications. */
  locale?: 'en' | 'ko';
  queuePosition?: number | null;
  pages: WorkOrderPage[];
}

/**
 * Generate an opaque native-attempt id without embedding gallery/user data.
 * WebView/Node crypto is required because run ids are a correctness boundary,
 * not a best-effort UI identifier.
 */
export function createDownloadRunId(): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
    throw new Error('Secure random generation is unavailable');
  }
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  // UUID-v4 shape is readable in diagnostics and accepted by the native
  // alphanumeric/hyphen validator; uniqueness, not UUID semantics, is required.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Resolve the ordered list of {index, url, ext} for a gallery's pages.
 *
 * Mirrors the logic previously inline in downloadGalleryToLibrary:
 *   - url  = getImageUrl(file, ggConfig, 'auto')   // avif > webp > original
 *   - ext  = url.split('?')[0].split('.').pop() || 'webp'
 *
 * The ext here is the URL-derived ext (used for the cache-copy filename + its
 * manifest entry). The network path may still refine it from content-type, but
 * for the cache-copy path this is the authoritative ext.
 */
export function resolveWorkOrder(files: GalleryFile[], ggConfig: GgConfig): WorkOrderItem[] {
  return files.map((file, index) => {
    const url = getImageUrl(file, ggConfig, 'auto');
    const ext = url.split('?')[0].split('.').pop() || 'webp';
    return { index, url, ext };
  });
}

/**
 * Build the full handoff work-order for the native Android download worker.
 *
 * Adds, per page, the SAF-relative destination path
 * (`HiPaGo/<id title>/NNNN.ext`, matching the TS reader/`imageFileName` 1-based
 * zero-padded naming) and the native request headers (getNativeHeaders()). The
 * worker writes images + the `0000.json` manifest into exactly this location, so
 * the existing library reader/reconcile sees them unchanged.
 */
export function buildWorkOrder(
  galleryId: number,
  title: string,
  files: GalleryFile[],
  ggConfig: GgConfig,
  runId = createDownloadRunId(),
  existingFolderName?: string | null,
): WorkOrder {
  // Keep retries in the exact physical folder recorded by the DB. A gallery's
  // title can change between attempts; deriving a new name would split one
  // logical download across two directories and hide reusable partial pages.
  const folderName = existingFolderName || galleryFolderName(galleryId, title);
  const headers = getNativeHeaders();
  const items = resolveWorkOrder(files, ggConfig);
  const pages: WorkOrderPage[] = items.map((item) => ({
    ...item,
    // 1-based, zero-padded to 4 digits — identical to imageFileName(index, ext).
    relPath: `${LIBRARY_ROOT}/${folderName}/${String(item.index + 1).padStart(4, '0')}.${item.ext}`,
    headers,
  }));
  return { galleryId, runId, title, folderName, pages };
}

/**
 * iOS subdir of `Directory.Data` the gallery images live under
 * (`CapacitorDownloadStore` DOWNLOADS_DIR). Kept here so the iOS work-order's
 * `relPath` matches the Swift `DownloadBackgroundTask` layout exactly.
 */
const IOS_DOWNLOADS_DIR = 'downloads';

/**
 * Build the handoff work-order for the iOS best-effort background task (Task D).
 *
 * Differs from {@link buildWorkOrder} (Android) ONLY in the per-page destination
 * layout: iOS stores galleries at `downloads/<galleryId>/NNNN.ext` under
 * `@capacitor/filesystem` `Directory.Data` — a NUMERIC-only folder (no title),
 * matching `CapacitorDownloadStore` (src/lib/storage/adapters/capacitor.ts). The
 * Swift task actually rebuilds the absolute path itself from galleryId + index +
 * ext, so `relPath` here is documentary/self-describing (the Swift parser ignores
 * it); we still emit the correct iOS-relative path rather than Android's
 * `HiPaGo/<id title>/…` so the JSON is not misleading.
 *
 * `title` is retained in the order for parity with the Android shape but is not
 * used in the iOS path (numeric folder).
 */
export function buildIosWorkOrder(
  galleryId: number,
  title: string,
  files: GalleryFile[],
  ggConfig: GgConfig,
  runId = createDownloadRunId(),
): WorkOrder {
  const headers = getNativeHeaders();
  const items = resolveWorkOrder(files, ggConfig);
  const pages: WorkOrderPage[] = items.map((item) => ({
    ...item,
    // downloads/<id>/NNNN.ext — 1-based, zero-padded to 4 digits (imageFileName).
    relPath: `${IOS_DOWNLOADS_DIR}/${galleryId}/${String(item.index + 1).padStart(4, '0')}.${item.ext}`,
    headers,
  }));
  // folderName is the numeric-only iOS gallery folder (galleryFolderName in
  // download-store.ts = String(galleryId)).
  return { galleryId, runId, title, folderName: String(galleryId), pages };
}

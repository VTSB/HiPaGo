import { zipSync } from 'fflate';
import { getImageUrl } from './image-url';
import { apiClient, ApiError } from '@/lib/api/client';
import type { GalleryFile, GgConfig } from './types';
import { createDownloadStore } from '@/lib/storage/download-store';
import { getImageCache } from '@/lib/cache/image-cache';
import {
  upsertDownload,
  updateDownloadStatus,
  updateDownloadProgress,
  serializeTags,
} from '@/lib/db/download';
import { parseRetryAfter } from '@/lib/api/tag-fetcher';
import { galleryFolderName } from '@/lib/storage/base-path-resolver';

/** Sanitize a string for use as a filename/folder component. */
export function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'gallery';
}

function padIndex(idx: number, total: number): string {
  const digits = String(total).length;
  return String(idx).padStart(digits, '0');
}

export interface DownloadProgress {
  current: number;
  total: number;
}

/** Derive the actual file extension from the HTTP response content-type and file metadata. */
function deriveExt(res: Response, file: GalleryFile): string {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('avif')) return 'avif';
  if (ct.includes('png')) return 'png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('webp')) return 'webp';
  if (!file.haswebp) return file.name.split('.').pop() || 'jpg';
  return 'webp';
}

// ── Index sentinel for manifest storage ───────────────────────────────────────
// The manifest (page ext array) is stored as "0000.json" inside the gallery folder.
// Real page filenames start at "0001.*" (index 0 → index+1 = 1), so 0000 is safe.
const MANIFEST_INDEX = -1; // imageFileName(-1, 'json') → "0000.json"
const MANIFEST_EXT = 'json';

/** Encode the per-page ext array as bytes for storage. */
function encodeManifest(exts: string[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(exts));
}

/** Decode the per-page ext array from stored bytes. Returns [] on error. */
function decodeManifest(bytes: Uint8Array): string[] {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as string[];
  } catch {
    return [];
  }
}

// ── Fetch with retry/backoff (mirrors tag-fetcher.ts HttpFetcher) ─────────────

const FETCH_MAX_RETRIES = 3;
const FETCH_BACKOFF_MS = [1000, 2000, 4000];

/**
 * Fetch a URL with up to 3 retries and exponential backoff.
 *
 * Retry policy (mirrors HttpFetcher in tag-fetcher.ts):
 *  - 429: honor Retry-After header, then retry
 *  - 502 / 503 / 504: retry with backoff
 *  - Timeout (AbortError from the per-attempt controller): retry with backoff
 *  - AbortError from the *caller* signal: rethrow immediately (no retry)
 *  - Other errors (4xx, network, etc.): rethrow immediately
 */
async function fetchWithRetry(url: string, signal?: AbortSignal): Promise<Response> {
  let lastError: Error | undefined;
  let retryAfterMs: number | null = null;

  for (let attempt = 0; attempt <= FETCH_MAX_RETRIES; attempt++) {
    // Propagate caller abort immediately.
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    if (attempt > 0) {
      const delay = retryAfterMs ?? FETCH_BACKOFF_MS[attempt - 1] ?? 4000;
      retryAfterMs = null;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
      // Check again after the wait.
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    }

    // Per-attempt timeout controller (30 s), distinct from caller signal.
    // Mirrors tag-fetcher.ts HttpFetcher: pass the timeout signal only;
    // distinguish caller-abort from timeout-abort via signal?.aborted in catch.
    const attemptController = new AbortController();
    const timer = setTimeout(() => attemptController.abort(), 30_000);

    try {
      const res = await apiClient.fetchUrl(url, { signal: attemptController.signal });

      if (res.status === 429) {
        retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
        lastError = new ApiError(429, `Rate limited (429) fetching image (attempt ${attempt + 1})`);
        continue;
      }
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        lastError = new ApiError(res.status, `Server error ${res.status} fetching image (attempt ${attempt + 1})`);
        continue;
      }

      return res;
    } catch (err) {
      const e = err as Error;

      // Caller-level abort: do not retry.
      if (e.name === 'AbortError' && signal?.aborted) {
        throw e;
      }

      // Per-attempt timeout: retry.
      if (e.name === 'AbortError') {
        lastError = new Error(`Timeout fetching image (attempt ${attempt + 1})`);
        continue;
      }

      // Other errors (ApiError 4xx, network, etc.): rethrow immediately.
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error('fetchWithRetry: exhausted all retries');
}

// ── Reader-facing helpers (consumed by AC-005) ─────────────────────────────────

/**
 * Returns the per-page extension list for a downloaded gallery.
 * Returns an empty array when no manifest is found.
 *
 * AC-005 uses this to know the ext for each page when calling getImage.
 */
export async function getDownloadedGalleryPages(
  galleryId: number,
): Promise<{ index: number; ext: string }[]> {
  const store = await createDownloadStore();
  const bytes = await store.getImage(galleryId, MANIFEST_INDEX, MANIFEST_EXT);
  if (!bytes) return [];
  const exts = decodeManifest(bytes);
  return exts.map((ext, index) => ({ index, ext }));
}

/**
 * Read one downloaded image by gallery + page index.
 * Resolves the ext via the stored manifest; returns null when missing.
 *
 * AC-005 calls this to load offline images in the reader.
 */
export async function getDownloadedImage(
  galleryId: number,
  index: number,
): Promise<Uint8Array | null> {
  const store = await createDownloadStore();
  const manifestBytes = await store.getImage(galleryId, MANIFEST_INDEX, MANIFEST_EXT);
  if (!manifestBytes) return null;
  const exts = decodeManifest(manifestBytes);
  const ext = exts[index];
  if (!ext) return null;
  return store.getImage(galleryId, index, ext);
}

// ── AC-006: Streaming download to the library (resilience rewrite) ─────────────

/**
 * Download a gallery into the offline library.
 *
 * Resilience contract (AC-006):
 *  - NO DB row is created before the first page is successfully written.
 *  - The first successful page creates the row (status:'downloading', pageCount:1).
 *  - Subsequent pages call updateDownloadProgress(galleryId, i+1, totalBytes).
 *  - The manifest (0000.json) is written incrementally after each page.
 *  - Per-page fetch uses fetchWithRetry (up to 3 retries, backoff, 429/5xx/timeout).
 *  - If putImageFromFile (cache copy) throws, the error is caught and the page
 *    falls through to the network fetch path — no whole-download failure.
 *  - On success: final upsertDownload with status:'complete' and final stats.
 *  - On abort before first page: no DB row left; AbortError rethrown.
 *  - On abort after some pages (rowCreated): updateDownloadStatus('failed'), rethrow.
 *  - On non-abort error before first page: no DB row left; error rethrown.
 *  - On non-abort error after some pages (rowCreated): updateDownloadStatus('failed'),
 *    partial pages retained; error rethrown.
 */
export async function downloadGalleryToLibrary(
  galleryId: number,
  title: string,
  thumbnail: string,
  files: GalleryFile[],
  ggConfig: GgConfig,
  tags: Record<string, string[]>,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const total = files.length;
  const now = new Date().toISOString();

  // Compute the folder name (pure string, safe on all platforms).
  const folderName = galleryFolderName(galleryId, title);

  const store = await createDownloadStore();

  // Prepare the gallery folder in public storage if the adapter supports it.
  if (store.ensureGallery) {
    await store.ensureGallery(galleryId, title);
  }

  // If the platform can copy files natively, reuse images already in the
  // persistent cache instead of re-fetching them — a native file→file copy,
  // no image bytes through the JS heap. Web omits putImageFromFile (and its
  // cache is a no-op), so it always fetches.
  const imageCache = store.putImageFromFile ? await getImageCache().catch(() => null) : null;

  const pageExts: string[] = [];
  let totalBytes = 0;
  let rowCreated = false;

  try {
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const file = files[i];
      const url = getImageUrl(file, ggConfig, 'webp');

      let pageWritten = false;

      // ── Cache-copy path ──────────────────────────────────────────────────────
      // Try to copy from the persistent image cache natively. If this throws
      // (permission error, file gone, etc.) we catch and fall through to the
      // network path rather than failing the whole download.
      if (imageCache && store.putImageFromFile) {
        const cachedPath = await imageCache.cachedFilePath(url).catch(() => null);
        if (cachedPath) {
          try {
            const size = await store.putImageFromFile(galleryId, i, cachedPath, 'webp');
            pageExts.push('webp');
            totalBytes += size;
            pageWritten = true;
          } catch {
            // Cache copy failed; fall through to network fetch below.
          }
        }
      }

      // ── Network fetch path ───────────────────────────────────────────────────
      if (!pageWritten) {
        const res = await fetchWithRetry(url, signal);
        const buf = await res.arrayBuffer();
        const ext = deriveExt(res, file);
        const bytes = new Uint8Array(buf);

        await store.putImage(galleryId, i, bytes, ext);
        pageExts.push(ext);
        totalBytes += bytes.byteLength;
      }

      // ── Incremental manifest write ───────────────────────────────────────────
      await store.putImage(
        galleryId,
        MANIFEST_INDEX,
        encodeManifest(pageExts),
        MANIFEST_EXT,
      );

      // ── DB row management ────────────────────────────────────────────────────
      if (!rowCreated) {
        await upsertDownload({
          galleryId,
          title,
          thumbnail,
          tags: serializeTags(tags),
          pageCount: 1,
          totalBytes,
          downloadedAt: now,
          status: 'downloading',
          folderName,
        });
        rowCreated = true;
      } else {
        await updateDownloadProgress(galleryId, i + 1, totalBytes);
      }

      onProgress?.({ current: i + 1, total });
    }

    // ── Success: mark complete with final stats ───────────────────────────────
    await upsertDownload({
      galleryId,
      title,
      thumbnail,
      tags: serializeTags(tags),
      pageCount: total,
      totalBytes,
      downloadedAt: now,
      status: 'complete',
      folderName,
    });
  } catch (err) {
    const isAbort = (err as Error).name === 'AbortError';

    if (rowCreated) {
      // Partial pages are retained; mark failed so the UI can show the state.
      await updateDownloadStatus(galleryId, 'failed');
    }
    // When no row was created (error on page 0): nothing to clean up.

    if (isAbort && !rowCreated) {
      // Aborted before any page was written: leave no trace.
    }

    throw err;
  }
}

// ── AC-007: ZIP export from a library item ─────────────────────────────────────

/**
 * Re-zip the stored loose images for a gallery and trigger an OS download.
 *
 * Reads pages via the stored manifest so it knows each page's ext, then
 * builds a zip with fflate (level 0 — images are already compressed) and
 * triggers the browser `<a download>` to the OS downloads folder.
 *
 * This preserves the original downloadGalleryAsZip behaviour as a secondary
 * action on a library item (AC-004 wires the button).
 */
export async function exportGalleryZip(galleryId: number, title: string): Promise<void> {
  const store = await createDownloadStore();

  // Load the manifest to know how many pages and their exts.
  const manifestBytes = await store.getImage(galleryId, MANIFEST_INDEX, MANIFEST_EXT);
  if (!manifestBytes) {
    throw new Error(`No manifest found for gallery ${galleryId}. Is it fully downloaded?`);
  }
  const exts = decodeManifest(manifestBytes);

  const entries: Record<string, Uint8Array> = {};
  for (let i = 0; i < exts.length; i++) {
    const ext = exts[i];
    const bytes = await store.getImage(galleryId, i, ext);
    if (bytes) {
      // Use the same zero-padded name that the store used, e.g. "0001.webp"
      const name = String(i + 1).padStart(4, '0') + '.' + ext;
      entries[name] = bytes;
    }
  }

  const zipped = zipSync(entries, { level: 0 });
  const safeName = sanitizeFilename(title);
  const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${galleryId} ${safeName}.zip`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Legacy: OS-folder zip download (kept for fallback / older callsites) ───────

export async function downloadGalleryAsZip(
  galleryId: number,
  title: string,
  files: GalleryFile[],
  ggConfig: GgConfig,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const total = files.length;
  const entries: Record<string, Uint8Array> = {};

  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const file = files[i];
    const url = getImageUrl(file, ggConfig, 'webp');
    const res = await apiClient.fetchUrl(url, { signal });
    const buf = await res.arrayBuffer();
    // Derive extension from actual content type or URL
    const ct = res.headers.get('content-type') || '';
    let ext = 'webp';
    if (ct.includes('avif')) ext = 'avif';
    else if (ct.includes('png')) ext = 'png';
    else if (ct.includes('jpeg') || ct.includes('jpg')) ext = 'jpg';
    else if (ct.includes('gif')) ext = 'gif';
    else if (!file.haswebp) ext = file.name.split('.').pop() || 'jpg';
    const name = `${padIndex(i + 1, total)}.${ext}`;
    entries[name] = new Uint8Array(buf);

    onProgress?.({ current: i + 1, total });
  }

  const zipped = zipSync(entries, { level: 0 }); // no compression, images are already compressed

  const safeName = sanitizeFilename(title);
  const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${galleryId} ${safeName}.zip`;
  a.click();
  URL.revokeObjectURL(a.href);
}

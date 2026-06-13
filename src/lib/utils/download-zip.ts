import { zipSync } from 'fflate';
import { getImageUrl } from './image-url';
import { apiClient, ApiError } from '@/lib/api/client';
import type { GalleryFile, GgConfig } from './types';
import { createDownloadStore, DownloadCancelledError } from '@/lib/storage/download-store';
import { getImageCache } from '@/lib/cache/image-cache';
import {
  upsertDownload,
  updateDownloadProgress,
  setDownloadError,
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

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function createAttemptSignal(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const onCallerAbort = () => controller.abort();
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

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

    // Per-attempt timeout plus caller abort. Passing only the timeout signal
    // would leave an in-flight image fetch running after the user cancels.
    const attemptAbort = createAttemptSignal(30_000, signal);

    try {
      const res = await apiClient.fetchUrl(url, { signal: attemptAbort.signal });

      if (res.status === 429) {
        retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
        lastError = new ApiError(429, `Rate limited (429) fetching image (attempt ${attempt + 1})`);
        continue;
      }
      if (isRetryableStatus(res.status)) {
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

      // apiClient.fetchUrl throws ApiError for non-ok statuses, so retryable
      // HTTP statuses arrive here rather than through the Response branch above.
      if (err instanceof ApiError && isRetryableStatus(err.status)) {
        lastError = err;
        continue;
      }

      // Other errors (ApiError 4xx, network, etc.): rethrow immediately.
      throw e;
    } finally {
      attemptAbort.cleanup();
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
 *  - On user cancel before first page: no DB row left; error rethrown.
 *  - On user cancel after some pages (rowCreated): row left as 'failed' (resumable,
 *    no lastError message), partial pages retained; error rethrown.
 *  - On genuine failure (any point, including before the first page): a 'failed'
 *    row is recorded with the real reason in lastError so the library shows it
 *    and offers retry; partial pages (if any) retained; error rethrown.
 *
 * Resume contract (AC-005): when `opts.resume` is true, pages already stored
 * (per the 0000.json manifest, with the last page verified on disk) are skipped
 * and only the remainder is fetched. Default `resume:false` is byte-identical to
 * the original full-download behavior.
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
  opts?: { resume?: boolean },
): Promise<void> {
  const total = files.length;
  const now = new Date().toISOString();

  // Compute the folder name (pure string, safe on all platforms).
  const folderName = galleryFolderName(galleryId, title);

  const store = await createDownloadStore();

  // Make sure the store can write before we touch the network. On Android this
  // prompts the SAF folder picker when no download folder is selected yet, and
  // throws if the user declines — aborting the download cleanly.
  if (store.ensureReady) {
    await store.ensureReady();
  }

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
  let startIndex = 0;

  // ── Resume seeding (AC-005) ───────────────────────────────────────────────
  // Read the manifest to find pages already stored, verify the last one really
  // exists (guard a torn write), then continue from the first missing page.
  if (opts?.resume) {
    try {
      const manifestBytes = await store.getImage(galleryId, MANIFEST_INDEX, MANIFEST_EXT);
      if (manifestBytes) {
        const existing = decodeManifest(manifestBytes);
        let validCount = existing.length;
        if (validCount > 0) {
          const lastIdx = validCount - 1;
          const lastBytes = await store
            .getImage(galleryId, lastIdx, existing[lastIdx])
            .catch(() => null);
          if (!lastBytes) validCount = lastIdx; // drop torn last page
        }
        for (let k = 0; k < validCount && k < total; k++) pageExts.push(existing[k]);
        startIndex = pageExts.length;
      }
    } catch {
      // No manifest / unreadable — start from scratch.
    }
    if (startIndex > 0) {
      // A row already exists from the prior attempt. Flip it back to
      // 'downloading' and clear the stale error; seed totalBytes from disk.
      rowCreated = true;
      totalBytes = await store.gallerySize(galleryId).catch(() => 0);
      await setDownloadError(galleryId, 'downloading', null);
    }
  }

  try {
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      // Already-stored page (resume) — keep its manifest ext, skip the fetch.
      if (i < startIndex) {
        onProgress?.({ current: i + 1, total });
        continue;
      }

      const file = files[i];
      // 'auto' (avif > webp > original) mirrors the reader. Hardcoding 'webp'
      // breaks avif-only galleries (no haswebp): getImageUrl falls back to the
      // original .jpg, which the CDN does not serve, so every page 404s/fails.
      const url = getImageUrl(file, ggConfig, 'auto');
      // The ext the 'auto' URL actually points at (avif/webp/jpg/…), used both
      // for the cache-copy filename and its manifest entry so offline reads
      // resolve the right file.
      const urlExt = url.split('?')[0].split('.').pop() || 'webp';

      let pageWritten = false;

      // ── Cache-copy path ──────────────────────────────────────────────────────
      // Try to copy from the persistent image cache natively. If this throws
      // (permission error, file gone, etc.) we catch and fall through to the
      // network path rather than failing the whole download.
      if (imageCache && store.putImageFromFile) {
        const cachedPath = await imageCache.cachedFilePath(url).catch(() => null);
        if (cachedPath) {
          try {
            const size = await store.putImageFromFile(galleryId, i, cachedPath, urlExt);
            pageExts.push(urlExt);
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
    const e = err as Error;
    const isCancel = e.name === 'AbortError' || err instanceof DownloadCancelledError;

    if (isCancel) {
      // User cancel. If pages were already written, leave a resumable 'failed'
      // row with NO error message (it was not a failure). If nothing was
      // written yet, leave no trace at all.
      if (rowCreated) await setDownloadError(galleryId, 'failed', null);
    } else {
      // Genuine failure. Record a 'failed' row WITH the real reason even when no
      // page was stored yet (failure before page 0) so the library shows it and
      // can offer retry.
      const reason = e.message || 'Download failed';
      if (rowCreated) {
        await setDownloadError(galleryId, 'failed', reason);
      } else {
        await upsertDownload({
          galleryId,
          title,
          thumbnail,
          tags: serializeTags(tags),
          pageCount: 0,
          totalBytes: 0,
          downloadedAt: now,
          status: 'failed',
          folderName,
          lastError: reason,
        });
      }
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
    const url = getImageUrl(file, ggConfig, 'auto');
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

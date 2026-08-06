import { Zip, ZipPassThrough, zipSync } from 'fflate';
import { getImageUrl } from './image-url';
import { resolveWorkOrder } from './work-order';
import { apiClient, ApiError } from '@/lib/api/client';
import type { GalleryFile, GgConfig } from './types';
import {
  createDownloadStore,
  DownloadCancelledError,
  type DownloadStoreLookupOptions,
} from '@/lib/storage/download-store';
import { getImageCache } from '@/lib/cache/image-cache';
import {
  upsertDownload,
  updateDownloadProgress,
  setDownloadError,
  updateDownloadStatus,
  getDownload,
  serializeTags,
  transitionNativeDownloadRun,
  completeNativeDownloadRun,
  resumeNativeDownloadRun,
  updateNativeDownloadProgress,
} from '@/lib/db/download';
import { parseRetryAfter } from '@/lib/api/tag-fetcher';
import { galleryFolderName } from '@/lib/storage/base-path-resolver';
import { isAndroid, isTauri } from './platform';
import type { DBDownload } from '@/lib/db/schema';

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

export type ZipExportResult = 'saved' | 'started' | 'cancelled';

export type ZipExportSourceMetadata = Pick<DBDownload, 'folderName' | 'pageCount' | 'status'>;

export class ZipExportSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipExportSourceError';
  }
}

/** The DB row was replaced while this foreground/native attempt was finishing. */
export class StaleDownloadRunError extends Error {
  constructor() {
    super('Download attempt was replaced');
    this.name = 'StaleDownloadRunError';
  }
}

/**
 * Thrown when a download is aborted because the user (or the queue processor)
 * PAUSED it — as opposed to a genuine cancel. The download row is left as
 * 'paused' (resumable, no lastError) and partial pages are retained. The queue
 * processor treats this distinctly from an AbortError cancel.
 */
export class DownloadPausedError extends Error {
  constructor(message = 'Download paused') {
    super(message);
    this.name = 'DownloadPausedError';
  }
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
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!Array.isArray(parsed)) return [];
    if (!parsed.every((ext) => typeof ext === 'string' && ext.length > 0)) return [];
    return parsed;
  } catch {
    return [];
  }
}

const DOWNLOAD_CHECKPOINT_PAGE_INTERVAL = 10;
const ZIP_EXPORT_READ_CONCURRENCY = 8;
const SAFE_ZIP_MANIFEST_EXTENSION = /^[A-Za-z0-9]{1,16}$/;

type ZipWritableFile = {
  write(data: Uint8Array): Promise<number>;
};

async function writeEntireChunk(file: ZipWritableFile, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const written = await file.write(chunk.subarray(offset));
    if (written <= 0) throw new Error('Could not write the ZIP export');
    offset += written;
  }
}

async function streamStoredGalleryZipToTauri(
  store: Awaited<ReturnType<typeof createDownloadStore>>,
  galleryId: number,
  exts: string[],
  options: DownloadStoreLookupOptions,
  destination: string,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  const exportId = await invoke<number>('begin_zip_export', { destination });
  const output: ZipWritableFile = {
    write: (data) => invoke<number>('write_zip_export', { exportId, data }),
  };
  let committed = false;

  try {
    let writeChain = Promise.resolve();
    let zipError: Error | null = null;
    let finalChunkSeen = false;
    const zip = new Zip((error, chunk, final) => {
      if (error) {
        zipError = error;
        return;
      }
      writeChain = writeChain.then(() => writeEntireChunk(output, chunk));
      if (final) finalChunkSeen = true;
    });

    try {
      for (let i = 0; i < exts.length; i++) {
        const ext = exts[i];
        const bytes = await store.getImage(galleryId, i, ext, options);
        if (!bytes || bytes.byteLength === 0) {
          throw new ZipExportSourceError(
            `Missing downloaded page ${i + 1} for gallery ${galleryId}`,
          );
        }

        const name = String(i + 1).padStart(4, '0') + '.' + ext;
        const entry = new ZipPassThrough(name);
        zip.add(entry);
        entry.push(bytes, true);

        // Bound memory to roughly one page plus pending ZIP output. Waiting for
        // native writes here prevents a large gallery from filling the WebView heap.
        await writeChain;
        if (zipError) throw zipError;
        onProgress?.({ current: i + 1, total: exts.length });
      }

      zip.end();
      await writeChain;
      if (zipError) throw zipError;
      if (!finalChunkSeen) throw new Error('ZIP export ended before the archive was finalized');
    } catch (error) {
      zip.terminate();
      throw error;
    }

    await invoke('commit_zip_export', { exportId });
    committed = true;
  } finally {
    if (!committed) await invoke('abort_zip_export', { exportId }).catch(() => {});
  }
}

async function triggerBrowserZipDownload(bytes: Uint8Array, fileName: string): Promise<void> {
  const blobBytes =
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
      ? bytes.buffer
      : (bytes.slice().buffer as ArrayBuffer);
  const blob = new Blob([blobBytes], { type: 'application/zip' });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);

  try {
    anchor.click();
    // WebView/browser download handling is asynchronous. Give it a task turn
    // before releasing the Blob URL instead of revoking it during the click.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  } finally {
    URL.revokeObjectURL(objectUrl);
    anchor.remove();
  }
}

function shouldWriteDownloadCheckpoint(pageCount: number, total: number): boolean {
  return (
    pageCount === 1 || pageCount >= total || pageCount % DOWNLOAD_CHECKPOINT_PAGE_INTERVAL === 0
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

async function storedPageSize(
  store: Awaited<ReturnType<typeof createDownloadStore>>,
  galleryId: number,
  index: number,
  ext: string,
  options: DownloadStoreLookupOptions,
): Promise<number> {
  const size = store.imageSize ? await store.imageSize(galleryId, index, ext, options) : null;
  if (size !== null) return size;
  const bytes = await store.getImage(galleryId, index, ext, options);
  return bytes?.byteLength ?? 0;
}

async function manifestBackedGallerySize(
  store: Awaited<ReturnType<typeof createDownloadStore>>,
  galleryId: number,
  exts: string[],
  options: DownloadStoreLookupOptions,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < exts.length; i++) {
    total += await storedPageSize(store, galleryId, i, exts[i], options);
  }
  return total;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
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
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
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
        lastError = new ApiError(
          res.status,
          `Server error ${res.status} fetching image (attempt ${attempt + 1})`,
        );
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
  options?: DownloadStoreLookupOptions,
): Promise<{ index: number; ext: string }[]> {
  const store = await createDownloadStore();
  const bytes = await store.getImage(galleryId, MANIFEST_INDEX, MANIFEST_EXT, options);
  if (!bytes) return [];
  const exts = decodeManifest(bytes);
  return exts.map((ext, index) => ({ index, ext }));
}

/**
 * Sum the durable image bytes described by a verified gallery manifest.
 * Returns null when a page disappeared between verification and sizing, while
 * storage/provider failures propagate so callers never commit a false size.
 */
export async function getDownloadedGalleryTotalBytes(
  galleryId: number,
  pages: readonly { index: number; ext: string }[],
  options: DownloadStoreLookupOptions = {},
): Promise<number | null> {
  const store = await createDownloadStore();
  let total = 0;
  for (const page of pages) {
    const size = await storedPageSize(store, galleryId, page.index, page.ext, options);
    if (size <= 0) return null;
    total += size;
  }
  return total;
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
  options?: DownloadStoreLookupOptions,
): Promise<Uint8Array | null> {
  const store = await createDownloadStore();
  const manifestBytes = await store.getImage(galleryId, MANIFEST_INDEX, MANIFEST_EXT, options);
  if (!manifestBytes) return null;
  const exts = decodeManifest(manifestBytes);
  const ext = exts[index];
  if (!ext) return null;
  const bytes = await store.getImage(galleryId, index, ext, options);
  return bytes && bytes.byteLength > 0 ? bytes : null;
}

/**
 * Verify that a completed gallery's manifest exactly matches the expected page
 * count and every listed page is actually present on disk. A manifest-only check
 * can be fooled by external deletion or a stale/corrupt storage state.
 */
export async function hasCompleteDownloadedGallery(
  galleryId: number,
  expectedPageCount: number,
  options?: DownloadStoreLookupOptions,
): Promise<boolean> {
  const store = await createDownloadStore();
  const manifestBytes = await store.getImage(galleryId, MANIFEST_INDEX, MANIFEST_EXT, options);
  if (!manifestBytes) return false;

  const exts = decodeManifest(manifestBytes);
  if (exts.length === 0) return false;
  if (expectedPageCount > 0 && exts.length !== expectedPageCount) return false;

  if (store.allImagesExist) {
    return store.allImagesExist(galleryId, exts, options);
  }

  for (let i = 0; i < exts.length; i++) {
    const ext = exts[i];
    const exists = store.imageExists
      ? await store.imageExists(galleryId, i, ext, options)
      : (await store.getImage(galleryId, i, ext, options)) !== null;
    if (!exists) return false;
  }

  return true;
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
 * Resume contract (AC-005 + resume-verify-all-pages): when `opts.resume` is
 * true, EVERY page is verified on disk per-page (not just the last). A page is
 * re-fetched whenever it is missing — including a gap deleted from the MIDDLE of
 * a previously-downloaded gallery, or a torn/zero-byte page. Pages confirmed
 * present on disk are skipped (no network) and keep their stored ext. The
 * manifest is rebuilt to reflect the true on-disk set. Existence is probed via
 * the cheap `store.imageExists` (stat, size>0) when the adapter exposes it,
 * falling back to `getImage(...) !== null` otherwise. Default `resume:false` is
 * byte-identical to the original full-download behavior.
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
  opts?: { resume?: boolean; isPauseSignal?: () => boolean; nativeRunId?: string },
): Promise<void> {
  const total = files.length;
  if (total === 0) {
    // The manifest contract requires at least one page. Treating an empty work
    // order as complete would publish no 0000.json, stamp Android public-storage
    // ownership, and make the next reconciliation delete the catalog row.
    throw new Error('Gallery has no downloadable files');
  }
  const now = new Date().toISOString();

  const existingRow = await getDownload(galleryId).catch(() => null);
  if (
    opts?.nativeRunId &&
    (existingRow?.status !== 'downloading' || existingRow.nativeRunId !== opts.nativeRunId)
  ) {
    throw new StaleDownloadRunError();
  }
  const folderName = existingRow?.folderName ?? galleryFolderName(galleryId, title);
  // Preserve an existing public-storage watermark throughout a retry, but do
  // not create a new one until the manifest-backed completion write succeeds.
  // Marking a fresh row before completion would let reconciliation prune a
  // retryable failure whose worker never managed to publish its manifest.
  const existingPublicStoredAt = existingRow?.migratedAt ?? null;
  const completedPublicStoredAt = isAndroid()
    ? (existingPublicStoredAt ?? now)
    : existingPublicStoredAt;
  const lookup = { folderName };

  const store = await createDownloadStore();

  // Make sure the store can write before we touch the network. On Android this
  // prompts the SAF folder picker when no download folder is selected yet, and
  // throws if the user declines — aborting the download cleanly.
  if (store.ensureReady) {
    await store.ensureReady();
  }

  // Prepare the gallery folder in public storage if the adapter supports it.
  if (store.ensureGallery && !existingRow?.folderName) {
    await store.ensureGallery(galleryId, title);
  }

  // If the platform can copy files natively, reuse images already in the
  // persistent cache instead of re-fetching them — a native file→file copy,
  // no image bytes through the JS heap. Web omits putImageFromFile (and its
  // cache is a no-op), so it always fetches.
  const imageCache = store.putImageFromFile ? await getImageCache().catch(() => null) : null;

  // Pre-resolve the per-page URL + ext once (pure). The network path may still
  // refine ext from the response content-type; this is the URL-derived ext used
  // for the cache-copy path + its manifest entry (behavior identical to before).
  const workOrder = resolveWorkOrder(files, ggConfig);

  const pageExts: string[] = [];
  let totalBytes = 0;
  let rowCreated = false;
  let resumeManifestNeedsExtension = false;
  if (
    opts?.nativeRunId ||
    (existingRow?.status === 'downloading' && existingRow.pageCount >= total)
  ) {
    rowCreated = true;
    totalBytes = existingRow?.totalBytes ?? 0;
  }

  // ── Resume seeding (per-page verify) ──────────────────────────────────────
  // Read the manifest to learn each already-stored page's ext. The main loop
  // verifies every index against the disk and re-fetches any gap (deleted or
  // torn page), instead of continuing past the last stored page only.
  let manifestExts: string[] = [];
  if (opts?.resume) {
    const manifestBytes = await store.getImage(galleryId, MANIFEST_INDEX, MANIFEST_EXT, lookup);
    if (manifestBytes) manifestExts = decodeManifest(manifestBytes);
    if (manifestExts.length > 0) {
      // A row already exists from the prior attempt. Flip it back to
      // 'downloading' and clear the stale error; seed totalBytes only from
      // manifest-backed pages. Checkpointed downloads may leave newer tail
      // files on disk that are not in the manifest yet; those pages will be
      // re-fetched and must not be counted twice.
      rowCreated = true;
      totalBytes = await manifestBackedGallerySize(store, galleryId, manifestExts, lookup);
      if (opts?.nativeRunId) {
        if (!(await resumeNativeDownloadRun(galleryId, opts.nativeRunId))) {
          throw new StaleDownloadRunError();
        }
      } else {
        await setDownloadError(galleryId, 'downloading', null);
      }
    }
  }

  // Probe whether a page already exists on disk: prefer the cheap
  // store.imageExists (stat, size>0) and fall back to reading the bytes.
  const pageIsPresent = async (index: number, ext: string): Promise<boolean> => {
    if (store.imageExists) return store.imageExists(galleryId, index, ext, lookup);
    return (await store.getImage(galleryId, index, ext, lookup)) !== null;
  };

  try {
    for (let i = 0; i < total; i++) {
      throwIfAborted(signal);

      // ── Resume: skip a page already present on disk ──────────────────────────
      // Only checkable when the manifest knows this index's ext; an unknown ext
      // (manifest shorter than i, or missing) is treated as missing → fetched.
      if (opts?.resume) {
        const knownExt = manifestExts[i];
        if (knownExt && (await pageIsPresent(i, knownExt))) {
          // Keep the stored ext; its bytes are already counted in the
          // disk-seeded totalBytes (rowCreated is true whenever a manifest
          // existed, which is the only way knownExt is set). Skip the network.
          pageExts.push(knownExt);
          // A fully-present resume already has a complete manifest, so avoid
          // rewriting it for every skipped page. Once a missing gap was
          // refetched, though, the manifest was truncated to that index; extend
          // it over subsequent verified skipped pages so an interruption does
          // not drop their exts.
          if (resumeManifestNeedsExtension) {
            await store.putImage(
              galleryId,
              MANIFEST_INDEX,
              encodeManifest(pageExts),
              MANIFEST_EXT,
              lookup,
            );
          }
          onProgress?.({ current: i + 1, total });
          continue;
        }
      }

      const file = files[i];
      // 'auto' (avif > webp > original) mirrors the reader. Hardcoding 'webp'
      // breaks avif-only galleries (no haswebp): getImageUrl falls back to the
      // original .jpg, which the CDN does not serve, so every page 404s/fails.
      // Resolved once up front by resolveWorkOrder (AC-004) — same URL/ext.
      const { url, ext: urlExt } = workOrder[i];

      let pageWritten = false;

      // ── Cache-copy path ──────────────────────────────────────────────────────
      // Try to copy from the persistent image cache natively. If this throws
      // (permission error, file gone, etc.) we catch and fall through to the
      // network path rather than failing the whole download.
      if (imageCache && store.putImageFromFile) {
        const cachedPath = await imageCache.cachedFilePath(url).catch(() => null);
        if (cachedPath) {
          try {
            throwIfAborted(signal);
            const size = await store.putImageFromFile(galleryId, i, cachedPath, urlExt, lookup);
            throwIfAborted(signal);
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
        throwIfAborted(signal);
        const buf = await res.arrayBuffer();
        throwIfAborted(signal);
        const ext = deriveExt(res, file);
        const bytes = new Uint8Array(buf);

        await store.putImage(galleryId, i, bytes, ext, lookup);
        throwIfAborted(signal);
        pageExts.push(ext);
        totalBytes += bytes.byteLength;
      }

      // ── Checkpoint manifest write ────────────────────────────────────────────
      // Writing the growing manifest after every page is expensive on Web OPFS /
      // IndexedDB and Android public storage. Checkpoints keep resume bounded:
      // an interruption can lose only the unmanifested tail, which is safely
      // re-fetched on the next resume.
      const pageCount = i + 1;
      const wroteManifest = shouldWriteDownloadCheckpoint(pageCount, total);
      if (wroteManifest) {
        await store.putImage(
          galleryId,
          MANIFEST_INDEX,
          encodeManifest(pageExts),
          MANIFEST_EXT,
          lookup,
        );
      }
      if (opts?.resume) resumeManifestNeedsExtension = !wroteManifest;

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
          migratedAt: existingPublicStoredAt,
          queuePosition: existingRow?.queuePosition ?? null,
          retryCount: existingRow?.retryCount ?? null,
          nextRetryAt: null,
          nativeRunId: opts?.nativeRunId ?? existingRow?.nativeRunId ?? null,
        });
        rowCreated = true;
      } else {
        const persist = shouldWriteDownloadCheckpoint(pageCount, total);
        if (opts?.nativeRunId) {
          if (
            !(await updateNativeDownloadProgress(
              galleryId,
              opts.nativeRunId,
              pageCount,
              totalBytes,
              { persist },
            ))
          ) {
            throw new StaleDownloadRunError();
          }
        } else {
          await updateDownloadProgress(galleryId, pageCount, totalBytes, { persist });
        }
      }

      onProgress?.({ current: i + 1, total });
    }

    // ── Success: mark complete with final stats ───────────────────────────────
    // Cancel/pause may arrive while the final page or checkpoint manifest write
    // is awaiting native storage. Re-check immediately before the terminal CAS
    // so that user intent wins that last-page race.
    throwIfAborted(signal);
    const completedRow: DBDownload = {
      galleryId,
      title,
      thumbnail,
      tags: serializeTags(tags),
      pageCount: total,
      totalBytes,
      downloadedAt: now,
      status: 'complete',
      folderName,
      migratedAt: completedPublicStoredAt,
      retryCount: 0,
      nextRetryAt: null,
    };
    if (opts?.nativeRunId) {
      if (!(await completeNativeDownloadRun(completedRow, opts.nativeRunId))) {
        throw new StaleDownloadRunError();
      }
    } else {
      await upsertDownload(completedRow);
    }
    // The terminal DB write itself is asynchronous. If cancel/pause arrived
    // while it was committing, route through the catch below so user intent is
    // re-applied (the native path deliberately retains its exact run token).
    throwIfAborted(signal);
  } catch (err) {
    if (err instanceof StaleDownloadRunError) throw err;
    const e = err as Error;
    const isAbort = e.name === 'AbortError' || err instanceof DownloadCancelledError;
    // An abort that the caller marked as a PAUSE (not a cancel): leave the row
    // 'paused' (resumable, partial pages retained, no lastError) and rethrow a
    // DownloadPausedError so the queue processor can tell the two apart.
    const isPause = isAbort && opts?.isPauseSignal?.() === true;

    if (isPause) {
      if (opts?.nativeRunId) {
        if (
          !(await transitionNativeDownloadRun(galleryId, opts.nativeRunId, 'paused', null, {
            clearRunId: false,
            clearQueuePosition: false,
          }))
        ) {
          throw new StaleDownloadRunError();
        }
      } else {
        await updateDownloadStatus(galleryId, 'paused');
      }
      throw new DownloadPausedError();
    }

    const isCancel = isAbort;

    if (isCancel) {
      // User cancel. If pages were already written, leave a resumable 'failed'
      // row with NO error message (it was not a failure). If nothing was
      // written yet, leave no trace at all.
      if (rowCreated) {
        if (opts?.nativeRunId) {
          if (
            !(await transitionNativeDownloadRun(galleryId, opts.nativeRunId, 'failed', null, {
              clearRunId: false,
            }))
          ) {
            throw new StaleDownloadRunError();
          }
        } else {
          await setDownloadError(galleryId, 'failed', null);
        }
      }
    } else {
      // Genuine failure. Record a 'failed' row WITH the real reason even when no
      // page was stored yet (failure before page 0) so the library shows it and
      // can offer retry.
      const reason = e.message || 'Download failed';
      if (rowCreated) {
        if (opts?.nativeRunId) {
          if (
            !(await transitionNativeDownloadRun(galleryId, opts.nativeRunId, 'failed', reason, {
              clearRunId: false,
            }))
          ) {
            throw new StaleDownloadRunError();
          }
        } else {
          await setDownloadError(galleryId, 'failed', reason);
        }
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
          migratedAt: existingPublicStoredAt,
          lastError: reason,
          queuePosition: existingRow?.queuePosition ?? null,
          retryCount: existingRow?.retryCount ?? null,
          nextRetryAt: null,
          nativeRunId: opts?.nativeRunId ?? existingRow?.nativeRunId ?? null,
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
 * streams the archive to a native save-dialog path on Tauri. Web and mobile
 * keep the browser download fallback.
 *
 * This preserves the original downloadGalleryAsZip behaviour as a secondary
 * action on a library item (AC-004 wires the button).
 */
export async function exportGalleryZip(
  galleryId: number,
  title: string,
  onProgress?: (progress: DownloadProgress) => void,
  sourceFallback?: ZipExportSourceMetadata,
): Promise<ZipExportResult> {
  const store = await createDownloadStore();
  const row = await getDownload(galleryId).catch(() => null);
  const source = row ?? sourceFallback;
  if (!source) {
    throw new ZipExportSourceError(`No download record found for gallery ${galleryId}`);
  }
  if (source.status !== 'complete') {
    throw new ZipExportSourceError(
      `Downloaded gallery ${galleryId} is not complete (status: ${source.status})`,
    );
  }

  // The rendered library item is a safe fallback when a transient DB lookup
  // fails. Prefer the latest DB value when present, but never discard the exact
  // Android SAF folder name that the caller already resolved.
  const options: DownloadStoreLookupOptions = {
    folderName: row?.folderName ?? sourceFallback?.folderName ?? null,
  };

  // Load the manifest to know how many pages and their exts.
  const manifestBytes = await store.getImage(galleryId, MANIFEST_INDEX, MANIFEST_EXT, options);
  if (!manifestBytes) {
    throw new ZipExportSourceError(
      `No manifest found for gallery ${galleryId}. Is it fully downloaded?`,
    );
  }
  const exts = decodeManifest(manifestBytes);
  if (exts.length === 0) {
    throw new ZipExportSourceError(
      `Downloaded manifest for gallery ${galleryId} is empty or corrupt`,
    );
  }
  if (!exts.every((ext) => SAFE_ZIP_MANIFEST_EXTENSION.test(ext))) {
    throw new ZipExportSourceError(
      `Downloaded manifest for gallery ${galleryId} contains an unsafe file extension`,
    );
  }
  if (
    !Number.isSafeInteger(source.pageCount) ||
    source.pageCount <= 0 ||
    exts.length !== source.pageCount
  ) {
    throw new ZipExportSourceError(
      `Downloaded manifest page count ${exts.length} does not match database page count ${source.pageCount} for gallery ${galleryId}`,
    );
  }

  const safeName = sanitizeFilename(title);
  const fileName = `${galleryId} ${safeName}.zip`;

  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const destination = await save({
      defaultPath: fileName,
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (!destination) return 'cancelled';

    await streamStoredGalleryZipToTauri(store, galleryId, exts, options, destination, onProgress);
    return 'saved';
  }

  let completedReads = 0;
  const pages = await mapWithConcurrency(exts, ZIP_EXPORT_READ_CONCURRENCY, async (ext, i) => {
    const bytes = await store.getImage(galleryId, i, ext, options);
    if (!bytes || bytes.byteLength === 0) {
      throw new ZipExportSourceError(`Missing downloaded page ${i + 1} for gallery ${galleryId}`);
    }
    completedReads += 1;
    onProgress?.({ current: completedReads, total: exts.length });
    return { index: i, ext, bytes };
  });

  const entries: Record<string, Uint8Array> = {};
  for (const page of pages) {
    // Use the same zero-padded name that the store used, e.g. "0001.webp"
    const name = String(page.index + 1).padStart(4, '0') + '.' + page.ext;
    entries[name] = page.bytes;
  }

  const zipped = zipSync(entries, { level: 0 });
  await triggerBrowserZipDownload(zipped, fileName);
  return 'started';
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
  await triggerBrowserZipDownload(zipped, `${galleryId} ${safeName}.zip`);
}

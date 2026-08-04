/**
 * Persistent LRU image cache (big = full reader image / small = thumbnail).
 * Files live in the platform CACHE directory (see adapters), not the persistent
 * download/data area. See doc/common/ADR__image-cache.md.
 *
 * This module is the platform-agnostic LRU core. It is **file-backed and
 * streamed**: the WebView serves images straight from disk via a file URL
 * (`convertFileSrc`) and downloads stream URL→file natively, so full image bytes
 * never pass through the JS heap. Per-platform file + index persistence is
 * supplied by an ImageCacheBackend (cache-dir adapters).
 */
import { isTauri, isCapacitor } from '@/lib/utils/platform';

/** Default cache cap when the user has not configured one. */
export const DEFAULT_IMAGE_CACHE_MAX_BYTES = 250 * 1024 * 1024;

export interface ImageCacheIndexEntry {
  key: string;
  size: number;
  /** Monotonic recency counter (not wall-clock); higher = more recently used. */
  lastAccess: number;
}

/**
 * Storage backend: image files on disk plus a small recency index. Adapters
 * target each platform's cache directory and stream downloads natively (no bytes
 * in JS). `statSize` returning null is a normal cache miss (the OS may reclaim
 * the cache dir at any time). The web adapter is intentionally a no-op (no native
 * file URL, and a CDN fetch is CORS-blocked) — web display already works via the
 * plain <img src> + the browser HTTP cache.
 */
export interface ImageCacheBackend {
  /** Bytes on disk for `key`, or null if the file is absent. */
  statSize(key: string): Promise<number | null>;
  /** Stream `url` into `key`'s file natively. Returns bytes written. Throws on failure. */
  download(key: string, url: string, headers: Record<string, string>): Promise<number>;
  /** A WebView-loadable URL for `key`'s file (convertFileSrc). Caller ensures it exists. */
  fileUrl(key: string): Promise<string>;
  /** The raw native fs path/uri of `key`'s file (for a native file→file copy, e.g.
   *  the download flow reusing a cached image). Distinct from `fileUrl`. */
  filePath(key: string): Promise<string>;
  remove(key: string): Promise<void>;
  loadIndex(): Promise<ImageCacheIndexEntry[]>;
  saveIndex(entries: ImageCacheIndexEntry[]): Promise<void>;
  clearAll(): Promise<void>;
}

export class ImageCacheStore {
  private readonly backend: ImageCacheBackend;
  private readonly entries = new Map<string, { size: number; lastAccess: number }>();
  private readonly inFlightEnsures = new Map<string, Promise<string | null>>();
  /**
   * Every key in the current concurrent ensure wave stays protected until the
   * last wave member settles. This lets all callers receive a live file even
   * when their combined size temporarily exceeds a small cache cap.
   */
  private readonly protectedKeys = new Set<string>();
  /** FIFO lane for shared LRU/index state. Native downloads stay outside it. */
  private stateCommitTail: Promise<void> = Promise.resolve();
  /** Clear supersedes every ensure that began in an older cache generation. */
  private cacheGeneration = 0;
  /** Blocks new ensures until a clear has drained old native downloads. */
  private clearInFlight: Promise<void> | null = null;
  private totalBytes = 0;
  private maxBytes: number | null;
  /** Monotonic recency counter; survives restart via the persisted index. */
  private clock = 0;
  private initialized = false;

  constructor(backend: ImageCacheBackend, maxBytes: number | null = DEFAULT_IMAGE_CACHE_MAX_BYTES) {
    this.backend = backend;
    this.maxBytes = maxBytes;
  }

  /** Load the persisted index. Idempotent. */
  async init(): Promise<void> {
    await this.withStateCommit(async () => {
      if (this.initialized) return;
      const idx = await this.backend.loadIndex();
      this.entries.clear();
      this.totalBytes = 0;
      let maxSeen = 0;
      for (const e of idx) {
        this.entries.set(e.key, { size: e.size, lastAccess: e.lastAccess });
        this.totalBytes += e.size;
        if (e.lastAccess > maxSeen) maxSeen = e.lastAccess;
      }
      this.clock = maxSeen; // continue numbering after the most-recent persisted use
      this.initialized = true;
    });
  }

  /**
   * Serialize mutations and persistence of entries/totalBytes/clock. The tail
   * always recovers from a rejected operation so one I/O failure cannot poison
   * later cache work.
   */
  private withStateCommit<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.stateCommitTail.then(operation, operation);
    this.stateCommitTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private nextTick(): number {
    return ++this.clock;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  usage(): number {
    return this.totalBytes;
  }

  count(): number {
    return this.entries.size;
  }

  getMaxBytes(): number | null {
    return this.maxBytes;
  }

  /**
   * Touch `key`: if it is a live cache hit (file present), bump its recency and
   * return true; if the index lists it but the file is gone (cache dir reclaimed
   * by the OS), drop the stale entry and return false. Shared by fileUrl /
   * cachedFilePath.
   */
  private async touch(key: string): Promise<boolean> {
    return this.withStateCommit(async () => {
      const entry = this.entries.get(key);
      if (!entry) return false;
      const size = await this.backend.statSize(key);
      if (size == null) {
        this.totalBytes -= entry.size;
        this.entries.delete(key);
        await this.flushIndexLocked();
        return false;
      }
      entry.lastAccess = this.nextTick();
      await this.flushIndexLocked();
      return true;
    });
  }

  /** Serve the cached file URL (convertFileSrc) for `key`, bumping recency, or
   *  null on a miss / reclaimed file. */
  async fileUrl(key: string): Promise<string | null> {
    // A lookup that begins after clear() must observe the empty generation,
    // even while clear is still draining an older native ensure.
    while (this.clearInFlight) await this.clearInFlight;
    const generation = this.cacheGeneration;
    if (!(await this.touch(key)) || generation !== this.cacheGeneration) return null;
    const fileUrl = await this.backend.fileUrl(key);
    return generation === this.cacheGeneration ? fileUrl : null;
  }

  /** The raw native fs path/uri of `key`'s cached file (for a native file copy,
   *  e.g. the download flow), bumping recency, or null on a miss / reclaimed file. */
  async cachedFilePath(key: string): Promise<string | null> {
    while (this.clearInFlight) await this.clearInFlight;
    const generation = this.cacheGeneration;
    if (!(await this.touch(key)) || generation !== this.cacheGeneration) return null;
    const filePath = await this.backend.filePath(key);
    return generation === this.cacheGeneration ? filePath : null;
  }

  /**
   * Ensure `key` is cached and return its file URL, or null on failure. A hit
   * just bumps recency; a miss streams the download to disk natively, records its
   * size, and evicts LRU down to the cap — but NEVER the file just downloaded.
   *
   * The download always happens on a miss (it is not gated by the cap), because
   * on platforms whose WebView can only load a CDN image from a local file (the
   * bypass-served platforms), display itself depends on this file existing. The
   * cap therefore governs how much we RETAIN across other entries, not whether
   * the in-view image can be shown. Callers that only want opportunistic caching
   * (e.g. the Android background warm, where display does not need the file)
   * should skip this when `getMaxBytes() === 0`.
   */
  async ensureCached(
    key: string,
    url: string,
    headers: Record<string, string>,
  ): Promise<string | null> {
    // A clear owns an exclusive generation boundary: starts after this point
    // belong to the new empty cache and must not share a pre-clear operation.
    while (this.clearInFlight) await this.clearInFlight;

    const generation = this.cacheGeneration;
    const inFlight = this.inFlightEnsures.get(key);
    if (inFlight) {
      const result = await inFlight;
      return generation === this.cacheGeneration ? result : null;
    }

    this.protectedKeys.add(key);
    const operation = this.ensureCachedOnce(key, url, headers, generation);
    this.inFlightEnsures.set(key, operation);
    let result: string | null = null;
    try {
      result = await operation;
    } finally {
      await this.withStateCommit(async () => {
        if (this.inFlightEnsures.get(key) === operation) {
          this.inFlightEnsures.delete(key);
        }
        // Keep completed members protected while any concurrently-started
        // ensure is still committing. No eviction is triggered by release;
        // the next cache mutation enforces the cap, matching keepKey semantics.
        if (this.inFlightEnsures.size === 0) this.protectedKeys.clear();
      });
    }
    // The inner operation can finish its final fileUrl check and then wait here
    // for serialized bookkeeping. A clear may cross that wait and delete the
    // file, so validate the generation once more at the actual API boundary.
    return generation === this.cacheGeneration ? result : null;
  }

  private async ensureCachedOnce(
    key: string,
    url: string,
    headers: Record<string, string>,
    generation: number,
  ): Promise<string | null> {
    const hit = await this.fileUrl(key);
    if (hit) return generation === this.cacheGeneration ? hit : null;
    let size: number;
    try {
      size = await this.backend.download(key, url, headers);
    } catch (e) {
      console.warn('[image-cache] download failed', {
        key,
        url,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
    let committed = false;
    await this.withStateCommit(async () => {
      if (generation !== this.cacheGeneration) return;
      const existing = this.entries.get(key);
      if (existing) this.totalBytes -= existing.size;
      this.entries.set(key, { size, lastAccess: this.nextTick() });
      this.totalBytes += size;
      await this.flushIndexLocked();
      await this.evictIfNeededLocked(key);
      committed = true;
    });
    // clear() can advance the generation while index persistence or eviction
    // is awaiting native IO, even though the state commit itself is serialized.
    if (!committed || generation !== this.cacheGeneration) return null;
    const fileUrl = await this.backend.fileUrl(key);
    // fileUrl may itself cross the clear boundary. Never hand a caller a URL
    // from a generation that clear() has already superseded.
    return generation === this.cacheGeneration ? fileUrl : null;
  }

  /** Set the byte cap (`null` = unlimited) and evict down to it if needed. */
  async setMaxBytes(maxBytes: number | null): Promise<void> {
    await this.withStateCommit(async () => {
      this.maxBytes = maxBytes;
      await this.evictIfNeededLocked();
    });
  }

  /** Remove everything from the cache. */
  async clear(): Promise<void> {
    if (this.clearInFlight) return this.clearInFlight;

    // Increment synchronously so every already-started ensure becomes stale
    // before any native download can commit its index entry.
    this.cacheGeneration++;
    const pendingEnsures = [...this.inFlightEnsures.values()];
    const operation = (async () => {
      // Native downloads write canonical key paths. Drain the old generation
      // before clearAll so none can recreate a file after clear returns.
      await Promise.allSettled(pendingEnsures);
      await this.withStateCommit(async () => {
        await this.backend.clearAll();
        this.entries.clear();
        this.totalBytes = 0;
      });
    })();
    this.clearInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.clearInFlight === operation) this.clearInFlight = null;
    }
  }

  /** Evict LRU entries until under the cap. `keepKey`, if given, is never evicted
   *  (the file a caller is about to serve must survive even at cap 0). */
  private async evictIfNeededLocked(keepKey?: string): Promise<void> {
    if (this.maxBytes == null || this.totalBytes <= this.maxBytes) return;
    // Least-recently-accessed first.
    const order = [...this.entries.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    let changed = false;
    for (const [key, entry] of order) {
      if (this.totalBytes <= this.maxBytes) break;
      if (key === keepKey || this.protectedKeys.has(key)) continue;
      await this.backend.remove(key);
      this.entries.delete(key);
      this.totalBytes -= entry.size;
      changed = true;
    }
    if (changed) await this.flushIndexLocked();
  }

  // Adapters may debounce saveIndex internally; the core flushes on every
  // mutation so recency/accounting survive an abrupt restart.
  private async flushIndexLocked(): Promise<void> {
    const entries: ImageCacheIndexEntry[] = [];
    for (const [key, e] of this.entries) {
      entries.push({ key, size: e.size, lastAccess: e.lastAccess });
    }
    await this.backend.saveIndex(entries);
  }
}

/**
 * Pick the cache-dir backend for the current runtime and return an initialised
 * store. Mirrors createDownloadStore's isTauri()/isCapacitor() selection.
 */
export async function createImageCacheStore(
  maxBytes: number | null = DEFAULT_IMAGE_CACHE_MAX_BYTES,
): Promise<ImageCacheStore> {
  let backend: ImageCacheBackend;
  if (isTauri()) {
    const { createTauriImageCacheBackend } = await import('./adapters/tauri');
    backend = await createTauriImageCacheBackend();
  } else if (isCapacitor()) {
    const { createCapacitorImageCacheBackend } = await import('./adapters/capacitor');
    backend = await createCapacitorImageCacheBackend();
  } else {
    const { createWebImageCacheBackend } = await import('./adapters/web');
    backend = await createWebImageCacheBackend();
  }
  const store = new ImageCacheStore(backend, maxBytes);
  await store.init();
  return store;
}

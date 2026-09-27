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
const INDEX_SAVE_DELAY_MS = 250;

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
  private totalBytes = 0;
  private maxBytes: number | null;
  /** Monotonic recency counter; survives restart via the persisted index. */
  private clock = 0;
  private initialized = false;
  private initialization: Promise<void> | null = null;
  private generation = 0;
  private readonly pending = new Map<string, Promise<string | null>>();
  private mutations: Promise<void> = Promise.resolve();
  private clearing: Promise<void> | null = null;
  private indexDirty = false;
  private indexTimer: ReturnType<typeof setTimeout> | null = null;
  private indexWrite: Promise<void> | null = null;

  constructor(backend: ImageCacheBackend, maxBytes: number | null = DEFAULT_IMAGE_CACHE_MAX_BYTES) {
    this.backend = backend;
    this.maxBytes = maxBytes;
  }

  /** Load the persisted index. Idempotent. */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.initialization) {
      const generation = this.generation;
      this.initialization = this.backend.loadIndex().then((idx) => {
        if (generation !== this.generation) return;
        this.entries.clear();
        this.totalBytes = 0;
        let maxSeen = 0;
        for (const e of idx) {
          this.entries.set(e.key, { size: e.size, lastAccess: e.lastAccess });
          this.totalBytes += e.size;
          if (e.lastAccess > maxSeen) maxSeen = e.lastAccess;
        }
        this.clock = maxSeen; // continue after the most-recent persisted use
        this.initialized = true;
      });
    }
    const initialization = this.initialization;
    try {
      await initialization;
    } finally {
      if (this.initialization === initialization) this.initialization = null;
    }
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
  private async touch(key: string, generation: number): Promise<boolean> {
    const entry = this.entries.get(key);
    if (!entry) return false;
    const size = await this.backend.statSize(key);
    // A concurrent clear, eviction, or stale lookup may have removed this entry.
    if (generation !== this.generation || this.entries.get(key) !== entry) return false;
    if (size == null) {
      this.totalBytes -= entry.size;
      this.entries.delete(key);
      this.scheduleIndexSave();
      return false;
    }
    entry.lastAccess = this.nextTick();
    this.scheduleIndexSave();
    return true;
  }

  private async resolveFile(
    key: string,
    generation: number,
    nativePath = false,
  ): Promise<string | null> {
    if (!(await this.touch(key, generation))) return null;
    const url = await (nativePath ? this.backend.filePath(key) : this.backend.fileUrl(key));
    return generation === this.generation && this.entries.has(key) ? url : null;
  }

  /** Serve the cached file URL (convertFileSrc) for `key`, bumping recency, or
   *  null on a miss / reclaimed file. */
  async fileUrl(key: string): Promise<string | null> {
    while (this.clearing) await this.clearing;
    return this.resolveFile(key, this.generation);
  }

  /** The raw native fs path/uri of `key`'s cached file (for a native file copy,
   *  e.g. the download flow), bumping recency, or null on a miss / reclaimed file. */
  async cachedFilePath(key: string): Promise<string | null> {
    while (this.clearing) await this.clearing;
    return this.resolveFile(key, this.generation, true);
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
    while (this.clearing) await this.clearing;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const work = this.loadOrDownload(key, url, headers, this.generation);
    this.pending.set(key, work);
    try {
      return await work;
    } finally {
      if (this.pending.get(key) === work) this.pending.delete(key);
    }
  }

  private async loadOrDownload(
    key: string,
    url: string,
    headers: Record<string, string>,
    generation: number,
  ): Promise<string | null> {
    const hit = await this.resolveFile(key, generation);
    if (generation !== this.generation) return null;
    if (hit) return hit;
    // An eviction may still be removing this filename after a stale-file lookup.
    // Finish existing removals before writing its replacement.
    await this.mutations;
    if (generation !== this.generation) return null;
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
    if (generation !== this.generation) return null;
    await this.mutate(async () => {
      if (generation !== this.generation) return;
      const existing = this.entries.get(key);
      if (existing) this.totalBytes -= existing.size;
      this.entries.set(key, { size, lastAccess: this.nextTick() });
      this.totalBytes += size;
      this.scheduleIndexSave();
      await this.evictIfNeeded(generation, key);
    });
    if (generation !== this.generation || !this.entries.has(key)) return null;
    const fileUrl = await this.backend.fileUrl(key);
    return generation === this.generation && this.entries.has(key) ? fileUrl : null;
  }

  /** Set the byte cap (`null` = unlimited) and evict down to it if needed. */
  async setMaxBytes(maxBytes: number | null): Promise<void> {
    this.maxBytes = maxBytes;
    while (this.clearing) await this.clearing;
    const generation = this.generation;
    await this.mutate(() => this.evictIfNeeded(generation));
  }

  /** Remove everything from the cache. */
  async clear(): Promise<void> {
    // Invalidate work immediately; native downloads cannot be cancelled, so let
    // them finish before deleting their files. New requests wait for this barrier.
    this.generation++;
    if (this.indexTimer !== null) clearTimeout(this.indexTimer);
    this.indexTimer = null;
    this.indexDirty = false;
    this.entries.clear();
    this.totalBytes = 0;
    this.initialized = true;
    const clearing = Promise.allSettled([
      this.clearing,
      this.initialization,
      this.indexWrite,
      this.mutations,
      ...this.pending.values(),
    ]).then(() => this.backend.clearAll());
    this.clearing = clearing;
    try {
      await clearing;
    } finally {
      if (this.clearing === clearing) this.clearing = null;
    }
  }

  /** Serialize commits/eviction without holding up independent native downloads. */
  private mutate(operation: () => Promise<void>): Promise<void> {
    const work = this.mutations.then(operation);
    this.mutations = work.catch(() => {});
    return work;
  }

  /** Evict LRU entries until under the cap. `keepKey`, if given, is never evicted
   *  (the file a caller is about to serve must survive even at cap 0). */
  private async evictIfNeeded(generation: number, keepKey?: string): Promise<void> {
    if (generation !== this.generation) return;
    if (this.maxBytes == null || this.totalBytes <= this.maxBytes) return;
    // Least-recently-accessed first.
    const order = [...this.entries.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    let changed = false;
    for (const [key, entry] of order) {
      if (generation !== this.generation) return;
      if (this.maxBytes == null || this.totalBytes <= this.maxBytes) break;
      if (key === keepKey || this.entries.get(key) !== entry) continue;
      await this.backend.remove(key);
      if (generation !== this.generation) return;
      if (this.entries.get(key) !== entry) continue;
      this.entries.delete(key);
      this.totalBytes -= entry.size;
      changed = true;
    }
    if (changed) this.scheduleIndexSave();
  }

  /** Snapshot only once per burst; the image-serving path never serializes the index. */
  private scheduleIndexSave(): void {
    this.indexDirty = true;
    if (this.indexTimer !== null || this.indexWrite || this.clearing) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      this.persistIndex();
    }, INDEX_SAVE_DELAY_MS);
  }

  private persistIndex(): void {
    if (!this.indexDirty || this.clearing) return;
    this.indexDirty = false;
    const generation = this.generation;
    const entries = [...this.entries].map(([key, entry]) => ({ key, ...entry }));
    const write = Promise.resolve().then(() => this.backend.saveIndex(entries));
    this.indexWrite = write;
    void write.then(
      () => {
        this.indexWrite = null;
        if (generation === this.generation && this.indexDirty) this.scheduleIndexSave();
      },
      (error) => {
        this.indexWrite = null;
        if (generation === this.generation) this.indexDirty = true;
        // Keep serving valid files. A later touch/commit retries persistence.
        console.warn('[image-cache] index save failed', error);
      },
    );
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

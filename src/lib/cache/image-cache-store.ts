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

  constructor(backend: ImageCacheBackend, maxBytes: number | null = DEFAULT_IMAGE_CACHE_MAX_BYTES) {
    this.backend = backend;
    this.maxBytes = maxBytes;
  }

  /** Load the persisted index. Idempotent. */
  async init(): Promise<void> {
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
   * Serve the cached file URL for `key`, bumping recency, or null on a miss. If
   * the index lists the key but the file is gone (cache dir reclaimed by the OS),
   * the stale entry is dropped and null is returned.
   */
  async fileUrl(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    const size = await this.backend.statSize(key);
    if (size == null) {
      this.totalBytes -= entry.size;
      this.entries.delete(key);
      await this.flushIndex();
      return null;
    }
    entry.lastAccess = this.nextTick();
    await this.flushIndex();
    return this.backend.fileUrl(key);
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
  async ensureCached(key: string, url: string, headers: Record<string, string>): Promise<string | null> {
    const hit = await this.fileUrl(key);
    if (hit) return hit;
    let size: number;
    try {
      size = await this.backend.download(key, url, headers);
    } catch {
      return null;
    }
    const existing = this.entries.get(key);
    if (existing) this.totalBytes -= existing.size;
    this.entries.set(key, { size, lastAccess: this.nextTick() });
    this.totalBytes += size;
    await this.flushIndex();
    await this.evictIfNeeded(key);
    return this.backend.fileUrl(key);
  }

  /** Set the byte cap (`null` = unlimited) and evict down to it if needed. */
  async setMaxBytes(maxBytes: number | null): Promise<void> {
    this.maxBytes = maxBytes;
    await this.evictIfNeeded();
  }

  /** Remove everything from the cache. */
  async clear(): Promise<void> {
    await this.backend.clearAll();
    this.entries.clear();
    this.totalBytes = 0;
  }

  /** Evict LRU entries until under the cap. `keepKey`, if given, is never evicted
   *  (the file a caller is about to serve must survive even at cap 0). */
  private async evictIfNeeded(keepKey?: string): Promise<void> {
    if (this.maxBytes == null || this.totalBytes <= this.maxBytes) return;
    // Least-recently-accessed first.
    const order = [...this.entries.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    let changed = false;
    for (const [key, entry] of order) {
      if (this.totalBytes <= this.maxBytes) break;
      if (key === keepKey) continue;
      await this.backend.remove(key);
      this.entries.delete(key);
      this.totalBytes -= entry.size;
      changed = true;
    }
    if (changed) await this.flushIndex();
  }

  // Adapters may debounce saveIndex internally; the core flushes on every
  // mutation so recency/accounting survive an abrupt restart.
  private async flushIndex(): Promise<void> {
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

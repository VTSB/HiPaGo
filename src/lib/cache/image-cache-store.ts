/**
 * Persistent LRU image cache (big = full reader image). Blobs live in the
 * platform CACHE directory (see adapters), not the persistent download/data
 * area. See doc/common/ADR__image-cache.md.
 *
 * This module is the platform-agnostic LRU core. Per-platform byte + index
 * persistence is supplied by an ImageCacheBackend (cache-dir adapters).
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
 * Storage backend: raw blob bytes by key plus a small recency index. Adapters
 * target each platform's cache directory. `read` returning null is a normal
 * cache miss (the OS may reclaim the cache dir at any time).
 */
export interface ImageCacheBackend {
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, bytes: Uint8Array): Promise<void>;
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
   * Return the cached bytes for `key`, or null on a miss. A hit bumps the
   * entry's recency. If the index lists the key but the blob is gone (cache dir
   * reclaimed by the OS), the stale entry is dropped and null is returned.
   */
  async get(key: string): Promise<Uint8Array | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    const bytes = await this.backend.read(key);
    if (!bytes) {
      this.totalBytes -= entry.size;
      this.entries.delete(key);
      await this.flushIndex();
      return null;
    }
    entry.lastAccess = this.nextTick();
    await this.flushIndex();
    return bytes;
  }

  /**
   * Store `bytes` under `key`, then evict least-recently-used entries until the
   * cap is satisfied. A single blob larger than a finite cap is not stored
   * (storing it would evict everything and still overflow).
   */
  async put(key: string, bytes: Uint8Array): Promise<void> {
    const size = bytes.byteLength;
    if (this.maxBytes != null && size > this.maxBytes) return;
    const existing = this.entries.get(key);
    if (existing) this.totalBytes -= existing.size;
    await this.backend.write(key, bytes);
    this.entries.set(key, { size, lastAccess: this.nextTick() });
    this.totalBytes += size;
    await this.flushIndex();
    await this.evictIfNeeded();
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

  private async evictIfNeeded(): Promise<void> {
    if (this.maxBytes == null || this.totalBytes <= this.maxBytes) return;
    // Least-recently-accessed first.
    const order = [...this.entries.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    let changed = false;
    for (const [key, entry] of order) {
      if (this.totalBytes <= this.maxBytes) break;
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

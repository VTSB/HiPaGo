// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  ImageCacheStore,
  DEFAULT_IMAGE_CACHE_MAX_BYTES,
  type ImageCacheBackend,
  type ImageCacheIndexEntry,
} from '../image-cache-store';

// In-memory fake backend so the LRU core is tested deterministically without any
// platform filesystem. `getIndex` exposes what was persisted.
function fakeBackend(initial: ImageCacheIndexEntry[] = []) {
  const blobs = new Map<string, Uint8Array>();
  let index: ImageCacheIndexEntry[] = initial.map((e) => ({ ...e }));
  const backend: ImageCacheBackend = {
    async read(key) {
      return blobs.get(key) ?? null;
    },
    async write(key, bytes) {
      blobs.set(key, bytes);
    },
    async remove(key) {
      blobs.delete(key);
    },
    async loadIndex() {
      return index.map((e) => ({ ...e }));
    },
    async saveIndex(entries) {
      index = entries.map((e) => ({ ...e }));
    },
    async clearAll() {
      blobs.clear();
      index = [];
    },
  };
  return { backend, blobs, getIndex: () => index };
}

const bytes = (n: number) => new Uint8Array(n);

describe('ImageCacheStore LRU core', () => {
  it('default cap is 250MB', () => {
    expect(DEFAULT_IMAGE_CACHE_MAX_BYTES).toBe(250 * 1024 * 1024);
  });

  it('stores, accounts bytes, and serves blobs (miss returns null)', async () => {
    const { backend, blobs } = fakeBackend();
    const s = new ImageCacheStore(backend, null);
    await s.init();
    await s.put('a', bytes(100));
    expect(s.has('a')).toBe(true);
    expect(s.usage()).toBe(100);
    expect(blobs.get('a')!.byteLength).toBe(100);
    expect((await s.get('a'))!.byteLength).toBe(100);
    expect(await s.get('missing')).toBeNull();
  });

  it('evicts the least-recently-used entry until under the cap', async () => {
    const { backend } = fakeBackend();
    const s = new ImageCacheStore(backend, 250);
    await s.init();
    await s.put('a', bytes(100));
    await s.put('b', bytes(100));
    await s.get('a'); // a is now more recently used than b
    await s.put('c', bytes(100)); // total 300 > 250 -> evict LRU (b)
    expect(s.has('b')).toBe(false);
    expect(s.has('a')).toBe(true);
    expect(s.has('c')).toBe(true);
    expect(s.usage()).toBe(200);
  });

  it('unlimited mode (null cap) never evicts', async () => {
    const { backend } = fakeBackend();
    const s = new ImageCacheStore(backend, null);
    await s.init();
    for (let i = 0; i < 50; i++) await s.put('k' + i, bytes(1000));
    expect(s.count()).toBe(50);
    expect(s.usage()).toBe(50000);
  });

  it('does not store a single blob larger than a finite cap', async () => {
    const { backend } = fakeBackend();
    const s = new ImageCacheStore(backend, 100);
    await s.init();
    await s.put('big', bytes(200));
    expect(s.has('big')).toBe(false);
    expect(s.usage()).toBe(0);
  });

  it('setMaxBytes shrinks the cache (evicts LRU); null lifts the cap', async () => {
    const { backend } = fakeBackend();
    const s = new ImageCacheStore(backend, null);
    await s.init();
    await s.put('a', bytes(100));
    await s.put('b', bytes(100)); // b more recent than a
    await s.setMaxBytes(150); // only one 100-byte entry fits -> drop LRU (a)
    expect(s.usage()).toBeLessThanOrEqual(150);
    expect(s.has('b')).toBe(true);
    expect(s.has('a')).toBe(false);
    await s.setMaxBytes(null);
    await s.put('c', bytes(10_000)); // no eviction under unlimited
    expect(s.has('b')).toBe(true);
    expect(s.has('c')).toBe(true);
  });

  it('clear empties both the index and the backend blobs', async () => {
    const { backend, blobs } = fakeBackend();
    const s = new ImageCacheStore(backend, null);
    await s.init();
    await s.put('a', bytes(100));
    await s.clear();
    expect(s.count()).toBe(0);
    expect(s.usage()).toBe(0);
    expect(blobs.size).toBe(0);
  });

  it('reload from the persisted index preserves LRU order across restart', async () => {
    const { backend, getIndex } = fakeBackend();
    const s1 = new ImageCacheStore(backend, null);
    await s1.init();
    await s1.put('a', bytes(100));
    await s1.put('b', bytes(100));
    await s1.get('a'); // a is most recently used

    // Fresh store over the SAME backend simulates an app restart.
    const s2 = new ImageCacheStore(backend, 250);
    await s2.init();
    expect(s2.usage()).toBe(200);
    await s2.put('c', bytes(100)); // 300 > 250 -> evict LRU; b (oldest) goes, a stays
    expect(s2.has('b')).toBe(false);
    expect(s2.has('a')).toBe(true);
    expect(s2.has('c')).toBe(true);
    expect(getIndex().some((e) => e.key === 'b')).toBe(false);
  });
});

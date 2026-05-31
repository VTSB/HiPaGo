// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  ImageCacheStore,
  DEFAULT_IMAGE_CACHE_MAX_BYTES,
  type ImageCacheBackend,
  type ImageCacheIndexEntry,
} from '../image-cache-store';

// In-memory fake file-backed backend so the LRU core is tested deterministically
// without any platform filesystem. Download size is encoded in the URL as
// `?size=<n>`; `files` is the on-"disk" state, `getIndex` what was persisted.
function fakeBackend(initial: ImageCacheIndexEntry[] = []) {
  const files = new Map<string, number>();
  let index: ImageCacheIndexEntry[] = initial.map((e) => ({ ...e }));
  const sizeOf = (url: string): number => {
    const m = /size=(\d+)/.exec(url);
    return m ? Number(m[1]) : 0;
  };
  const backend: ImageCacheBackend = {
    async statSize(key) {
      return files.has(key) ? (files.get(key) as number) : null;
    },
    async download(key, url) {
      const size = sizeOf(url);
      files.set(key, size);
      return size;
    },
    async fileUrl(key) {
      return `file://cache/${key}`;
    },
    async remove(key) {
      files.delete(key);
    },
    async loadIndex() {
      return index.map((e) => ({ ...e }));
    },
    async saveIndex(entries) {
      index = entries.map((e) => ({ ...e }));
    },
    async clearAll() {
      files.clear();
      index = [];
    },
  };
  return { backend, files, getIndex: () => index };
}

const url = (size: number) => `https://cdn/img?size=${size}`;

describe('ImageCacheStore LRU core (file-backed)', () => {
  it('default cap is 250MB', () => {
    expect(DEFAULT_IMAGE_CACHE_MAX_BYTES).toBe(250 * 1024 * 1024);
  });

  it('downloads on a miss, accounts bytes, and serves a file URL (miss returns null)', async () => {
    const { backend, files } = fakeBackend();
    const s = new ImageCacheStore(backend, null);
    await s.init();
    expect(await s.fileUrl('a')).toBeNull(); // not cached yet
    const served = await s.ensureCached('a', url(100), {});
    expect(served).toBe('file://cache/a');
    expect(s.has('a')).toBe(true);
    expect(s.usage()).toBe(100);
    expect(files.get('a')).toBe(100);
    expect(await s.fileUrl('a')).toBe('file://cache/a'); // hit
  });

  it('evicts the least-recently-used entry until under the cap', async () => {
    const { backend } = fakeBackend();
    const s = new ImageCacheStore(backend, 250);
    await s.init();
    await s.ensureCached('a', url(100), {});
    await s.ensureCached('b', url(100), {});
    await s.fileUrl('a'); // a is now more recently used than b
    await s.ensureCached('c', url(100), {}); // total 300 > 250 -> evict LRU (b)
    expect(s.has('b')).toBe(false);
    expect(s.has('a')).toBe(true);
    expect(s.has('c')).toBe(true);
    expect(s.usage()).toBe(200);
  });

  it('unlimited mode (null cap) never evicts', async () => {
    const { backend } = fakeBackend();
    const s = new ImageCacheStore(backend, null);
    await s.init();
    for (let i = 0; i < 50; i++) await s.ensureCached('k' + i, url(1000), {});
    expect(s.count()).toBe(50);
    expect(s.usage()).toBe(50000);
  });

  it('always serves the just-downloaded file, keeping it even at cap 0 (display requirement)', async () => {
    const { backend } = fakeBackend();
    const s = new ImageCacheStore(backend, 0);
    await s.init();
    expect(await s.ensureCached('a', url(100), {})).toBe('file://cache/a');
    expect(s.has('a')).toBe(true); // the in-view file survives
    expect(s.usage()).toBe(100);
    // The next download evicts the previous one (cap 0 retains only the newest).
    expect(await s.ensureCached('b', url(100), {})).toBe('file://cache/b');
    expect(s.has('a')).toBe(false);
    expect(s.has('b')).toBe(true);
    expect(s.usage()).toBe(100);
  });

  it('setMaxBytes shrinks the cache (evicts LRU); null lifts the cap', async () => {
    const { backend } = fakeBackend();
    const s = new ImageCacheStore(backend, null);
    await s.init();
    await s.ensureCached('a', url(100), {});
    await s.ensureCached('b', url(100), {}); // b more recent than a
    await s.setMaxBytes(150); // only one 100-byte entry fits -> drop LRU (a)
    expect(s.usage()).toBeLessThanOrEqual(150);
    expect(s.has('b')).toBe(true);
    expect(s.has('a')).toBe(false);
    await s.setMaxBytes(null);
    await s.ensureCached('c', url(10_000), {}); // no eviction under unlimited
    expect(s.has('b')).toBe(true);
    expect(s.has('c')).toBe(true);
  });

  it('fileUrl drops a stale entry when the file was reclaimed by the OS', async () => {
    const { backend, files } = fakeBackend();
    const s = new ImageCacheStore(backend, null);
    await s.init();
    await s.ensureCached('a', url(100), {});
    files.delete('a'); // OS reclaimed the cache dir behind our back
    expect(await s.fileUrl('a')).toBeNull();
    expect(s.has('a')).toBe(false);
    expect(s.usage()).toBe(0);
  });

  it('clear empties both the index and the backend files', async () => {
    const { backend, files } = fakeBackend();
    const s = new ImageCacheStore(backend, null);
    await s.init();
    await s.ensureCached('a', url(100), {});
    await s.clear();
    expect(s.count()).toBe(0);
    expect(s.usage()).toBe(0);
    expect(files.size).toBe(0);
  });

  it('reload from the persisted index preserves LRU order across restart', async () => {
    const { backend, getIndex } = fakeBackend();
    const s1 = new ImageCacheStore(backend, null);
    await s1.init();
    await s1.ensureCached('a', url(100), {});
    await s1.ensureCached('b', url(100), {});
    await s1.fileUrl('a'); // a is most recently used

    // Fresh store over the SAME backend simulates an app restart.
    const s2 = new ImageCacheStore(backend, 250);
    await s2.init();
    expect(s2.usage()).toBe(200);
    await s2.ensureCached('c', url(100), {}); // 300 > 250 -> evict LRU; b (oldest) goes, a stays
    expect(s2.has('b')).toBe(false);
    expect(s2.has('a')).toBe(true);
    expect(s2.has('c')).toBe(true);
    expect(getIndex().some((e) => e.key === 'b')).toBe(false);
  });
});

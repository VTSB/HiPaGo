// @vitest-environment node
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
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
    async filePath(key) {
      return `/cache/${key}`;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ImageCacheStore LRU core (file-backed)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

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

  it('cachedFilePath returns the native fs path on a hit and null on a miss/reclaimed file', async () => {
    const { backend, files } = fakeBackend();
    const s = new ImageCacheStore(backend, null);
    await s.init();
    expect(await s.cachedFilePath('a')).toBeNull(); // miss
    await s.ensureCached('a', url(100), {});
    expect(await s.cachedFilePath('a')).toBe('/cache/a'); // hit → raw fs path
    files.delete('a'); // OS reclaimed
    expect(await s.cachedFilePath('a')).toBeNull();
    expect(s.has('a')).toBe(false);
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
    const { backend, files, getIndex } = fakeBackend();
    const s = new ImageCacheStore(backend, null);
    await s.init();
    await s.ensureCached('a', url(100), {});
    await s.clear();
    expect(s.count()).toBe(0);
    expect(s.usage()).toBe(0);
    expect(files.size).toBe(0);
    await vi.runAllTimersAsync();
    expect(getIndex()).toEqual([]);
  });

  it('reload from the persisted index preserves LRU order across restart', async () => {
    const { backend, getIndex } = fakeBackend();
    const s1 = new ImageCacheStore(backend, null);
    await s1.init();
    await s1.ensureCached('a', url(100), {});
    await s1.ensureCached('b', url(100), {});
    await s1.fileUrl('a'); // a is most recently used
    await vi.runAllTimersAsync(); // recency persistence is coalesced

    // Fresh store over the SAME backend simulates an app restart.
    const s2 = new ImageCacheStore(backend, 250);
    await s2.init();
    expect(s2.usage()).toBe(200);
    await s2.ensureCached('c', url(100), {}); // 300 > 250 -> evict LRU; b (oldest) goes, a stays
    expect(s2.has('b')).toBe(false);
    expect(s2.has('a')).toBe(true);
    expect(s2.has('c')).toBe(true);
    await vi.runAllTimersAsync();
    expect(getIndex().some((e) => e.key === 'b')).toBe(false);
  });

  it('serves warm URLs and native paths without waiting for index persistence', async () => {
    const { backend, files } = fakeBackend([{ key: 'a', size: 100, lastAccess: 1 }]);
    files.set('a', 100);
    const pendingSave = deferred<void>();
    const save = vi.spyOn(backend, 'saveIndex').mockReturnValue(pendingSave.promise);
    const s = new ImageCacheStore(backend, null);
    await s.init();

    expect(await s.fileUrl('a')).toBe('file://cache/a');
    expect(await s.cachedFilePath('a')).toBe('/cache/a');
    expect(save).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
    expect(save).toHaveBeenCalledTimes(1);
    expect(await s.fileUrl('a')).toBe('file://cache/a');
    pendingSave.resolve();
    await vi.runAllTimersAsync();
  });

  it('coalesces hit bursts and serializes saves while retaining latest recency', async () => {
    const { backend, files, getIndex } = fakeBackend([
      { key: 'a', size: 100, lastAccess: 1 },
      { key: 'b', size: 100, lastAccess: 2 },
    ]);
    files.set('a', 100);
    files.set('b', 100);
    const pendingSave = deferred<void>();
    const originalSave = backend.saveIndex;
    const save = vi.spyOn(backend, 'saveIndex').mockImplementationOnce(async (entries) => {
      await pendingSave.promise;
      await originalSave(entries);
    });
    const s = new ImageCacheStore(backend, null);
    await s.init();
    await Promise.all(Array.from({ length: 50 }, () => s.fileUrl('a')));
    expect(save).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
    expect(save).toHaveBeenCalledTimes(1);

    await Promise.all(Array.from({ length: 50 }, () => s.fileUrl('b')));
    await vi.runOnlyPendingTimersAsync();
    expect(save).toHaveBeenCalledTimes(1);
    pendingSave.resolve();
    await vi.runAllTimersAsync();
    expect(save).toHaveBeenCalledTimes(2);
    expect(getIndex().find((e) => e.key === 'b')!.lastAccess).toBeGreaterThan(
      getIndex().find((e) => e.key === 'a')!.lastAccess,
    );
  });

  it('shares one native download across concurrent requests for the same key', async () => {
    const { backend, files } = fakeBackend();
    const started = deferred<void>();
    const finish = deferred<number>();
    const download = vi.spyOn(backend, 'download').mockImplementation(async (key) => {
      started.resolve();
      const size = await finish.promise;
      files.set(key, size);
      return size;
    });
    const s = new ImageCacheStore(backend, null);
    await s.init();
    const requests = Array.from({ length: 20 }, () => s.ensureCached('a', url(100), {}));
    await started.promise;
    finish.resolve(100);
    expect(await Promise.all(requests)).toEqual(Array(20).fill('file://cache/a'));
    expect(download).toHaveBeenCalledTimes(1);
    expect(s.usage()).toBe(100);
  });

  it('clear waits for an old native download and discards it before new requests resume', async () => {
    const { backend, files, getIndex } = fakeBackend();
    const started = deferred<void>();
    const finish = deferred<number>();
    const download = vi.spyOn(backend, 'download').mockImplementationOnce(async (key) => {
      started.resolve();
      const size = await finish.promise;
      files.set(key, size);
      return size;
    });
    const s = new ImageCacheStore(backend, null);
    await s.init();
    const oldRequest = s.ensureCached('a', url(100), {});
    await started.promise;
    const clearing = s.clear();
    const freshRequest = s.ensureCached('a', url(200), {});
    expect(s.usage()).toBe(0);
    finish.resolve(100);
    expect(await oldRequest).toBeNull();
    await clearing;
    expect(await freshRequest).toBe('file://cache/a');
    await vi.runAllTimersAsync();
    expect(download).toHaveBeenCalledTimes(2);
    expect(files.get('a')).toBe(200);
    expect(s.usage()).toBe(200);
    expect(getIndex()).toEqual([{ key: 'a', size: 200, lastAccess: expect.any(Number) }]);
  });

  it('clear invalidates a request before its native download has started', async () => {
    const { backend, files } = fakeBackend();
    const download = vi.spyOn(backend, 'download');
    const s = new ImageCacheStore(backend, null);
    await s.init();
    const pending = s.ensureCached('a', url(100), {});
    await s.clear();
    expect(await pending).toBeNull();
    expect(download).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
    expect(s.count()).toBe(0);
  });

  it('clear drains an already running save and cancels delayed saves', async () => {
    const { backend, files, getIndex } = fakeBackend([{ key: 'a', size: 100, lastAccess: 1 }]);
    files.set('a', 100);
    const finish = deferred<void>();
    const originalSave = backend.saveIndex;
    const save = vi.spyOn(backend, 'saveIndex').mockImplementationOnce(async (entries) => {
      await finish.promise;
      await originalSave(entries);
    });
    const s = new ImageCacheStore(backend, null);
    await s.init();
    await s.fileUrl('a');
    await vi.runOnlyPendingTimersAsync();
    await s.fileUrl('a');
    const clearing = s.clear();
    finish.resolve();
    await clearing;
    await vi.runAllTimersAsync();
    expect(files.size).toBe(0);
    expect(getIndex()).toEqual([]);
    expect(s.usage()).toBe(0);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('keeps hits usable after a save failure and retries on later activity', async () => {
    const { backend, files, getIndex } = fakeBackend([{ key: 'a', size: 100, lastAccess: 1 }]);
    files.set('a', 100);
    const save = vi.spyOn(backend, 'saveIndex').mockRejectedValueOnce(new Error('disk busy'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new ImageCacheStore(backend, null);
    await s.init();
    expect(await s.fileUrl('a')).toBe('file://cache/a');
    await vi.runAllTimersAsync();
    expect(save).toHaveBeenCalledTimes(1);
    expect(await s.cachedFilePath('a')).toBe('/cache/a');
    await vi.runAllTimersAsync();
    expect(save).toHaveBeenCalledTimes(2);
    expect(getIndex()[0].lastAccess).toBeGreaterThan(1);
  });

  it('accounts a reclaimed file only once across concurrent stale hits', async () => {
    const { backend } = fakeBackend([{ key: 'a', size: 100, lastAccess: 1 }]);
    const s = new ImageCacheStore(backend, null);
    await s.init();
    expect(await Promise.all([s.fileUrl('a'), s.cachedFilePath('a')])).toEqual([null, null]);
    expect(s.usage()).toBe(0);
    expect(s.count()).toBe(0);
    expect(await s.ensureCached('a', url(200), {})).toBe('file://cache/a');
    expect(s.usage()).toBe(200);
  });

  it('serializes concurrent cap changes so each evicted file is accounted once', async () => {
    const { backend, files } = fakeBackend();
    const s = new ImageCacheStore(backend, null);
    await s.init();
    for (const key of ['a', 'b', 'c']) await s.ensureCached(key, url(100), {});
    const started = deferred<void>();
    const finish = deferred<void>();
    const remove = backend.remove;
    vi.spyOn(backend, 'remove').mockImplementationOnce(async (key) => {
      started.resolve();
      await finish.promise;
      await remove(key);
    });
    const first = s.setMaxBytes(200);
    await started.promise;
    const second = s.setMaxBytes(100);
    finish.resolve();
    await Promise.all([first, second]);
    expect(s.usage()).toBe(100);
    expect(s.count()).toBe(1);
    expect([...files.keys()]).toEqual(['c']);
  });

  it('clear during an eviction leaves empty files and nonnegative accounting', async () => {
    const { backend, files, getIndex } = fakeBackend();
    const s = new ImageCacheStore(backend, null);
    await s.init();
    await s.ensureCached('a', url(100), {});
    const started = deferred<void>();
    const finish = deferred<void>();
    const remove = backend.remove;
    vi.spyOn(backend, 'remove').mockImplementationOnce(async (key) => {
      started.resolve();
      await finish.promise;
      await remove(key);
    });
    const eviction = s.setMaxBytes(0);
    await started.promise;
    const clearing = s.clear();
    finish.resolve();
    await Promise.all([eviction, clearing]);
    await vi.runAllTimersAsync();
    expect(s.usage()).toBe(0);
    expect(s.count()).toBe(0);
    expect(files.size).toBe(0);
    expect(getIndex()).toEqual([]);
  });

  it('finishes an old eviction before replacing a reclaimed file with the same key', async () => {
    const { backend, files } = fakeBackend([{ key: 'a', size: 100, lastAccess: 1 }]);
    const s = new ImageCacheStore(backend, null);
    await s.init();
    const started = deferred<void>();
    const finish = deferred<void>();
    const remove = backend.remove;
    vi.spyOn(backend, 'remove').mockImplementationOnce(async (key) => {
      started.resolve();
      await finish.promise;
      await remove(key);
    });
    const eviction = s.setMaxBytes(0);
    await started.promise;
    const replacement = s.ensureCached('a', url(200), {});
    // Let the cache lookup complete while the old remove is still pending.
    await vi.advanceTimersByTimeAsync(0);
    finish.resolve();
    await eviction;
    expect(await replacement).toBe('file://cache/a');
    expect(files.get('a')).toBe(200);
    expect(s.usage()).toBe(200);
  });

  it('clear does not reload an index whose initialization was already in flight', async () => {
    const { backend, getIndex } = fakeBackend([{ key: 'a', size: 100, lastAccess: 1 }]);
    const loaded = deferred<ImageCacheIndexEntry[]>();
    const load = vi.spyOn(backend, 'loadIndex').mockReturnValueOnce(loaded.promise);
    const s = new ImageCacheStore(backend, null);
    const first = s.init();
    const second = s.init();
    const clearing = s.clear();
    loaded.resolve([{ key: 'a', size: 100, lastAccess: 1 }]);
    await Promise.all([first, second, clearing]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(s.usage()).toBe(0);
    expect(s.count()).toBe(0);
    expect(getIndex()).toEqual([]);
  });

  it('allows another download attempt after a shared native failure', async () => {
    const { backend } = fakeBackend();
    const download = vi.spyOn(backend, 'download').mockRejectedValueOnce(new Error('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new ImageCacheStore(backend, null);
    await s.init();
    expect(
      await Promise.all([s.ensureCached('a', url(100), {}), s.ensureCached('a', url(100), {})]),
    ).toEqual([null, null]);
    expect(download).toHaveBeenCalledTimes(1);
    expect(await s.ensureCached('a', url(100), {})).toBe('file://cache/a');
    expect(download).toHaveBeenCalledTimes(2);
    expect(s.usage()).toBe(100);
  });
});

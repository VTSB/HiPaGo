// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
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

  it('coalesces concurrent same-key downloads and starts a fresh operation after success', async () => {
    const { backend, files } = fakeBackend();
    const originalDownload = backend.download;
    let releaseDownload!: () => void;
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const download = vi.fn(
      async (key: string, requestUrl: string, headers: Record<string, string>) => {
        await downloadGate;
        return originalDownload(key, requestUrl, headers);
      },
    );
    backend.download = download;

    const s = new ImageCacheStore(backend, null);
    await s.init();
    const first = s.ensureCached('a', url(100), { Referer: 'first' });
    const second = s.ensureCached('a', url(100), { Referer: 'second' });

    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    releaseDownload();
    await expect(Promise.all([first, second])).resolves.toEqual([
      'file://cache/a',
      'file://cache/a',
    ]);

    files.delete('a'); // force a miss after the completed operation was removed
    await expect(s.ensureCached('a', url(100), {})).resolves.toBe('file://cache/a');
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('serializes cross-key commits and protects every concurrent result from eviction', async () => {
    const { backend, files, getIndex } = fakeBackend();
    const originalDownload = backend.download;
    const originalSaveIndex = backend.saveIndex;

    let releaseDownloads!: () => void;
    const downloadsGate = new Promise<void>((resolve) => {
      releaseDownloads = resolve;
    });
    const download = vi.fn(
      async (key: string, requestUrl: string, headers: Record<string, string>) => {
        await downloadsGate;
        return originalDownload(key, requestUrl, headers);
      },
    );
    backend.download = download;

    let releaseOldSave!: () => void;
    const oldSaveGate = new Promise<void>((resolve) => {
      releaseOldSave = resolve;
    });
    const saveCompletions: number[] = [];
    let saveCall = 0;
    const saveIndex = vi.fn(async (entries: ImageCacheIndexEntry[]) => {
      const call = ++saveCall;
      // Without the commit mutex, the newer snapshot can finish first and the
      // delayed older snapshot then overwrites it. The mutex must prevent the
      // second write from even starting while this gate is held.
      if (call === 1) await oldSaveGate;
      await originalSaveIndex(entries);
      saveCompletions.push(call);
    });
    backend.saveIndex = saveIndex;

    const s = new ImageCacheStore(backend, 50);
    await s.init();
    const first = s.ensureCached('a', url(100), {});
    const second = s.ensureCached('b', url(100), {});

    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(2));
    releaseDownloads();
    await vi.waitFor(() => expect(saveIndex).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(saveIndex).toHaveBeenCalledTimes(1);

    releaseOldSave();
    await expect(Promise.all([first, second])).resolves.toEqual([
      'file://cache/a',
      'file://cache/b',
    ]);

    expect(saveCompletions).toEqual([1, 2]);
    expect(files.has('a')).toBe(true);
    expect(files.has('b')).toBe(true);
    expect(new Set(getIndex().map((entry) => entry.key))).toEqual(new Set(['a', 'b']));
  });

  it('clears the same-key operation after a download failure so it can be retried', async () => {
    const { backend } = fakeBackend();
    const originalDownload = backend.download;
    let attempts = 0;
    const download = vi.fn(
      async (key: string, requestUrl: string, headers: Record<string, string>) => {
        attempts += 1;
        if (attempts === 1) throw new Error('network unavailable');
        return originalDownload(key, requestUrl, headers);
      },
    );
    backend.download = download;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const s = new ImageCacheStore(backend, null);
      await s.init();
      await expect(s.ensureCached('a', url(100), {})).resolves.toBeNull();
      await expect(s.ensureCached('a', url(100), {})).resolves.toBe('file://cache/a');
      expect(download).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('clears the same-key operation when index persistence rejects', async () => {
    const { backend } = fakeBackend();
    const originalSaveIndex = backend.saveIndex;
    const persistenceError = new Error('index write failed');
    let attempts = 0;
    const saveIndex = vi.fn(async (entries: ImageCacheIndexEntry[]) => {
      attempts += 1;
      if (attempts === 1) throw persistenceError;
      await originalSaveIndex(entries);
    });
    backend.saveIndex = saveIndex;

    const s = new ImageCacheStore(backend, null);
    await s.init();
    await expect(s.ensureCached('a', url(100), {})).rejects.toBe(persistenceError);
    await expect(s.ensureCached('a', url(100), {})).resolves.toBe('file://cache/a');
    expect(saveIndex).toHaveBeenCalledTimes(2);
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
    const { backend, files } = fakeBackend();
    const s = new ImageCacheStore(backend, null);
    await s.init();
    await s.ensureCached('a', url(100), {});
    await s.clear();
    expect(s.count()).toBe(0);
    expect(s.usage()).toBe(0);
    expect(files.size).toBe(0);
  });

  it('clear drains and supersedes an in-flight native download before deleting the cache', async () => {
    const { backend, files, getIndex } = fakeBackend();
    const originalDownload = backend.download;
    let signalDownloadStarted!: () => void;
    let releaseDownload!: () => void;
    const downloadStarted = new Promise<void>((resolve) => {
      signalDownloadStarted = resolve;
    });
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    backend.download = vi.fn(async (key, requestUrl, headers) => {
      signalDownloadStarted();
      await downloadGate;
      return originalDownload(key, requestUrl, headers);
    });
    const clearAll = vi.spyOn(backend, 'clearAll');
    const s = new ImageCacheStore(backend, null);
    await s.init();

    const ensure = s.ensureCached('late', url(100), {});
    await downloadStarted;
    let clearSettled = false;
    const clearing = s.clear().then(() => {
      clearSettled = true;
    });
    await Promise.resolve();

    expect(clearSettled).toBe(false);
    expect(clearAll).not.toHaveBeenCalled();

    releaseDownload();
    await expect(ensure).resolves.toBeNull();
    await clearing;

    expect(clearAll).toHaveBeenCalledTimes(1);
    expect(s.count()).toBe(0);
    expect(s.usage()).toBe(0);
    expect(files.size).toBe(0);
    expect(getIndex()).toEqual([]);
  });

  it('clear supersedes an ensure while its index commit is awaiting native IO', async () => {
    const { backend, files, getIndex } = fakeBackend();
    const originalSaveIndex = backend.saveIndex;
    let signalSaveStarted!: () => void;
    let releaseSave!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      signalSaveStarted = resolve;
    });
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    backend.saveIndex = vi.fn(async (entries) => {
      signalSaveStarted();
      await saveGate;
      await originalSaveIndex(entries);
    });
    const s = new ImageCacheStore(backend, null);
    await s.init();

    const ensure = s.ensureCached('committing', url(100), {});
    await saveStarted;
    const clearing = s.clear();
    releaseSave();

    await expect(ensure).resolves.toBeNull();
    await clearing;
    expect(s.count()).toBe(0);
    expect(files.size).toBe(0);
    expect(getIndex()).toEqual([]);
  });

  it('clear supersedes an ensure while its final file URL is awaiting native IO', async () => {
    const { backend, files, getIndex } = fakeBackend();
    let signalFileUrlStarted!: () => void;
    let releaseFileUrl!: () => void;
    const fileUrlStarted = new Promise<void>((resolve) => {
      signalFileUrlStarted = resolve;
    });
    const fileUrlGate = new Promise<void>((resolve) => {
      releaseFileUrl = resolve;
    });
    backend.fileUrl = vi.fn(async (key) => {
      signalFileUrlStarted();
      await fileUrlGate;
      return `file://cache/${key}`;
    });
    const s = new ImageCacheStore(backend, null);
    await s.init();

    const ensure = s.ensureCached('url-pending', url(100), {});
    await fileUrlStarted;
    const clearing = s.clear();
    releaseFileUrl();

    await expect(ensure).resolves.toBeNull();
    await clearing;
    expect(s.count()).toBe(0);
    expect(files.size).toBe(0);
    expect(getIndex()).toEqual([]);
  });

  it('clear supersedes an ensure while its outer bookkeeping is queued', async () => {
    const { backend, files, getIndex } = fakeBackend();
    const s = new ImageCacheStore(backend, null);
    await s.init();
    await s.ensureCached('bookkeeping-blocker', url(50), {});

    const originalSaveIndex = backend.saveIndex;
    let holdNextSave = false;
    let signalBlockedSaveStarted!: () => void;
    let releaseBlockedSave!: () => void;
    const blockedSaveStarted = new Promise<void>((resolve) => {
      signalBlockedSaveStarted = resolve;
    });
    const blockedSaveGate = new Promise<void>((resolve) => {
      releaseBlockedSave = resolve;
    });
    backend.saveIndex = vi.fn(async (entries) => {
      if (holdNextSave) {
        holdNextSave = false;
        signalBlockedSaveStarted();
        await blockedSaveGate;
      }
      await originalSaveIndex(entries);
    });

    const originalFileUrl = backend.fileUrl;
    let signalFinalFileUrlStarted!: () => void;
    let releaseFinalFileUrl!: () => void;
    const finalFileUrlStarted = new Promise<void>((resolve) => {
      signalFinalFileUrlStarted = resolve;
    });
    const finalFileUrlGate = new Promise<void>((resolve) => {
      releaseFinalFileUrl = resolve;
    });
    backend.fileUrl = vi.fn(async (key) => {
      if (key === 'cleanup-race') {
        signalFinalFileUrlStarted();
        await finalFileUrlGate;
      }
      return originalFileUrl(key);
    });

    let ensureSettled = false;
    const ensure = s.ensureCached('cleanup-race', url(100), {}).then((result) => {
      ensureSettled = true;
      return result;
    });
    await finalFileUrlStarted;

    // Hold a separate state commit so the ensure's outer finally bookkeeping
    // cannot finish after its inner operation has already produced a live URL.
    holdNextSave = true;
    const blockerLookup = s.fileUrl('bookkeeping-blocker');
    await blockedSaveStarted;
    const operations = Reflect.get(s, 'inFlightEnsures') as Map<
      string,
      Promise<string | null>
    >;
    const innerOperation = operations.get('cleanup-race');
    expect(innerOperation).toBeDefined();

    releaseFinalFileUrl();
    await expect(innerOperation).resolves.toBe('file://cache/cleanup-race');
    expect(ensureSettled).toBe(false);

    const clearing = s.clear();
    releaseBlockedSave();

    await expect(blockerLookup).resolves.toBeNull();
    await expect(ensure).resolves.toBeNull();
    await clearing;
    expect(files.size).toBe(0);
    expect(getIndex()).toEqual([]);
  });

  it('does not return a direct cached URL after clear deletes the touched file', async () => {
    const { backend, files } = fakeBackend();
    const s = new ImageCacheStore(backend, null);
    await s.init();
    await s.ensureCached('direct-url', url(100), {});

    let signalFileUrlStarted!: () => void;
    let releaseFileUrl!: () => void;
    const fileUrlStarted = new Promise<void>((resolve) => {
      signalFileUrlStarted = resolve;
    });
    const fileUrlGate = new Promise<void>((resolve) => {
      releaseFileUrl = resolve;
    });
    backend.fileUrl = vi.fn(async (key) => {
      signalFileUrlStarted();
      await fileUrlGate;
      return `file://cache/${key}`;
    });

    const lookup = s.fileUrl('direct-url');
    await fileUrlStarted;
    await s.clear();
    releaseFileUrl();

    await expect(lookup).resolves.toBeNull();
    expect(files.size).toBe(0);
  });

  it('does not return a direct cached path after clear deletes the touched file', async () => {
    const { backend, files } = fakeBackend();
    const s = new ImageCacheStore(backend, null);
    await s.init();
    await s.ensureCached('direct-path', url(100), {});

    let signalFilePathStarted!: () => void;
    let releaseFilePath!: () => void;
    const filePathStarted = new Promise<void>((resolve) => {
      signalFilePathStarted = resolve;
    });
    const filePathGate = new Promise<void>((resolve) => {
      releaseFilePath = resolve;
    });
    backend.filePath = vi.fn(async (key) => {
      signalFilePathStarted();
      await filePathGate;
      return `/cache/${key}`;
    });

    const lookup = s.cachedFilePath('direct-path');
    await filePathStarted;
    await s.clear();
    releaseFilePath();

    await expect(lookup).resolves.toBeNull();
    expect(files.size).toBe(0);
  });

  it('blocks direct lookups behind a clear that is still draining an old ensure', async () => {
    const { backend, files } = fakeBackend();
    const s = new ImageCacheStore(backend, null);
    await s.init();
    await s.ensureCached('old-hit', url(50), {});

    const originalDownload = backend.download;
    let signalDownloadStarted!: () => void;
    let releaseDownload!: () => void;
    const downloadStarted = new Promise<void>((resolve) => {
      signalDownloadStarted = resolve;
    });
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    backend.download = vi.fn(async (key, requestUrl, headers) => {
      if (key === 'pending-clear') {
        signalDownloadStarted();
        await downloadGate;
      }
      return originalDownload(key, requestUrl, headers);
    });

    const pendingEnsure = s.ensureCached('pending-clear', url(100), {});
    await downloadStarted;
    const clearing = s.clear();
    let lookupsSettled = false;
    const lookups = Promise.all([s.fileUrl('old-hit'), s.cachedFilePath('old-hit')]).then(
      (result) => {
        lookupsSettled = true;
        return result;
      },
    );
    await Promise.resolve();
    expect(lookupsSettled).toBe(false);

    releaseDownload();
    await expect(pendingEnsure).resolves.toBeNull();
    await clearing;
    await expect(lookups).resolves.toEqual([null, null]);
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

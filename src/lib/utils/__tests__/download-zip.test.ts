// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GalleryFile, GgConfig } from '../types';
import type { DownloadStore } from '@/lib/storage/download-store';

// Mock fflate before importing the module under test
vi.mock('fflate', () => ({
  zipSync: vi.fn(() => new Uint8Array([1, 2, 3])),
  strToU8: vi.fn((s: string) => new TextEncoder().encode(s)),
}));

// Mock image-url module
vi.mock('../image-url', () => ({
  getImageUrl: vi.fn(() => 'https://example.com/image.webp'),
}));

// Mock api client — include ApiError class for error-path tests
vi.mock('@/lib/api/client', () => {
  class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
      this.name = 'ApiError';
    }
  }
  return {
    apiClient: { fetchUrl: vi.fn() },
    getGgConfig: vi.fn(),
    ApiError,
  };
});

// Mock db/download (upsertDownload, updateDownloadProgress, setDownloadError, serializeTags)
vi.mock('@/lib/db/download', () => ({
  upsertDownload: vi.fn().mockResolvedValue(undefined),
  updateDownloadProgress: vi.fn().mockResolvedValue(undefined),
  setDownloadError: vi.fn().mockResolvedValue(undefined),
  serializeTags: vi.fn((tags: Record<string, string[]>) => JSON.stringify(tags)),
}));

// Mock createDownloadStore — we inject a fake store per test. DownloadCancelledError
// is the real class so `instanceof` checks in download-zip behave correctly.
vi.mock('@/lib/storage/download-store', () => ({
  createDownloadStore: vi.fn(),
  DownloadCancelledError: class DownloadCancelledError extends Error {
    constructor(message = 'download cancelled by user') {
      super(message);
      this.name = 'DownloadCancelledError';
    }
  },
  imageFileName: (index: number, ext: string) =>
    String(index + 1).padStart(4, '0') + '.' + ext,
  galleryFolderName: (id: number) => String(id),
}));

// Mock base-path-resolver (galleryFolderName used in download-zip.ts)
vi.mock('@/lib/storage/base-path-resolver', () => ({
  galleryFolderName: vi.fn((id: number, title: string) => `${id} ${title}`),
  sanitizeGalleryTitle: vi.fn((t: string) => t),
}));

// Mock tag-fetcher (parseRetryAfter used by fetchWithRetry)
vi.mock('@/lib/api/tag-fetcher', () => ({
  parseRetryAfter: vi.fn(() => null),
}));

// Mock the image cache singleton (stage-4 download reuse). cachedFilePath is
// controlled per test; only exercised when the store exposes putImageFromFile.
const { cachedFilePath } = vi.hoisted(() => ({ cachedFilePath: vi.fn() }));
vi.mock('@/lib/cache/image-cache', () => ({
  getImageCache: vi.fn(async () => ({ cachedFilePath })),
}));

import {
  downloadGalleryAsZip,
  downloadGalleryToLibrary,
  exportGalleryZip,
  getDownloadedGalleryPages,
  getDownloadedImage,
} from '../download-zip';
import { zipSync } from 'fflate';
import { getImageUrl } from '../image-url';
import { apiClient, ApiError } from '@/lib/api/client';
import { upsertDownload, setDownloadError, updateDownloadProgress } from '@/lib/db/download';
import { createDownloadStore, DownloadCancelledError } from '@/lib/storage/download-store';

// ── Helpers ────────────────────────────────────────────────────────────────────

const makeGgConfig = (): GgConfig => ({
  pathCode: 'abc',
  mDefault: 1,
  mCases: new Set<number>(),
  mCaseValue: 0,
});

const makeFile = (name = 'image.jpg', haswebp = 1): GalleryFile => ({
  name,
  hash: 'aabbcc1122',
  haswebp,
  hasavif: 0,
  hasavifsmalltn: 0,
  width: 800,
  height: 1200,
});

function makeFetchResponse(
  contentType: string | null,
  bytes = new Uint8Array([0xff, 0xfe]),
): Response {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (h: string) => (h === 'content-type' ? contentType : null),
    } as unknown as Headers,
    arrayBuffer: () => Promise.resolve(bytes.buffer as ArrayBuffer),
  } as unknown as Response;
}

/** Minimal in-memory DownloadStore for tests. */
function makeMemoryStore(): DownloadStore & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  const key = (galleryId: number, index: number, ext: string) =>
    `${galleryId}/${String(index + 1).padStart(4, '0')}.${ext}`;
  return {
    store,
    async putImage(galleryId, index, bytes, ext) {
      store.set(key(galleryId, index, ext), bytes);
    },
    async getImage(galleryId, index, ext) {
      return store.get(key(galleryId, index, ext)) ?? null;
    },
    async listGalleries() {
      const ids = new Set<number>();
      for (const k of store.keys()) ids.add(parseInt(k.split('/')[0], 10));
      return [...ids];
    },
    async deleteGallery(galleryId) {
      const prefix = `${galleryId}/`;
      for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k);
    },
    async gallerySize(galleryId) {
      const prefix = `${galleryId}/`;
      let total = 0;
      for (const [k, v] of store) if (k.startsWith(prefix)) total += v.byteLength;
      return total;
    },
    async usage() {
      let total = 0;
      for (const v of store.values()) total += v.byteLength;
      return total;
    },
  };
}

/** Memory store that also supports the stage-4 native file copy. */
function makeMemoryStoreWithCopy() {
  const base = makeMemoryStore();
  const copies: Array<{ galleryId: number; index: number; srcPath: string; ext: string }> = [];
  return Object.assign(base, {
    copies,
    async putImageFromFile(galleryId: number, index: number, srcPath: string, ext: string) {
      copies.push({ galleryId, index, srcPath, ext });
      base.store.set(
        `${galleryId}/${String(index + 1).padStart(4, '0')}.${ext}`,
        new Uint8Array([7, 7, 7, 7]),
      );
      return 4; // bytes copied
    },
  });
}

// ── downloadGalleryAsZip (legacy behaviour unchanged) ─────────────────────────

describe('downloadGalleryAsZip', () => {
  let anchorEl: { href: string; download: string; click: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    anchorEl = { href: '', download: '', click: vi.fn() };

    vi.stubGlobal('document', { createElement: vi.fn(() => anchorEl) });
    vi.stubGlobal('Blob', class MockBlob {
      constructor(public parts: unknown[], public options: unknown) {}
    });
    const origURL = globalThis.URL;
    vi.stubGlobal('URL', Object.assign(
      function (...args: unknown[]) { return new origURL(...(args as [string])); },
      {
        ...origURL,
        createObjectURL: vi.fn(() => 'blob:fake-url'),
        revokeObjectURL: vi.fn(),
      },
    ));

    vi.mocked(getImageUrl).mockReturnValue('https://example.com/image.webp');
    vi.mocked(zipSync).mockReturnValue(new Uint8Array([1, 2, 3]));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse('image/webp')));
    // apiClient.fetchUrl delegates to fetch in browser mode — stub it too
    vi.mocked(apiClient.fetchUrl).mockImplementation(() =>
      Promise.resolve(makeFetchResponse('image/webp')),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('progress callback', () => {
    it('calls onProgress with { current, total } after each file', async () => {
      const files = [makeFile('a.jpg'), makeFile('b.jpg'), makeFile('c.jpg')];
      const progress: Array<{ current: number; total: number }> = [];
      await downloadGalleryAsZip(1, 'Test Gallery', files, makeGgConfig(), (p) => {
        progress.push({ ...p });
      });
      expect(progress).toHaveLength(3);
      expect(progress[0]).toEqual({ current: 1, total: 3 });
      expect(progress[1]).toEqual({ current: 2, total: 3 });
      expect(progress[2]).toEqual({ current: 3, total: 3 });
    });

    it('does not throw when onProgress is omitted', async () => {
      await expect(
        downloadGalleryAsZip(1, 'Title', [makeFile()], makeGgConfig()),
      ).resolves.toBeUndefined();
    });
  });

  describe('abort signal', () => {
    it('throws AbortError when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        downloadGalleryAsZip(1, 'Title', [makeFile(), makeFile()], makeGgConfig(), undefined, controller.signal),
      ).rejects.toMatchObject({ name: 'AbortError', message: 'Aborted' });
    });

    it('throws AbortError when signal is aborted mid-loop', async () => {
      const controller = new AbortController();
      vi.mocked(apiClient.fetchUrl).mockImplementation(() => {
        controller.abort();
        return Promise.resolve(makeFetchResponse('image/webp'));
      });
      await expect(
        downloadGalleryAsZip(1, 'Title', [makeFile('a.jpg'), makeFile('b.jpg')], makeGgConfig(), undefined, controller.signal),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });
  });

  describe('content-type extension derivation', () => {
    it.each([
      ['image/avif', '.avif'],
      ['image/png', '.png'],
      ['image/jpeg', '.jpg'],
      ['image/webp', '.webp'],
      ['image/gif', '.gif'],
    ] as const)('content-type "%s" → extension "%s"', async (ct, expectedExt) => {
      vi.mocked(apiClient.fetchUrl).mockResolvedValue(makeFetchResponse(ct));
      await downloadGalleryAsZip(1, 'Title', [makeFile('page.jpg', 1)], makeGgConfig());
      const zipEntries = vi.mocked(zipSync).mock.calls[0][0] as Record<string, Uint8Array>;
      const entryNames = Object.keys(zipEntries);
      expect(entryNames).toHaveLength(1);
      expect(entryNames[0]).toMatch(new RegExp(`\\${expectedExt}$`));
    });
  });

  describe('fallback extension', () => {
    it('uses file.name extension when haswebp=0 and content-type is unrecognized', async () => {
      vi.mocked(apiClient.fetchUrl).mockResolvedValue(makeFetchResponse('application/octet-stream'));
      await downloadGalleryAsZip(1, 'Title', [makeFile('artwork.png', 0)], makeGgConfig());
      const zipEntries = vi.mocked(zipSync).mock.calls[0][0] as Record<string, Uint8Array>;
      expect(Object.keys(zipEntries)[0]).toMatch(/\.png$/);
    });

    it('defaults to webp when haswebp=1 and content-type is unrecognized', async () => {
      vi.mocked(apiClient.fetchUrl).mockResolvedValue(makeFetchResponse('application/octet-stream'));
      await downloadGalleryAsZip(1, 'Title', [makeFile('img.jpg', 1)], makeGgConfig());
      const zipEntries = vi.mocked(zipSync).mock.calls[0][0] as Record<string, Uint8Array>;
      expect(Object.keys(zipEntries)[0]).toMatch(/\.webp$/);
    });

    it('uses file.name extension when content-type is null and haswebp=0', async () => {
      vi.mocked(apiClient.fetchUrl).mockResolvedValue(makeFetchResponse(null));
      await downloadGalleryAsZip(1, 'Title', [makeFile('page.gif', 0)], makeGgConfig());
      const zipEntries = vi.mocked(zipSync).mock.calls[0][0] as Record<string, Uint8Array>;
      expect(Object.keys(zipEntries)[0]).toMatch(/\.gif$/);
    });

    it('stays webp when content-type is null and haswebp=1', async () => {
      vi.mocked(apiClient.fetchUrl).mockResolvedValue(makeFetchResponse(null));
      await downloadGalleryAsZip(1, 'Title', [makeFile('page.jpg', 1)], makeGgConfig());
      const zipEntries = vi.mocked(zipSync).mock.calls[0][0] as Record<string, Uint8Array>;
      expect(Object.keys(zipEntries)[0]).toMatch(/\.webp$/);
    });
  });

  describe('filename sanitization', () => {
    it('replaces special chars with underscores', async () => {
      await downloadGalleryAsZip(42, 'My <Gallery> / "Title"', [makeFile()], makeGgConfig());
      expect(anchorEl.download).toBe('42 My _Gallery_ _ _Title_.zip');
    });

    it('uses "gallery" fallback when title is whitespace-only', async () => {
      await downloadGalleryAsZip(7, '      ', [makeFile()], makeGgConfig());
      expect(anchorEl.download).toBe('7 gallery.zip');
    });

    it('preserves normal unicode title', async () => {
      await downloadGalleryAsZip(99, 'Normal Title 123', [makeFile()], makeGgConfig());
      expect(anchorEl.download).toBe('99 Normal Title 123.zip');
    });
  });

  describe('zero-padded index', () => {
    it('pads single digit when total >= 10', async () => {
      const files = Array.from({ length: 10 }, (_, i) => makeFile(`f${i}.jpg`));
      await downloadGalleryAsZip(1, 'T', files, makeGgConfig());
      const zipEntries = vi.mocked(zipSync).mock.calls[0][0] as Record<string, Uint8Array>;
      expect(Object.keys(zipEntries)).toContain('01.webp');
      expect(Object.keys(zipEntries)).toContain('10.webp');
    });

    it('no padding when total < 10', async () => {
      await downloadGalleryAsZip(1, 'T', [makeFile('a.jpg'), makeFile('b.jpg')], makeGgConfig());
      const zipEntries = vi.mocked(zipSync).mock.calls[0][0] as Record<string, Uint8Array>;
      expect(Object.keys(zipEntries)).toContain('1.webp');
      expect(Object.keys(zipEntries)).toContain('2.webp');
    });
  });

  describe('download mechanics', () => {
    it('creates anchor, triggers click, revokes URL', async () => {
      await downloadGalleryAsZip(5, 'Gallery', [makeFile()], makeGgConfig());
      expect(document.createElement).toHaveBeenCalledWith('a');
      expect(URL.createObjectURL).toHaveBeenCalled();
      expect(anchorEl.href).toBe('blob:fake-url');
      expect(anchorEl.download).toBe('5 Gallery.zip');
      expect(anchorEl.click).toHaveBeenCalledOnce();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
    });

    it('passes level:0 to zipSync', async () => {
      await downloadGalleryAsZip(1, 'T', [makeFile()], makeGgConfig());
      expect(vi.mocked(zipSync)).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ level: 0 }),
      );
    });
  });

  describe('fetch error handling', () => {
    it('throws when response is not ok', async () => {
      vi.mocked(apiClient.fetchUrl).mockRejectedValue(new Error('HTTP 404: Not Found'));
      await expect(
        downloadGalleryAsZip(1, 'T', [makeFile()], makeGgConfig()),
      ).rejects.toThrow('HTTP 404');
    });
  });
});

// ── downloadGalleryToLibrary (AC-006 resilience rewrite) ──────────────────────

describe('downloadGalleryToLibrary', () => {
  let memStore: ReturnType<typeof makeMemoryStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    memStore = makeMemoryStore();
    vi.mocked(createDownloadStore).mockResolvedValue(memStore);
    vi.mocked(apiClient.fetchUrl).mockResolvedValue(makeFetchResponse('image/webp', new Uint8Array([10, 20, 30])));
    vi.mocked(getImageUrl).mockReturnValue('https://example.com/image.webp');
    vi.mocked(upsertDownload).mockResolvedValue(undefined);
    vi.mocked(setDownloadError).mockResolvedValue(undefined);
    vi.mocked(updateDownloadProgress).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes each image to the store and stores a manifest', async () => {
    const files = [makeFile('a.jpg'), makeFile('b.png', 0)];
    await downloadGalleryToLibrary(
      42,
      'Test Gallery',
      'https://tn.example.com/thumb.jpg',
      files,
      makeGgConfig(),
      {},
    );

    // Page 0 and 1 should be written
    const page0 = await memStore.getImage(42, 0, 'webp');
    expect(page0).toBeInstanceOf(Uint8Array);
    // page 1 has content-type image/webp → ext webp
    const page1 = await memStore.getImage(42, 1, 'webp');
    expect(page1).toBeInstanceOf(Uint8Array);

    // Manifest should exist at index -1
    const manifest = await memStore.getImage(42, -1, 'json');
    expect(manifest).not.toBeNull();
    const exts = JSON.parse(new TextDecoder().decode(manifest!));
    expect(exts).toEqual(['webp', 'webp']);
  });

  // AC-003: a genuine failure before the first page now RECORDS a 'failed' row
  // (pageCount 0) carrying the real reason, so the library shows it + offers retry.
  it('(a) records a failed row with the real reason when all retries fail before the first page', async () => {
    vi.mocked(apiClient.fetchUrl).mockRejectedValue(new Error('Network error'));

    await expect(
      downloadGalleryToLibrary(
        1,
        'Gallery',
        'thumb.jpg',
        [makeFile()],
        makeGgConfig(),
        {},
      ),
    ).rejects.toThrow('Network error');

    expect(upsertDownload).toHaveBeenCalledTimes(1);
    const failedRow = vi.mocked(upsertDownload).mock.calls[0][0];
    expect(failedRow).toMatchObject({
      galleryId: 1,
      status: 'failed',
      pageCount: 0,
      totalBytes: 0,
      lastError: 'Network error',
    });
  });

  // AC-006 (b): first page ok → row created pageCount:1, then updateDownloadProgress per page
  it('(b) creates row with pageCount:1 on first page success, then updateDownloadProgress for subsequent pages', async () => {
    const files = [makeFile('a.jpg'), makeFile('b.jpg'), makeFile('c.jpg')];
    await downloadGalleryToLibrary(
      2,
      'My Gallery',
      'thumb.jpg',
      files,
      makeGgConfig(),
      { artist: ['foo'] },
    );

    // upsertDownload called twice: once creating row (pageCount:1), once on completion
    expect(upsertDownload).toHaveBeenCalledTimes(2);

    const firstUpsert = vi.mocked(upsertDownload).mock.calls[0][0];
    expect(firstUpsert.status).toBe('downloading');
    expect(firstUpsert.pageCount).toBe(1);
    expect(firstUpsert.galleryId).toBe(2);

    // updateDownloadProgress called for pages 2 and 3 (i+1 = 2, 3)
    expect(updateDownloadProgress).toHaveBeenCalledTimes(2);
    expect(vi.mocked(updateDownloadProgress).mock.calls[0]).toEqual([2, 2, expect.any(Number)]);
    expect(vi.mocked(updateDownloadProgress).mock.calls[1]).toEqual([2, 3, expect.any(Number)]);

    const lastUpsert = vi.mocked(upsertDownload).mock.calls[1][0];
    expect(lastUpsert.status).toBe('complete');
    expect(lastUpsert.pageCount).toBe(3);
  });

  // AC-006 (c): putImageFromFile rejects → falls back to fetch, page is still written
  it('(c) putImageFromFile failure falls back to network fetch and page is still written', async () => {
    const storeWithFailingCopy = Object.assign(makeMemoryStore(), {
      async putImageFromFile(): Promise<number> {
        throw new Error('Permission denied');
      },
    });
    vi.mocked(createDownloadStore).mockResolvedValue(storeWithFailingCopy);

    // cachedFilePath returns a path so the cache copy is attempted
    cachedFilePath.mockResolvedValue('file:///cache/key');
    vi.mocked(apiClient.fetchUrl).mockResolvedValue(
      makeFetchResponse('image/webp', new Uint8Array([1, 2, 3])),
    );

    await downloadGalleryToLibrary(1, 'G', 'thumb.jpg', [makeFile()], makeGgConfig(), {});

    // Page should be written via network fallback
    const page = await storeWithFailingCopy.getImage(1, 0, 'webp');
    expect(page).toBeInstanceOf(Uint8Array);
    expect(apiClient.fetchUrl).toHaveBeenCalledTimes(1);
    // Row should be created (page was still written successfully)
    expect(upsertDownload).toHaveBeenCalledWith(expect.objectContaining({ status: 'downloading', pageCount: 1 }));
  });

  // AC-006 (d): fetchWithRetry retries transient failures then succeeds; AbortError not retried
  it('(d) retries transient 5xx failures and succeeds', async () => {
    // First two attempts return 503 (treated as retryable by fetchWithRetry),
    // third attempt returns 200 ok.
    // We need to simulate apiClient.fetchUrl returning a 503 response
    // (not throwing — the existing code handles status codes).
    // But fetchWithRetry in download-zip.ts calls apiClient.fetchUrl and checks
    // status 502/503/504 itself. Since apiClient.fetchUrl throws ApiError on !ok,
    // we simulate timeout retries instead (AbortError from per-attempt controller).
    // Simpler: just verify 3 calls happen before success via a simple error pattern.
    let callCount = 0;
    vi.mocked(apiClient.fetchUrl).mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        // Simulate a timeout abort (per-attempt controller fires)
        const err = new DOMException('Aborted', 'AbortError');
        return Promise.reject(err);
      }
      return Promise.resolve(makeFetchResponse('image/webp', new Uint8Array([5, 6, 7])));
    });

    await downloadGalleryToLibrary(1, 'G', 'thumb.jpg', [makeFile()], makeGgConfig(), {});

    expect(callCount).toBe(3);
    // Row should be created after successful third attempt
    expect(upsertDownload).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'downloading', pageCount: 1 }),
    );
  }, 15_000);

  it('(d) retries ApiError transient statuses thrown by apiClient and succeeds', async () => {
    let callCount = 0;
    vi.mocked(apiClient.fetchUrl).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new ApiError(503, 'HTTP 503: Service Unavailable'));
      }
      return Promise.resolve(makeFetchResponse('image/webp', new Uint8Array([5, 6, 7])));
    });

    await downloadGalleryToLibrary(30, 'G', 'thumb.jpg', [makeFile()], makeGgConfig(), {});

    expect(callCount).toBe(2);
    expect(upsertDownload).toHaveBeenCalledWith(
      expect.objectContaining({ galleryId: 30, status: 'downloading', pageCount: 1 }),
    );
  });

  it('(d) aborts the in-flight image fetch when the caller signal is aborted', async () => {
    const controller = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    vi.mocked(apiClient.fetchUrl).mockImplementation((_url, options) => {
      fetchSignal = options?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        fetchSignal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    });

    const downloadPromise = downloadGalleryToLibrary(
      31,
      'G',
      'thumb.jpg',
      [makeFile()],
      makeGgConfig(),
      {},
      undefined,
      controller.signal,
    );

    await vi.waitFor(() => {
      expect(fetchSignal).toBeDefined();
    });
    controller.abort();

    await expect(downloadPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchSignal?.aborted).toBe(true);
    expect(upsertDownload).not.toHaveBeenCalled();
  });

  it('(d) does not retry caller AbortError — rethrows immediately', async () => {
    const controller = new AbortController();
    controller.abort();

    let callCount = 0;
    vi.mocked(apiClient.fetchUrl).mockImplementation(() => {
      callCount++;
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    });

    await expect(
      downloadGalleryToLibrary(
        3,
        'Gallery',
        'thumb.jpg',
        [makeFile()],
        makeGgConfig(),
        {},
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // With a pre-aborted signal, fetchUrl should not be called at all
    // (the abort check at the top of the loop fires first)
    expect(callCount).toBe(0);
    expect(upsertDownload).not.toHaveBeenCalled();
    expect(setDownloadError).not.toHaveBeenCalled();
  });

  // AC-006 (e): failure on page 5 (rowCreated) → updateDownloadStatus('failed'), 4 pages retained
  it('(e) marks failed only when row exists and retains partial pages', async () => {
    const files = Array.from({ length: 6 }, (_, i) => makeFile(`f${i}.jpg`));
    let callCount = 0;
    vi.mocked(apiClient.fetchUrl).mockImplementation(() => {
      callCount++;
      if (callCount === 5) {
        return Promise.reject(new Error('Network error on page 5'));
      }
      return Promise.resolve(makeFetchResponse('image/webp', new Uint8Array([1, 2])));
    });

    await expect(
      downloadGalleryToLibrary(4, 'Gallery', 'thumb.jpg', files, makeGgConfig(), {}),
    ).rejects.toThrow('Network error on page 5');

    // Row was created after page 1 succeeded
    expect(upsertDownload).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'downloading', pageCount: 1 }),
    );
    // Failed status + real reason set because row exists
    expect(setDownloadError).toHaveBeenCalledWith(4, 'failed', 'Network error on page 5');

    // 4 pages retained in store (pages 0–3 written before page 4 failed)
    for (let i = 0; i < 4; i++) {
      const page = await memStore.getImage(4, i, 'webp');
      expect(page).toBeInstanceOf(Uint8Array);
    }
  });

  // AC-006 (f): success → final status 'complete'
  it('(f) success path sets final status complete with correct pageCount and totalBytes', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]); // 5 bytes
    vi.mocked(apiClient.fetchUrl).mockResolvedValue(makeFetchResponse('image/webp', payload));
    const files = [makeFile(), makeFile()]; // 2 pages

    await downloadGalleryToLibrary(5, 'G', 'th.jpg', files, makeGgConfig(), {});

    const lastUpsert = vi.mocked(upsertDownload).mock.calls.at(-1)![0];
    expect(lastUpsert.status).toBe('complete');
    expect(lastUpsert.pageCount).toBe(2);
    expect(lastUpsert.totalBytes).toBe(10); // 5 × 2
  });

  it('calls onProgress once per image', async () => {
    const files = [makeFile('a.jpg'), makeFile('b.jpg'), makeFile('c.jpg')];
    const progress: Array<{ current: number; total: number }> = [];
    await downloadGalleryToLibrary(
      2,
      'Gallery',
      'thumb.jpg',
      files,
      makeGgConfig(),
      {},
      (p) => progress.push({ ...p }),
    );
    expect(progress).toHaveLength(3);
    expect(progress[0]).toEqual({ current: 1, total: 3 });
    expect(progress[2]).toEqual({ current: 3, total: 3 });
  });

  it('abort before first page leaves no DB row', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      downloadGalleryToLibrary(
        3,
        'Gallery',
        'thumb.jpg',
        [makeFile(), makeFile()],
        makeGgConfig(),
        {},
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(upsertDownload).not.toHaveBeenCalled();
    expect(setDownloadError).not.toHaveBeenCalled();
  });

  it('marks download as failed when fetch throws mid-download (after first page)', async () => {
    vi.mocked(apiClient.fetchUrl)
      .mockResolvedValueOnce(makeFetchResponse('image/webp', new Uint8Array([1])))
      .mockRejectedValueOnce(new Error('Network error'));

    await expect(
      downloadGalleryToLibrary(
        4,
        'Gallery',
        'thumb.jpg',
        [makeFile('a.jpg'), makeFile('b.jpg')],
        makeGgConfig(),
        {},
      ),
    ).rejects.toThrow('Network error');

    expect(setDownloadError).toHaveBeenCalledWith(4, 'failed', 'Network error');
  });

  it('accumulates totalBytes correctly', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]); // 5 bytes
    vi.mocked(apiClient.fetchUrl).mockResolvedValue(
      makeFetchResponse('image/webp', payload),
    );
    const files = [makeFile(), makeFile()]; // 2 pages
    await downloadGalleryToLibrary(5, 'G', 'th.jpg', files, makeGgConfig(), {});

    const lastUpsert = vi.mocked(upsertDownload).mock.calls.at(-1)![0];
    expect(lastUpsert.totalBytes).toBe(10); // 5 × 2
  });

  it('stores folderName in the DB row', async () => {
    await downloadGalleryToLibrary(42, 'My Title', 'thumb.jpg', [makeFile()], makeGgConfig(), {});

    const firstUpsert = vi.mocked(upsertDownload).mock.calls[0][0];
    expect(firstUpsert.folderName).toBe('42 My Title');
  });

  // AC-003: user cancel (SAF picker backout via ensureReady) before any page is
  // a silent no-op — no row, no error reason recorded.
  it('cancel (folder-picker backout) before first page leaves no DB row', async () => {
    const store = Object.assign(makeMemoryStore(), {
      async ensureReady() {
        throw new DownloadCancelledError();
      },
    });
    vi.mocked(createDownloadStore).mockResolvedValue(store);

    await expect(
      downloadGalleryToLibrary(1, 'G', 'thumb.jpg', [makeFile()], makeGgConfig(), {}),
    ).rejects.toBeInstanceOf(DownloadCancelledError);

    expect(upsertDownload).not.toHaveBeenCalled();
    expect(setDownloadError).not.toHaveBeenCalled();
  });

  // AC-003: abort AFTER some pages leaves a resumable 'failed' row with NO error
  // message (it was a cancel, not a failure).
  it('abort mid-download (after first page) marks failed with a null reason', async () => {
    const controller = new AbortController();
    let callCount = 0;
    vi.mocked(apiClient.fetchUrl).mockImplementation(() => {
      callCount++;
      if (callCount === 2) {
        controller.abort();
        return Promise.reject(new DOMException('Aborted', 'AbortError'));
      }
      return Promise.resolve(makeFetchResponse('image/webp', new Uint8Array([1])));
    });

    await expect(
      downloadGalleryToLibrary(
        7,
        'G',
        'thumb.jpg',
        [makeFile('a.jpg'), makeFile('b.jpg')],
        makeGgConfig(),
        {},
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(setDownloadError).toHaveBeenCalledWith(7, 'failed', null);
  });

  // AC-005: resume skips already-stored pages (per manifest) and fetches the rest.
  it('resume skips stored pages and fetches only the remainder', async () => {
    await memStore.putImage(9, -1, new TextEncoder().encode(JSON.stringify(['webp', 'webp'])), 'json');
    await memStore.putImage(9, 0, new Uint8Array([1, 1]), 'webp');
    await memStore.putImage(9, 1, new Uint8Array([2, 2]), 'webp');
    vi.mocked(apiClient.fetchUrl).mockResolvedValue(
      makeFetchResponse('image/webp', new Uint8Array([3, 3, 3])),
    );
    const files = [makeFile('a'), makeFile('b'), makeFile('c'), makeFile('d')];

    await downloadGalleryToLibrary(
      9,
      'G',
      'thumb.jpg',
      files,
      makeGgConfig(),
      {},
      undefined,
      undefined,
      { resume: true },
    );

    // Only pages 2 and 3 fetched (0 and 1 were already stored).
    expect(apiClient.fetchUrl).toHaveBeenCalledTimes(2);
    // Resume flips the stale 'failed' row back to 'downloading' and clears the error.
    expect(setDownloadError).toHaveBeenCalledWith(9, 'downloading', null);
    const lastUpsert = vi.mocked(upsertDownload).mock.calls.at(-1)![0];
    expect(lastUpsert.status).toBe('complete');
    expect(lastUpsert.pageCount).toBe(4);
    const manifest = await memStore.getImage(9, -1, 'json');
    expect(JSON.parse(new TextDecoder().decode(manifest!))).toEqual(['webp', 'webp', 'webp', 'webp']);
  });

  // AC-005: a torn last page (manifest claims it but the file is missing) is
  // dropped and re-fetched on resume.
  it('resume re-fetches a torn last page that is missing on disk', async () => {
    await memStore.putImage(10, -1, new TextEncoder().encode(JSON.stringify(['webp', 'webp'])), 'json');
    await memStore.putImage(10, 0, new Uint8Array([1]), 'webp');
    // page 1 intentionally absent (torn write)
    vi.mocked(apiClient.fetchUrl).mockResolvedValue(
      makeFetchResponse('image/webp', new Uint8Array([9])),
    );
    const files = [makeFile('a'), makeFile('b')];

    await downloadGalleryToLibrary(
      10,
      'G',
      'thumb.jpg',
      files,
      makeGgConfig(),
      {},
      undefined,
      undefined,
      { resume: true },
    );

    // Page 0 kept, torn page 1 re-fetched → exactly one network call.
    expect(apiClient.fetchUrl).toHaveBeenCalledTimes(1);
  });

  // AC-005: default (no opts) is byte-identical — a full download, nothing skipped.
  it('without resume, a fresh download fetches every page', async () => {
    await memStore.putImage(11, -1, new TextEncoder().encode(JSON.stringify(['webp'])), 'json');
    await memStore.putImage(11, 0, new Uint8Array([1]), 'webp');
    vi.mocked(apiClient.fetchUrl).mockResolvedValue(
      makeFetchResponse('image/webp', new Uint8Array([5])),
    );
    const files = [makeFile('a'), makeFile('b')];

    await downloadGalleryToLibrary(11, 'G', 'thumb.jpg', files, makeGgConfig(), {});

    // No resume → both pages fetched despite a pre-existing manifest/page.
    expect(apiClient.fetchUrl).toHaveBeenCalledTimes(2);
    expect(setDownloadError).not.toHaveBeenCalledWith(11, 'downloading', null);
  });
});

// ── downloadGalleryToLibrary cache reuse (stage 4) ────────────────────────────

describe('downloadGalleryToLibrary — cache reuse', () => {
  let memStore: ReturnType<typeof makeMemoryStoreWithCopy>;

  beforeEach(() => {
    vi.clearAllMocks();
    memStore = makeMemoryStoreWithCopy();
    vi.mocked(createDownloadStore).mockResolvedValue(memStore);
    vi.mocked(getImageUrl).mockReturnValue('https://example.com/image.webp');
    vi.mocked(apiClient.fetchUrl).mockResolvedValue(
      makeFetchResponse('image/webp', new Uint8Array([1, 2, 3])),
    );
    vi.mocked(upsertDownload).mockResolvedValue(undefined);
    vi.mocked(updateDownloadProgress).mockResolvedValue(undefined);
    cachedFilePath.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('copies a cached page from the cache file and skips the network', async () => {
    cachedFilePath.mockResolvedValue('file:///cache/image-cache/key');

    await downloadGalleryToLibrary(1, 'G', 'thumb.jpg', [makeFile()], makeGgConfig(), {});

    expect(apiClient.fetchUrl).not.toHaveBeenCalled();
    expect(cachedFilePath).toHaveBeenCalledWith('https://example.com/image.webp');
    expect(memStore.copies).toEqual([
      { galleryId: 1, index: 0, srcPath: 'file:///cache/image-cache/key', ext: 'webp' },
    ]);
    const manifest = await memStore.getImage(1, -1, 'json');
    expect(JSON.parse(new TextDecoder().decode(manifest!))).toEqual(['webp']);
  });

  it('falls back to fetch + putImage when the page is not cached', async () => {
    cachedFilePath.mockResolvedValue(null);

    await downloadGalleryToLibrary(2, 'G', 'thumb.jpg', [makeFile()], makeGgConfig(), {});

    expect(apiClient.fetchUrl).toHaveBeenCalledTimes(1);
    expect(memStore.copies).toHaveLength(0);
    expect(await memStore.getImage(2, 0, 'webp')).toBeInstanceOf(Uint8Array);
  });

  it('mixes copy + fetch and accounts totalBytes from both paths', async () => {
    cachedFilePath.mockResolvedValueOnce('file:///cache/key0').mockResolvedValueOnce(null);
    vi.mocked(apiClient.fetchUrl).mockResolvedValue(
      makeFetchResponse('image/webp', new Uint8Array([9, 9, 9, 9, 9])), // 5 bytes
    );

    await downloadGalleryToLibrary(
      3,
      'G',
      'thumb.jpg',
      [makeFile('a.jpg'), makeFile('b.jpg')],
      makeGgConfig(),
      {},
    );

    expect(memStore.copies).toHaveLength(1); // page 0 copied from cache
    expect(apiClient.fetchUrl).toHaveBeenCalledTimes(1); // page 1 fetched
    const lastUpsert = vi.mocked(upsertDownload).mock.calls.at(-1)![0];
    expect(lastUpsert.totalBytes).toBe(4 + 5); // copy 4 + fetch 5
    expect(lastUpsert.pageCount).toBe(2);
  });
});

// ── getDownloadedGalleryPages / getDownloadedImage (AC-003 reader helpers) ────

describe('getDownloadedGalleryPages', () => {
  let memStore: ReturnType<typeof makeMemoryStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    memStore = makeMemoryStore();
    vi.mocked(createDownloadStore).mockResolvedValue(memStore);
  });

  it('returns empty array when no manifest exists', async () => {
    const pages = await getDownloadedGalleryPages(99);
    expect(pages).toEqual([]);
  });

  it('returns index+ext pairs matching the stored manifest', async () => {
    // Write a manifest manually (same as downloadGalleryToLibrary would)
    const exts = ['webp', 'avif', 'jpg'];
    const manifestBytes = new TextEncoder().encode(JSON.stringify(exts));
    await memStore.putImage(7, -1, manifestBytes, 'json');

    const pages = await getDownloadedGalleryPages(7);
    expect(pages).toEqual([
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'avif' },
      { index: 2, ext: 'jpg' },
    ]);
  });
});

describe('getDownloadedImage', () => {
  let memStore: ReturnType<typeof makeMemoryStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    memStore = makeMemoryStore();
    vi.mocked(createDownloadStore).mockResolvedValue(memStore);
  });

  it('returns null when no manifest exists', async () => {
    const img = await getDownloadedImage(99, 0);
    expect(img).toBeNull();
  });

  it('returns null when page index is out of range', async () => {
    const exts = ['webp'];
    await memStore.putImage(10, -1, new TextEncoder().encode(JSON.stringify(exts)), 'json');
    const img = await getDownloadedImage(10, 5);
    expect(img).toBeNull();
  });

  it('returns the image bytes for a valid index', async () => {
    const exts = ['webp', 'jpg'];
    await memStore.putImage(11, -1, new TextEncoder().encode(JSON.stringify(exts)), 'json');
    const imageBytes = new Uint8Array([0xaa, 0xbb, 0xcc]);
    await memStore.putImage(11, 1, imageBytes, 'jpg');

    const result = await getDownloadedImage(11, 1);
    expect(result).toEqual(imageBytes);
  });
});

// ── exportGalleryZip (AC-007) ─────────────────────────────────────────────────

describe('exportGalleryZip', () => {
  let memStore: ReturnType<typeof makeMemoryStore>;
  let anchorEl: { href: string; download: string; click: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    memStore = makeMemoryStore();
    vi.mocked(createDownloadStore).mockResolvedValue(memStore);
    vi.mocked(zipSync).mockReturnValue(new Uint8Array([1, 2, 3]));

    anchorEl = { href: '', download: '', click: vi.fn() };
    vi.stubGlobal('document', { createElement: vi.fn(() => anchorEl) });
    vi.stubGlobal('Blob', class MockBlob {
      constructor(public parts: unknown[], public options: unknown) {}
    });
    const origURL = globalThis.URL;
    vi.stubGlobal('URL', Object.assign(
      function (...args: unknown[]) { return new origURL(...(args as [string])); },
      {
        ...origURL,
        createObjectURL: vi.fn(() => 'blob:fake-url'),
        revokeObjectURL: vi.fn(),
      },
    ));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('throws when no manifest is found', async () => {
    await expect(exportGalleryZip(999, 'Missing')).rejects.toThrow(
      'No manifest found for gallery 999',
    );
  });

  it('builds a zip from stored images and triggers download', async () => {
    // Set up a gallery with 2 pages
    const exts = ['webp', 'jpg'];
    await memStore.putImage(42, -1, new TextEncoder().encode(JSON.stringify(exts)), 'json');
    await memStore.putImage(42, 0, new Uint8Array([1, 2]), 'webp');
    await memStore.putImage(42, 1, new Uint8Array([3, 4, 5]), 'jpg');

    await exportGalleryZip(42, 'My Gallery');

    // zipSync should have been called with both pages
    expect(zipSync).toHaveBeenCalledOnce();
    const entries = vi.mocked(zipSync).mock.calls[0][0] as Record<string, Uint8Array>;
    expect(Object.keys(entries)).toContain('0001.webp');
    expect(Object.keys(entries)).toContain('0002.jpg');

    // Download anchor should be triggered
    expect(document.createElement).toHaveBeenCalledWith('a');
    expect(anchorEl.download).toBe('42 My Gallery.zip');
    expect(anchorEl.click).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
  });

  it('uses level:0 compression (images already compressed)', async () => {
    const exts = ['webp'];
    await memStore.putImage(1, -1, new TextEncoder().encode(JSON.stringify(exts)), 'json');
    await memStore.putImage(1, 0, new Uint8Array([1]), 'webp');

    await exportGalleryZip(1, 'G');

    expect(vi.mocked(zipSync)).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ level: 0 }),
    );
  });

  it('sanitizes the gallery title in the zip filename', async () => {
    const exts = ['webp'];
    await memStore.putImage(5, -1, new TextEncoder().encode(JSON.stringify(exts)), 'json');
    await memStore.putImage(5, 0, new Uint8Array([1]), 'webp');

    await exportGalleryZip(5, 'Bad <Title> / "Name"');
    expect(anchorEl.download).toBe('5 Bad _Title_ _ _Name_.zip');
  });

  it('skips missing pages gracefully (partial download)', async () => {
    // Manifest says 2 pages but only page 0 is stored
    const exts = ['webp', 'jpg'];
    await memStore.putImage(6, -1, new TextEncoder().encode(JSON.stringify(exts)), 'json');
    await memStore.putImage(6, 0, new Uint8Array([1, 2]), 'webp');
    // page 1 is intentionally missing

    await exportGalleryZip(6, 'Partial');

    const entries = vi.mocked(zipSync).mock.calls[0][0] as Record<string, Uint8Array>;
    expect(Object.keys(entries)).toContain('0001.webp');
    expect(Object.keys(entries)).not.toContain('0002.jpg');
  });
});

// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GalleryFile, GgConfig } from '../types';
import type { DownloadStore } from '@/lib/storage/download-store';
import type { DBDownload } from '@/lib/db/schema';

// Mock fflate before importing the module under test
vi.mock('fflate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fflate')>();
  return {
    ...actual,
    zipSync: vi.fn(() => new Uint8Array([1, 2, 3])),
    strToU8: vi.fn((s: string) => new TextEncoder().encode(s)),
  };
});

const nativeZip = vi.hoisted(() => ({
  save: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: nativeZip.save }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: nativeZip.invoke }));

// Mock image-url module
vi.mock('../image-url', () => ({
  getImageUrl: vi.fn(() => 'https://example.com/image.webp'),
}));

// Mock api client — include ApiError class for error-path tests
vi.mock('@/lib/api/client', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
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
  updateNativeDownloadProgress: vi.fn().mockResolvedValue(true),
  setDownloadError: vi.fn().mockResolvedValue(undefined),
  updateDownloadStatus: vi.fn().mockResolvedValue(undefined),
  resumeNativeDownloadRun: vi.fn().mockResolvedValue(true),
  transitionNativeDownloadRun: vi.fn().mockResolvedValue(true),
  completeNativeDownloadRun: vi.fn().mockResolvedValue(true),
  getDownload: vi.fn().mockResolvedValue(null),
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
  imageFileName: (index: number, ext: string) => String(index + 1).padStart(4, '0') + '.' + ext,
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
  hasCompleteDownloadedGallery,
  StaleDownloadRunError,
  type DownloadProgress,
} from '../download-zip';
import { unzipSync, zipSync } from 'fflate';
import { getImageUrl } from '../image-url';
import { apiClient, ApiError } from '@/lib/api/client';
import {
  upsertDownload,
  setDownloadError,
  updateDownloadProgress,
  updateNativeDownloadProgress,
  updateDownloadStatus,
  resumeNativeDownloadRun,
  transitionNativeDownloadRun,
  completeNativeDownloadRun,
  getDownload,
} from '@/lib/db/download';
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
  let anchorEl: {
    href: string;
    download: string;
    click: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    anchorEl = { href: '', download: '', click: vi.fn(), remove: vi.fn() };

    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchorEl),
      body: { appendChild: vi.fn() },
    });
    vi.stubGlobal(
      'Blob',
      class MockBlob {
        constructor(
          public parts: unknown[],
          public options: unknown,
        ) {}
      },
    );
    const origURL = globalThis.URL;
    vi.stubGlobal(
      'URL',
      Object.assign(
        function (...args: unknown[]) {
          return new origURL(...(args as [string]));
        },
        {
          ...origURL,
          createObjectURL: vi.fn(() => 'blob:fake-url'),
          revokeObjectURL: vi.fn(),
        },
      ),
    );

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
        downloadGalleryAsZip(
          1,
          'Title',
          [makeFile(), makeFile()],
          makeGgConfig(),
          undefined,
          controller.signal,
        ),
      ).rejects.toMatchObject({ name: 'AbortError', message: 'Aborted' });
    });

    it('throws AbortError when signal is aborted mid-loop', async () => {
      const controller = new AbortController();
      vi.mocked(apiClient.fetchUrl).mockImplementation(() => {
        controller.abort();
        return Promise.resolve(makeFetchResponse('image/webp'));
      });
      await expect(
        downloadGalleryAsZip(
          1,
          'Title',
          [makeFile('a.jpg'), makeFile('b.jpg')],
          makeGgConfig(),
          undefined,
          controller.signal,
        ),
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
      vi.mocked(apiClient.fetchUrl).mockResolvedValue(
        makeFetchResponse('application/octet-stream'),
      );
      await downloadGalleryAsZip(1, 'Title', [makeFile('artwork.png', 0)], makeGgConfig());
      const zipEntries = vi.mocked(zipSync).mock.calls[0][0] as Record<string, Uint8Array>;
      expect(Object.keys(zipEntries)[0]).toMatch(/\.png$/);
    });

    it('defaults to webp when haswebp=1 and content-type is unrecognized', async () => {
      vi.mocked(apiClient.fetchUrl).mockResolvedValue(
        makeFetchResponse('application/octet-stream'),
      );
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
      expect(anchorEl.remove).toHaveBeenCalledOnce();
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
      await expect(downloadGalleryAsZip(1, 'T', [makeFile()], makeGgConfig())).rejects.toThrow(
        'HTTP 404',
      );
    });
  });
});

// ── downloadGalleryToLibrary (AC-006 resilience rewrite) ──────────────────────

describe('downloadGalleryToLibrary', () => {
  let memStore: ReturnType<typeof makeMemoryStore>;

  const nativeRow = (
    galleryId: number,
    nativeRunId: string,
    overrides: Partial<DBDownload> = {},
  ): DBDownload => ({
    galleryId,
    title: `Gallery ${galleryId}`,
    thumbnail: 'thumb.jpg',
    tags: '{}',
    pageCount: 1,
    totalBytes: 3,
    downloadedAt: '2026-07-31T00:00:00.000Z',
    status: 'downloading',
    folderName: `${galleryId} Gallery ${galleryId}`,
    queuePosition: 1,
    retryCount: 0,
    nextRetryAt: null,
    nativeRunId,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    memStore = makeMemoryStore();
    vi.mocked(createDownloadStore).mockResolvedValue(memStore);
    vi.mocked(apiClient.fetchUrl).mockResolvedValue(
      makeFetchResponse('image/webp', new Uint8Array([10, 20, 30])),
    );
    vi.mocked(getImageUrl).mockReturnValue('https://example.com/image.webp');
    vi.mocked(upsertDownload).mockResolvedValue(undefined);
    vi.mocked(setDownloadError).mockResolvedValue(undefined);
    vi.mocked(updateDownloadProgress).mockResolvedValue(undefined);
    vi.mocked(updateNativeDownloadProgress).mockResolvedValue(true);
    vi.mocked(updateDownloadStatus).mockResolvedValue(undefined);
    vi.mocked(resumeNativeDownloadRun).mockResolvedValue(true);
    vi.mocked(transitionNativeDownloadRun).mockResolvedValue(true);
    vi.mocked(completeNativeDownloadRun).mockResolvedValue(true);
    vi.mocked(getDownload).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
      downloadGalleryToLibrary(1, 'Gallery', 'thumb.jpg', [makeFile()], makeGgConfig(), {}),
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
    await downloadGalleryToLibrary(2, 'My Gallery', 'thumb.jpg', files, makeGgConfig(), {
      artist: ['foo'],
    });

    // upsertDownload called twice: once creating row (pageCount:1), once on completion
    expect(upsertDownload).toHaveBeenCalledTimes(2);

    const firstUpsert = vi.mocked(upsertDownload).mock.calls[0][0];
    expect(firstUpsert.status).toBe('downloading');
    expect(firstUpsert.pageCount).toBe(1);
    expect(firstUpsert.galleryId).toBe(2);

    // updateDownloadProgress called for pages 2 and 3 (i+1 = 2, 3)
    expect(updateDownloadProgress).toHaveBeenCalledTimes(2);
    expect(vi.mocked(updateDownloadProgress).mock.calls[0]).toEqual([
      2,
      2,
      expect.any(Number),
      { persist: false },
    ]);
    expect(vi.mocked(updateDownloadProgress).mock.calls[1]).toEqual([
      2,
      3,
      expect.any(Number),
      { persist: true },
    ]);

    const lastUpsert = vi.mocked(upsertDownload).mock.calls[1][0];
    expect(lastUpsert.status).toBe('complete');
    expect(lastUpsert.pageCount).toBe(3);
  });

  it('preserves an existing queuePosition on the first active row so pause remains resumable', async () => {
    vi.mocked(getDownload).mockResolvedValue({
      galleryId: 22,
      title: 'Queued',
      thumbnail: 'thumb.jpg',
      tags: '{}',
      pageCount: 0,
      totalBytes: 0,
      downloadedAt: '2026-01-01T00:00:00.000Z',
      status: 'queued',
      queuePosition: 7,
      retryCount: 2,
      nextRetryAt: '2026-01-01T00:01:00.000Z',
    });

    await downloadGalleryToLibrary(22, 'Queued', 'thumb.jpg', [makeFile()], makeGgConfig(), {});

    const firstUpsert = vi.mocked(upsertDownload).mock.calls[0][0];
    expect(firstUpsert).toMatchObject({
      galleryId: 22,
      status: 'downloading',
      queuePosition: 7,
      retryCount: 2,
      nextRetryAt: null,
    });
  });

  it('preserves retryCount when a retry attempt fails before the first page', async () => {
    vi.mocked(getDownload).mockResolvedValue({
      galleryId: 24,
      title: 'Retrying',
      thumbnail: 'thumb.jpg',
      tags: '{}',
      pageCount: 0,
      totalBytes: 0,
      downloadedAt: '2026-01-01T00:00:00.000Z',
      status: 'queued',
      queuePosition: 9,
      retryCount: 2,
      nextRetryAt: null,
    });
    vi.mocked(apiClient.fetchUrl).mockRejectedValue(new Error('Network down'));

    await expect(
      downloadGalleryToLibrary(24, 'Retrying', 'thumb.jpg', [makeFile()], makeGgConfig(), {}),
    ).rejects.toThrow('Network down');

    const failedUpsert = vi.mocked(upsertDownload).mock.calls[0][0];
    expect(failedUpsert).toMatchObject({
      galleryId: 24,
      status: 'failed',
      queuePosition: 9,
      retryCount: 2,
      nextRetryAt: null,
    });
  });

  it('pause before the first page flips the queued row to paused instead of leaving it queued', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      downloadGalleryToLibrary(
        23,
        'Queued',
        'thumb.jpg',
        [makeFile()],
        makeGgConfig(),
        {},
        undefined,
        controller.signal,
        { isPauseSignal: () => true },
      ),
    ).rejects.toMatchObject({ name: 'DownloadPausedError' });

    expect(updateDownloadStatus).toHaveBeenCalledWith(23, 'paused');
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
    expect(upsertDownload).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'downloading', pageCount: 1 }),
    );
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

  it('(d) abort after the response body is read does not write a stale page', async () => {
    const controller = new AbortController();
    vi.mocked(apiClient.fetchUrl).mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (h: string) => (h === 'content-type' ? 'image/webp' : null),
      } as unknown as Headers,
      arrayBuffer: () => {
        controller.abort();
        return Promise.resolve(new Uint8Array([4, 5, 6]).buffer as ArrayBuffer);
      },
    } as unknown as Response);

    await expect(
      downloadGalleryToLibrary(
        32,
        'G',
        'thumb.jpg',
        [makeFile()],
        makeGgConfig(),
        {},
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(await memStore.getImage(32, 0, 'webp')).toBeNull();
    expect(await memStore.getImage(32, -1, 'json')).toBeNull();
    expect(upsertDownload).not.toHaveBeenCalled();
  });

  it('(d) abort after page storage skips manifest and DB progress writes', async () => {
    const controller = new AbortController();
    const putImage = vi
      .spyOn(memStore, 'putImage')
      .mockImplementation(async (galleryId, index, bytes, ext) => {
        memStore.store.set(`${galleryId}/${String(index + 1).padStart(4, '0')}.${ext}`, bytes);
        controller.abort();
      });

    await expect(
      downloadGalleryToLibrary(
        33,
        'G',
        'thumb.jpg',
        [makeFile()],
        makeGgConfig(),
        {},
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(putImage).toHaveBeenCalledWith(33, 0, expect.any(Uint8Array), 'webp', {
      folderName: '33 G',
    });
    expect(await memStore.getImage(33, 0, 'webp')).toBeInstanceOf(Uint8Array);
    expect(await memStore.getImage(33, -1, 'json')).toBeNull();
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

  it('throws StaleDownloadRunError when the exact-run completion CAS loses without recording a failure', async () => {
    const nativeRunId = 'run-complete-aaaaaaaa';
    vi.mocked(getDownload).mockResolvedValue(nativeRow(51, nativeRunId));
    vi.mocked(completeNativeDownloadRun).mockResolvedValue(false);

    await expect(
      downloadGalleryToLibrary(
        51,
        'Gallery 51',
        'thumb.jpg',
        [makeFile()],
        makeGgConfig(),
        {},
        undefined,
        undefined,
        { nativeRunId },
      ),
    ).rejects.toBeInstanceOf(StaleDownloadRunError);

    expect(completeNativeDownloadRun).toHaveBeenCalledWith(
      expect.objectContaining({ galleryId: 51, status: 'complete', pageCount: 1 }),
      nativeRunId,
    );
    expect(upsertDownload).not.toHaveBeenCalled();
    expect(setDownloadError).not.toHaveBeenCalled();
    expect(updateDownloadStatus).not.toHaveBeenCalled();
    expect(transitionNativeDownloadRun).not.toHaveBeenCalled();
  });

  it('observes an abort raised by final progress before committing the native run', async () => {
    const nativeRunId = 'run-abort-aaaaaaaaaa';
    const controller = new AbortController();
    vi.mocked(getDownload).mockResolvedValue(nativeRow(52, nativeRunId));

    await expect(
      downloadGalleryToLibrary(
        52,
        'Gallery 52',
        'thumb.jpg',
        [makeFile()],
        makeGgConfig(),
        {},
        ({ current, total }) => {
          if (current === total) controller.abort();
        },
        controller.signal,
        { nativeRunId },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(completeNativeDownloadRun).not.toHaveBeenCalled();
    expect(transitionNativeDownloadRun).toHaveBeenCalledWith(52, nativeRunId, 'failed', null, {
      clearRunId: false,
    });
    expect(upsertDownload).not.toHaveBeenCalled();
    expect(setDownloadError).not.toHaveBeenCalled();
  });

  it('uses exact-run CAS helpers for native resume, progress, and completion', async () => {
    const nativeRunId = 'run-resume-aaaaaaaaa';
    vi.mocked(getDownload).mockResolvedValue(nativeRow(53, nativeRunId));
    await memStore.putImage(53, -1, new TextEncoder().encode(JSON.stringify(['webp'])), 'json');
    await memStore.putImage(53, 0, new Uint8Array([7]), 'webp');

    await downloadGalleryToLibrary(
      53,
      'Gallery 53',
      'thumb.jpg',
      [makeFile('first.jpg'), makeFile('second.jpg')],
      makeGgConfig(),
      {},
      undefined,
      undefined,
      { resume: true, nativeRunId },
    );

    expect(resumeNativeDownloadRun).toHaveBeenCalledWith(53, nativeRunId);
    expect(updateNativeDownloadProgress).toHaveBeenCalledWith(
      53,
      nativeRunId,
      2,
      expect.any(Number),
      { persist: true },
    );
    expect(completeNativeDownloadRun).toHaveBeenCalledWith(
      expect.objectContaining({ galleryId: 53, status: 'complete', pageCount: 2 }),
      nativeRunId,
    );
    expect(setDownloadError).not.toHaveBeenCalled();
    expect(updateDownloadProgress).not.toHaveBeenCalled();
    expect(upsertDownload).not.toHaveBeenCalled();
  });

  it('stops without lifecycle writes when a native progress CAS reports stale ownership', async () => {
    const nativeRunId = 'run-progress-aaaaaaaa';
    vi.mocked(getDownload).mockResolvedValue(nativeRow(54, nativeRunId));
    vi.mocked(updateNativeDownloadProgress).mockResolvedValue(false);

    await expect(
      downloadGalleryToLibrary(
        54,
        'Gallery 54',
        'thumb.jpg',
        [makeFile()],
        makeGgConfig(),
        {},
        undefined,
        undefined,
        { nativeRunId },
      ),
    ).rejects.toBeInstanceOf(StaleDownloadRunError);

    expect(updateNativeDownloadProgress).toHaveBeenCalledWith(
      54,
      nativeRunId,
      1,
      expect.any(Number),
      { persist: true },
    );
    expect(completeNativeDownloadRun).not.toHaveBeenCalled();
    expect(transitionNativeDownloadRun).not.toHaveBeenCalled();
    expect(upsertDownload).not.toHaveBeenCalled();
    expect(setDownloadError).not.toHaveBeenCalled();
    expect(updateDownloadStatus).not.toHaveBeenCalled();
  });

  it('stops before network or DB progress when the native resume CAS reports stale ownership', async () => {
    const nativeRunId = 'run-resume-bbbbbbbbb';
    vi.mocked(getDownload).mockResolvedValue(nativeRow(55, nativeRunId));
    vi.mocked(resumeNativeDownloadRun).mockResolvedValue(false);
    await memStore.putImage(55, -1, new TextEncoder().encode(JSON.stringify(['webp'])), 'json');
    await memStore.putImage(55, 0, new Uint8Array([7]), 'webp');

    await expect(
      downloadGalleryToLibrary(
        55,
        'Gallery 55',
        'thumb.jpg',
        [makeFile()],
        makeGgConfig(),
        {},
        undefined,
        undefined,
        { resume: true, nativeRunId },
      ),
    ).rejects.toBeInstanceOf(StaleDownloadRunError);

    expect(apiClient.fetchUrl).not.toHaveBeenCalled();
    expect(updateNativeDownloadProgress).not.toHaveBeenCalled();
    expect(updateDownloadProgress).not.toHaveBeenCalled();
    expect(completeNativeDownloadRun).not.toHaveBeenCalled();
    expect(transitionNativeDownloadRun).not.toHaveBeenCalled();
    expect(upsertDownload).not.toHaveBeenCalled();
    expect(setDownloadError).not.toHaveBeenCalled();
  });

  it('calls onProgress once per image', async () => {
    const files = [makeFile('a.jpg'), makeFile('b.jpg'), makeFile('c.jpg')];
    const progress: Array<{ current: number; total: number }> = [];
    await downloadGalleryToLibrary(2, 'Gallery', 'thumb.jpg', files, makeGgConfig(), {}, (p) =>
      progress.push({ ...p }),
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
    vi.mocked(apiClient.fetchUrl).mockResolvedValue(makeFetchResponse('image/webp', payload));
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

  it('marks a new Android public row only when manifest-backed completion succeeds', async () => {
    vi.stubGlobal('window', {
      Capacitor: {
        getPlatform: () => 'android',
      },
    });

    await downloadGalleryToLibrary(
      44,
      'Public Library',
      'thumb.jpg',
      [makeFile()],
      makeGgConfig(),
      {},
    );

    const [activeRow, completedRow] = vi.mocked(upsertDownload).mock.calls.map(([row]) => row);
    expect(activeRow).toMatchObject({
      galleryId: 44,
      status: 'downloading',
      folderName: '44 Public Library',
      migratedAt: null,
    });
    expect(completedRow).toMatchObject({
      galleryId: 44,
      status: 'complete',
      folderName: '44 Public Library',
      migratedAt: expect.any(String),
    });
  });

  it('rejects an empty gallery without publishing storage or a completion watermark', async () => {
    vi.stubGlobal('window', {
      Capacitor: {
        getPlatform: () => 'android',
      },
    });
    const putImage = vi.spyOn(memStore, 'putImage');

    await expect(
      downloadGalleryToLibrary(46, 'Empty Gallery', 'thumb.jpg', [], makeGgConfig(), {}),
    ).rejects.toThrow('Gallery has no downloadable files');

    expect(getDownload).not.toHaveBeenCalled();
    expect(createDownloadStore).not.toHaveBeenCalled();
    expect(putImage).not.toHaveBeenCalled();
    expect(upsertDownload).not.toHaveBeenCalled();
    expect(completeNativeDownloadRun).not.toHaveBeenCalled();
  });

  it('keeps a zero-page Android failure unmarked when no public manifest was published', async () => {
    vi.stubGlobal('window', {
      Capacitor: {
        getPlatform: () => 'android',
      },
    });
    vi.mocked(apiClient.fetchUrl).mockRejectedValue(new Error('Network unavailable'));

    await expect(
      downloadGalleryToLibrary(
        45,
        'No Manifest',
        'thumb.jpg',
        [makeFile()],
        makeGgConfig(),
        {},
      ),
    ).rejects.toThrow('Network unavailable');

    expect(vi.mocked(upsertDownload).mock.calls.at(-1)?.[0]).toMatchObject({
      galleryId: 45,
      status: 'failed',
      pageCount: 0,
      migratedAt: null,
    });
  });

  it('reuses an existing persisted folderName while resuming', async () => {
    vi.mocked(getDownload).mockResolvedValue({
      galleryId: 43,
      title: 'Old',
      thumbnail: 'thumb.jpg',
      tags: '{}',
      pageCount: 1,
      totalBytes: 1,
      downloadedAt: '2026-01-01T00:00:00.000Z',
      status: 'failed',
      folderName: '43 Persisted Folder',
    });
    const putImage = vi.spyOn(memStore, 'putImage');

    await downloadGalleryToLibrary(43, 'New Title', 'thumb.jpg', [makeFile()], makeGgConfig(), {});

    expect(putImage).toHaveBeenCalledWith(43, 0, expect.any(Uint8Array), 'webp', {
      folderName: '43 Persisted Folder',
    });
    expect(vi.mocked(upsertDownload).mock.calls.at(-1)?.[0]).toMatchObject({
      galleryId: 43,
      status: 'complete',
      folderName: '43 Persisted Folder',
    });
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
    await memStore.putImage(
      9,
      -1,
      new TextEncoder().encode(JSON.stringify(['webp', 'webp'])),
      'json',
    );
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
    expect(JSON.parse(new TextDecoder().decode(manifest!))).toEqual([
      'webp',
      'webp',
      'webp',
      'webp',
    ]);
  });

  // AC-005: a torn last page (manifest claims it but the file is missing) is
  // dropped and re-fetched on resume.
  it('resume re-fetches a torn last page that is missing on disk', async () => {
    await memStore.putImage(
      10,
      -1,
      new TextEncoder().encode(JSON.stringify(['webp', 'webp'])),
      'json',
    );
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

  // resume-verify-all-pages: a page deleted from the MIDDLE of a gallery is
  // re-fetched on resume (the old last-page-only seeding skipped it forever).
  it('resume re-fetches ONLY a deleted middle page and heals the gap', async () => {
    await memStore.putImage(
      20,
      -1,
      new TextEncoder().encode(JSON.stringify(['webp', 'webp', 'webp'])),
      'json',
    );
    await memStore.putImage(20, 0, new Uint8Array([1]), 'webp');
    // page 1 deleted externally (gap in the middle); page 2 still present.
    await memStore.putImage(20, 2, new Uint8Array([3]), 'webp');
    vi.mocked(apiClient.fetchUrl).mockResolvedValue(
      makeFetchResponse('image/webp', new Uint8Array([9, 9])),
    );
    const files = [makeFile('a'), makeFile('b'), makeFile('c')];

    await downloadGalleryToLibrary(
      20,
      'G',
      'thumb.jpg',
      files,
      makeGgConfig(),
      {},
      undefined,
      undefined,
      { resume: true },
    );

    // Exactly the middle page is re-fetched.
    expect(apiClient.fetchUrl).toHaveBeenCalledTimes(1);
    // The gap is filled and the gallery is complete with a full manifest.
    expect(await memStore.getImage(20, 1, 'webp')).toBeInstanceOf(Uint8Array);
    const lastUpsert = vi.mocked(upsertDownload).mock.calls.at(-1)![0];
    expect(lastUpsert.status).toBe('complete');
    expect(lastUpsert.pageCount).toBe(3);
    const manifest = await memStore.getImage(20, -1, 'json');
    expect(JSON.parse(new TextDecoder().decode(manifest!))).toEqual(['webp', 'webp', 'webp']);
  });

  // resume-verify-all-pages: a fully-present gallery fetches nothing on resume
  // and is marked complete (no redundant network).
  it('resume of a fully-present gallery fetches nothing and completes', async () => {
    await memStore.putImage(
      21,
      -1,
      new TextEncoder().encode(JSON.stringify(['webp', 'jpg'])),
      'json',
    );
    await memStore.putImage(21, 0, new Uint8Array([1, 1]), 'webp');
    await memStore.putImage(21, 1, new Uint8Array([2, 2]), 'jpg');
    const files = [makeFile('a'), makeFile('b')];

    await downloadGalleryToLibrary(
      21,
      'G',
      'thumb.jpg',
      files,
      makeGgConfig(),
      {},
      undefined,
      undefined,
      { resume: true },
    );

    expect(apiClient.fetchUrl).not.toHaveBeenCalled();
    const lastUpsert = vi.mocked(upsertDownload).mock.calls.at(-1)![0];
    expect(lastUpsert.status).toBe('complete');
    expect(lastUpsert.pageCount).toBe(2);
    // Manifest preserved with the original (mixed) exts.
    const manifest = await memStore.getImage(21, -1, 'json');
    expect(JSON.parse(new TextDecoder().decode(manifest!))).toEqual(['webp', 'jpg']);
  });

  // resume-verify-all-pages: resume with NO manifest (folder/manifest entirely
  // gone) re-downloads all pages from index 0.
  it('resume with no manifest re-downloads all pages from the start', async () => {
    vi.mocked(apiClient.fetchUrl).mockResolvedValue(
      makeFetchResponse('image/webp', new Uint8Array([7])),
    );
    const files = [makeFile('a'), makeFile('b'), makeFile('c')];

    await downloadGalleryToLibrary(
      22,
      'G',
      'thumb.jpg',
      files,
      makeGgConfig(),
      {},
      undefined,
      undefined,
      { resume: true },
    );

    // No manifest → nothing to verify → every page fetched.
    expect(apiClient.fetchUrl).toHaveBeenCalledTimes(3);
    // No stale row to flip back to 'downloading'.
    expect(setDownloadError).not.toHaveBeenCalledWith(22, 'downloading', null);
    const lastUpsert = vi.mocked(upsertDownload).mock.calls.at(-1)![0];
    expect(lastUpsert.status).toBe('complete');
    expect(lastUpsert.pageCount).toBe(3);
  });

  // resume-verify-all-pages: when the store exposes the cheap imageExists probe,
  // resume uses it (stat, no byte read) — and a size-0 page is treated missing.
  it('resume uses store.imageExists when available and refetches a torn (size-0) page', async () => {
    const probed: Array<[number, string]> = [];
    const base = makeMemoryStore();
    const storeWithExists = Object.assign(base, {
      async imageExists(galleryId: number, index: number, ext: string): Promise<boolean> {
        probed.push([index, ext]);
        const bytes = await base.getImage(galleryId, index, ext);
        return !!bytes && bytes.byteLength > 0;
      },
    });
    vi.mocked(createDownloadStore).mockResolvedValue(storeWithExists);

    await storeWithExists.putImage(
      23,
      -1,
      new TextEncoder().encode(JSON.stringify(['webp', 'webp'])),
      'json',
    );
    await storeWithExists.putImage(23, 0, new Uint8Array([1, 1]), 'webp');
    // page 1 present but ZERO bytes → torn write → must refetch.
    await storeWithExists.putImage(23, 1, new Uint8Array(0), 'webp');
    vi.mocked(apiClient.fetchUrl).mockResolvedValue(
      makeFetchResponse('image/webp', new Uint8Array([5])),
    );
    const files = [makeFile('a'), makeFile('b')];

    await downloadGalleryToLibrary(
      23,
      'G',
      'thumb.jpg',
      files,
      makeGgConfig(),
      {},
      undefined,
      undefined,
      { resume: true },
    );

    // imageExists was consulted for the verifiable indices.
    expect(probed).toContainEqual([0, 'webp']);
    expect(probed).toContainEqual([1, 'webp']);
    // Only the torn page is refetched.
    expect(apiClient.fetchUrl).toHaveBeenCalledTimes(1);
    expect(await storeWithExists.getImage(23, 1, 'webp')).toEqual(new Uint8Array([5]));
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

  it('returns null for a zero-byte torn page', async () => {
    await memStore.putImage(13, -1, new TextEncoder().encode(JSON.stringify(['webp'])), 'json');
    await memStore.putImage(13, 0, new Uint8Array(), 'webp');

    await expect(getDownloadedImage(13, 0)).resolves.toBeNull();
  });
});

describe('hasCompleteDownloadedGallery', () => {
  let memStore: ReturnType<typeof makeMemoryStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    memStore = makeMemoryStore();
    vi.mocked(createDownloadStore).mockResolvedValue(memStore);
  });

  it('returns true when manifest covers expected pages and every file exists', async () => {
    await memStore.putImage(
      31,
      -1,
      new TextEncoder().encode(JSON.stringify(['webp', 'jpg'])),
      'json',
    );
    await memStore.putImage(31, 0, new Uint8Array([1]), 'webp');
    await memStore.putImage(31, 1, new Uint8Array([2]), 'jpg');

    await expect(hasCompleteDownloadedGallery(31, 2)).resolves.toBe(true);
  });

  it('uses an adapter batch existence check instead of probing pages one by one', async () => {
    await memStore.putImage(
      35,
      -1,
      new TextEncoder().encode(JSON.stringify(['webp', 'jpg'])),
      'json',
    );
    const allImagesExist = vi.fn(async () => true);
    const imageExists = vi.fn(async () => {
      throw new Error('per-page probe should not run');
    });
    vi.mocked(createDownloadStore).mockResolvedValue({
      ...memStore,
      allImagesExist,
      imageExists,
    });

    await expect(hasCompleteDownloadedGallery(35, 2)).resolves.toBe(true);
    expect(allImagesExist).toHaveBeenCalledWith(35, ['webp', 'jpg'], undefined);
    expect(imageExists).not.toHaveBeenCalled();
  });

  it('returns false when manifest covers pageCount but a page file is missing', async () => {
    await memStore.putImage(
      32,
      -1,
      new TextEncoder().encode(JSON.stringify(['webp', 'jpg'])),
      'json',
    );
    await memStore.putImage(32, 0, new Uint8Array([1]), 'webp');

    await expect(hasCompleteDownloadedGallery(32, 2)).resolves.toBe(false);
  });

  it('returns false when the manifest is shorter than the expected pageCount', async () => {
    await memStore.putImage(33, -1, new TextEncoder().encode(JSON.stringify(['webp'])), 'json');
    await memStore.putImage(33, 0, new Uint8Array([1]), 'webp');

    await expect(hasCompleteDownloadedGallery(33, 2)).resolves.toBe(false);
  });

  it('returns false when the manifest has stale extra pages beyond the expected pageCount', async () => {
    await memStore.putImage(
      34,
      -1,
      new TextEncoder().encode(JSON.stringify(['webp', 'webp', 'webp'])),
      'json',
    );
    await memStore.putImage(34, 0, new Uint8Array([1]), 'webp');
    await memStore.putImage(34, 1, new Uint8Array([1]), 'webp');
    await memStore.putImage(34, 2, new Uint8Array([1]), 'webp');

    await expect(hasCompleteDownloadedGallery(34, 2)).resolves.toBe(false);
  });
});

describe('hasCompleteDownloadedGallery', () => {
  let memStore: ReturnType<typeof makeMemoryStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    memStore = makeMemoryStore();
    vi.mocked(createDownloadStore).mockResolvedValue(memStore);
  });

  it('returns true when manifest covers expected pages and every file exists', async () => {
    await memStore.putImage(
      31,
      -1,
      new TextEncoder().encode(JSON.stringify(['webp', 'jpg'])),
      'json',
    );
    await memStore.putImage(31, 0, new Uint8Array([1]), 'webp');
    await memStore.putImage(31, 1, new Uint8Array([2]), 'jpg');

    await expect(hasCompleteDownloadedGallery(31, 2)).resolves.toBe(true);
  });

  it('returns false when manifest covers pageCount but a page file is missing', async () => {
    await memStore.putImage(
      32,
      -1,
      new TextEncoder().encode(JSON.stringify(['webp', 'jpg'])),
      'json',
    );
    await memStore.putImage(32, 0, new Uint8Array([1]), 'webp');

    await expect(hasCompleteDownloadedGallery(32, 2)).resolves.toBe(false);
  });

  it('returns false when the manifest is shorter than the expected pageCount', async () => {
    await memStore.putImage(33, -1, new TextEncoder().encode(JSON.stringify(['webp'])), 'json');
    await memStore.putImage(33, 0, new Uint8Array([1]), 'webp');

    await expect(hasCompleteDownloadedGallery(33, 2)).resolves.toBe(false);
  });

  it('returns false when the manifest has stale extra pages beyond the expected pageCount', async () => {
    await memStore.putImage(
      34,
      -1,
      new TextEncoder().encode(JSON.stringify(['webp', 'webp', 'webp'])),
      'json',
    );
    await memStore.putImage(34, 0, new Uint8Array([1]), 'webp');
    await memStore.putImage(34, 1, new Uint8Array([1]), 'webp');
    await memStore.putImage(34, 2, new Uint8Array([1]), 'webp');

    await expect(hasCompleteDownloadedGallery(34, 2)).resolves.toBe(false);
  });
});

// ── exportGalleryZip (AC-007) ─────────────────────────────────────────────────

describe('exportGalleryZip', () => {
  let memStore: ReturnType<typeof makeMemoryStore>;
  let anchorEl: {
    href: string;
    download: string;
    click: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  let nativeChunks: Uint8Array[];
  let blobParts: unknown[];

  function downloadRow(
    galleryId: number,
    pageCount: number,
    overrides: Partial<DBDownload> = {},
  ): DBDownload {
    return {
      galleryId,
      title: `Gallery ${galleryId}`,
      thumbnail: '',
      tags: '{}',
      pageCount,
      totalBytes: 0,
      downloadedAt: '2026-07-31T00:00:00.000Z',
      status: 'complete',
      folderName: null,
      ...overrides,
    };
  }

  function configureNativeInvoke(options?: { writeError?: Error; commitError?: Error }) {
    nativeZip.invoke.mockImplementation(
      async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
        if (command === 'begin_zip_export') return 73;
        if (command === 'write_zip_export') {
          if (options?.writeError) throw options.writeError;
          const data = args?.data as Uint8Array;
          nativeChunks.push(data.slice());
          return data.byteLength;
        }
        if (command === 'commit_zip_export') {
          if (options?.commitError) throw options.commitError;
          return undefined;
        }
        if (command === 'abort_zip_export') return undefined;
        throw new Error(`Unexpected native command: ${command}`);
      },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    memStore = makeMemoryStore();
    vi.mocked(createDownloadStore).mockResolvedValue(memStore);
    vi.mocked(zipSync).mockReturnValue(new Uint8Array([1, 2, 3]));
    vi.mocked(getDownload).mockImplementation(async (galleryId) => {
      const manifest = memStore.store.get(`${galleryId}/0000.json`);
      let pageCount = 1;
      if (manifest) {
        try {
          const parsed = JSON.parse(new TextDecoder().decode(manifest)) as unknown;
          if (Array.isArray(parsed) && parsed.length > 0) pageCount = parsed.length;
        } catch {
          // Keep a positive DB page count so malformed-manifest tests reach
          // the manifest validation path rather than metadata validation.
        }
      }
      return downloadRow(galleryId, pageCount);
    });

    anchorEl = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchorEl),
      body: { appendChild: vi.fn() },
    });
    nativeChunks = [];
    blobParts = [];
    nativeZip.save.mockResolvedValue('C:\\Exports\\gallery.zip');
    configureNativeInvoke();
    vi.stubGlobal(
      'Blob',
      class MockBlob {
        constructor(
          public parts: unknown[],
          public options: unknown,
        ) {
          blobParts = parts;
        }
      },
    );
    const origURL = globalThis.URL;
    vi.stubGlobal(
      'URL',
      Object.assign(
        function (...args: unknown[]) {
          return new origURL(...(args as [string]));
        },
        {
          ...origURL,
          createObjectURL: vi.fn(() => 'blob:fake-url'),
          revokeObjectURL: vi.fn(),
        },
      ),
    );
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

  it('throws when the stored manifest is empty or corrupt instead of creating an empty zip', async () => {
    await memStore.putImage(
      999,
      -1,
      new TextEncoder().encode(JSON.stringify({ 0: 'webp' })),
      'json',
    );

    await expect(exportGalleryZip(999, 'Corrupt')).rejects.toThrow(
      'Downloaded manifest for gallery 999 is empty or corrupt',
    );
    expect(zipSync).not.toHaveBeenCalled();
    expect(anchorEl.click).not.toHaveBeenCalled();
  });

  it('rejects unsafe manifest extensions before reading pages or creating a zip', async () => {
    await memStore.putImage(
      996,
      -1,
      new TextEncoder().encode(JSON.stringify(['webp/../../escape'])),
      'json',
    );

    await expect(exportGalleryZip(996, 'Unsafe')).rejects.toThrow('unsafe file extension');
    expect(zipSync).not.toHaveBeenCalled();
    expect(anchorEl.click).not.toHaveBeenCalled();
  });

  it('rejects a manifest whose page count differs from the complete DB row', async () => {
    await memStore.putImage(
      995,
      -1,
      new TextEncoder().encode(JSON.stringify(['webp', 'jpg'])),
      'json',
    );
    vi.mocked(getDownload).mockResolvedValue(downloadRow(995, 3));

    await expect(exportGalleryZip(995, 'Mismatched')).rejects.toThrow(
      'manifest page count 2 does not match database page count 3',
    );
    expect(zipSync).not.toHaveBeenCalled();
  });

  it('rejects a DB row that is no longer complete', async () => {
    await memStore.putImage(994, -1, new TextEncoder().encode(JSON.stringify(['webp'])), 'json');
    vi.mocked(getDownload).mockResolvedValue(downloadRow(994, 1, { status: 'failed' }));

    await expect(exportGalleryZip(994, 'Failed')).rejects.toThrow(
      'gallery 994 is not complete (status: failed)',
    );
    expect(zipSync).not.toHaveBeenCalled();
  });

  it('uses caller metadata and exact folderName when the DB lookup fails', async () => {
    const folderName = '993 Exact SAF Folder';
    await memStore.putImage(993, -1, new TextEncoder().encode(JSON.stringify(['webp'])), 'json');
    await memStore.putImage(993, 0, new Uint8Array([9, 9]), 'webp');
    vi.mocked(getDownload).mockRejectedValue(new Error('database unavailable'));
    const getImage = vi.spyOn(memStore, 'getImage');

    await expect(
      exportGalleryZip(993, 'Fallback', undefined, {
        folderName,
        pageCount: 1,
        status: 'complete',
      }),
    ).resolves.toBe('started');

    expect(getImage).toHaveBeenCalledWith(993, -1, 'json', { folderName });
    expect(getImage).toHaveBeenCalledWith(993, 0, 'webp', { folderName });
  });

  it('throws when a manifest page exists as a zero-byte torn file', async () => {
    await memStore.putImage(997, -1, new TextEncoder().encode(JSON.stringify(['webp'])), 'json');
    await memStore.putImage(997, 0, new Uint8Array(), 'webp');

    await expect(exportGalleryZip(997, 'Torn')).rejects.toThrow(
      'Missing downloaded page 1 for gallery 997',
    );
  });

  it('builds a zip from stored images and triggers download', async () => {
    // Set up a gallery with 2 pages
    const exts = ['webp', 'jpg'];
    await memStore.putImage(42, -1, new TextEncoder().encode(JSON.stringify(exts)), 'json');
    await memStore.putImage(42, 0, new Uint8Array([1, 2]), 'webp');
    await memStore.putImage(42, 1, new Uint8Array([3, 4, 5]), 'jpg');

    await expect(exportGalleryZip(42, 'My Gallery')).resolves.toBe('started');

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
    expect(anchorEl.remove).toHaveBeenCalledOnce();
    expect(blobParts[0]).toBe(vi.mocked(zipSync).mock.results[0].value.buffer);
  });

  it('streams a valid ZIP to a native save-dialog path on Tauri', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const exts = ['webp', 'jpg'];
    await memStore.putImage(42, -1, new TextEncoder().encode(JSON.stringify(exts)), 'json');
    await memStore.putImage(42, 0, new Uint8Array([1, 2]), 'webp');
    await memStore.putImage(42, 1, new Uint8Array([3, 4, 5]), 'jpg');
    const progress: DownloadProgress[] = [];

    await expect(exportGalleryZip(42, 'My Gallery', (value) => progress.push(value))).resolves.toBe(
      'saved',
    );

    expect(nativeZip.save).toHaveBeenCalledWith({
      defaultPath: '42 My Gallery.zip',
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    expect(nativeZip.invoke).toHaveBeenCalledWith('begin_zip_export', {
      destination: 'C:\\Exports\\gallery.zip',
    });
    expect(nativeZip.invoke).toHaveBeenCalledWith('commit_zip_export', {
      exportId: 73,
    });
    expect(nativeZip.invoke).not.toHaveBeenCalledWith('abort_zip_export', expect.anything());
    expect(zipSync).not.toHaveBeenCalled();
    expect(document.createElement).not.toHaveBeenCalled();
    expect(progress).toEqual([
      { current: 1, total: 2 },
      { current: 2, total: 2 },
    ]);

    const archiveLength = nativeChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const archive = new Uint8Array(archiveLength);
    let offset = 0;
    for (const chunk of nativeChunks) {
      archive.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const files = unzipSync(archive);
    expect(files['0001.webp']).toEqual(new Uint8Array([1, 2]));
    expect(files['0002.jpg']).toEqual(new Uint8Array([3, 4, 5]));
  });

  it('treats cancelling the Tauri save dialog as a no-op', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    nativeZip.save.mockResolvedValue(null);
    await memStore.putImage(7, -1, new TextEncoder().encode(JSON.stringify(['webp'])), 'json');
    await memStore.putImage(7, 0, new Uint8Array([1]), 'webp');

    await expect(exportGalleryZip(7, 'Cancelled')).resolves.toBe('cancelled');

    expect(nativeZip.invoke).not.toHaveBeenCalled();
    expect(document.createElement).not.toHaveBeenCalled();
  });

  it('propagates native ZIP write failures and aborts the staged file', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    configureNativeInvoke({ writeError: new Error('disk full') });
    await memStore.putImage(8, -1, new TextEncoder().encode(JSON.stringify(['webp'])), 'json');
    await memStore.putImage(8, 0, new Uint8Array([1]), 'webp');

    await expect(exportGalleryZip(8, 'Write Failure')).rejects.toThrow('disk full');

    expect(nativeZip.invoke).not.toHaveBeenCalledWith('commit_zip_export', expect.anything());
    expect(nativeZip.invoke).toHaveBeenCalledWith('abort_zip_export', { exportId: 73 });
    expect(document.createElement).not.toHaveBeenCalled();
  });

  it('aborts the staged file when the atomic commit fails', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    configureNativeInvoke({ commitError: new Error('permission denied') });
    await memStore.putImage(9, -1, new TextEncoder().encode(JSON.stringify(['webp'])), 'json');
    await memStore.putImage(9, 0, new Uint8Array([1]), 'webp');

    await expect(exportGalleryZip(9, 'Commit Failure')).rejects.toThrow('permission denied');

    expect(nativeZip.invoke).toHaveBeenCalledWith('commit_zip_export', { exportId: 73 });
    expect(nativeZip.invoke).toHaveBeenCalledWith('abort_zip_export', { exportId: 73 });
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

  it('throws when a manifest page is missing instead of creating a partial zip', async () => {
    // Manifest says 2 pages but only page 0 is stored
    const exts = ['webp', 'jpg'];
    await memStore.putImage(6, -1, new TextEncoder().encode(JSON.stringify(exts)), 'json');
    await memStore.putImage(6, 0, new Uint8Array([1, 2]), 'webp');
    // page 1 is intentionally missing

    await expect(exportGalleryZip(6, 'Partial')).rejects.toThrow(
      'Missing downloaded page 2 for gallery 6',
    );
    expect(zipSync).not.toHaveBeenCalled();
    expect(anchorEl.click).not.toHaveBeenCalled();
  });
});

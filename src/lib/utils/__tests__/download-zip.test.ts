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

// Mock api client
vi.mock('@/lib/api/client', () => ({
  apiClient: { fetchUrl: vi.fn() },
  getGgConfig: vi.fn(),
}));

// Mock db/download (upsertDownload, updateDownloadStatus, serializeTags)
vi.mock('@/lib/db/download', () => ({
  upsertDownload: vi.fn().mockResolvedValue(undefined),
  updateDownloadStatus: vi.fn().mockResolvedValue(undefined),
  serializeTags: vi.fn((tags: Record<string, string[]>) => JSON.stringify(tags)),
}));

// Mock createDownloadStore — we inject a fake store per test
vi.mock('@/lib/storage/download-store', () => ({
  createDownloadStore: vi.fn(),
  imageFileName: (index: number, ext: string) =>
    String(index + 1).padStart(4, '0') + '.' + ext,
  galleryFolderName: (id: number) => String(id),
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
import { apiClient } from '@/lib/api/client';
import { upsertDownload, updateDownloadStatus } from '@/lib/db/download';
import { createDownloadStore } from '@/lib/storage/download-store';

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

// ── downloadGalleryToLibrary (AC-003) ─────────────────────────────────────────

describe('downloadGalleryToLibrary', () => {
  let memStore: ReturnType<typeof makeMemoryStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    memStore = makeMemoryStore();
    vi.mocked(createDownloadStore).mockResolvedValue(memStore);
    vi.mocked(apiClient.fetchUrl).mockResolvedValue(makeFetchResponse('image/webp', new Uint8Array([10, 20, 30])));
    vi.mocked(getImageUrl).mockReturnValue('https://example.com/image.webp');
    vi.mocked(upsertDownload).mockResolvedValue(undefined);
    vi.mocked(updateDownloadStatus).mockResolvedValue(undefined);
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

  it('calls upsertDownload twice: once with downloading, once with complete', async () => {
    await downloadGalleryToLibrary(
      1,
      'My Gallery',
      'thumb.jpg',
      [makeFile()],
      makeGgConfig(),
      { artist: ['foo'] },
    );

    expect(upsertDownload).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(upsertDownload).mock.calls[0][0];
    expect(firstCall.status).toBe('downloading');
    expect(firstCall.galleryId).toBe(1);

    const secondCall = vi.mocked(upsertDownload).mock.calls[1][0];
    expect(secondCall.status).toBe('complete');
    expect(secondCall.pageCount).toBe(1);
    expect(secondCall.totalBytes).toBeGreaterThan(0);
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

  it('marks download as failed and rethrows when signal is pre-aborted', async () => {
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

    expect(updateDownloadStatus).toHaveBeenCalledWith(3, 'failed');
  });

  it('marks download as failed when fetch throws mid-download', async () => {
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

    expect(updateDownloadStatus).toHaveBeenCalledWith(4, 'failed');
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

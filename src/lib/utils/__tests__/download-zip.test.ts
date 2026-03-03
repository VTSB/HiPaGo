// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GalleryFile, GgConfig } from '../types';

// Mock fflate before importing the module under test
vi.mock('fflate', () => ({
  zipSync: vi.fn(() => new Uint8Array([1, 2, 3])),
  strToU8: vi.fn((s: string) => new TextEncoder().encode(s)),
}));

// Mock image-url module
vi.mock('../image-url', () => ({
  getImageUrl: vi.fn(() => 'https://example.com/image.webp'),
}));

import { downloadGalleryAsZip } from '../download-zip';
import { zipSync } from 'fflate';
import { getImageUrl } from '../image-url';

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

function makeFetchResponse(contentType: string | null, bytes = new Uint8Array([0xff, 0xfe])): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h === 'content-type' ? contentType : null) } as unknown as Headers,
    arrayBuffer: () => Promise.resolve(bytes.buffer as ArrayBuffer),
  } as unknown as Response;
}

describe('downloadGalleryAsZip', () => {
  let anchorEl: { href: string; download: string; click: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    anchorEl = { href: '', download: '', click: vi.fn() };

    // Stub DOM globals for node environment
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchorEl),
    });
    vi.stubGlobal('Blob', class MockBlob {
      constructor(public parts: any[], public options: any) {}
    });
    // URL.createObjectURL / revokeObjectURL
    const origURL = globalThis.URL;
    vi.stubGlobal('URL', Object.assign(
      function (...args: any[]) { return new origURL(...args as [string]); },
      {
        ...origURL,
        createObjectURL: vi.fn(() => 'blob:fake-url'),
        revokeObjectURL: vi.fn(),
      },
    ));

    vi.mocked(getImageUrl).mockReturnValue('https://example.com/image.webp');
    vi.mocked(zipSync).mockReturnValue(new Uint8Array([1, 2, 3]));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse('image/webp')));
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
      vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
        controller.abort();
        return Promise.resolve(makeFetchResponse('image/webp'));
      }));
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
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(ct)));
      await downloadGalleryAsZip(1, 'Title', [makeFile('page.jpg', 1)], makeGgConfig());
      const zipEntries = vi.mocked(zipSync).mock.calls[0][0] as Record<string, Uint8Array>;
      const entryNames = Object.keys(zipEntries);
      expect(entryNames).toHaveLength(1);
      expect(entryNames[0]).toMatch(new RegExp(`\\${expectedExt}$`));
    });
  });

  describe('fallback extension', () => {
    it('uses file.name extension when haswebp=0 and content-type is unrecognized', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse('application/octet-stream')));
      await downloadGalleryAsZip(1, 'Title', [makeFile('artwork.png', 0)], makeGgConfig());
      const zipEntries = vi.mocked(zipSync).mock.calls[0][0] as Record<string, Uint8Array>;
      expect(Object.keys(zipEntries)[0]).toMatch(/\.png$/);
    });

    it('defaults to webp when haswebp=1 and content-type is unrecognized', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse('application/octet-stream')));
      await downloadGalleryAsZip(1, 'Title', [makeFile('img.jpg', 1)], makeGgConfig());
      const zipEntries = vi.mocked(zipSync).mock.calls[0][0] as Record<string, Uint8Array>;
      expect(Object.keys(zipEntries)[0]).toMatch(/\.webp$/);
    });

    it('uses file.name extension when content-type is null and haswebp=0 (covers line 39 null branch + line 45)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(null)));
      await downloadGalleryAsZip(1, 'Title', [makeFile('page.gif', 0)], makeGgConfig());
      const zipEntries = vi.mocked(zipSync).mock.calls[0][0] as Record<string, Uint8Array>;
      expect(Object.keys(zipEntries)[0]).toMatch(/\.gif$/);
    });

    it('stays webp when content-type is null and haswebp=1 (covers line 39 null branch, skips line 45)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(null)));
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
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: { get: () => null },
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      } as unknown as Response));
      await expect(
        downloadGalleryAsZip(1, 'T', [makeFile()], makeGgConfig()),
      ).rejects.toThrow('HTTP 404');
    });
  });
});

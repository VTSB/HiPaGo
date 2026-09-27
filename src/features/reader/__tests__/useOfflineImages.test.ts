// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { DBDownload } from '@/lib/db/schema';

const mockGetDownload = vi.fn();
const mockGetDownloadedGalleryPages = vi.fn();
const mockGetDownloadedImage = vi.fn();
const mockHasCompleteDownloadedGallery = vi.fn();
const mockCreateDownloadStore = vi.fn();
const mockGetImage = vi.fn();
const mockFetchGalleryImagesCached = vi.fn();
const mockGetGgConfig = vi.fn();

vi.mock('@/lib/api/gallery', () => ({
  fetchGalleryImagesCached: (...args: unknown[]) => mockFetchGalleryImagesCached(...args),
}));
vi.mock('@/lib/api/client', () => ({ getGgConfig: () => mockGetGgConfig() }));
vi.mock('@/lib/utils/image-url', () => ({
  galleryImageToFile: (image: unknown) => image,
  getBestImageUrl: (image: { name: string }) => `https://cdn.example/${image.name}`,
}));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: () => ({ imageFormat: 'webp' }) },
}));

vi.mock('@/lib/db/download', () => ({
  getDownload: (galleryId: number) => mockGetDownload(galleryId),
}));

vi.mock('@/lib/storage/download-store', () => ({
  createDownloadStore: () => mockCreateDownloadStore(),
}));

vi.mock('@/lib/utils/download-zip', () => ({
  getDownloadedGalleryPages: (...args: unknown[]) => mockGetDownloadedGalleryPages(...args),
  getDownloadedImage: (...args: unknown[]) => mockGetDownloadedImage(...args),
  hasCompleteDownloadedGallery: (galleryId: number, expectedPageCount: number) =>
    mockHasCompleteDownloadedGallery(galleryId, expectedPageCount),
}));

const createdUrls: string[] = [];
const revokedUrls: string[] = [];

let urlCounter = 0;
const mockCreateObjectURL = vi.fn(() => {
  const url = `blob:mock-url-${++urlCounter}`;
  createdUrls.push(url);
  return url;
});
const mockRevokeObjectURL = vi.fn((url: string) => {
  revokedUrls.push(url);
});

import { useOfflineImages } from '../hooks/useOfflineImages';

function makeRow(status: DBDownload['status'], galleryId = 42, pageCount = 3): DBDownload {
  return {
    galleryId,
    title: 'Test Gallery',
    thumbnail: '',
    tags: '{}',
    pageCount,
    totalBytes: 1000,
    downloadedAt: new Date().toISOString(),
    status,
  };
}

async function flushHook() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  createdUrls.length = 0;
  revokedUrls.length = 0;
  urlCounter = 0;
  mockCreateDownloadStore.mockResolvedValue({ getImage: mockGetImage });
  mockFetchGalleryImagesCached.mockResolvedValue({
    id: 42, images: [{ name: '0.webp', hash: 'zero' }, { name: '1.webp', hash: 'one' }],
  });
  mockGetGgConfig.mockResolvedValue({});
  mockHasCompleteDownloadedGallery.mockResolvedValue(true);
  vi.stubGlobal('URL', {
    createObjectURL: mockCreateObjectURL,
    revokeObjectURL: mockRevokeObjectURL,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useOfflineImages - gallery not downloaded', () => {
  it('returns empty offline state when getDownload returns null', async () => {
    mockGetDownload.mockResolvedValue(null);

    const { result } = renderHook(() => useOfflineImages(42));
    expect(result.current.loading).toBe(true);

    await flushHook();

    expect(result.current.sources).toBeNull();
    expect(result.current.urls).toBeNull();
    expect(result.current.missing).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(mockCreateObjectURL).not.toHaveBeenCalled();
  });

  it.each(['downloading', 'failed'] as const)(
    'ignores non-complete status "%s"',
    async (status) => {
      mockGetDownload.mockResolvedValue(makeRow(status));

      const { result } = renderHook(() => useOfflineImages(42));
      await flushHook();

      expect(result.current.sources).toBeNull();
      expect(result.current.urls).toBeNull();
      expect(result.current.missing).toBe(false);
      expect(result.current.loading).toBe(false);
      expect(mockGetDownloadedGalleryPages).not.toHaveBeenCalled();
    },
  );
});

describe('useOfflineImages - completed gallery', () => {
  it('returns lazy page loaders without reading image bytes up front', async () => {
    mockGetDownload.mockResolvedValue(makeRow('complete'));
    mockGetDownloadedGalleryPages.mockResolvedValue([
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
      { index: 2, ext: 'jpg' },
    ]);
    mockGetImage.mockImplementation((_gid: number, index: number) =>
      Promise.resolve(new Uint8Array([index, index + 1])),
    );

    const { result } = renderHook(() => useOfflineImages(42));
    await flushHook();

    expect(result.current.loading).toBe(false);
    expect(result.current.missing).toBe(false);
    expect(result.current.urls).toBeNull();
    expect(result.current.sources).toHaveLength(3);
    expect(mockGetDownloadedImage).not.toHaveBeenCalled();
    expect(mockGetImage).not.toHaveBeenCalled();
    expect(mockHasCompleteDownloadedGallery).not.toHaveBeenCalled();
    expect(mockFetchGalleryImagesCached).not.toHaveBeenCalled();
    expect(mockGetGgConfig).not.toHaveBeenCalled();
    expect(mockCreateObjectURL).not.toHaveBeenCalled();

    let url: string | null = null;
    await act(async () => {
      url = await result.current.sources![0].loadUrl!();
    });

    expect(url).toBe('blob:mock-url-1');
    expect(mockGetImage).toHaveBeenCalledTimes(1);
    expect(mockGetImage).toHaveBeenCalledWith(42, 0, 'webp', undefined);
    expect(mockGetDownloadedGalleryPages).toHaveBeenCalledTimes(1);
    expect(mockFetchGalleryImagesCached).not.toHaveBeenCalled();
    expect(mockGetGgConfig).not.toHaveBeenCalled();
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
  });

  it('uses lazy native file URL loaders when the store exposes imageUrl', async () => {
    const imageUrl = vi.fn(
      async (galleryId: number, index: number, ext: string) =>
        `file://${galleryId}/${index}.${ext}`,
    );
    mockCreateDownloadStore.mockResolvedValue({ imageUrl });
    mockGetDownload.mockResolvedValue({ ...makeRow('complete', 7, 2), folderName: '7-exact-folder' });
    mockGetDownloadedGalleryPages.mockResolvedValue([
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'jpg' },
    ]);

    const { result } = renderHook(() => useOfflineImages(7));
    await flushHook();

    expect(result.current.sources).toHaveLength(2);
    expect(result.current.urls).toBeNull();
    expect(imageUrl).not.toHaveBeenCalled();

    let url: string | null = null;
    await act(async () => {
      url = await result.current.sources![1].loadUrl!();
    });

    expect(url).toBe('file://7/1.jpg');
    expect(imageUrl).toHaveBeenCalledTimes(1);
    expect(imageUrl).toHaveBeenCalledWith(7, 1, 'jpg', { folderName: '7-exact-folder' });
    expect(mockGetDownloadedGalleryPages).toHaveBeenCalledWith(7, { folderName: '7-exact-folder' });
    expect(mockGetDownloadedImage).not.toHaveBeenCalled();
    expect(mockCreateObjectURL).not.toHaveBeenCalled();
  });

  it('falls back to lazy loaders when store creation fails', async () => {
    mockCreateDownloadStore.mockRejectedValue(new Error('storage unavailable'));
    mockGetDownload.mockResolvedValue(makeRow('complete', 42, 1));
    mockGetDownloadedGalleryPages.mockResolvedValue([{ index: 0, ext: 'webp' }]);

    const { result } = renderHook(() => useOfflineImages(42));
    await flushHook();

    expect(result.current.sources).toHaveLength(1);
    expect(result.current.sources![0].loadUrl).toEqual(expect.any(Function));
    expect(result.current.urls).toBeNull();
    expect(result.current.missing).toBe(false);
  });
});

describe('useOfflineImages - missing stored files', () => {
  it('returns missing:true when status is complete but manifest is empty', async () => {
    mockGetDownload.mockResolvedValue(makeRow('complete'));
    mockGetDownloadedGalleryPages.mockResolvedValue([]);
    mockHasCompleteDownloadedGallery.mockResolvedValue(false);

    const { result } = renderHook(() => useOfflineImages(42));
    await flushHook();

    expect(result.current.sources).toBeNull();
    expect(result.current.urls).toBeNull();
    expect(result.current.missing).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it('returns missing:true when the manifest is shorter than the completed row pageCount', async () => {
    mockGetDownload.mockResolvedValue(makeRow('complete'));
    mockGetDownloadedGalleryPages.mockResolvedValue([
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
    ]);
    mockHasCompleteDownloadedGallery.mockResolvedValue(false);

    const { result } = renderHook(() => useOfflineImages(42));
    await flushHook();

    expect(result.current.sources).toBeNull();
    expect(result.current.urls).toBeNull();
    expect(result.current.missing).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it('keeps valid pages available without scanning every file for missing pages', async () => {
    mockGetDownload.mockResolvedValue(makeRow('complete', 42, 2));
    mockGetDownloadedGalleryPages.mockResolvedValue([
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
    ]);
    mockHasCompleteDownloadedGallery.mockResolvedValue(false);

    const { result } = renderHook(() => useOfflineImages(42));
    await flushHook();

    expect(mockHasCompleteDownloadedGallery).not.toHaveBeenCalled();
    expect(mockGetImage).not.toHaveBeenCalled();
    expect(result.current.sources).toHaveLength(2);
    expect(result.current.urls).toBeNull();
    expect(result.current.missing).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('lets a lazy native URL loader report null for a missing page', async () => {
    mockCreateDownloadStore.mockResolvedValue({
      imageUrl: vi.fn(async (_galleryId: number, index: number) =>
        index === 0 ? 'file://0.webp' : null,
      ),
    });
    mockGetDownload.mockResolvedValue(makeRow('complete', 42, 2));
    mockGetDownloadedGalleryPages.mockResolvedValue([
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
    ]);

    const { result } = renderHook(() => useOfflineImages(42));
    await flushHook();

    expect(result.current.sources).toHaveLength(2);
    expect(result.current.urls).toBeNull();
    expect(result.current.missing).toBe(false);

    let url: string | null = 'not-null';
    await act(async () => {
      url = await result.current.sources![1].loadUrl!();
    });

    expect(url).toBeNull();
  });

  it('lets a lazy page loader report null for a missing page', async () => {
    mockGetDownload.mockResolvedValue(makeRow('complete', 55, 2));
    mockGetDownloadedGalleryPages.mockResolvedValue([
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
    ]);
    mockGetImage.mockResolvedValueOnce(null);

    const { result } = renderHook(() => useOfflineImages(55));
    await flushHook();

    expect(result.current.sources).toHaveLength(2);
    expect(result.current.missing).toBe(false);

    let url: string | null = 'not-null';
    await act(async () => {
      url = await result.current.sources![0].loadUrl!();
    });

    expect(url).toBeNull();
    expect(mockCreateObjectURL).not.toHaveBeenCalled();
  });
});

describe('useOfflineImages - page network recovery', () => {
  it('loads shared metadata/config only when a missing page requests recovery', async () => {
    mockGetDownload.mockResolvedValue(makeRow('complete', 42, 2));
    mockGetDownloadedGalleryPages.mockResolvedValue([
      { index: 0, ext: 'webp' }, { index: 1, ext: 'webp' },
    ]);
    const imageUrl = vi.fn(async () => 'content://saved/page');
    mockCreateDownloadStore.mockResolvedValue({ imageUrl });
    const { result } = renderHook(() => useOfflineImages(42));
    await flushHook();

    await expect(result.current.sources![0].loadUrl!()).resolves.toBe('content://saved/page');
    expect(mockFetchGalleryImagesCached).not.toHaveBeenCalled();
    expect(mockGetGgConfig).not.toHaveBeenCalled();
    await expect(Promise.all(result.current.sources!.map((source) => source.loadFallbackUrl!())))
      .resolves.toEqual(['https://cdn.example/0.webp', 'https://cdn.example/1.webp']);
    expect(mockFetchGalleryImagesCached).toHaveBeenCalledTimes(1);
    expect(mockFetchGalleryImagesCached).toHaveBeenCalledWith(42);
    expect(mockGetGgConfig).toHaveBeenCalledTimes(1);
    expect(imageUrl).toHaveBeenCalledTimes(1);
  });

  it('allows a later missing page to retry after connectivity returns', async () => {
    mockGetDownload.mockResolvedValue(makeRow('complete', 42, 2));
    mockGetDownloadedGalleryPages.mockResolvedValue([
      { index: 0, ext: 'webp' }, { index: 1, ext: 'webp' },
    ]);
    mockFetchGalleryImagesCached.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useOfflineImages(42));
    await flushHook();

    await expect(result.current.sources![0].loadFallbackUrl!()).resolves.toBeNull();
    await expect(result.current.sources![1].loadFallbackUrl!()).resolves.toBe('https://cdn.example/1.webp');
    expect(mockFetchGalleryImagesCached).toHaveBeenCalledTimes(2);
  });
});

describe('useOfflineImages - DB error degrades gracefully', () => {
  it('returns empty offline state when getDownload throws', async () => {
    mockGetDownload.mockRejectedValue(new Error('DB not initialised'));

    const { result } = renderHook(() => useOfflineImages(42));
    await flushHook();

    expect(result.current.sources).toBeNull();
    expect(result.current.urls).toBeNull();
    expect(result.current.missing).toBe(false);
    expect(result.current.loading).toBe(false);
  });
});

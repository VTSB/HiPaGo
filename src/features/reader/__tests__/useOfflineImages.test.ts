// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { DBDownload } from '@/lib/db/schema';

const mockGetDownload = vi.fn();
const mockGetDownloadedGalleryPages = vi.fn();
const mockGetDownloadedImage = vi.fn();
const mockHasCompleteDownloadedGallery = vi.fn();
const mockCreateDownloadStore = vi.fn();
const mockStoreGetImage = vi.fn();

vi.mock('@/lib/db/download', () => ({
  getDownload: (galleryId: number) => mockGetDownload(galleryId),
}));

vi.mock('@/lib/storage/download-store', () => ({
  createDownloadStore: () => mockCreateDownloadStore(),
}));

vi.mock('@/lib/utils/download-zip', () => ({
  getDownloadedGalleryPages: (galleryId: number, options?: unknown) =>
    mockGetDownloadedGalleryPages(galleryId, options),
  getDownloadedImage: (galleryId: number, index: number, options?: unknown) =>
    mockGetDownloadedImage(galleryId, index, options),
  hasCompleteDownloadedGallery: (galleryId: number, expectedPageCount: number, options?: unknown) =>
    mockHasCompleteDownloadedGallery(galleryId, expectedPageCount, options),
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
  mockStoreGetImage.mockImplementation((_galleryId: number, index: number) =>
    Promise.resolve(new Uint8Array([index, index + 1])),
  );
  mockCreateDownloadStore.mockResolvedValue({ getImage: mockStoreGetImage });
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
    mockGetDownloadedImage.mockImplementation((_gid: number, index: number) =>
      Promise.resolve(new Uint8Array([index, index + 1])),
    );

    const { result } = renderHook(() => useOfflineImages(42));
    await flushHook();

    expect(result.current.loading).toBe(false);
    expect(result.current.missing).toBe(false);
    expect(result.current.urls).toBeNull();
    expect(result.current.sources).toHaveLength(3);
    expect(mockGetDownloadedImage).not.toHaveBeenCalled();
    expect(mockCreateObjectURL).not.toHaveBeenCalled();

    let url: string | null = null;
    await act(async () => {
      url = await result.current.sources![0].loadUrl!();
    });

    expect(url).toBe('blob:mock-url-1');
    expect(mockGetDownloadedImage).toHaveBeenCalledTimes(1);
    expect(mockGetDownloadedImage).toHaveBeenCalledWith(42, 0, undefined);
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
  });

  it('uses lazy native file URL loaders when the store exposes imageUrl', async () => {
    const imageUrl = vi.fn(
      async (galleryId: number, index: number, ext: string) =>
        `file://${galleryId}/${index}.${ext}`,
    );
    mockCreateDownloadStore.mockResolvedValue({ imageUrl });
    mockGetDownload.mockResolvedValue(makeRow('complete', 7, 2));
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
    expect(imageUrl).toHaveBeenCalledWith(7, 1, 'jpg');
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

  it('returns missing:true when manifest covers pageCount but an image file is missing', async () => {
    mockGetDownload.mockResolvedValue(makeRow('complete', 42, 2));
    mockGetDownloadedGalleryPages.mockResolvedValue([
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
    ]);
    mockHasCompleteDownloadedGallery.mockResolvedValue(false);

    const { result } = renderHook(() => useOfflineImages(42));
    await flushHook();

    expect(mockHasCompleteDownloadedGallery).toHaveBeenCalledWith(42, 2, { folderName: null });
    expect(result.current.sources).toBeNull();
    expect(result.current.urls).toBeNull();
    expect(result.current.missing).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(mockHasCompleteDownloadedGallery).toHaveBeenCalledWith(42, 2, {
      folderName: null,
    });
  });

  it('returns missing:true when manifest covers pageCount but a page file is absent', async () => {
    mockGetDownload.mockResolvedValue(makeRow('complete', 42, 2));
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
    mockGetDownloadedImage.mockResolvedValueOnce(null);

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

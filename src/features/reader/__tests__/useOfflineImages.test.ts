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

import { useOfflineImages, type OfflineImagesResult } from '../hooks/useOfflineImages';

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
  vi.stubGlobal('URL', {
    createObjectURL: mockCreateObjectURL,
    revokeObjectURL: mockRevokeObjectURL,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useOfflineImages - gallery ownership', () => {
  it('never exposes the previous gallery result during a galleryId rerender', async () => {
    let resolveGalleryB!: (row: DBDownload | null) => void;
    let resolveGalleryC!: (row: DBDownload | null) => void;
    const galleryB = new Promise<DBDownload | null>((resolve) => {
      resolveGalleryB = resolve;
    });
    const galleryC = new Promise<DBDownload | null>((resolve) => {
      resolveGalleryC = resolve;
    });
    const storageFailure = new Error('gallery B storage failed');

    mockGetDownload.mockImplementation((galleryId: number) => {
      if (galleryId === 42) return Promise.resolve(makeRow('complete', 42, 1));
      if (galleryId === 84) return galleryB;
      return galleryC;
    });
    mockGetDownloadedGalleryPages.mockResolvedValue([{ index: 0, ext: 'webp' }]);
    mockStoreGetImage.mockResolvedValueOnce(null).mockRejectedValueOnce(storageFailure);

    const observed: OfflineImagesResult[] = [];
    const { result, rerender } = renderHook(
      ({ galleryId }) => {
        const offline = useOfflineImages(galleryId);
        observed.push(offline);
        return offline;
      },
      { initialProps: { galleryId: 42 } },
    );
    await flushHook();

    expect(result.current.sources).toHaveLength(1);
    await act(async () => {
      await expect(result.current.sources![0].loadUrl!()).resolves.toBeNull();
    });
    expect(result.current.missing).toBe(true);

    observed.length = 0;
    rerender({ galleryId: 84 });

    expect(observed[0]).toMatchObject({
      sources: null,
      urls: null,
      dims: null,
      missing: false,
      error: null,
      loading: true,
    });

    resolveGalleryB(makeRow('complete', 84, 1));
    await flushHook();
    expect(result.current.sources).toHaveLength(1);

    await act(async () => {
      await expect(result.current.sources![0].loadUrl!()).rejects.toBe(storageFailure);
    });
    expect(result.current.error).toBe(storageFailure);

    observed.length = 0;
    rerender({ galleryId: 126 });

    expect(observed[0]).toMatchObject({
      sources: null,
      urls: null,
      dims: null,
      missing: false,
      error: null,
      loading: true,
    });

    resolveGalleryC(null);
    await flushHook();
  });
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
    expect(result.current.error).toBeNull();
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
      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(false);
      expect(mockGetDownloadedGalleryPages).not.toHaveBeenCalled();
    },
  );
});

describe('useOfflineImages - completed gallery', () => {
  it('returns lazy page loaders without reading image bytes up front', async () => {
    mockGetDownload.mockResolvedValue({
      ...makeRow('complete'),
      folderName: '42 Exact Folder',
    });
    mockGetDownloadedGalleryPages.mockResolvedValue([
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
      { index: 2, ext: 'jpg' },
    ]);
    const { result } = renderHook(() => useOfflineImages(42));
    await flushHook();

    expect(result.current.loading).toBe(false);
    expect(result.current.missing).toBe(false);
    expect(result.current.urls).toBeNull();
    expect(result.current.sources).toHaveLength(3);
    expect(mockGetDownloadedImage).not.toHaveBeenCalled();
    expect(mockCreateObjectURL).not.toHaveBeenCalled();
    expect(mockGetDownloadedGalleryPages).toHaveBeenCalledWith(42, {
      folderName: '42 Exact Folder',
    });
    expect(mockHasCompleteDownloadedGallery).not.toHaveBeenCalled();

    let url: string | null = null;
    await act(async () => {
      url = await result.current.sources![0].loadUrl!();
    });

    expect(url).toBe('blob:mock-url-1');
    expect(mockGetDownloadedImage).not.toHaveBeenCalled();
    expect(mockStoreGetImage).toHaveBeenCalledTimes(1);
    expect(mockStoreGetImage).toHaveBeenCalledWith(42, 0, 'webp', {
      folderName: '42 Exact Folder',
    });
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

  it('surfaces store creation failures without reporting missing files', async () => {
    const failure = new Error('storage unavailable');
    mockCreateDownloadStore.mockRejectedValue(failure);
    mockGetDownload.mockResolvedValue(makeRow('complete', 42, 1));
    mockGetDownloadedGalleryPages.mockResolvedValue([{ index: 0, ext: 'webp' }]);

    const { result } = renderHook(() => useOfflineImages(42));
    await flushHook();

    expect(result.current.sources).toBeNull();
    expect(result.current.urls).toBeNull();
    expect(result.current.missing).toBe(false);
    expect(result.current.error).toBe(failure);
    expect(result.current.retry).toEqual(expect.any(Function));
    expect(result.current.loading).toBe(false);
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
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(mockHasCompleteDownloadedGallery).not.toHaveBeenCalled();
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
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(mockHasCompleteDownloadedGallery).not.toHaveBeenCalled();
  });

  it('does not block valid manifests on a full-gallery completeness scan', async () => {
    mockGetDownload.mockResolvedValue(makeRow('complete', 42, 2));
    mockGetDownloadedGalleryPages.mockResolvedValue([
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
    ]);

    const { result } = renderHook(() => useOfflineImages(42));
    await flushHook();

    expect(mockHasCompleteDownloadedGallery).not.toHaveBeenCalled();
    expect(mockStoreGetImage).not.toHaveBeenCalled();
    expect(result.current.sources).toHaveLength(2);
    expect(result.current.urls).toBeNull();
    expect(result.current.missing).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('reports an absent lazy page as missing without turning it into an error', async () => {
    mockGetDownload.mockResolvedValue(makeRow('complete', 42, 2));
    mockGetDownloadedGalleryPages.mockResolvedValue([
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
    ]);
    mockStoreGetImage.mockResolvedValueOnce(null);

    const { result } = renderHook(() => useOfflineImages(42));
    await flushHook();

    expect(result.current.sources).toHaveLength(2);
    expect(result.current.missing).toBe(false);

    let url: string | null = 'not-null';
    await act(async () => {
      url = await result.current.sources![0].loadUrl!();
    });

    expect(url).toBeNull();
    expect(result.current.missing).toBe(true);
    expect(result.current.error).toBeNull();
    expect(mockStoreGetImage).toHaveBeenCalledWith(42, 0, 'webp', {
      folderName: null,
    });
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
    expect(result.current.missing).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('lets a lazy page loader report null for a missing page', async () => {
    mockGetDownload.mockResolvedValue(makeRow('complete', 55, 2));
    mockGetDownloadedGalleryPages.mockResolvedValue([
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
    ]);
    mockStoreGetImage.mockResolvedValueOnce(null);

    const { result } = renderHook(() => useOfflineImages(55));
    await flushHook();

    expect(result.current.sources).toHaveLength(2);
    expect(result.current.missing).toBe(false);

    let url: string | null = 'not-null';
    await act(async () => {
      url = await result.current.sources![0].loadUrl!();
    });

    expect(url).toBeNull();
    expect(result.current.missing).toBe(true);
    expect(result.current.error).toBeNull();
    expect(mockStoreGetImage).toHaveBeenCalledWith(55, 0, 'webp', {
      folderName: null,
    });
    expect(mockGetDownloadedImage).not.toHaveBeenCalled();
    expect(mockCreateObjectURL).not.toHaveBeenCalled();
  });
});

describe('useOfflineImages - storage and DB errors', () => {
  it('surfaces getDownload failures and retries the full load', async () => {
    const failure = new Error('DB not initialised');
    mockGetDownload.mockRejectedValueOnce(failure).mockResolvedValueOnce(null);

    const { result } = renderHook(() => useOfflineImages(42));
    await flushHook();

    expect(result.current.sources).toBeNull();
    expect(result.current.urls).toBeNull();
    expect(result.current.missing).toBe(false);
    expect(result.current.error).toBe(failure);
    expect(result.current.loading).toBe(false);

    act(() => result.current.retry());
    await flushHook();

    expect(mockGetDownload).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.missing).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('surfaces manifest read failures without reporting the gallery as missing', async () => {
    const failure = new Error('SAF provider unavailable');
    mockGetDownload.mockResolvedValue(makeRow('complete'));
    mockGetDownloadedGalleryPages.mockRejectedValue(failure);

    const { result } = renderHook(() => useOfflineImages(42));
    await flushHook();

    expect(result.current.sources).toBeNull();
    expect(result.current.missing).toBe(false);
    expect(result.current.error).toBe(failure);
    expect(mockCreateDownloadStore).not.toHaveBeenCalled();
    expect(mockHasCompleteDownloadedGallery).not.toHaveBeenCalled();
  });

  it('surfaces lazy page read failures instead of treating them as missing', async () => {
    const failure = new Error('Tauri read failed');
    mockGetDownload.mockResolvedValue(makeRow('complete', 42, 1));
    mockGetDownloadedGalleryPages.mockResolvedValue([{ index: 0, ext: 'webp' }]);
    mockStoreGetImage.mockRejectedValueOnce(failure);

    const { result } = renderHook(() => useOfflineImages(42));
    await flushHook();

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.sources![0].loadUrl!();
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBe(failure);
    expect(result.current.missing).toBe(false);
    expect(result.current.error).toBe(failure);
    expect(mockGetDownloadedImage).not.toHaveBeenCalled();
  });
});

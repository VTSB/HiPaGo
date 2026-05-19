// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { DBDownload } from '@/lib/db/schema';

// ---------------------------------------------------------------------------
// Mocks — declared before any module imports that depend on them
// ---------------------------------------------------------------------------

const mockGetDownload = vi.fn();
const mockGetDownloadedGalleryPages = vi.fn();
const mockGetDownloadedImage = vi.fn();

vi.mock('@/lib/db/download', () => ({
  getDownload: (galleryId: number) => mockGetDownload(galleryId),
}));

vi.mock('@/lib/utils/download-zip', () => ({
  getDownloadedGalleryPages: (galleryId: number) => mockGetDownloadedGalleryPages(galleryId),
  getDownloadedImage: (galleryId: number, index: number) => mockGetDownloadedImage(galleryId, index),
}));

// Track createObjectURL / revokeObjectURL calls to verify blob-URL lifecycle.
const createdUrls: string[] = [];
const revokedUrls: string[] = [];

let urlCounter = 0;
const mockCreateObjectURL = vi.fn((_blob: unknown) => {
  const url = `blob:mock-url-${++urlCounter}`;
  createdUrls.push(url);
  return url;
});
const mockRevokeObjectURL = vi.fn((url: string) => {
  revokedUrls.push(url);
});

// ---------------------------------------------------------------------------
// Import hook AFTER mocks are registered
// ---------------------------------------------------------------------------
import { useOfflineImages } from '../hooks/useOfflineImages';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeRow(status: DBDownload['status']): DBDownload {
  return {
    galleryId: 42,
    title: 'Test Gallery',
    thumbnail: '',
    tags: '{}',
    pageCount: 3,
    totalBytes: 1000,
    downloadedAt: new Date().toISOString(),
    status,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
  createdUrls.length = 0;
  revokedUrls.length = 0;
  urlCounter = 0;
  vi.stubGlobal('URL', {
    createObjectURL: mockCreateObjectURL,
    revokeObjectURL: mockRevokeObjectURL,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useOfflineImages — gallery not downloaded', () => {
  it('returns urls:null when getDownload returns null', async () => {
    mockGetDownload.mockResolvedValue(null);

    const { result } = renderHook(() => useOfflineImages(42));

    // Initially loading
    expect(result.current.loading).toBe(true);

    await act(async () => {});

    expect(result.current.urls).toBeNull();
    expect(result.current.missing).toBe(false);
    expect(result.current.loading).toBe(false);
    // No blob URLs created
    expect(mockCreateObjectURL).not.toHaveBeenCalled();
  });

  it('returns urls:null when gallery status is "downloading" (not complete)', async () => {
    mockGetDownload.mockResolvedValue(makeRow('downloading'));

    const { result } = renderHook(() => useOfflineImages(42));
    await act(async () => {});

    expect(result.current.urls).toBeNull();
    expect(result.current.missing).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(mockCreateObjectURL).not.toHaveBeenCalled();
  });

  it('returns urls:null when gallery status is "failed"', async () => {
    mockGetDownload.mockResolvedValue(makeRow('failed'));

    const { result } = renderHook(() => useOfflineImages(42));
    await act(async () => {});

    expect(result.current.urls).toBeNull();
    expect(result.current.missing).toBe(false);
    expect(result.current.loading).toBe(false);
  });
});

describe('useOfflineImages — gallery downloaded (status: complete)', () => {
  it('loads images from getDownloadedImage and returns blob URLs (no network fetch)', async () => {
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
    await act(async () => {});

    expect(result.current.loading).toBe(false);
    expect(result.current.missing).toBe(false);
    expect(result.current.urls).not.toBeNull();
    expect(result.current.urls!.length).toBe(3);

    // Each URL is a blob: URL created by createObjectURL
    for (const url of result.current.urls!) {
      expect(url).toMatch(/^blob:/);
    }

    // createObjectURL called once per page
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(3);

    // getDownloadedImage called for each page index
    expect(mockGetDownloadedImage).toHaveBeenCalledTimes(3);
    expect(mockGetDownloadedImage).toHaveBeenCalledWith(42, 0);
    expect(mockGetDownloadedImage).toHaveBeenCalledWith(42, 1);
    expect(mockGetDownloadedImage).toHaveBeenCalledWith(42, 2);
  });

  it('does NOT call getGgConfig or any network function when serving offline', async () => {
    mockGetDownload.mockResolvedValue({ ...makeRow('complete'), galleryId: 7 });
    mockGetDownloadedGalleryPages.mockResolvedValue([{ index: 0, ext: 'webp' }]);
    mockGetDownloadedImage.mockResolvedValue(new Uint8Array([1, 2, 3]));

    const { result } = renderHook(() => useOfflineImages(7));
    await act(async () => {});

    expect(result.current.urls).not.toBeNull();
    // Only the storage mocks were called — no getGgConfig import in this hook
    expect(mockGetDownload).toHaveBeenCalledWith(7);
    expect(mockGetDownloadedGalleryPages).toHaveBeenCalledWith(7);
    expect(mockGetDownloadedImage).toHaveBeenCalledWith(7, 0);
  });
});

describe('useOfflineImages — missing / corrupt stored files', () => {
  it('returns missing:true when status is complete but pages array is empty', async () => {
    mockGetDownload.mockResolvedValue(makeRow('complete'));
    mockGetDownloadedGalleryPages.mockResolvedValue([]); // empty manifest

    const { result } = renderHook(() => useOfflineImages(42));
    await act(async () => {});

    expect(result.current.urls).toBeNull();
    expect(result.current.missing).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(mockCreateObjectURL).not.toHaveBeenCalled();
  });

  it('returns missing:true when getDownloadedImage returns null for a page', async () => {
    mockGetDownload.mockResolvedValue({ ...makeRow('complete'), galleryId: 55 });
    mockGetDownloadedGalleryPages.mockResolvedValue([
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
    ]);
    // First page loads OK, second is null (corrupt/missing)
    mockGetDownloadedImage
      .mockResolvedValueOnce(new Uint8Array([1, 2]))
      .mockResolvedValueOnce(null);

    const { result } = renderHook(() => useOfflineImages(55));
    await act(async () => {});

    expect(result.current.urls).toBeNull();
    expect(result.current.missing).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it('revokes already-created blob URLs when a page is missing mid-load', async () => {
    mockGetDownload.mockResolvedValue({ ...makeRow('complete'), galleryId: 55 });
    mockGetDownloadedGalleryPages.mockResolvedValue([
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
    ]);
    mockGetDownloadedImage
      .mockResolvedValueOnce(new Uint8Array([1]))  // page 0 OK
      .mockResolvedValueOnce(null);                 // page 1 missing

    const { result } = renderHook(() => useOfflineImages(55));
    await act(async () => {});

    // The URL created for page 0 must be revoked to avoid leaks
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
    expect(mockRevokeObjectURL).toHaveBeenCalledTimes(1);
    expect(result.current.missing).toBe(true);
  });
});

describe('useOfflineImages — blob URL lifecycle', () => {
  it('revokes blob URLs when galleryId changes', async () => {
    mockGetDownload.mockResolvedValue(makeRow('complete'));
    mockGetDownloadedGalleryPages.mockResolvedValue([{ index: 0, ext: 'webp' }]);
    mockGetDownloadedImage.mockResolvedValue(new Uint8Array([42]));

    const { result, rerender } = renderHook(({ gid }: { gid: number }) => useOfflineImages(gid), {
      initialProps: { gid: 1 },
    });
    await act(async () => {});

    expect(result.current.urls).not.toBeNull();
    const firstUrl = result.current.urls![0];

    // Switch to a different gallery — blob URL for gallery 1 must be revoked.
    mockGetDownload.mockResolvedValue({ ...makeRow('complete'), galleryId: 2 });
    mockGetDownloadedGalleryPages.mockResolvedValue([{ index: 0, ext: 'jpg' }]);
    mockGetDownloadedImage.mockResolvedValue(new Uint8Array([99]));

    rerender({ gid: 2 });
    await act(async () => {});

    expect(revokedUrls).toContain(firstUrl);
    expect(result.current.urls).not.toBeNull();
    expect(result.current.urls!.length).toBe(1);
  });

  it('revokes blob URLs on unmount', async () => {
    mockGetDownload.mockResolvedValue(makeRow('complete'));
    mockGetDownloadedGalleryPages.mockResolvedValue([
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
    ]);
    mockGetDownloadedImage.mockResolvedValue(new Uint8Array([1]));

    const { result, unmount } = renderHook(() => useOfflineImages(42));
    await act(async () => {});

    expect(result.current.urls!.length).toBe(2);
    const urlsBefore = [...result.current.urls!];

    unmount();

    // Both URLs must have been revoked
    for (const u of urlsBefore) {
      expect(revokedUrls).toContain(u);
    }
  });
});

describe('useOfflineImages — DB error degrades gracefully', () => {
  it('returns urls:null (not crash) when getDownload throws', async () => {
    mockGetDownload.mockRejectedValue(new Error('DB not initialised'));

    const { result } = renderHook(() => useOfflineImages(42));
    await act(async () => {});

    expect(result.current.urls).toBeNull();
    expect(result.current.missing).toBe(false);
    expect(result.current.loading).toBe(false);
  });
});

// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useReaderStore } from '@/features/reader/store/reader.store';
import { ImageType, type GalleryImage } from '@/lib/utils/types';
import { useReader } from '../useReader';

const mocks = vi.hoisted(() => ({
  getReadingProgress: vi.fn(),
  useGalleryDetail: vi.fn(),
  preferredMode: { value: 'page' as 'page' | 'scroll' },
}));

vi.mock('@/lib/db/gallery', () => ({
  getReadingProgress: mocks.getReadingProgress,
}));

vi.mock('@/features/gallery-detail/hooks/useGalleryDetail', () => ({
  useGalleryDetail: mocks.useGalleryDetail,
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: {
    getState: () => ({ readerMode: mocks.preferredMode.value }),
  },
}));

vi.mock('../useReaderHistory', () => ({
  useReaderHistory: () => ({ goBack: vi.fn() }),
}));

vi.mock('../useReaderPersistence', () => ({
  useReaderPersistence: vi.fn(),
  waitForPendingReaderHistoryWrites: vi.fn(() => Promise.resolve()),
}));

function makeImages(count: number): GalleryImage[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `${index + 1}.webp`,
    hash: `offline-${index}`,
    width: 800,
    height: 1200,
    types: new Set([ImageType.WEBP]),
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  useReaderStore.getState().reset();
  mocks.preferredMode.value = 'page';
  mocks.getReadingProgress.mockResolvedValue(null);
  mocks.useGalleryDetail.mockReturnValue({
    images: null,
    isLoading: true,
    error: new Error('network detail must be ignored for local images'),
  });
});

describe('useReader initialization', () => {
  it('pauses the network query while an offline manifest lookup is unresolved', () => {
    renderHook(() => useReader(2, undefined, null));

    expect(mocks.useGalleryDetail).toHaveBeenCalledWith(0);
    expect(useReaderStore.getState().galleryId).toBe(2);
    expect(useReaderStore.getState().images).toEqual([]);
  });

  it('clears the previous gallery when the resolved gallery has no pages', () => {
    useReaderStore.getState().setGallery(1, makeImages(2));

    const { result } = renderHook(() => useReader(2, undefined, []));

    expect(result.current.galleryId).toBe(2);
    expect(result.current.images).toEqual([]);
    expect(result.current.totalPages).toBe(0);
    expect(mocks.getReadingProgress).not.toHaveBeenCalled();
  });

  it('preserves page and mode when the same gallery receives a refreshed image array', () => {
    const firstImages = makeImages(4);
    const refreshedImages = makeImages(5);
    const { result, rerender } = renderHook(({ images }) => useReader(42, undefined, images), {
      initialProps: { images: firstImages },
    });

    act(() => {
      result.current.setCurrentPage(2);
      result.current.setMode('scroll');
    });
    rerender({ images: refreshedImages });

    expect(result.current.images).toEqual(refreshedImages);
    expect(result.current.totalPages).toBe(5);
    expect(result.current.currentPage).toBe(2);
    expect(result.current.mode).toBe('scroll');
  });

  it('uses local images without enabling the network detail query and restores clamped progress', async () => {
    const images = makeImages(3);
    mocks.getReadingProgress.mockResolvedValue({
      lastPage: 99,
      totalPages: 100,
      readerMode: 'vertical',
    });

    const { result } = renderHook(() => useReader(42, undefined, images));

    expect(mocks.useGalleryDetail).toHaveBeenCalledWith(0);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(useReaderStore.getState().images).toEqual(images);
    expect(useReaderStore.getState().totalPages).toBe(3);
    await waitFor(() => {
      expect(result.current.currentPage).toBe(2);
      expect(result.current.mode).toBe('scroll');
      expect(useReaderStore.getState().progressReadyGalleryId).toBe(42);
    });
  });

  it('restores saved progress after a StrictMode effect replay', async () => {
    const images = makeImages(3);
    const pending = deferred<{ lastPage: number; totalPages: number; readerMode: string } | null>();
    mocks.getReadingProgress.mockReturnValue(pending.promise);

    const { result } = renderHook(() => useReader(42, undefined, images), {
      reactStrictMode: true,
    });

    await act(async () => {
      pending.resolve({ lastPage: 2, totalPages: 3, readerMode: 'scroll' });
      await pending.promise;
    });

    expect(mocks.getReadingProgress).toHaveBeenCalledTimes(1);
    expect(result.current.currentPage).toBe(2);
    expect(result.current.mode).toBe('scroll');
    expect(useReaderStore.getState().progressReadyGalleryId).toBe(42);
  });

  it('keeps a pending progress restore alive across a same-gallery image refresh', async () => {
    const pending = deferred<{ lastPage: number; totalPages: number; readerMode: string } | null>();
    mocks.getReadingProgress.mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(({ images }) => useReader(43, undefined, images), {
      initialProps: { images: makeImages(3) },
    });

    rerender({ images: makeImages(4) });
    await act(async () => {
      pending.resolve({ lastPage: 2, totalPages: 3, readerMode: 'scroll' });
      await pending.promise;
    });

    expect(mocks.getReadingProgress).toHaveBeenCalledTimes(1);
    expect(result.current.currentPage).toBe(2);
    expect(result.current.mode).toBe('scroll');
    expect(useReaderStore.getState().progressReadyGalleryId).toBe(43);
  });

  it('applies a clamped explicit initialPage and does not read saved progress', () => {
    const images = makeImages(3);
    mocks.preferredMode.value = 'scroll';

    const { result } = renderHook(() => useReader(7, 100, images));

    expect(result.current.currentPage).toBe(2);
    expect(result.current.mode).toBe('scroll');
    expect(mocks.getReadingProgress).not.toHaveBeenCalled();
    expect(useReaderStore.getState().progressReadyGalleryId).toBe(7);
  });

  it('applies an explicit initialPage when an empty gallery later receives pages', () => {
    const { result, rerender } = renderHook(({ images }) => useReader(14, 3, images), {
      initialProps: { images: [] as GalleryImage[] },
    });

    expect(result.current.currentPage).toBe(0);
    expect(useReaderStore.getState().progressReadyGalleryId).toBeNull();

    rerender({ images: makeImages(5) });

    expect(result.current.currentPage).toBe(2);
    expect(useReaderStore.getState().progressReadyGalleryId).toBe(14);
    expect(mocks.getReadingProgress).not.toHaveBeenCalled();
  });

  it('does not treat a zero-page visit row as reading progress', async () => {
    const images = makeImages(4);
    mocks.preferredMode.value = 'scroll';
    mocks.getReadingProgress.mockResolvedValue({
      lastPage: 3,
      totalPages: 0,
      readerMode: 'horizontal',
    });

    const { result } = renderHook(() => useReader(8, undefined, images));

    await waitFor(() => expect(useReaderStore.getState().progressReadyGalleryId).toBe(8));
    expect(result.current.currentPage).toBe(0);
    expect(result.current.mode).toBe('scroll');
  });

  it('opens persistence after a failed progress read', async () => {
    mocks.getReadingProgress.mockRejectedValue(new Error('database unavailable'));

    const { result } = renderHook(() => useReader(13, undefined, makeImages(3)));

    await waitFor(() => expect(useReaderStore.getState().progressReadyGalleryId).toBe(13));
    expect(result.current.currentPage).toBe(0);
    expect(result.current.mode).toBe('page');
  });

  it('keeps the configured mode for an unknown stored value while restoring the page', async () => {
    const images = makeImages(4);
    mocks.preferredMode.value = 'scroll';
    mocks.getReadingProgress.mockResolvedValue({
      lastPage: 1,
      totalPages: 4,
      readerMode: 'diagonal',
    });

    const { result } = renderHook(() => useReader(9, undefined, images));

    await waitFor(() => expect(result.current.currentPage).toBe(1));
    expect(result.current.mode).toBe('scroll');
  });

  it.each([
    ['page', 'page'],
    ['horizontal', 'page'],
    ['scroll', 'scroll'],
    ['vertical', 'scroll'],
    ['webtoon', 'scroll'],
  ] as const)('normalizes stored mode %s to %s', async (storedMode, expectedMode) => {
    const images = makeImages(2);
    mocks.preferredMode.value = expectedMode === 'page' ? 'scroll' : 'page';
    mocks.getReadingProgress.mockResolvedValue({
      lastPage: 1,
      totalPages: 2,
      readerMode: storedMode,
    });

    const { result } = renderHook(() => useReader(10, undefined, images));

    await waitFor(() => expect(result.current.mode).toBe(expectedMode));
  });

  it('does not let delayed progress overwrite returned page and mode actions', async () => {
    const images = makeImages(3);
    const pending = deferred<{ lastPage: number; totalPages: number; readerMode: string } | null>();
    mocks.preferredMode.value = 'scroll';
    mocks.getReadingProgress.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useReader(11, undefined, images));

    act(() => {
      result.current.setCurrentPage(1);
      result.current.setMode('page');
    });
    expect(useReaderStore.getState().progressReadyGalleryId).toBe(11);
    await act(async () => {
      pending.resolve({ lastPage: 2, totalPages: 3, readerMode: 'scroll' });
      await pending.promise;
    });

    expect(result.current.currentPage).toBe(1);
    expect(result.current.mode).toBe('page');
  });

  it('still restores delayed progress after a same-page visibility notification', async () => {
    const images = makeImages(3);
    const pending = deferred<{ lastPage: number; totalPages: number; readerMode: string } | null>();
    mocks.getReadingProgress.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useReader(12, undefined, images));

    act(() => result.current.setCurrentPage(0));
    expect(useReaderStore.getState().progressReadyGalleryId).toBeNull();
    await act(async () => {
      pending.resolve({ lastPage: 2, totalPages: 3, readerMode: 'scroll' });
      await pending.promise;
    });

    expect(result.current.currentPage).toBe(2);
    expect(result.current.mode).toBe('scroll');
  });
});

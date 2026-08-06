// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReaderStore } from '@/features/reader/store/reader.store';
import { ImageType, type GalleryImage } from '@/lib/utils/types';
import { useReader } from '../useReader';
import { __resetReaderHistoryLanesForTests } from '../useReaderPersistence';

type ReadingProgress = {
  lastPage: number;
  totalPages: number;
  readerMode: string;
};

const mocks = vi.hoisted(() => ({
  getReadingProgress: vi.fn(),
  recordHistory: vi.fn(),
  useGalleryDetail: vi.fn(),
}));

vi.mock('@/lib/db/gallery', () => ({
  getReadingProgress: mocks.getReadingProgress,
  recordHistory: mocks.recordHistory,
}));

vi.mock('@/features/gallery-detail/hooks/useGalleryDetail', () => ({
  useGalleryDetail: mocks.useGalleryDetail,
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: {
    getState: () => ({ readerMode: 'page' }),
  },
}));

vi.mock('../useReaderHistory', () => ({
  useReaderHistory: () => ({ goBack: vi.fn() }),
}));

function makeImages(count: number): GalleryImage[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `${index + 1}.webp`,
    hash: `progress-${index}`,
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

describe('useReader progress read-before-write barrier', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetReaderHistoryLanesForTests();
    vi.clearAllMocks();
    useReaderStore.getState().reset();
    mocks.useGalleryDetail.mockReturnValue({
      images: null,
      isLoading: false,
      error: null,
      retry: vi.fn(),
    });
  });

  afterEach(async () => {
    cleanup();
    await act(async () => Promise.resolve());
    __resetReaderHistoryLanesForTests();
    useReaderStore.getState().reset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('preserves old progress during a slow read and saves normally after restore', async () => {
    const galleryId = 77;
    const oldProgress: ReadingProgress = {
      lastPage: 5,
      totalPages: 8,
      readerMode: 'scroll',
    };
    let storedProgress = oldProgress;
    const images = makeImages(8);
    const pendingRead = deferred<ReadingProgress | null>();
    mocks.getReadingProgress.mockReturnValue(pendingRead.promise);
    mocks.recordHistory.mockImplementation(
      async (_id: number, lastPage: number, totalPages: number, readerMode: string) => {
        storedProgress = { lastPage, totalPages, readerMode };
      },
    );

    const { result } = renderHook(() => useReader(galleryId, undefined, images));
    expect(result.current.currentPage).toBe(0);
    expect(useReaderStore.getState().progressReadyGalleryId).toBeNull();

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(2000);
    });

    expect(mocks.recordHistory).not.toHaveBeenCalled();
    expect(storedProgress).toEqual(oldProgress);

    await act(async () => {
      pendingRead.resolve(oldProgress);
      await pendingRead.promise;
      await Promise.resolve();
    });

    expect(result.current.currentPage).toBe(5);
    expect(result.current.mode).toBe('scroll');
    expect(useReaderStore.getState().progressReadyGalleryId).toBe(galleryId);

    act(() => vi.advanceTimersByTime(1999));
    expect(mocks.recordHistory).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(mocks.recordHistory).toHaveBeenCalledOnce();
    expect(mocks.recordHistory).toHaveBeenCalledWith(galleryId, 5, 8, 'scroll');
    expect(storedProgress).toEqual(oldProgress);
  });

  it('drains an old instance write before a remounted reader restores progress', async () => {
    const galleryId = 88;
    const images = makeImages(8);
    let storedProgress: ReadingProgress = {
      lastPage: 0,
      totalPages: 8,
      readerMode: 'page',
    };
    const slowFirstWrite = deferred<void>();
    mocks.recordHistory
      .mockImplementationOnce(
        async (_id: number, lastPage: number, totalPages: number, readerMode: string) => {
          await slowFirstWrite.promise;
          storedProgress = { lastPage, totalPages, readerMode };
        },
      )
      .mockImplementation(
        async (_id: number, lastPage: number, totalPages: number, readerMode: string) => {
          storedProgress = { lastPage, totalPages, readerMode };
        },
      );
    mocks.getReadingProgress.mockImplementation(async () => storedProgress);

    const oldReader = renderHook(() => useReader(galleryId, 2, images));
    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(mocks.recordHistory).toHaveBeenCalledOnce();
    expect(mocks.recordHistory).toHaveBeenLastCalledWith(galleryId, 1, 8, 'page');

    act(() => oldReader.result.current.setCurrentPage(3));
    oldReader.unmount();

    // Mount before the old unmount microtask runs. Its synchronous lane
    // reservation must still keep the new read behind both old snapshots.
    const newReader = renderHook(() => useReader(galleryId, undefined, images));
    expect(mocks.getReadingProgress).not.toHaveBeenCalled();
    await act(async () => Promise.resolve());
    expect(mocks.getReadingProgress).not.toHaveBeenCalled();

    await act(async () => {
      slowFirstWrite.resolve();
      await slowFirstWrite.promise;
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(mocks.recordHistory).toHaveBeenCalledTimes(2);
    expect(mocks.recordHistory).toHaveBeenLastCalledWith(galleryId, 3, 8, 'page');
    expect(mocks.getReadingProgress).toHaveBeenCalledOnce();
    expect(newReader.result.current.currentPage).toBe(3);
  });
});

// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GalleryImage, GalleryImages } from '@/lib/utils/types';
import { StrictMode } from 'react';

const { detail, progress } = vi.hoisted(() => ({ detail: vi.fn(), progress: vi.fn() }));
vi.mock('@/features/gallery-detail/hooks/useGalleryDetail', () => ({ useGalleryDetail: detail }));
vi.mock('@/lib/db/gallery', () => ({ getReadingProgress: progress }));
vi.mock('../useReaderHistory', () => ({ useReaderHistory: () => ({ goBack: vi.fn() }) }));
vi.mock('../useReaderPersistence', () => ({ useReaderPersistence: vi.fn() }));
vi.mock('../useReaderZoom', () => ({ useReaderZoom: vi.fn() }));
vi.mock('@/shared/hooks/useScrollReveal', () => ({ useScrollReveal: vi.fn() }));
vi.mock('../useOfflineImages', async () => {
  const { useState } = await import('react');
  return {
    useOfflineImages: function useOfflineImages(id: number) {
      const [loadedId] = useState(id);
      return {
        sources: Array.from({ length: loadedId === 42 ? 4 : 10 }, () => 'page'),
        loading: false,
      };
    },
  };
});
vi.mock('../../components/PageReader', () => ({
  PageReader: ({ images, currentPage }: { images: GalleryImage[]; currentPage: number }) => (
    <div data-testid="page">{images[currentPage]?.hash}</div>
  ),
}));
vi.mock('../../components/ScrollReader', () => ({ ScrollReader: () => null }));
vi.mock('../../components/ReaderControls', () => ({ ReaderControls: () => null }));

import { useReader } from '../useReader';
import { ReaderView } from '../../components/ReaderView';
import { useReaderStore } from '../../store/reader.store';
import { useSettingsStore } from '@/lib/store/settings';

const images = (count: number, prefix = 'page'): GalleryImage[] =>
  Array.from({ length: count }, (_, index) => ({
    name: '',
    hash: `${prefix}-${index}`,
    width: 800,
    height: 1200,
    types: new Set(),
  }));
let networkImages: GalleryImages | null;
type SavedProgress = { lastPage: number; totalPages: number; readerMode: string };
beforeEach(() => {
  useReaderStore.getState().reset();
  useSettingsStore.setState({ readerMode: 'page' });
  networkImages = null;
  detail
    .mockReset()
    .mockImplementation(() => ({ images: networkImages, isLoading: !networkImages, error: null }));
  progress.mockReset().mockResolvedValue(null);
});
afterEach(cleanup);

describe('reader initialization shared by offline manifests and detail images', () => {
  it.each(['online', 'manifest'] as const)(
    'keeps the preferred mode for a detail-only visit on the %s path',
    async (path) => {
      useSettingsStore.setState({ readerMode: 'page' });
      progress.mockResolvedValue({ lastPage: 0, totalPages: 0, readerMode: '' });
      if (path === 'online') networkImages = { id: 42, images: images(10) };
      const { result } = renderHook(() => useReader(42));
      await act(async () => {
        if (path === 'manifest') result.current.setGallery(42, images(10));
        await Promise.resolve();
      });
      expect(progress).toHaveBeenCalledWith(42);
      expect(result.current.mode).toBe('page');
      expect(result.current.currentPage).toBe(0);
      expect(result.current.totalPages).toBe(10);
    },
  );

  it.each([
    ['no reading pages', { lastPage: 4, totalPages: 0, readerMode: 'page' }],
    ['negative reading pages', { lastPage: 4, totalPages: -1, readerMode: 'page' }],
    ['NaN reading pages', { lastPage: 4, totalPages: Number.NaN, readerMode: 'page' }],
    [
      'infinite reading pages',
      { lastPage: 4, totalPages: Number.POSITIVE_INFINITY, readerMode: 'page' },
    ],
    ['NaN saved page', { lastPage: Number.NaN, totalPages: 10, readerMode: 'page' }],
    [
      'infinite saved page',
      { lastPage: Number.POSITIVE_INFINITY, totalPages: 10, readerMode: 'page' },
    ],
  ])('keeps preferred mode and first page for %s', async (_name, saved) => {
    useSettingsStore.setState({ readerMode: 'scroll' });
    progress.mockResolvedValue(saved);
    const { result } = renderHook(() => useReader(42));
    await act(async () => result.current.setGallery(42, images(10)));
    expect(result.current.mode).toBe('scroll');
    expect(result.current.currentPage).toBe(0);
  });

  it.each(['', 'spread'])(
    'restores valid saved page while retaining preferred mode for invalid mode %j',
    async (readerMode) => {
      useSettingsStore.setState({ readerMode: 'scroll' });
      progress.mockResolvedValue({ lastPage: 4, totalPages: 10, readerMode });
      const { result } = renderHook(() => useReader(42));
      await act(async () => result.current.setGallery(42, images(10)));
      expect(result.current.mode).toBe('scroll');
      expect(result.current.currentPage).toBe(4);
    },
  );

  it.each(['page', 'scroll'] as const)(
    'restores a valid saved %s mode over the preference',
    async (readerMode) => {
      useSettingsStore.setState({ readerMode: readerMode === 'page' ? 'scroll' : 'page' });
      progress.mockResolvedValue({ lastPage: 4, totalPages: 10, readerMode });
      const { result } = renderHook(() => useReader(42));
      await act(async () => result.current.setGallery(42, images(10)));
      expect(result.current.mode).toBe(readerMode);
      expect(result.current.currentPage).toBe(4);
    },
  );

  it.each([
    [3.9, 3],
    [-4, 0],
  ])('normalizes saved page %s to available page %s', async (lastPage, expected) => {
    progress.mockResolvedValue({ lastPage, totalPages: 10, readerMode: 'page' });
    const { result } = renderHook(() => useReader(42));
    await act(async () => result.current.setGallery(42, images(10)));
    expect(result.current.currentPage).toBe(expected);
  });

  it.each(['online', 'manifest'] as const)(
    'opens an explicit one-based resume page on the %s path using the preferred mode',
    (path) => {
      useSettingsStore.setState({ readerMode: 'scroll' });
      progress.mockResolvedValue({ lastPage: 7, totalPages: 10, readerMode: 'page' });
      if (path === 'online') networkImages = { id: 42, images: images(10) };
      const { result } = renderHook(() => useReader(42, 3));
      if (path === 'manifest') act(() => result.current.setGallery(42, images(10)));
      expect(result.current.currentPage).toBe(2);
      expect(result.current.mode).toBe('scroll');
      expect(progress).not.toHaveBeenCalled();
    },
  );

  it('clamps a requested page to available files', () => {
    const { result } = renderHook(() => useReader(42, 99));
    act(() => result.current.setGallery(42, images(4)));
    expect(result.current.currentPage).toBe(3);
  });

  it('restores and clamps saved zero-based progress and mode without a page query', async () => {
    progress.mockResolvedValue({ lastPage: 12, totalPages: 15, readerMode: 'scroll' });
    const { result } = renderHook(() => useReader(42));
    await act(async () => result.current.setGallery(42, images(10)));
    expect(result.current.currentPage).toBe(9);
    expect(result.current.mode).toBe('scroll');
  });

  it('does not reset user navigation when detail images arrive after offline initialization', () => {
    const { result, rerender } = renderHook(() => useReader(42, 3));
    act(() => result.current.setGallery(42, images(10, 'offline')));
    act(() => {
      result.current.setCurrentPage(6);
      result.current.setMode('scroll');
    });
    networkImages = { id: 42, images: images(10, 'network') };
    rerender();
    expect(result.current.images[0].hash).toBe('network-0');
    expect(result.current.currentPage).toBe(6);
    expect(result.current.mode).toBe('scroll');
  });

  it('still restores pending progress when metadata arrives before the DB result', async () => {
    let resolve!: (value: SavedProgress) => void;
    progress.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { result, rerender } = renderHook(() => useReader(42));
    act(() => result.current.setGallery(42, images(10, 'offline')));
    networkImages = { id: 42, images: images(10, 'network') };
    rerender();
    await act(async () => resolve({ lastPage: 4, totalPages: 10, readerMode: 'scroll' }));
    expect(result.current.currentPage).toBe(4);
    expect(result.current.mode).toBe('scroll');
  });

  it('does not override navigation even when the user returns to the first page', async () => {
    let resolve!: (value: SavedProgress) => void;
    progress.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { result } = renderHook(() => useReader(42));
    act(() => result.current.setGallery(42, images(10)));
    act(() => {
      result.current.setCurrentPage(1);
      result.current.setCurrentPage(0);
    });
    await act(async () => resolve({ lastPage: 4, totalPages: 10, readerMode: 'scroll' }));
    expect(result.current.currentPage).toBe(0);
    expect(result.current.mode).toBe('page');
  });

  it('does not override a mode change while saved progress is pending', async () => {
    let resolve!: (value: SavedProgress) => void;
    progress.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { result } = renderHook(() => useReader(42));
    act(() => result.current.setGallery(42, images(10)));
    act(() => result.current.setMode('scroll'));
    await act(async () => resolve({ lastPage: 4, totalPages: 10, readerMode: 'page' }));
    expect(result.current.currentPage).toBe(0);
    expect(result.current.mode).toBe('scroll');
  });

  it('ignores stale progress from a different gallery', async () => {
    let resolve!: (value: SavedProgress) => void;
    progress
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue(null);
    const { result, rerender } = renderHook(({ id }) => useReader(id), {
      initialProps: { id: 42 },
    });
    act(() => result.current.setGallery(42, images(10)));
    rerender({ id: 43 });
    await act(async () => result.current.setGallery(43, images(10)));
    await act(async () => resolve({ lastPage: 4, totalPages: 10, readerMode: 'scroll' }));
    expect(result.current.galleryId).toBe(43);
    expect(result.current.currentPage).toBe(0);
  });

  it('ignores a progress result after unmount', async () => {
    let resolve!: (value: SavedProgress) => void;
    progress.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { result, unmount } = renderHook(() => useReader(42));
    act(() => result.current.setGallery(42, images(10)));
    unmount();
    await act(async () => resolve({ lastPage: 4, totalPages: 10, readerMode: 'scroll' }));
    expect(useReaderStore.getState().currentPage).toBe(0);
  });

  it('opens normally when reading progress is unavailable', async () => {
    progress.mockRejectedValue(new Error('DB unavailable'));
    const { result } = renderHook(() => useReader(42));
    await act(async () => result.current.setGallery(42, images(10)));
    expect(result.current.currentPage).toBe(0);
    expect(result.current.totalPages).toBe(10);
  });

  it('restores progress when Strict Mode replays initial effects', async () => {
    networkImages = { id: 42, images: images(10) };
    progress.mockResolvedValue({ lastPage: 4, totalPages: 10, readerMode: 'scroll' });
    const { result } = renderHook(() => useReader(42), { wrapper: StrictMode });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.currentPage).toBe(4);
    expect(result.current.mode).toBe('scroll');
  });

  it('replaces another gallery with the same page count and resumes its manifest', () => {
    useReaderStore.getState().setGallery(41, images(4, 'previous'));
    render(<ReaderView galleryId={42} initialPage={3} />);
    expect(useReaderStore.getState().galleryId).toBe(42);
    expect(screen.getByTestId('page')).toHaveTextContent('offline-2');
  });

  it('starts fresh offline loaders when navigating to another work', () => {
    const view = render(<ReaderView galleryId={42} initialPage={3} />);
    view.rerender(<ReaderView galleryId={43} initialPage={8} />);
    expect(useReaderStore.getState().galleryId).toBe(43);
    expect(useReaderStore.getState().totalPages).toBe(10);
    expect(screen.getByTestId('page')).toHaveTextContent('offline-7');
  });
});

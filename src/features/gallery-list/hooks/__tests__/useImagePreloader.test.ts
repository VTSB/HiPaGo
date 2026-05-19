// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useImagePreloader } from '../useImagePreloader';
import { GalleryBlockType } from '@/lib/utils/types';
import type { GalleryBlock } from '@/lib/utils/types';
import type { VirtualItem } from '@tanstack/react-virtual';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockResolveBlock = vi.fn<(id: number, signal?: AbortSignal) => Promise<GalleryBlock>>();

vi.mock('../useGalleryBlock', () => ({
  galleryBlockQueryKey: (id: number) => ['gallery-block', id],
  resolveBlock: (...args: [number, AbortSignal?]) => mockResolveBlock(...args),
}));

vi.mock('@/lib/api/url-resolver', () => ({
  resolveThumbnailUrl: (url: string) => `/api/img/proxied/${url}`,
}));

// Track Image() constructor calls
const createdImages: { src: string }[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBlock(id: number, thumbnail: string): GalleryBlock {
  return {
    id,
    type: GalleryBlockType.NOT_DETAILED,
    title: `Gallery ${id}`,
    thumbnail,
    tags: {},
    date: new Date(),
    related: [],
  };
}

function makeVirtualItems(startIndex: number, count: number): VirtualItem[] {
  return Array.from({ length: count }, (_, i) => ({
    index: startIndex + i,
    key: startIndex + i,
    start: (startIndex + i) * 300,
    end: (startIndex + i + 1) * 300,
    size: 300,
    lane: 0,
  }));
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    queryClient,
    wrapper: ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useImagePreloader — thumbnail image preloading', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    createdImages.length = 0;
    mockResolveBlock.mockReset();

    // Stub Image constructor to track preloaded images
    vi.stubGlobal('Image', class {
      _src = '';
      get src() { return this._src; }
      set src(v: string) {
        this._src = v;
        if (v) createdImages.push({ src: v });
      }
    });

    // requestIdleCallback → run synchronously
    vi.stubGlobal('requestIdleCallback', (fn: () => void) => {
      fn();
      return 0;
    });
    vi.stubGlobal('cancelIdleCallback', () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('preloads thumbnail images after block data is fetched', async () => {
    const block = makeBlock(42, 'https://cdn.example.com/tn/42.avif');
    mockResolveBlock.mockResolvedValue(block);

    const { queryClient, wrapper } = createWrapper();

    // Visible rows = [5..9], preloadRows=2 → preload rows [3,4] and [10,11]
    // With 5 cols, row 10 col 0 → itemIndex = 50, id comes from getItemId
    const getItemId = (idx: number) => idx < 60 ? 42 : null;

    renderHook(
      () =>
        useImagePreloader({
          getItemId,
          virtualItems: makeVirtualItems(5, 5),
          windowStartItem: 0,
          actualCols: 5,
          totalLength: 60,
          requestPage: vi.fn(),
          preloadRows: 2,
        }),
      { wrapper },
    );

    // Trigger the 300ms debounce
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    // Wait for prefetch promises to resolve
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Block data should have been prefetched
    expect(mockResolveBlock).toHaveBeenCalled();

    // Thumbnail images should have been preloaded via new Image().src
    expect(createdImages.length).toBeGreaterThan(0);
    expect(createdImages.some((img) => img.src.includes('42.avif'))).toBe(true);
  });

  it('does NOT preload images for LOADING or FAILED blocks', async () => {
    const loadingBlock: GalleryBlock = {
      id: 99,
      type: GalleryBlockType.LOADING,
      title: '',
      thumbnail: '',
      tags: {},
      date: new Date(),
      related: [],
    };
    mockResolveBlock.mockResolvedValue(loadingBlock);

    const { wrapper } = createWrapper();
    const getItemId = (idx: number) => idx < 10 ? 99 : null;

    renderHook(
      () =>
        useImagePreloader({
          getItemId,
          virtualItems: makeVirtualItems(0, 2),
          windowStartItem: 0,
          actualCols: 5,
          totalLength: 20,
          requestPage: vi.fn(),
          preloadRows: 2,
        }),
      { wrapper },
    );

    await act(async () => {
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
    });

    // No image preloading for loading blocks
    expect(createdImages.length).toBe(0);
  });
});

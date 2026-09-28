// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useImagePreloader } from '../useImagePreloader';
import { GalleryBlockType, type GalleryBlock } from '@/lib/utils/types';
import { PAGE_SIZE } from '@/lib/utils/constants';

const { resolveBlock, preload } = vi.hoisted(() => ({
  resolveBlock: vi.fn(), preload: vi.fn(),
}));
vi.mock('../useGalleryBlock', () => ({
  galleryBlockQueryKey: (id: number) => ['gallery-block', id], resolveBlock,
}));
vi.mock('@/shared/components/AbortableImage', () => ({ preloadImageSource: preload }));
vi.mock('@/lib/api/url-resolver', () => ({ resolveThumbnailUrl: (url: string) => url }));

const block = (id: number): GalleryBlock => ({
  id, type: GalleryBlockType.NOT_DETAILED, title: String(id),
  thumbnail: '/thumb/' + id, tags: {}, date: new Date(), related: [],
});
function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}
function options(page = 2, count = PAGE_SIZE * 4) {
  return {
    getItemId: (index: number) => index + 1, viewingPage: page,
    visibleStartItem: (page - 1) * PAGE_SIZE + 5,
    visibleEndItem: (page - 1) * PAGE_SIZE + 9,
    totalLength: count, requestPage: vi.fn(),
  };
}
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 300; i++) await Promise.resolve();
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  resolveBlock.mockReset().mockImplementation(async (id: number) => block(id));
  preload.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe('adjacent logical page warming', () => {
  it.each([
    [1, [0, 1], 1, PAGE_SIZE * 2],
    [2, [1, 2, 0], 1, PAGE_SIZE * 3],
    [4, [3, 2], PAGE_SIZE * 2 + 1, PAGE_SIZE * 4],
  ])('clamps page %i to one previous/next page', async (page, expectedPages, firstId, lastId) => {
    const props = options(page as number);
    const { wrapper } = setup();
    renderHook(() => useImagePreloader(props), { wrapper });
    await flush();
    expect(props.requestPage.mock.calls.map(([p]) => p)).toEqual(expectedPages);
    const ids = resolveBlock.mock.calls.map(([id]) => id).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: (lastId as number) - (firstId as number) + 1 }, (_, i) => (firstId as number) + i));
    expect(preload).toHaveBeenCalledTimes(ids.length);
    expect(resolveBlock.mock.calls.every((args) => args[3] === 2)).toBe(true);
  });

  it('starts metadata at the actual viewport and holds the bound until images finish', async () => {
    preload.mockImplementation(() => new Promise(() => {}));
    const props = options();
    const { wrapper } = setup();
    renderHook(() => useImagePreloader(props), { wrapper });
    await flush();
    expect(resolveBlock).toHaveBeenCalledTimes(2);
    expect(preload).toHaveBeenCalledTimes(2);
    for (const [id] of resolveBlock.mock.calls) {
      expect(id - 1).toBeGreaterThanOrEqual(props.visibleStartItem);
      expect(id - 1).toBeLessThanOrEqual(props.visibleEndItem);
    }
  });

  it('does not restart warming when equivalent callbacks and viewport bounds rerender', async () => {
    preload.mockImplementation(() => new Promise(() => {}));
    const { wrapper } = setup();
    const { rerender } = renderHook((props) => useImagePreloader(props), { wrapper, initialProps: options() });
    await flush();
    const signal = preload.mock.calls[0][1] as AbortSignal;
    rerender({ ...options(), visibleStartItem: PAGE_SIZE + 10 });
    await flush();
    expect(preload).toHaveBeenCalledTimes(2);
    expect(signal.aborted).toBe(false);
    expect(preload.mock.calls[0][2]()).toBeGreaterThan(0);
  });

  it('cancels old metadata and never warms an image from a late obsolete result', async () => {
    const pending: Array<{ id: number; signal: AbortSignal; resolve: (value: GalleryBlock) => void }> = [];
    resolveBlock.mockImplementation((id, signal) => new Promise((resolve) => pending.push({ id, signal, resolve })));
    const { wrapper } = setup();
    const { rerender, unmount } = renderHook((props) => useImagePreloader(props), { wrapper, initialProps: options(1, PAGE_SIZE * 10) });
    await flush();
    const old = pending.slice();
    rerender(options(8, PAGE_SIZE * 10));
    expect(old.every((p) => p.signal.aborted)).toBe(true);
    await act(async () => { old.forEach((p) => p.resolve(block(p.id))); });
    expect(preload).not.toHaveBeenCalled();
    await flush();
    unmount();
    expect(pending.every((p) => p.signal.aborted)).toBe(true);
  });

  it('skips failed metadata and an empty population', async () => {
    resolveBlock.mockImplementation(async (id) => ({ ...block(id), type: GalleryBlockType.FAILED }));
    const { wrapper } = setup();
    const { rerender } = renderHook((props) => useImagePreloader(props), { wrapper, initialProps: options() });
    await flush();
    expect(preload).not.toHaveBeenCalled();
    resolveBlock.mockClear();
    const empty = options(1, 0);
    rerender(empty);
    await flush();
    expect(empty.requestPage).not.toHaveBeenCalled();
    expect(resolveBlock).not.toHaveBeenCalled();
  });

  it('aborts unfinished image warming on page changes and unmount', async () => {
    preload.mockImplementation(() => new Promise(() => {}));
    const { wrapper } = setup();
    const { rerender, unmount } = renderHook((props) => useImagePreloader(props), { wrapper, initialProps: options(1) });
    await flush();
    const oldSignals = preload.mock.calls.map((args) => args[1] as AbortSignal);
    rerender(options(4));
    expect(oldSignals.every((s) => s.aborted)).toBe(true);
    await flush();
    unmount();
    expect(preload.mock.calls.every((args) => args[1].aborted)).toBe(true);
  });
});

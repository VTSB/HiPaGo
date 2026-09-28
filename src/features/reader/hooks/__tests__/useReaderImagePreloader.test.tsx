// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { preload } = vi.hoisted(() => ({ preload: vi.fn() }));
vi.mock('@/shared/components/AbortableImage', () => ({ preloadImageSource: preload }));

import { useReaderImagePreloader } from '../useReaderImagePreloader';

interface PendingLoad {
  url: string;
  signal: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
}

let pending: PendingLoad[];
const urls = Array.from({ length: 50 }, (_, page) => `https://images.example/page-${page}.webp`);
const requested = () => pending.map(({ url }) => url);

async function completeWindow() {
  let completed = 0;
  while (completed < pending.length) {
    const batch = pending.slice(completed);
    completed = pending.length;
    await act(async () => { batch.forEach(({ resolve }) => resolve()); });
  }
}

beforeEach(() => {
  pending = [];
  preload.mockReset();
  // Deliberately keep canceled calls pending: a late transport settlement must
  // never cause an obsolete reader window to start another request.
  preload.mockImplementation((url: string, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    pending.push({ url, signal, resolve, reject });
  }));
});

describe('useReaderImagePreloader', () => {
  it('starts nearest pages first with forward ties and admits at most four unsettled calls', async () => {
    renderHook(() => useReaderImagePreloader(urls, 20));
    expect(requested()).toEqual([21, 19, 22, 18].map((page) => urls[page]));

    await act(async () => { await Promise.resolve(); });
    expect(pending).toHaveLength(4);
    await act(async () => { pending[0].resolve(); });
    expect(requested()).toEqual([21, 19, 22, 18, 23].map((page) => urls[page]));
  });

  it('warms exactly the bounded +15/-5 physical-page window, excluding the current page', async () => {
    renderHook(() => useReaderImagePreloader(urls, 20));
    await completeWindow();
    expect(requested()).toEqual([
      21, 19, 22, 18, 23, 17, 24, 16, 25, 15,
      26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
    ].map((page) => urls[page]));
  });

  it('skips both displayed pages in dual mode and prioritizes distance from the visible pair', async () => {
    renderHook(() => useReaderImagePreloader(urls, 20, 2));
    expect(requested()).toEqual([22, 19, 23, 18].map((page) => urls[page]));
    await completeWindow();
    expect(requested()).not.toContain(urls[20]);
    expect(requested()).not.toContain(urls[21]);
    expect(new Set(requested())).toEqual(new Set([
      ...urls.slice(15, 20), ...urls.slice(22, 36),
    ]));
  });

  it.each([
    { page: 0, expected: [1, 2, 3, 4, 5, 6, 7] },
    { page: 7, expected: [6, 5, 4, 3, 2] },
  ])('clamps the warm window at page $page', async ({ page, expected }) => {
    const shortUrls = urls.slice(0, 8);
    renderHook(() => useReaderImagePreloader(shortUrls, page));
    await completeWindow();
    expect(requested()).toEqual(expected.map((index) => shortUrls[index]));
  });

  it('continues best-effort warming after an individual image fails', async () => {
    renderHook(() => useReaderImagePreloader(urls, 20));
    await act(async () => { pending[0].reject(new Error('unavailable image')); });
    expect(requested()).toEqual([21, 19, 22, 18, 23].map((page) => urls[page]));
  });

  it('aborts the previous page window and ignores its late completions', async () => {
    const { rerender } = renderHook(({ page }) => useReaderImagePreloader(urls, page), {
      initialProps: { page: 20 },
    });
    const oldLoads = [...pending];
    rerender({ page: 35 });
    expect(oldLoads.every(({ signal }) => signal.aborted)).toBe(true);
    expect(requested().slice(4)).toEqual([36, 34, 37, 33].map((page) => urls[page]));
    await act(async () => { oldLoads.forEach(({ resolve }) => resolve()); });
    expect(pending).toHaveLength(8);
  });

  it('replaces source/format URLs without starting more work from the old gallery', async () => {
    const nextUrls = urls.map((url) => url.replace('page-', 'other-').replace('.webp', '.avif'));
    const { rerender } = renderHook(({ sources }) => useReaderImagePreloader(sources, 20), {
      initialProps: { sources: urls },
    });
    const oldLoads = [...pending];
    rerender({ sources: nextUrls });
    expect(oldLoads.every(({ signal }) => signal.aborted)).toBe(true);
    expect(requested().slice(4)).toEqual([21, 19, 22, 18].map((page) => nextUrls[page]));
    await act(async () => { oldLoads.forEach(({ resolve }) => resolve()); });
    expect(pending).toHaveLength(8);
  });

  it('replaces warming when the displayed page count changes', () => {
    const { rerender } = renderHook(({ count }) => useReaderImagePreloader(urls, 20, count), {
      initialProps: { count: 1 },
    });
    const oldLoads = [...pending];
    rerender({ count: 2 });
    expect(oldLoads.every(({ signal }) => signal.aborted)).toBe(true);
    expect(requested().slice(4)).toEqual([22, 19, 23, 18].map((page) => urls[page]));
  });

  it('aborts all pending work on unmount and never pumps after late settlement', async () => {
    const { unmount } = renderHook(() => useReaderImagePreloader(urls, 20));
    unmount();
    expect(pending.every(({ signal }) => signal.aborted)).toBe(true);
    await act(async () => { pending.forEach(({ resolve }) => resolve()); });
    expect(pending).toHaveLength(4);
  });

  it('starts no warming for empty, single-page, or offline sources', () => {
    const { rerender } = renderHook(({ sources, offline }) => useReaderImagePreloader(sources, 0, 1, offline), {
      initialProps: { sources: [] as string[], offline: false },
    });
    rerender({ sources: [urls[0]], offline: false });
    rerender({ sources: urls, offline: true });
    expect(preload).not.toHaveBeenCalled();
  });

  it('cancels warming when switching to offline sources and resumes when online', async () => {
    const { rerender } = renderHook(({ offline }) => useReaderImagePreloader(urls, 20, 1, offline), {
      initialProps: { offline: false },
    });
    const oldLoads = [...pending];
    rerender({ offline: true });
    expect(oldLoads.every(({ signal }) => signal.aborted)).toBe(true);
    await act(async () => { oldLoads.forEach(({ resolve }) => resolve()); });
    expect(pending).toHaveLength(4);
    rerender({ offline: false });
    expect(requested().slice(4)).toEqual([21, 19, 22, 18].map((page) => urls[page]));
  });
});

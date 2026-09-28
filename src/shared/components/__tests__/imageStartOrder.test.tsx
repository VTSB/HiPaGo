// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AbortableImage, preloadImageSource, resetImageDisplayCaches } from '../AbortableImage';
import { imageLoadScheduler } from '@/shared/utils/imageLoadScheduler';

vi.mock('@/lib/utils/platform', () => ({ isTauri: () => false, isCapacitor: () => false, isAndroid: () => false }));
vi.mock('@/lib/cache/image-cache', () => ({ getImageCache: async () => ({ fileUrl: async () => null, getMaxBytes: () => 0 }) }));
vi.mock('@/shared/utils/imageLoadScheduler', async (original) => {
  const actual = await original<typeof import('@/shared/utils/imageLoadScheduler')>();
  return { ...actual, imageLoadScheduler: new actual.ImageLoadScheduler({ start: 6, min: 6, max: 6 }) };
});

afterEach(() => {
  cleanup();
  resetImageDisplayCaches();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('commits the visible src before an imperative preloader starts with spare capacity', async () => {
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLImageElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 0, bottom: 100, left: 0, right: 100,
  } as DOMRect);
  const visible = 'https://images.example/current.webp';
  const observedDisplaySources: Array<string | null> = [];
  const pending: Array<{ onload: (() => void) | null }> = [];
  vi.stubGlobal('Image', class {
    fetchPriority = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { pending.push(this); }
    set src(value: string) {
      if (value) observedDisplaySources.push(document.querySelector('img[alt="current"]')?.getAttribute('src') ?? null);
    }
  });
  const view = render(<AbortableImage src={visible} alt="current" loading="eager" />);
  const controller = new AbortController();
  const warm = preloadImageSource('https://images.example/next.webp', controller.signal).catch(() => {});
  try {
    // First dispatch grants demand. React's commit acknowledges its actual src;
    // a later dispatch may now start the imperative background transport.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(observedDisplaySources).toEqual([visible]);
    expect(imageLoadScheduler.activeCount).toBe(2);
    await act(async () => { pending[0].onload?.(); await warm; });
    fireEvent.load(view.getByAltText('current'));
    expect(imageLoadScheduler.activeCount).toBe(0);
  } finally {
    controller.abort();
    await warm;
  }
});

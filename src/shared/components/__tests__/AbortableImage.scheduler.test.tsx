// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AbortableImage, preloadImageSource, resetImageDisplayCaches } from '../AbortableImage';
import { imageLoadScheduler, STUCK_MS } from '@/shared/utils/imageLoadScheduler';

const mocks = vi.hoisted(() => ({ native: true, android: false, fileUrl: vi.fn(), ensureCached: vi.fn() }));
vi.mock('@/lib/utils/platform', () => ({ isTauri: () => mocks.native, isCapacitor: () => mocks.android, isAndroid: () => mocks.android }));
vi.mock('@/lib/cache/image-cache', () => ({ getImageCache: async () => ({ fileUrl: mocks.fileUrl, ensureCached: mocks.ensureCached, getMaxBytes: () => 1000 }) }));
vi.mock('@/shared/utils/imageLoadScheduler', async (original) => {
  const actual = await original<typeof import('@/shared/utils/imageLoadScheduler')>();
  return { ...actual, imageLoadScheduler: new actual.ImageLoadScheduler({ start: 2, min: 2, max: 2 }) };
});
const source = (id: string) => `https://aa.gold-usergeneratedcontent.net/${id}.webp`;
const pending: Array<(url: string | null) => void> = [];
const observers: IntersectionObserverCallback[] = [];
const flush = async () => { await act(async () => {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); }
  for (let i = 0; i < 12; i++) await Promise.resolve();
}); };
beforeEach(() => {
  vi.useRealTimers();
  mocks.native = true;
  mocks.android = false;
  resetImageDisplayCaches();
  mocks.fileUrl.mockReset().mockResolvedValue(null);
  mocks.ensureCached.mockReset().mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { observers.push(callback); }
    observe() {} disconnect() {}
  });
  vi.spyOn(HTMLImageElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLImageElement) {
    const top = this.alt === 'far' ? 2000 : this.alt === 'near' ? 1000 : 10;
    return { top, bottom: top + 100, left: 0, right: 100 } as DOMRect;
  });
});
afterEach(async () => {
  cleanup();
  for (const resolve of pending.splice(0)) resolve(null);
  await flush();
  expect(imageLoadScheduler.activeCount).toBe(0);
  expect(imageLoadScheduler.pendingCount).toBe(0);
  observers.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('native cache transport scheduling', () => {
  it('does not download an offscreen lazy native image', async () => {
    render(<AbortableImage src={source('offscreen')} alt="far" />);
    await flush();
    expect(mocks.ensureCached).not.toHaveBeenCalled();
    expect(imageLoadScheduler.activeCount).toBe(0);
  });

  it('admits an existing lazy image when reader demand changes it to eager', async () => {
    const view = render(<AbortableImage src={source('promoted')} alt="far" />);
    await flush();
    expect(mocks.ensureCached).not.toHaveBeenCalled();
    view.rerender(<AbortableImage src={source('promoted')} alt="far" loading="eager" />);
    await flush();
    expect(mocks.ensureCached).toHaveBeenCalledOnce();
  });

  it('ranks eager native misses by actual viewport before starting them', async () => {
    render(<>
      <AbortableImage src={source('far')} alt="far" loading="eager" />
      <AbortableImage src={source('near')} alt="near" loading="eager" />
      <AbortableImage src={source('visible')} alt="visible" loading="eager" />
    </>);
    await flush();
    expect(mocks.ensureCached.mock.calls.map(([src]) => src)).toEqual([source('visible'), source('near')]);
    expect(imageLoadScheduler.activeCount).toBe(2);
  });

  it('joins and promotes a queued native prefetch into reserved demand capacity', async () => {
    const first = new AbortController();
    const second = new AbortController();
    const warmFirst = preloadImageSource(source('first'), first.signal, () => 0).catch(() => {});
    await flush();
    const warmSecond = preloadImageSource(source('second'), second.signal, () => 10).catch(() => {});
    await flush();
    expect(mocks.ensureCached).toHaveBeenCalledTimes(1);
    const view = render(<AbortableImage src={source('second')} alt="visible" loading="eager" />);
    await flush();
    expect(mocks.ensureCached.mock.calls.map(([src]) => src)).toEqual([source('first'), source('second')]);
    expect(imageLoadScheduler.activeCount).toBe(2);
    first.abort(); second.abort(); view.unmount();
    await flush();
    expect(imageLoadScheduler.activeCount).toBe(2); // native work still really runs
    vi.useFakeTimers();
    await act(async () => { await vi.advanceTimersByTimeAsync(STUCK_MS + 1); });
    expect(imageLoadScheduler.activeCount).toBe(2); // no browser deadline releases native work
    vi.useRealTimers();
    expect(imageLoadScheduler.pendingCount).toBe(0);
    pending.splice(0).forEach((resolve) => resolve(null));
    await flush();
    await Promise.all([warmFirst, warmSecond]);
    expect(imageLoadScheduler.activeCount).toBe(0);
  });

  it('cancels obsolete queued native work without starting its transport', async () => {
    const active = new AbortController();
    const cancelled = new AbortController();
    const first = preloadImageSource(source('active'), active.signal).catch(() => {});
    await flush();
    const obsolete = preloadImageSource(source('obsolete'), cancelled.signal).catch(() => {});
    await flush();
    cancelled.abort();
    pending.shift()!(source('file'));
    await flush();
    expect(mocks.ensureCached).toHaveBeenCalledTimes(1);
    expect(imageLoadScheduler.pendingCount).toBe(0);
    await Promise.all([first, obsolete]);
  });

  it('resolves a disk hit even when cold transports occupy every slot', async () => {
    render(<>
      <AbortableImage src={source('a')} alt="visible" loading="eager" />
      <AbortableImage src={source('b')} alt="visible" loading="eager" />
    </>);
    await flush();
    mocks.fileUrl.mockResolvedValue('asset://localhost/cache/hit');
    const view = render(<AbortableImage src={source('hit')} alt="hit" loading="eager" />);
    await flush();
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('asset://localhost/cache/hit');
    expect(mocks.ensureCached).toHaveBeenCalledTimes(2);
    expect(imageLoadScheduler.activeCount).toBe(2);
  });

  it('re-admits a new lazy src while the previous native file URL is still null', async () => {
    const view = render(<AbortableImage src={source('old')} alt="visible" />);
    act(() => observers.at(-1)!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    await flush();
    view.rerender(<AbortableImage src={source('new')} alt="visible" />);
    act(() => observers.at(-1)!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    await flush();
    expect(mocks.ensureCached.mock.calls.map(([src]) => src)).toEqual([source('old'), source('new')]);
  });
});

describe('browser preload budget', () => {
  it('retains an active displayed source when another consumer warms the same URL', async () => {
    mocks.native = false;
    const images: HTMLImageElement[] = [];
    vi.stubGlobal('Image', class {
      src = ''; fetchPriority = ''; onload: (() => void) | null = null; onerror: (() => void) | null = null;
      constructor() { images.push(this as unknown as HTMLImageElement); }
    });
    const url = source('shared-browser');
    const warm = preloadImageSource(url);
    await flush();
    const view = render(<AbortableImage src={url} alt="visible" loading="eager" />);
    await flush();
    const element = view.container.querySelector('img')!;
    expect(element.getAttribute('src')).toBe(url);
    expect(imageLoadScheduler.activeCount).toBe(2);
    await act(async () => { images[0].onload?.(new Event('load')); await warm; });
    view.rerender(<AbortableImage src={url} alt="visible changed" loading="eager" />);
    await flush();
    expect(element.getAttribute('src')).toBe(url);
    expect(imageLoadScheduler.activeCount).toBe(1);
    // Admission-prop changes also must not adopt another consumer's cache state.
    view.rerender(<AbortableImage src={url} alt="visible changed" loading="lazy" />);
    await flush();
    expect(element.getAttribute('src')).toBe(url);
    expect(imageLoadScheduler.activeCount).toBe(1);
    fireEvent.load(element);
    expect(imageLoadScheduler.activeCount).toBe(0);
  });

  it('keeps speculative starts bounded and cancels the real src before releasing', async () => {
    mocks.native = false;
    const images: HTMLImageElement[] = [];
    vi.stubGlobal('Image', class {
      src = ''; fetchPriority = ''; onload: (() => void) | null = null; onerror: (() => void) | null = null;
      constructor() { images.push(this as unknown as HTMLImageElement); }
    });
    const controllers = Array.from({ length: 5 }, () => new AbortController());
    const loads = controllers.map((controller, index) => preloadImageSource(source(String(index)), controller.signal).catch(() => {}));
    await flush();
    expect(images).toHaveLength(1);
    const view = render(<AbortableImage src={source('demand')} alt="visible" loading="eager" />);
    await flush();
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe(source('demand'));
    expect(imageLoadScheduler.activeCount).toBe(2);
    controllers.forEach((controller) => controller.abort());
    expect(images[0].src).toBe('');
    await flush();
    expect(imageLoadScheduler.activeCount).toBe(1);
    expect(imageLoadScheduler.concurrencyLimit).toBe(2);
    fireEvent.load(view.container.querySelector('img')!);
    await Promise.all(loads);
  });

  it('cancels a queued Android cache warm when its displayed source unmounts', async () => {
    mocks.native = false;
    mocks.android = true;
    const first = render(<AbortableImage src={source('android-first')} alt="visible" loading="eager" />);
    await flush();
    fireEvent.load(first.container.querySelector('img')!);
    await flush();
    expect(mocks.ensureCached).toHaveBeenCalledTimes(1);
    const second = render(<AbortableImage src={source('android-second')} alt="visible" loading="eager" />);
    await flush();
    fireEvent.load(second.container.querySelector('img')!);
    await flush();
    expect(imageLoadScheduler.pendingCount).toBe(1);
    second.unmount();
    await flush();
    expect(imageLoadScheduler.pendingCount).toBe(0);
    expect(mocks.ensureCached).toHaveBeenCalledTimes(1);
  });

  it('cancels an old source retry before the recycled image starts another source', async () => {
    mocks.native = false;
    vi.useFakeTimers();
    const view = render(<AbortableImage src={source('old-retry')} alt="visible" loading="eager" />);
    await flush();
    const img = view.container.querySelector('img')!;
    fireEvent.error(img); // schedules a delayed retry of the old src
    view.rerender(<AbortableImage src={source('new-src')} alt="visible" loading="eager" />);
    await flush();
    const assignments = vi.spyOn(img, 'src', 'set');
    await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
    expect(assignments).not.toHaveBeenCalled();
    expect(img.getAttribute('src')).toBe(source('new-src'));
    fireEvent.load(img);
  });

  it('times out an actual browser preload without allowing pending work to escape the cap', async () => {
    mocks.native = false;
    vi.useFakeTimers();
    const images: Array<{ src: string }> = [];
    vi.stubGlobal('Image', class { src = ''; constructor() { images.push(this); } });
    const first = preloadImageSource(source('timeout')).catch((error: Error) => error);
    const controller = new AbortController();
    const queued = preloadImageSource(source('queued'), controller.signal).catch(() => {});
    await flush();
    expect(images).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(STUCK_MS + 1); });
    await flush();
    expect(images[0].src).toBe('');
    expect(images).toHaveLength(2);
    expect(imageLoadScheduler.activeCount).toBe(1);
    expect(await first).toBeInstanceOf(Error);
    controller.abort();
    await queued;
  });
});

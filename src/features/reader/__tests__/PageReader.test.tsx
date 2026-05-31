// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that use them
// ---------------------------------------------------------------------------

let resolveGg: (v: unknown) => void = () => {};
const mockGetGgConfig = vi.fn(() => new Promise((res) => { resolveGg = res; }));

vi.mock('@/lib/api/client', () => ({
  getGgConfig: () => mockGetGgConfig(),
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (sel: (s: { imageFormat: string; dualPage: boolean }) => unknown) =>
    sel({ imageFormat: 'webp', dualPage: false }),
}));

vi.mock('@/lib/utils/image-url', () => ({
  getBestImageUrl: (file: { name: string }) => `https://cdn.example.com/${file.name}.jpg`,
  galleryImageToFile: (img: { name: string; hash: string }) => ({ name: img.name, hash: img.hash }),
}));

// Spy on the virtualizer's scrollToIndex so the open-at-page regression test can
// assert the initial positioning routes through the library API (not a raw
// scrollLeft assignment that clamps short on device).
const { scrollToIndexSpy } = vi.hoisted(() => ({ scrollToIndexSpy: vi.fn() }));

// Deterministic virtualizer: render a windowed slice (≤5) so jsdom (which has no
// layout/scroll) still mounts slides. Mirrors the VirtualGalleryGrid test mock.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => {
    const sz = estimateSize() || 1000;
    return {
      getVirtualItems: () =>
        Array.from({ length: Math.min(count, 5) }, (_, i) => ({ key: i, index: i, start: i * sz, size: sz })),
      getTotalSize: () => count * sz,
      measure: () => {},
      scrollToIndex: scrollToIndexSpy,
    };
  },
}));

// IntersectionObserver stub (required by AbortableImage)
const mockObserve = vi.fn();
const mockDisconnect = vi.fn();
function MockIntersectionObserver(this: IntersectionObserver) {
  (this as unknown as { observe: typeof mockObserve }).observe = mockObserve;
  (this as unknown as { disconnect: typeof mockDisconnect }).disconnect = mockDisconnect;
}

import { PageReader, easeOutCubic } from '../components/PageReader';
import { type GalleryImage, ImageType } from '@/lib/utils/types';
import { __resetAbortableImageCacheForTests } from '@/shared/components/AbortableImage';

const makeImage = (name: string): GalleryImage => ({
  name,
  hash: `hash-${name}`,
  width: 800,
  height: 1200,
  types: new Set([ImageType.WEBP]),
});

const images = [makeImage('001'), makeImage('002'), makeImage('003')];
const fakeGgConfig = { b: 0, m: 0 };

// The reader caps concurrent preloads, so a window only fully warms across
// several microtask rounds (load → finally → pump → next). Flush generously.
async function drainPreloads() {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}

beforeEach(() => {
  mockObserve.mockClear();
  mockDisconnect.mockClear();
  __resetAbortableImageCacheForTests();
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  mockGetGgConfig.mockImplementation(() => new Promise((res) => { resolveGg = res; }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Loading state when ggConfig is null
// ---------------------------------------------------------------------------
describe('PageReader loading state', () => {
  it('renders a loading indicator while ggConfig is loading (urls empty)', () => {
    const { container } = render(<PageReader images={images} currentPage={0} onPageChange={vi.fn()} />);
    expect(container.firstChild).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders images after ggConfig resolves', async () => {
    const { container } = render(<PageReader images={images} currentPage={0} onPageChange={vi.fn()} />);
    expect(container.querySelector('img')).toBeNull();
    await act(async () => { resolveGg(fakeGgConfig); await Promise.resolve(); });
    expect(container.querySelector('img')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AbortableImage usage (opacity:0 before load)
// ---------------------------------------------------------------------------
describe('PageReader image rendering', () => {
  it('renders AbortableImage (opacity:0 before load) instead of bare img', async () => {
    const { container } = render(<PageReader images={images} currentPage={0} onPageChange={vi.fn()} />);
    await act(async () => { resolveGg(fakeGgConfig); await Promise.resolve(); });
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.style.opacity).toBe('0');
  });

  it('every rendered img has opacity:0 (all use AbortableImage, not bare img)', async () => {
    const { container } = render(<PageReader images={images} currentPage={0} onPageChange={vi.fn()} />);
    await act(async () => { resolveGg(fakeGgConfig); await Promise.resolve(); });
    const imgs = container.querySelectorAll('img:not([data-preload])');
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of Array.from(imgs)) {
      expect((img as HTMLElement).style.opacity).toBe('0');
    }
  });
});

// ---------------------------------------------------------------------------
// Preload window — JS Image() warming without pinning decoded bitmaps to the DOM
// ---------------------------------------------------------------------------
describe('PageReader preload window', () => {
  let createdImages: Array<{ srcs: string[] }>;
  let OriginalImage: typeof Image;

  beforeEach(() => {
    createdImages = [];
    OriginalImage = globalThis.Image;
    class MockImage {
      private _src = '';
      fetchPriority = '';
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private _record: { srcs: string[] };
      constructor() { this._record = { srcs: [] }; createdImages.push(this._record); }
      get src() { return this._src; }
      set src(v: string) {
        this._src = v;
        this._record.srcs.push(v);
        // Auto-resolve so the (now concurrency-capped) preload pump drains the
        // whole window across microtasks — mirrors a real successful load.
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('Image', MockImage);
  });
  afterEach(() => { vi.stubGlobal('Image', OriginalImage); });

  it('warms surrounding pages via JS Image() (no DOM <img data-preload>)', async () => {
    const images50 = Array.from({ length: 50 }, (_, i) => makeImage(String(i).padStart(3, '0')));
    const { container } = render(<PageReader images={images50} currentPage={20} onPageChange={vi.fn()} />);
    await act(async () => { resolveGg(fakeGgConfig); await drainPreloads(); });
    expect(container.querySelectorAll('[data-preload="true"]').length).toBe(0);
    expect(createdImages.length).toBe(20);
    const expected = [15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35].map(
      (i) => `https://cdn.example.com/${String(i).padStart(3, '0')}.jpg`,
    );
    const loaded = createdImages.map((r) => r.srcs[r.srcs.length - 1]).sort();
    expect(loaded).toEqual(expected.sort());
  });

  it('clamps preload range at start boundary', async () => {
    const images10 = Array.from({ length: 10 }, (_, i) => makeImage(String(i).padStart(3, '0')));
    render(<PageReader images={images10} currentPage={0} onPageChange={vi.fn()} />);
    await act(async () => { resolveGg(fakeGgConfig); await drainPreloads(); });
    expect(createdImages.length).toBe(9);
  });

  it('warms the new preload window after navigation without DOM preload nodes', async () => {
    const images25 = Array.from({ length: 25 }, (_, i) => makeImage(String(i).padStart(3, '0')));
    const { container, rerender } = render(<PageReader images={images25} currentPage={5} onPageChange={vi.fn()} />);
    await act(async () => { resolveGg(fakeGgConfig); await drainPreloads(); });
    const initialCount = createdImages.length;
    expect(initialCount).toBeGreaterThan(0);
    rerender(<PageReader images={images25} currentPage={20} onPageChange={vi.fn()} />);
    await act(async () => { await drainPreloads(); });
    expect(container.querySelectorAll('[data-preload="true"]').length).toBe(0);
    expect(createdImages.length).toBeGreaterThan(initialCount);
    expect(createdImages.map((r) => r.srcs.at(-1))).toContain('https://cdn.example.com/024.jpg');
  });

  it('does not preload when urls are not yet loaded (ggConfig pending)', () => {
    const images5 = Array.from({ length: 5 }, (_, i) => makeImage(String(i).padStart(3, '0')));
    render(<PageReader images={images5} currentPage={0} onPageChange={vi.fn()} />);
    expect(createdImages.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Native scroll-snap carousel — virtualized track + tap-zone navigation
// (scroll/snap/drag physics is native and exercised in browser QA, not jsdom)
// ---------------------------------------------------------------------------
describe('PageReader native scroll-snap', () => {
  async function mount(currentPage: number, images_: GalleryImage[] = images) {
    const onPageChange = vi.fn();
    const utils = render(<PageReader images={images_} currentPage={currentPage} onPageChange={onPageChange} />);
    await act(async () => { resolveGg(fakeGgConfig); await Promise.resolve(); });
    const scroller = utils.container.firstElementChild as HTMLElement;
    scroller.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 400, bottom: 800, width: 400, height: 800, x: 0, y: 0, toJSON() {} }) as DOMRect;
    return { ...utils, onPageChange, scroller };
  }

  it('renders a horizontal CSS scroll-snap scroll container', async () => {
    const { scroller } = await mount(0);
    expect(scroller.style.scrollSnapType).toBe('x mandatory');
    expect(scroller.className).toContain('overflow-x-auto');
  });

  it('hides the scrollbar on the scroller and on each slide', async () => {
    const { scroller, container } = await mount(0);
    expect(scroller.className).toContain('scrollbar-hide');
    const slide = container.querySelector('[data-slide-index]') as HTMLElement;
    expect(slide.className).toContain('scrollbar-hide');
  });

  it('marks each slide scroll-snap-stop:always so a fast swipe advances exactly one page', async () => {
    const { container } = await mount(0);
    const slides = container.querySelectorAll('[data-slide-index]');
    expect(slides.length).toBeGreaterThan(0);
    for (const slide of Array.from(slides)) {
      expect((slide as HTMLElement).style.scrollSnapStop).toBe('always');
    }
  });

  it('gives the current page image fetchPriority="high" and leaves others default', async () => {
    const { container } = await mount(0);
    const slides = container.querySelectorAll('[data-slide-index]');
    expect(slides.length).toBeGreaterThan(1);
    const currentImg = slides[0].querySelector('img') as HTMLImageElement;
    expect(currentImg.getAttribute('fetchpriority')).toBe('high');
    const otherImg = slides[1].querySelector('img') as HTMLImageElement;
    expect(otherImg.getAttribute('fetchpriority')).toBeNull();
  });

  it('only mounts a windowed subset of slides for a large gallery', async () => {
    const images50 = Array.from({ length: 50 }, (_, i) => makeImage(String(i).padStart(3, '0')));
    const { container } = await mount(0, images50);
    const slides = container.querySelectorAll('[data-slide-index]');
    expect(slides.length).toBeGreaterThan(0);
    expect(slides.length).toBeLessThanOrEqual(5); // virtualized, not all 50
  });

  it('navigates to the next page on a tap in the right half', async () => {
    const { scroller, onPageChange } = await mount(0);
    fireEvent.click(scroller, { clientX: 300, clientY: 400 });
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('navigates to the previous page on a tap in the left half', async () => {
    const { scroller, onPageChange } = await mount(2);
    fireEvent.click(scroller, { clientX: 100, clientY: 400 });
    expect(onPageChange).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// Preload concurrency cap — the visible page must not be starved by a burst of
// warming requests saturating the CDN connection pool ("loading forever").
// ---------------------------------------------------------------------------
describe('PageReader preload concurrency cap', () => {
  let peak: number;
  let active: number;
  let created: number;
  let cleared: number;
  let OriginalImage: typeof Image;

  beforeEach(() => {
    peak = 0; active = 0; created = 0; cleared = 0;
    OriginalImage = globalThis.Image;
    class MockImage {
      private _src = '';
      fetchPriority = '';
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        // Never resolves: these requests stay "in flight" so we can observe the
        // peak number the pump allows concurrently and that abort clears src.
        created += 1;
        active += 1;
        peak = Math.max(peak, active);
      }
      get src() { return this._src; }
      set src(v: string) {
        this._src = v;
        if (v === '') cleared += 1; // abort path sets src='' to cancel the fetch
      }
    }
    vi.stubGlobal('Image', MockImage);
  });
  afterEach(() => { vi.stubGlobal('Image', OriginalImage); });

  it('never fires more than 4 preload requests in flight at once', async () => {
    const images50 = Array.from({ length: 50 }, (_, i) => makeImage(String(i).padStart(3, '0')));
    render(<PageReader images={images50} currentPage={20} onPageChange={vi.fn()} />);
    await act(async () => { resolveGg(fakeGgConfig); await Promise.resolve(); });
    // With no load events firing, the pump fills exactly the cap and waits.
    expect(peak).toBeLessThanOrEqual(4);
    expect(created).toBe(4);
  });

  it('aborts in-flight warms on unmount so connection slots are freed', async () => {
    const images50 = Array.from({ length: 50 }, (_, i) => makeImage(String(i).padStart(3, '0')));
    const { unmount } = render(<PageReader images={images50} currentPage={20} onPageChange={vi.fn()} />);
    await act(async () => { resolveGg(fakeGgConfig); await Promise.resolve(); });
    expect(created).toBe(4);
    expect(cleared).toBe(0); // still in flight
    unmount();
    // Effect cleanup aborts the controller → every in-flight warm clears its src.
    expect(cleared).toBe(4);
  });

  it('aborts the previous page warms when navigating to a new page', async () => {
    const images50 = Array.from({ length: 50 }, (_, i) => makeImage(String(i).padStart(3, '0')));
    const { rerender } = render(<PageReader images={images50} currentPage={20} onPageChange={vi.fn()} />);
    await act(async () => { resolveGg(fakeGgConfig); await Promise.resolve(); });
    expect(created).toBe(4);
    rerender(<PageReader images={images50} currentPage={30} onPageChange={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    // The 4 warms from page 20 were aborted (src cleared) when the effect re-ran.
    expect(cleared).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Page-turn easing — ease-out (fast→slow), replacing native ease-in-out.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Open-at-page positioning — opening a long gallery at a far page must route the
// initial jump through virtualizer.scrollToIndex (survives the measurement race)
// and must NOT let the scroll listener echo a clamped/short position back as the
// page (the device-only "every page past the window opens on page 3" bug).
// ---------------------------------------------------------------------------
describe('PageReader open-at-page positioning', () => {
  const W = 400;
  let clientWidthSpy: PropertyDescriptor | undefined;

  beforeEach(() => {
    scrollToIndexSpy.mockClear();
    // jsdom reports clientWidth 0; give the scroller a real width so the
    // width-gated initial-positioning effect actually runs.
    clientWidthSpy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => W });
    // Run rAF callbacks synchronously so a dispatched scroll event resolves its
    // throttled handler within the test.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    if (clientWidthSpy) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidthSpy);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  });

  async function mountAt(currentPage: number) {
    const onPageChange = vi.fn();
    const images50 = Array.from({ length: 50 }, (_, i) => makeImage(String(i).padStart(3, '0')));
    const utils = render(<PageReader images={images50} currentPage={currentPage} onPageChange={onPageChange} />);
    await act(async () => { resolveGg(fakeGgConfig); await Promise.resolve(); });
    const scroller = utils.container.firstElementChild as HTMLElement;
    return { ...utils, onPageChange, scroller };
  }

  it('routes the initial open-at-page jump through virtualizer.scrollToIndex with the target slide', async () => {
    await mountAt(20);
    expect(scrollToIndexSpy).toHaveBeenCalledWith(20, { align: 'start' });
  });

  it('does not echo a clamped scroll position back as the page during the initial jump', async () => {
    const { scroller, onPageChange } = await mountAt(20);
    // Simulate the device failure: the programmatic jump settles short (the
    // virtual window was still small), so the scroll fires at a low position.
    scroller.scrollLeft = 3 * W;
    await act(async () => { fireEvent.scroll(scroller); await Promise.resolve(); });
    // Suppression must be held: currentPage is NOT overwritten with page 3.
    expect(onPageChange).not.toHaveBeenCalledWith(3);
  });
});

describe('easeOutCubic', () => {
  it('is a decelerating curve: anchored at 0/1 and ahead of linear early on', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    // Fast start: progress outruns time before the midpoint (ease-OUT, not
    // ease-in-out which would lag a linear ramp early).
    expect(easeOutCubic(0.25)).toBeGreaterThan(0.25);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    // Monotonic increasing.
    expect(easeOutCubic(0.75)).toBeGreaterThan(easeOutCubic(0.5));
  });
});

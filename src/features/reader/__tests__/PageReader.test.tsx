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
      scrollToIndex: () => {},
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

import { PageReader } from '../components/PageReader';
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
      set src(v: string) { this._src = v; this._record.srcs.push(v); }
    }
    vi.stubGlobal('Image', MockImage);
  });
  afterEach(() => { vi.stubGlobal('Image', OriginalImage); });

  it('warms surrounding pages via JS Image() (no DOM <img data-preload>)', async () => {
    const images50 = Array.from({ length: 50 }, (_, i) => makeImage(String(i).padStart(3, '0')));
    const { container } = render(<PageReader images={images50} currentPage={20} onPageChange={vi.fn()} />);
    await act(async () => { resolveGg(fakeGgConfig); await Promise.resolve(); });
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
    await act(async () => { resolveGg(fakeGgConfig); await Promise.resolve(); });
    expect(createdImages.length).toBe(9);
  });

  it('warms the new preload window after navigation without DOM preload nodes', async () => {
    const images25 = Array.from({ length: 25 }, (_, i) => makeImage(String(i).padStart(3, '0')));
    const { container, rerender } = render(<PageReader images={images25} currentPage={5} onPageChange={vi.fn()} />);
    await act(async () => { resolveGg(fakeGgConfig); await Promise.resolve(); });
    const initialCount = createdImages.length;
    expect(initialCount).toBeGreaterThan(0);
    rerender(<PageReader images={images25} currentPage={20} onPageChange={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
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

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that use them
// ---------------------------------------------------------------------------

// Stable reference for the resolve callback
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

// IntersectionObserver stub (required by AbortableImage)
const mockObserve = vi.fn();
const mockDisconnect = vi.fn();
function MockIntersectionObserver(
  this: IntersectionObserver,
  _cb: IntersectionObserverCallback,
  _opts?: IntersectionObserverInit,
) {
  (this as unknown as { observe: typeof mockObserve }).observe = mockObserve;
  (this as unknown as { disconnect: typeof mockDisconnect }).disconnect = mockDisconnect;
}

// ---------------------------------------------------------------------------
// Import component AFTER mocks are registered
// ---------------------------------------------------------------------------
import { PageReader } from '../components/PageReader';
import { type GalleryImage, ImageType } from '@/lib/utils/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  // Reset gg promise for each test
  mockGetGgConfig.mockImplementation(() => new Promise((res) => { resolveGg = res; }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Bug 5: loading state when ggConfig is null
// ---------------------------------------------------------------------------
describe('PageReader loading state (Bug 5)', () => {
  it('renders a loading indicator while ggConfig is loading (urls empty)', () => {
    const { container } = render(
      <PageReader images={images} currentPage={0} onPageChange={vi.fn()} />,
    );
    // Must not be blank/null — a loading skeleton/spinner must be present
    expect(container.firstChild).not.toBeNull();
    // No real image should be rendered yet
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders images after ggConfig resolves', async () => {
    const { container } = render(
      <PageReader images={images} currentPage={0} onPageChange={vi.fn()} />,
    );
    // Before resolve — no img
    expect(container.querySelector('img')).toBeNull();

    // Resolve ggConfig
    await act(async () => {
      resolveGg(fakeGgConfig);
      await Promise.resolve();
    });

    // After resolve — img(s) present
    expect(container.querySelector('img')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bug 1: PageReader must use AbortableImage, not bare <img>
// ---------------------------------------------------------------------------
describe('PageReader image rendering (Bug 1)', () => {
  it('renders AbortableImage (opacity:0 before load) instead of bare img', async () => {
    const { container } = render(
      <PageReader images={images} currentPage={0} onPageChange={vi.fn()} />,
    );

    await act(async () => {
      resolveGg(fakeGgConfig);
      await Promise.resolve();
    });

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    // AbortableImage sets opacity:0 before load — bare <img> has no inline opacity
    expect(img!.style.opacity).toBe('0');
  });

  it('every rendered img has opacity:0 (all use AbortableImage, not bare img)', async () => {
    const { container } = render(
      <PageReader images={images} currentPage={0} onPageChange={vi.fn()} />,
    );

    await act(async () => {
      resolveGg(fakeGgConfig);
      await Promise.resolve();
    });

    // Exclude preload imgs — they use visibility:hidden, not opacity:0
    const imgs = container.querySelectorAll('img:not([data-preload])');
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of Array.from(imgs)) {
      expect((img as HTMLElement).style.opacity).toBe('0');
    }
  });
});

// ---------------------------------------------------------------------------
// PageReader preload window — uses JS Image() to warm cache without pinning
// decoded bitmaps to DOM lifetime (prevents OOM under rapid prev/next nav).
// ---------------------------------------------------------------------------
describe('PageReader preload window', () => {
  // Track Image() instances created and the src each was assigned.
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
      constructor() {
        this._record = { srcs: [] };
        createdImages.push(this._record);
      }
      get src() { return this._src; }
      set src(v: string) {
        this._src = v;
        this._record.srcs.push(v);
      }
    }
    vi.stubGlobal('Image', MockImage);
  });

  afterEach(() => {
    vi.stubGlobal('Image', OriginalImage);
  });

  it('warms surrounding pages via JS Image() (no DOM <img data-preload>)', async () => {
    // 50 images, currentPage=20, PRELOAD_BEHIND=5, PRELOAD_AHEAD=15
    // window = [15..35] = 21 indices, skip {20} → 20 Image() preloads
    const images50 = Array.from({ length: 50 }, (_, i) => makeImage(String(i).padStart(3, '0')));

    const { container } = render(
      <PageReader images={images50} currentPage={20} onPageChange={vi.fn()} />,
    );

    await act(async () => {
      resolveGg(fakeGgConfig);
      await Promise.resolve();
    });

    // No hidden DOM preloads (the OOM-causing pattern)
    expect(container.querySelectorAll('[data-preload="true"]').length).toBe(0);

    // JS Image() was used to warm exactly the expected pages
    expect(createdImages.length).toBe(20);
    const expected = [15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35].map(
      (i) => `https://cdn.example.com/${String(i).padStart(3, '0')}.jpg`,
    );
    const loaded = createdImages.map((r) => r.srcs[r.srcs.length - 1]).sort();
    expect(loaded).toEqual(expected.sort());
  });

  it('clamps preload range at start boundary', async () => {
    // 10 images, currentPage=0, PRELOAD_BEHIND=5, PRELOAD_AHEAD=15
    // window = [0..9] = 10 indices, skip {0} → 9 Image() preloads
    const images10 = Array.from({ length: 10 }, (_, i) => makeImage(String(i).padStart(3, '0')));

    render(
      <PageReader images={images10} currentPage={0} onPageChange={vi.fn()} />,
    );

    await act(async () => {
      resolveGg(fakeGgConfig);
      await Promise.resolve();
    });

    expect(createdImages.length).toBe(9);
  });

  it('aborts in-flight preloads on navigation by clearing src', async () => {
    const images25 = Array.from({ length: 25 }, (_, i) => makeImage(String(i).padStart(3, '0')));

    const { rerender } = render(
      <PageReader images={images25} currentPage={5} onPageChange={vi.fn()} />,
    );

    await act(async () => {
      resolveGg(fakeGgConfig);
      await Promise.resolve();
    });

    const initialCount = createdImages.length;
    expect(initialCount).toBeGreaterThan(0);

    // Navigate to a different page — old loaders must have src cleared
    rerender(<PageReader images={images25} currentPage={20} onPageChange={vi.fn()} />);

    await act(async () => { await Promise.resolve(); });

    // Each loader from the first window had its src cleared (last assignment === '')
    const firstWindowLoaders = createdImages.slice(0, initialCount);
    for (const loader of firstWindowLoaders) {
      expect(loader.srcs[loader.srcs.length - 1]).toBe('');
    }
  });

  it('does not preload when urls are not yet loaded (ggConfig pending)', () => {
    const images5 = Array.from({ length: 5 }, (_, i) => makeImage(String(i).padStart(3, '0')));

    render(
      <PageReader images={images5} currentPage={0} onPageChange={vi.fn()} />,
    );

    expect(createdImages.length).toBe(0);
  });
});

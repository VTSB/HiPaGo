// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Mocks — declared before imports that use them
// ---------------------------------------------------------------------------
vi.mock('@/lib/api/client', () => ({
  getGgConfig: () => Promise.resolve({ b: 0, m: 0 }),
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: Object.assign(
    (sel: (s: { imageFormat: string; scrollZoom: number }) => unknown) =>
      sel({ imageFormat: 'webp', scrollZoom: 1 }),
    { getState: () => ({ scrollZoom: 1, setScrollZoom: () => {} }) },
  ),
}));

vi.mock('@/lib/utils/image-url', () => ({
  getBestImageUrl: (file: { name: string }) => `https://cdn.example.com/${file.name}.jpg`,
  galleryImageToFile: (img: { name: string; hash: string }) => ({ name: img.name, hash: img.hash }),
}));

const mockObserve = vi.fn();
const mockDisconnect = vi.fn();
function MockIntersectionObserver(this: IntersectionObserver) {
  (this as unknown as { observe: typeof mockObserve }).observe = mockObserve;
  (this as unknown as { disconnect: typeof mockDisconnect }).disconnect = mockDisconnect;
}

import { ScrollReader } from '../components/ScrollReader';
import { type GalleryImage, ImageType } from '@/lib/utils/types';
import { __resetAbortableImageCacheForTests } from '@/shared/components/AbortableImage';

const makeImage = (name: string): GalleryImage => ({
  name,
  hash: `hash-${name}`,
  width: 800,
  height: 1200,
  types: new Set([ImageType.WEBP]),
});

const ROW_TOP = 1000; // synthetic per-row offset: row index i sits at i*ROW_TOP
let rectSpy: PropertyDescriptor | undefined;
let rafStub: ((cb: FrameRequestCallback) => number) | undefined;

beforeEach(() => {
  mockObserve.mockClear();
  mockDisconnect.mockClear();
  __resetAbortableImageCacheForTests();
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

  // Give each page-row a deterministic synthetic offset keyed off data-page-index.
  // Model real layout: a row's *viewport* top is its document offset minus the
  // scroll container's scrollTop, so the re-assert loop converges (scrolling the
  // target to the top makes its rect.top approach 0) instead of running away.
  // The container itself (no data-page-index) reports top 0.
  const mkRect = (top: number) =>
    ({ top, left: 0, right: 0, bottom: top, width: 0, height: 0, x: 0, y: top, toJSON() {} }) as DOMRect;
  rectSpy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect');
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      const idx = this.dataset?.pageIndex;
      if (idx == null) return mkRect(0);
      let sc: HTMLElement | null = this.parentElement;
      while (sc && !(typeof sc.className === 'string' && sc.className.includes('overflow-auto'))) {
        sc = sc.parentElement;
      }
      return mkRect(Number(idx) * ROW_TOP - (sc ? sc.scrollTop : 0));
    },
  });

  // Run rAF callbacks synchronously so the re-assert loop settles in-test.
  rafStub = (cb: FrameRequestCallback) => { cb(0); return 1; };
  vi.stubGlobal('requestAnimationFrame', rafStub);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  if (rectSpy) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', rectSpy);
  vi.unstubAllGlobals();
});

const images = Array.from({ length: 20 }, (_, i) => makeImage(String(i).padStart(3, '0')));

async function mount(initialPage?: number) {
  const onScrollPositionChange = vi.fn();
  const onVisiblePageChange = vi.fn();
  const scrollCallbackRef = () => {};
  const utils = render(
    <ScrollReader
      images={images}
      initialPage={initialPage}
      onScrollPositionChange={onScrollPositionChange}
      onVisiblePageChange={onVisiblePageChange}
      scrollCallbackRef={scrollCallbackRef}
    />,
  );
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const container = utils.container.firstElementChild as HTMLElement;
  return { ...utils, container };
}

describe('ScrollReader page rows reserve deterministic height', () => {
  it('gives every page wrapper an aspect-ratio so its height is set before images load', async () => {
    const { container } = await mount();
    const rows = container.querySelectorAll('[data-page-index]');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of Array.from(rows)) {
      // 800 / 1200 → the row reserves height independent of image load.
      expect((row as HTMLElement).style.aspectRatio.replace(/\s/g, '')).toBe('800/1200');
    }
  });
});

describe('ScrollReader initial-page scroll', () => {
  it('re-asserts scrollTop until it reaches the requested row (not a one-shot that locks at the top)', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { container } = await mount(5);
    // Reached the synthetic offset of row 5 (5 * ROW_TOP), not stuck near 0.
    expect(container.scrollTop).toBe(5 * ROW_TOP);
    // The buggy implementation used a single scrollIntoView + permanent lock.
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('does not scroll when opened at the first page (index 0)', async () => {
    const { container } = await mount(0);
    expect(container.scrollTop).toBe(0);
  });
});

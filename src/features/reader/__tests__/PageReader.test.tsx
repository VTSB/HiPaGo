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
  getBestImageUrl: () => 'https://cdn.example.com/page.jpg',
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

    const imgs = container.querySelectorAll('img');
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of Array.from(imgs)) {
      expect(img.style.opacity).toBe('0');
    }
  });
});

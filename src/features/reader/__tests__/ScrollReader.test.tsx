// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const mockGetGgConfig = vi.fn();
vi.mock('@/lib/api/client', () => ({
  getGgConfig: () => mockGetGgConfig(),
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: Object.assign(
    (select: (state: { imageFormat: string; scrollZoom: number; locale: 'en' }) => unknown) =>
      select({ imageFormat: 'webp', scrollZoom: 1, locale: 'en' }),
    { getState: () => ({ scrollZoom: 1, setScrollZoom: () => {} }) },
  ),
}));

vi.mock('@/lib/utils/image-url', () => ({
  getBestImageUrl: (file: { name: string }) => `https://cdn.example.com/${file.name}.jpg`,
  galleryImageToFile: (image: { name: string; hash: string }) => ({
    name: image.name,
    hash: image.hash,
  }),
}));

class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
}

type ResizeCallback = ResizeObserverCallback;
const resizeObservers = new Set<MockResizeObserver>();
let viewport = { width: 800, height: 600 };

class MockResizeObserver {
  readonly targets = new Set<Element>();

  constructor(readonly callback: ResizeCallback) {
    resizeObservers.add(this);
  }

  observe(target: Element) {
    this.targets.add(target);
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
    resizeObservers.delete(this);
  }
}

import { ScrollReader } from '../components/ScrollReader';
import { type GalleryImage, ImageType } from '@/lib/utils/types';
import { __resetAbortableImageCacheForTests } from '@/shared/components/AbortableImage';

const makeImage = (index: number): GalleryImage => ({
  name: String(index).padStart(4, '0'),
  hash: `hash-${index}`,
  width: 800,
  height: 1200,
  types: new Set([ImageType.WEBP]),
});

const prototypeDescriptors = new Map<string, PropertyDescriptor | undefined>();

function defineViewportProperty(
  name: 'clientWidth' | 'clientHeight' | 'offsetWidth' | 'offsetHeight',
) {
  prototypeDescriptors.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
  Object.defineProperty(HTMLElement.prototype, name, {
    configurable: true,
    get(this: HTMLElement) {
      if (typeof this.className === 'string' && this.className.includes('overflow-auto')) {
        return name.endsWith('Width') ? viewport.width : viewport.height;
      }
      if (name.endsWith('Height') && this.dataset?.pageIndex != null) {
        const reservedHeight = Number.parseFloat(this.style.height);
        if (Number.isFinite(reservedHeight)) return reservedHeight;
        const image = this.querySelector('img');
        if (image && image.naturalWidth > 0 && image.naturalHeight > 0) {
          return (viewport.width * image.naturalHeight) / image.naturalWidth;
        }
      }
      return 0;
    },
  });
}

function resizeTo(width: number, height: number) {
  viewport = { width, height };
  act(() => {
    for (const observer of resizeObservers) {
      for (const target of observer.targets) {
        observer.callback(
          [
            {
              target,
              borderBoxSize: [{ inlineSize: width, blockSize: height }],
              contentRect: {
                width,
                height,
                top: 0,
                left: 0,
                right: width,
                bottom: height,
                x: 0,
                y: 0,
                toJSON() {},
              },
            } as unknown as ResizeObserverEntry,
          ],
          observer as unknown as ResizeObserver,
        );
      }
    }
  });
}

beforeEach(() => {
  viewport = { width: 800, height: 600 };
  resizeObservers.clear();
  mockGetGgConfig.mockReset();
  mockGetGgConfig.mockResolvedValue({ b: 0, m: 0 });
  __resetAbortableImageCacheForTests();
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});

  for (const name of ['clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight'] as const) {
    defineViewportProperty(name);
  }
  prototypeDescriptors.set(
    'getBoundingClientRect',
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect'),
  );
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      const isViewport =
        typeof this.className === 'string' && this.className.includes('overflow-auto');
      const width = isViewport ? viewport.width : 0;
      const height = isViewport ? viewport.height : 0;
      return {
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        x: 0,
        y: 0,
        toJSON() {},
      } as DOMRect;
    },
  });
});

afterEach(() => {
  for (const [name, descriptor] of prototypeDescriptors) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
  prototypeDescriptors.clear();
  resizeObservers.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mountImages(images: GalleryImage[], initialPage?: number) {
  const onScrollPositionChange = vi.fn();
  const onVisiblePageChange = vi.fn();
  const utils = render(
    <ScrollReader
      images={images}
      initialPage={initialPage}
      onScrollPositionChange={onScrollPositionChange}
      onVisiblePageChange={onVisiblePageChange}
      scrollCallbackRef={() => {}}
      offlineUrls={images.map((image) => `blob:${image.hash}`)}
    />,
  );
  const container = utils.container.firstElementChild as HTMLDivElement;
  return { ...utils, container, images, onScrollPositionChange, onVisiblePageChange };
}

function mount(count = 20, initialPage?: number) {
  return mountImages(
    Array.from({ length: count }, (_, index) => makeImage(index)),
    initialPage,
  );
}

describe('ScrollReader virtual rows', () => {
  it('uses aspect-ratio estimates without forcing that ratio onto the image', () => {
    const { container } = mount();
    const column = container.firstElementChild as HTMLElement;
    const rows = container.querySelectorAll<HTMLElement>('[data-page-index]');

    expect(Number(column.dataset.virtualTotalSize)).toBe(20 * 1200);
    expect(mockGetGgConfig).not.toHaveBeenCalled();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(5);
    for (const row of rows) {
      expect(row.style.height).toBe('1200px');
      expect(row.querySelector('img')?.style.aspectRatio).toBe('');
    }
  });

  it('remeasures a fallback estimate from the decoded natural image ratio', async () => {
    const { container } = mount(2);
    const firstImage = container.querySelector<HTMLImageElement>('[data-page-index="0"] img');
    expect(firstImage).not.toBeNull();
    Object.defineProperties(firstImage!, {
      naturalWidth: { configurable: true, value: 1600 },
      naturalHeight: { configurable: true, value: 800 },
    });

    fireEvent.load(firstImage!);

    await waitFor(() => {
      const firstRow = container.querySelector<HTMLElement>('[data-page-index="0"]');
      const column = container.firstElementChild as HTMLElement;
      // The 800×1200 fallback reserved 1200px. Natural 2:1 content is 400px
      // tall at this viewport, and page 1 retains its 1200px estimate.
      expect(firstRow?.style.height).toBe('');
      expect(Number(column.dataset.virtualTotalSize)).toBe(1600);
    });
  });

  it('shows a retryable source error and recovers', async () => {
    mockGetGgConfig
      .mockRejectedValueOnce(new Error('gg config unavailable'))
      .mockResolvedValueOnce({ b: 0, m: 0 });
    const images = [makeImage(0), makeImage(1)];
    const onScrollPositionChange = vi.fn();
    const { container } = render(
      <ScrollReader
        images={images}
        initialPage={0}
        onScrollPositionChange={onScrollPositionChange}
        onVisiblePageChange={() => {}}
        scrollCallbackRef={() => {}}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('gg config unavailable');
    expect(container.querySelector('img')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(mockGetGgConfig).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();

    const scroller = container.firstElementChild as HTMLDivElement;
    const column = scroller.firstElementChild as HTMLElement;
    expect(Number(column.dataset.virtualTotalSize)).toBe(2 * 1200);

    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 321 });
    fireEvent.scroll(scroller);
    await waitFor(() => expect(onScrollPositionChange).toHaveBeenCalledWith(321));
  });

  it('keeps mounted rows bounded for a 1,000-page gallery', () => {
    const { container } = mount(1000);
    const column = container.firstElementChild as HTMLElement;
    const rows = container.querySelectorAll('[data-page-index]');

    expect(Number(column.dataset.virtualTotalSize)).toBe(1_200_000);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(6);
  });
});

describe('ScrollReader position contracts', () => {
  it('opens directly at an unmounted initial page without scrollIntoView', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { container } = mount(20, 5);

    expect(container.scrollTop).toBe(5 * 1200);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(container.querySelector('[data-page-index="5"]')).not.toBeNull();
  });

  it('clamps an initial last-page request when the viewport is taller than a page', () => {
    viewport = { width: 800, height: 2000 };
    const { container, onVisiblePageChange } = mount(3, 2);

    // Three 1200px pages total 3600px; the browser can scroll only to 1600px.
    expect(container.scrollTop).toBe(1600);
    expect(onVisiblePageChange).toHaveBeenLastCalledWith(2);
  });

  it('does not scroll when opened at the first page', () => {
    const { container } = mount(20, 0);
    expect(container.scrollTop).toBe(0);
  });

  it('supports a page-number jump whose target is outside the mounted range', () => {
    const result = mount(1000, 0);
    expect(result.container.querySelector('[data-page-index="900"]')).toBeNull();
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      result.container.scrollTop = Number(options.top ?? 0);
      result.container.dispatchEvent(new Event('scroll'));
    });
    Object.defineProperty(result.container, 'scrollTo', { configurable: true, value: scrollTo });
    Object.defineProperty(result.container, 'scrollHeight', {
      configurable: true,
      value: 1_200_000,
    });

    result.rerender(
      <ScrollReader
        images={result.images}
        initialPage={900}
        onScrollPositionChange={result.onScrollPositionChange}
        onVisiblePageChange={result.onVisiblePageChange}
        scrollCallbackRef={() => {}}
        offlineUrls={result.images.map((image) => `blob:${image.hash}`)}
      />,
    );

    expect(scrollTo).toHaveBeenCalledWith({ top: 900 * 1200, behavior: 'auto' });
    expect(result.container.scrollTop).toBe(900 * 1200);
    expect(result.container.querySelector('[data-page-index="900"]')).not.toBeNull();
    // The smooth programmatic scroll must not echo an intermediate visible page
    // back into ReaderView and overwrite its requested page.
    expect(result.onVisiblePageChange).not.toHaveBeenCalledWith(900);
  });

  it('waits for smooth scrolling to settle and reports an interrupted position', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const result = mount(1000, 0);
    result.onVisiblePageChange.mockClear();
    act(() => {
      result.container.scrollTop = 1;
      result.container.dispatchEvent(new Event('scroll'));
    });
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      result.container.scrollTop = Number(options.top ?? 0);
      result.container.dispatchEvent(new Event('scroll'));
    });
    Object.defineProperties(result.container, {
      scrollTo: { configurable: true, value: scrollTo },
      scrollHeight: { configurable: true, value: 1_200_000 },
    });

    try {
      result.rerender(
        <ScrollReader
          images={result.images}
          initialPage={900}
          onScrollPositionChange={result.onScrollPositionChange}
          onVisiblePageChange={result.onVisiblePageChange}
          scrollCallbackRef={() => {}}
          offlineUrls={result.images.map((image) => `blob:${image.hash}`)}
        />,
      );
      expect(scrollTo).toHaveBeenCalledWith({ top: 900 * 1200, behavior: 'smooth' });
      expect(result.onVisiblePageChange).not.toHaveBeenCalled();

      // Simulate a user interrupting the smooth scroll at page 400. It must not
      // leak while movement is active, but becomes authoritative after 120ms idle.
      act(() => {
        result.container.scrollTop = 400 * 1200;
        result.container.dispatchEvent(new Event('scroll'));
        vi.advanceTimersByTime(119);
      });
      expect(result.onVisiblePageChange).not.toHaveBeenCalled();

      act(() => vi.advanceTimersByTime(1));
      expect(result.onVisiblePageChange).toHaveBeenLastCalledWith(400);
    } finally {
      result.unmount();
      act(() => vi.runOnlyPendingTimers());
      vi.useRealTimers();
    }
  });

  it('preserves the visible page and its internal position after a width resize', () => {
    const { container, onVisiblePageChange } = mount(1000);
    // 800px wide => each 800x1200 page is 1200px tall. Sit 25% into page 100.
    act(() => {
      container.scrollTop = 100 * 1200 + 300;
      container.dispatchEvent(new Event('scroll'));
    });

    resizeTo(400, 800);

    // 400px wide => 600px rows. The logical anchor remains 25% into page 100.
    expect(container.scrollTop).toBe(100 * 600 + 150);
    expect(container.querySelector('[data-page-index="100"]')).not.toBeNull();
    expect(onVisiblePageChange).toHaveBeenLastCalledWith(100);
  });

  it('tracks the largest visible page fraction when page aspect ratios differ', () => {
    const images = [
      { ...makeImage(0), height: 1600 },
      { ...makeImage(1), height: 200 },
      { ...makeImage(2), height: 1600 },
    ];
    const { container, onVisiblePageChange } = mountImages(images, 0);

    act(() => {
      // Page 1 is fully visible; pages 0 and 2 each contribute the same 200px
      // but only a small fraction of their much taller image.
      container.scrollTop = 1400;
      container.dispatchEvent(new Event('scroll'));
    });

    expect(container.scrollTop).toBe(1400);
    expect(onVisiblePageChange).toHaveBeenLastCalledWith(1);
  });

  it('cancels a queued scroll callback when the reader unmounts', () => {
    const result = mount(20, 0);
    result.onScrollPositionChange.mockClear();
    let nextFrame = 1;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));

    act(() => {
      result.container.scrollTop = 300;
      result.container.dispatchEvent(new Event('scroll'));
    });
    expect(frames.size).toBeGreaterThan(0);

    result.unmount();
    act(() => {
      for (const callback of frames.values()) callback(0);
    });

    expect(result.onScrollPositionChange).not.toHaveBeenCalled();
  });
});

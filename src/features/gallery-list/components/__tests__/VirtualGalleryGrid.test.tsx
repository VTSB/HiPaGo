// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React, { createRef } from 'react';
import { VirtualGalleryGrid, type VirtualGalleryGridHandle } from '../VirtualGalleryGrid';
import { PAGE_SIZE } from '@/lib/utils/constants';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (sel: (s: { gridColumns: number }) => unknown) =>
    sel({ gridColumns: 5 }),
}));

vi.mock('../../hooks/useImagePreloader', () => ({
  useImagePreloader: () => {},
}));

vi.mock('../GalleryCard', () => ({
  GalleryCardById: ({ id }: { id: number }) => (
    <div data-testid={`card-${id}`} data-card-id={id} />
  ),
}));

const mockScrollToIndex = vi.fn();

vi.mock('@tanstack/react-virtual', () => ({
  useWindowVirtualizer: ({
    count,
    estimateSize,
  }: {
    count: number;
    estimateSize: () => number;
    scrollMargin?: number;
    overscan?: number;
  }) => {
    const sz = estimateSize();
    return {
      getVirtualItems: () =>
        Array.from({ length: Math.min(count, 5) }, (_, i) => ({
          key: i,
          index: i,
          start: i * sz,
          size: sz,
        })),
      getTotalSize: () => count * sz,
      scrollToIndex: mockScrollToIndex,
    };
  },
}));

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGetItemId(pages: Map<number, number[]>) {
  return (itemIndex: number): number | null => {
    const pageIndex = Math.floor(itemIndex / PAGE_SIZE);
    const localIndex = itemIndex % PAGE_SIZE;
    return pages.get(pageIndex)?.[localIndex] ?? null;
  };
}

const noop = () => {};

// ---------------------------------------------------------------------------
// Skeleton rendering
// ---------------------------------------------------------------------------

describe('VirtualGalleryGrid — skeleton rendering', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders skeleton cards when getItemId returns null', () => {
    const { container } = render(
      <VirtualGalleryGrid
        totalLength={PAGE_SIZE * 2}
        totalPages={2}
        viewingPage={1}
        getItemId={() => null}
        requestPage={noop}
      />,
    );
    // Each skeleton has 2 animate-pulse divs (image + title bar)
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(screen.queryByTestId(/^card-/)).toBeNull();
  });

  it('renders GalleryCardById when getItemId returns an id', () => {
    const pages = new Map([[0, [10, 20, 30, 40, 50]]]);
    render(
      <VirtualGalleryGrid
        totalLength={5}
        totalPages={1}
        viewingPage={1}
        getItemId={makeGetItemId(pages)}
        requestPage={noop}
      />,
    );
    expect(screen.getByTestId('card-10')).toBeTruthy();
    expect(screen.getByTestId('card-20')).toBeTruthy();
  });

  it('renders skeleton for null slots and cards for loaded slots in same row', () => {
    // Only first 2 of 5 items in page 0 are loaded
    const getItemId = (idx: number) => (idx < 2 ? idx + 1 : null);
    const { container } = render(
      <VirtualGalleryGrid
        totalLength={5}
        totalPages={1}
        viewingPage={1}
        getItemId={getItemId}
        requestPage={noop}
      />,
    );
    expect(screen.getByTestId('card-1')).toBeTruthy();
    expect(screen.getByTestId('card-2')).toBeTruthy();
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders empty placeholder div for itemIndex >= totalLength', () => {
    // totalLength=3 but grid has 5 cols → last 2 slots should be empty divs
    const pages = new Map([[0, [10, 20, 30]]]);
    const { container } = render(
      <VirtualGalleryGrid
        totalLength={3}
        totalPages={1}
        viewingPage={1}
        getItemId={makeGetItemId(pages)}
        requestPage={noop}
      />,
    );
    // 3 real cards, no skeleton, 2 empty divs (no data-item-index, no animate-pulse)
    expect(container.querySelectorAll('[data-card-id]')).toHaveLength(3);
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// data-item-index
// ---------------------------------------------------------------------------

describe('VirtualGalleryGrid — data-item-index', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets data-item-index starting at 0 for page 1', () => {
    const pages = new Map([[0, Array.from({ length: 25 }, (_, i) => i + 1)]]);
    const { container } = render(
      <VirtualGalleryGrid
        totalLength={25}
        totalPages={1}
        viewingPage={1}
        getItemId={makeGetItemId(pages)}
        requestPage={noop}
      />,
    );
    const first = container.querySelector('[data-item-index="0"]');
    expect(first).not.toBeNull();
  });

  it('data-item-index is offset by windowStartItem when window starts at a later page', () => {
    // viewingPage=105 → windowStartPage = max(1, 105-100) = 5
    // windowStartItem = (5-1) * PAGE_SIZE = 4 * 25 = 100
    const pages = new Map([[4, Array.from({ length: 25 }, (_, i) => i + 100)]]);
    const { container } = render(
      <VirtualGalleryGrid
        totalLength={PAGE_SIZE * 200}
        totalPages={200}
        viewingPage={105}
        getItemId={makeGetItemId(pages)}
        requestPage={noop}
      />,
    );
    // First virtual row is row 0, which starts at windowStartItem = 100
    const first = container.querySelector('[data-item-index="100"]');
    expect(first).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// requestPage calls
// ---------------------------------------------------------------------------

describe('VirtualGalleryGrid — requestPage', () => {
  it('calls requestPage for pages covering the visible virtual rows', () => {
    const requestPage = vi.fn();
    render(
      <VirtualGalleryGrid
        totalLength={PAGE_SIZE * 10}
        totalPages={10}
        viewingPage={1}
        getItemId={() => null}
        requestPage={requestPage}
      />,
    );
    // Virtualizer mocks rows 0..4; page 0 covers all with PAGE_SIZE=25 and 5 cols
    expect(requestPage).toHaveBeenCalled();
    expect(requestPage).toHaveBeenCalledWith(0);
  });
});

// ---------------------------------------------------------------------------
// scrollToPage ref
// ---------------------------------------------------------------------------

describe('VirtualGalleryGrid — scrollToPage handle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes scrollToPage via ref', () => {
    const ref = createRef<VirtualGalleryGridHandle>();
    render(
      <VirtualGalleryGrid
        ref={ref}
        totalLength={PAGE_SIZE * 10}
        totalPages={10}
        viewingPage={1}
        getItemId={() => null}
        requestPage={noop}
      />,
    );
    expect(ref.current).not.toBeNull();
    expect(typeof ref.current?.scrollToPage).toBe('function');
  });

  it('scrollToPage calls virtualizer.scrollToIndex', () => {
    vi.useFakeTimers();
    const ref = createRef<VirtualGalleryGridHandle>();
    render(
      <VirtualGalleryGrid
        ref={ref}
        totalLength={PAGE_SIZE * 10}
        totalPages={10}
        viewingPage={1}
        getItemId={() => null}
        requestPage={noop}
      />,
    );
    act(() => {
      ref.current?.scrollToPage(3);
    });
    // scrollToIndex is called inside setTimeout(0)
    vi.runAllTimers();
    vi.useRealTimers();
    expect(mockScrollToIndex).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Sliding window
// ---------------------------------------------------------------------------

describe('VirtualGalleryGrid — sliding window', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => { vi.useRealTimers(); });

  it('window is centered near viewingPage on initial render (sliding window)', () => {
    // viewingPage=150 → windowStartPage = max(1, 150-100) = 50
    // windowStartItem = (50-1)*25 = 1225
    const requestPage = vi.fn();
    const { container } = render(
      <VirtualGalleryGrid
        totalLength={PAGE_SIZE * 500}
        totalPages={500}
        viewingPage={150}
        getItemId={() => null}
        requestPage={requestPage}
      />,
    );
    // First data-item-index should be >= (50-1)*PAGE_SIZE = 1225
    const items = container.querySelectorAll('[data-item-index]');
    if (items.length > 0) {
      const firstIdx = parseInt((items[0] as HTMLElement).dataset.itemIndex ?? '0', 10);
      expect(firstIdx).toBeGreaterThanOrEqual(1225);
    }
    // requestPage should be called with page indices in the window (page 49+)
    const calledPages = requestPage.mock.calls.map((c) => c[0]);
    expect(calledPages.some((p) => p >= 49)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// scrollToItem ref
// ---------------------------------------------------------------------------

describe('VirtualGalleryGrid — scrollToItem handle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes scrollToItem via ref', () => {
    const ref = createRef<VirtualGalleryGridHandle>();
    render(
      <VirtualGalleryGrid
        ref={ref}
        totalLength={PAGE_SIZE * 10}
        totalPages={10}
        viewingPage={1}
        getItemId={() => null}
        requestPage={noop}
      />,
    );
    expect(ref.current).not.toBeNull();
    expect(typeof ref.current?.scrollToItem).toBe('function');
  });

  it('scrollToItem calls virtualizer.scrollToIndex', () => {
    vi.useFakeTimers();
    const ref = createRef<VirtualGalleryGridHandle>();
    render(
      <VirtualGalleryGrid
        ref={ref}
        totalLength={PAGE_SIZE * 10}
        totalPages={10}
        viewingPage={1}
        getItemId={() => null}
        requestPage={noop}
      />,
    );
    act(() => {
      ref.current?.scrollToItem(100);
    });
    vi.runAllTimers();
    vi.useRealTimers();
    expect(mockScrollToIndex).toHaveBeenCalled();
  });
});

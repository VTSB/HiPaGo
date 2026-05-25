// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import React from 'react';

// Container objects for props captured from mock components.
// Populated via useEffect inside each mock (effect runs after render, within act()).
const navPropsRef: { current: Record<string, unknown> } = { current: {} };
const gridPropsRef: { current: Record<string, unknown> } = { current: {} };
const mockScrollToPage = vi.fn();
const mockScrollToItem = vi.fn();
let mockAtParam: string | null = null;
let mockSortParam: string | null = null;
let mockPageParam: string | null = null;

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({
    get: (key: string) => {
      if (key === 'at') return mockAtParam;
      if (key === 'sort') return mockSortParam;
      if (key === 'page') return mockPageParam;
      return null;
    },
  }),
}));

vi.mock('../../hooks/useVirtualGallery', () => ({
  useVirtualGallery: vi.fn(() => ({
    totalLength: 5000,
    requestPage: vi.fn(),
    getItemId: () => null,
    isInitialLoading: false,
    error: null,
  })),
}));

vi.mock('../VirtualGalleryGrid', () => ({
  VirtualGalleryGrid: React.forwardRef(function MockGrid(
    props: Record<string, unknown>,
    ref: React.Ref<unknown>,
  ) {
    React.useEffect(() => {
      gridPropsRef.current = props;
    });
    React.useImperativeHandle(ref, () => ({
      scrollToPage: mockScrollToPage,
      scrollToItem: mockScrollToItem,
    }));
    return <div data-testid="virtual-grid" />;
  }),
}));

vi.mock('@/shared/components/FloatingPageNav', () => ({
  FloatingPageNav: React.forwardRef(function MockNav(
    props: Record<string, unknown>,
    ref: React.Ref<unknown>,
  ) {
    React.useEffect(() => {
      navPropsRef.current = props;
    });
    React.useImperativeHandle(ref, () => ({ suppress: vi.fn() }));
    return <div data-testid="floating-nav" />;
  }),
}));

vi.mock('../GalleryGrid', () => ({
  SkeletonGrid: () => <div data-testid="skeleton" />,
}));

vi.mock('@/shared/components/SortSelector', () => ({
  SortSelector: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <div data-testid="sort-selector" data-sort={value} onClick={() => onChange('popular_year')} />
  ),
}));

vi.mock('@/lib/i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

vi.mock('@/lib/utils/constants', () => ({
  PAGE_SIZE: 25,
}));

describe('GalleryListView — URL state (?at=, ?sort=)', () => {
  let replaceStateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    sessionStorage.clear();
    navPropsRef.current = {};
    gridPropsRef.current = {};
    mockAtParam = null;
    mockSortParam = null;
    mockPageParam = null;
    window.history.replaceState(null, '', '/');
    replaceStateSpy = vi.spyOn(window.history, 'replaceState');
  });

  afterEach(() => {
    vi.useRealTimers();
    replaceStateSpy.mockRestore();
    cleanup();
  });

  it('starts at page 1 when URL has no params', async () => {
    vi.resetModules();
    const { GalleryListView } = await import('../GalleryListView');
    await act(async () => {
      render(<GalleryListView />);
    });
    expect(navPropsRef.current.viewingPage).toBe(1);
  });

  it('reads ?at= and derives viewingPage', async () => {
    mockAtParam = '450';
    vi.resetModules();
    const { GalleryListView } = await import('../GalleryListView');
    await act(async () => {
      render(<GalleryListView />);
    });
    // at=450, PAGE_SIZE=25 → page = floor(450/25) + 1 = 19
    expect(navPropsRef.current.viewingPage).toBe(19);
  });

  it('reads ?sort= from URL', async () => {
    mockSortParam = 'popular_year';
    vi.resetModules();
    const { GalleryListView } = await import('../GalleryListView');
    const { container } = render(<GalleryListView />);
    const sortEl = container.querySelector('[data-testid="sort-selector"]');
    expect(sortEl?.getAttribute('data-sort')).toBe('popular_year');
  });

  it('falls back to date_added for invalid ?sort=', async () => {
    mockSortParam = 'garbage_invalid';
    vi.resetModules();
    const { GalleryListView } = await import('../GalleryListView');
    const { container } = render(<GalleryListView />);
    const sortEl = container.querySelector('[data-testid="sort-selector"]');
    expect(sortEl?.getAttribute('data-sort')).toBe('date_added');
  });

  it('migrates ?page=3 to at=50 when ?at= is absent', async () => {
    mockPageParam = '3';
    vi.resetModules();
    const { GalleryListView } = await import('../GalleryListView');
    await act(async () => {
      render(<GalleryListView />);
    });
    // page=3 → at=(3-1)*25=50 → viewingPage = floor(50/25)+1 = 3
    expect(navPropsRef.current.viewingPage).toBe(3);
  });

  it('writes debounced ?at= to URL via replaceState from visible DOM item', async () => {
    // Add a data-item-index element so the DOM query finds it
    const div = document.createElement('div');
    div.setAttribute('data-item-index', '100');
    div.getBoundingClientRect = () =>
      ({ top: 50, bottom: 60, left: 0, right: 100, width: 100, height: 10 }) as DOMRect;
    document.body.appendChild(div);

    vi.resetModules();
    const { GalleryListView } = await import('../GalleryListView');
    await act(async () => {
      render(<GalleryListView />);
    });
    replaceStateSpy.mockClear();

    const onViewingPageChange = navPropsRef.current.onViewingPageChange as (p: number) => void;
    act(() => {
      onViewingPageChange(5);
    });

    // Before debounce: no replaceState yet
    expect(replaceStateSpy).not.toHaveBeenCalled();

    // After 200ms debounce
    act(() => {
      vi.advanceTimersByTime(200);
    });

    const calls = replaceStateSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastUrl = calls[calls.length - 1]?.[2] as string;
    expect(lastUrl).toContain('at=100');

    document.body.removeChild(div);
  });

  it('omits ?sort= from URL when sort is date_added (default)', async () => {
    vi.resetModules();
    const { GalleryListView } = await import('../GalleryListView');
    await act(async () => {
      render(<GalleryListView />);
    });
    replaceStateSpy.mockClear();

    const onViewingPageChange = navPropsRef.current.onViewingPageChange as (p: number) => void;
    act(() => {
      onViewingPageChange(2);
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    const calls = replaceStateSpy.mock.calls;
    const lastUrl = calls[calls.length - 1]?.[2] as string;
    expect(lastUrl).not.toContain('sort=');
  });

  it('cleans up legacy ?page= param from URL', async () => {
    mockPageParam = '3';
    vi.resetModules();
    const { GalleryListView } = await import('../GalleryListView');
    render(<GalleryListView />);
    replaceStateSpy.mockClear();

    act(() => {
      vi.advanceTimersByTime(200);
    });

    const calls = replaceStateSpy.mock.calls;
    if (calls.length > 0) {
      const lastUrl = calls[calls.length - 1]?.[2] as string;
      expect(lastUrl).not.toContain('page=');
    }
  });

  it('does not use sessionStorage', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    vi.resetModules();
    const { GalleryListView } = await import('../GalleryListView');
    await act(async () => {
      render(<GalleryListView />);
    });
    act(() => {
      (navPropsRef.current.onViewingPageChange as (p: number) => void)(10);
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const galleryCalls = setItemSpy.mock.calls.filter(([key]) => key === 'gallery-list-page');
    expect(galleryCalls).toHaveLength(0);
    setItemSpy.mockRestore();
  });

  it('restores list scroll state from the current history entry', async () => {
    window.history.replaceState(
      {
        hipagoListScrollSnapshot: {
          version: 1,
          url: window.location.pathname + window.location.search,
          at: 175,
          scrollY: 3200,
          ts: Date.now(),
          anchorIndex: 175,
          anchorTop: 0,
          clickedIndex: 180,
          clickedId: 123,
          viewportWidth: 390,
        },
      },
      '',
      window.location.pathname + window.location.search,
    );
    const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);

    vi.resetModules();
    const { GalleryListView } = await import('../GalleryListView');
    await act(async () => {
      render(<GalleryListView />);
    });

    expect(mockScrollToItem).toHaveBeenCalledWith(175);
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 3200, behavior: 'auto' });

    scrollToSpy.mockRestore();
  });

  it('restores history-entry scroll state when only ?at= changed while away', async () => {
    window.history.replaceState(null, '', '/?at=11');
    mockAtParam = '11';
    window.history.replaceState(
      {
        hipagoListScrollSnapshot: {
          version: 1,
          url: '/?at=1',
          at: 25,
          scrollY: 3612,
          ts: Date.now(),
          anchorIndex: 25,
          anchorTop: 0,
          clickedIndex: 26,
          clickedId: 123,
          viewportWidth: 390,
        },
      },
      '',
      '/?at=11',
    );
    const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);

    vi.resetModules();
    const { GalleryListView } = await import('../GalleryListView');
    await act(async () => {
      render(<GalleryListView />);
    });

    expect(mockScrollToItem).toHaveBeenCalledWith(25);
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 3612, behavior: 'auto' });

    scrollToSpy.mockRestore();
  });

  it('restores by anchor offset when grid metrics changed', async () => {
    window.history.replaceState(
      {
        hipagoListScrollSnapshot: {
          version: 1,
          url: '/?at=1',
          at: 25,
          scrollY: 3612,
          ts: Date.now(),
          anchorIndex: 25,
          anchorTop: 48,
          clickedIndex: 26,
          clickedId: 123,
          viewportWidth: 390,
        },
      },
      '',
      '/?at=11',
    );
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 1000 });
    const anchor = document.createElement('div');
    anchor.dataset.itemIndex = '25';
    anchor.getBoundingClientRect = () =>
      ({ top: 120, bottom: 380, left: 0, right: 180, width: 180, height: 260 }) as DOMRect;
    document.body.appendChild(anchor);
    const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);

    vi.resetModules();
    const { GalleryListView } = await import('../GalleryListView');
    await act(async () => {
      render(<GalleryListView />);
    });

    expect(mockScrollToItem).toHaveBeenCalledWith(25);
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 1072, behavior: 'auto' });

    scrollToSpy.mockRestore();
    document.body.removeChild(anchor);
  });

  it('omits ?at= when viewingPage is 1 (clean URL)', async () => {
    vi.resetModules();
    const { GalleryListView } = await import('../GalleryListView');
    render(<GalleryListView />);
    replaceStateSpy.mockClear();

    act(() => {
      vi.advanceTimersByTime(200);
    });

    const calls = replaceStateSpy.mock.calls;
    if (calls.length > 0) {
      const lastUrl = calls[calls.length - 1]?.[2] as string;
      expect(lastUrl).not.toContain('at=');
    }
  });
});

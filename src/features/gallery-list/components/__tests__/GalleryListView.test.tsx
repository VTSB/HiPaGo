// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

const navPropsRef: { current: Record<string, unknown> } = { current: {} };
const mockScrollToPage = vi.fn();
const mockScrollToItem = vi.fn();
const mockRequestPage = vi.fn();
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
    requestPage: mockRequestPage,
    getItemId: () => null,
    isInitialLoading: false,
    error: null,
  })),
}));

vi.mock('../VirtualGalleryGrid', () => ({
  VirtualGalleryGrid: React.forwardRef(function MockGrid(
    _props: Record<string, unknown>,
    ref: React.Ref<unknown>,
  ) {
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
    <button data-testid="sort-selector" data-sort={value} onClick={() => onChange('popular_year')}>
      sort
    </button>
  ),
}));

vi.mock('@/lib/i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

vi.mock('@/lib/utils/constants', () => ({
  PAGE_SIZE: 25,
}));

describe('GalleryListView URL state and native scroll restoration', () => {
  let replaceStateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    navPropsRef.current = {};
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

  it('ignores legacy ?at= and ?page= for initial page', async () => {
    mockAtParam = '450';
    mockPageParam = '3';
    window.history.replaceState(null, '', '/?at=450&page=3');

    vi.resetModules();
    const { GalleryListView } = await import('../GalleryListView');
    await act(async () => {
      render(<GalleryListView />);
    });

    expect(navPropsRef.current.viewingPage).toBe(1);
  });

  it('reads valid ?sort= from URL', async () => {
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

  it('strips legacy ?at= and ?page= without writing scroll position back to URL', async () => {
    mockAtParam = '100';
    mockPageParam = '5';
    mockSortParam = 'popular_year';
    window.history.replaceState(null, '', '/?at=100&page=5&sort=popular_year');

    vi.resetModules();
    const { GalleryListView } = await import('../GalleryListView');
    render(<GalleryListView />);

    const calls = replaceStateSpy.mock.calls;
    const lastUrl = calls[calls.length - 1]?.[2] as string;
    expect(lastUrl).toBe('/?sort=popular_year');
    expect(lastUrl).not.toContain('at=');
    expect(lastUrl).not.toContain('page=');
  });

  it('updates sort in URL on sort change', async () => {
    const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    vi.resetModules();
    const { GalleryListView } = await import('../GalleryListView');
    const { getByTestId } = render(<GalleryListView />);
    replaceStateSpy.mockClear();

    fireEvent.click(getByTestId('sort-selector'));

    const lastUrl = replaceStateSpy.mock.calls.at(-1)?.[2] as string;
    expect(lastUrl).toBe('/?sort=popular_year');
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0 });
    scrollToSpy.mockRestore();
  });

  it('does not use sessionStorage for list position', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    vi.resetModules();
    const { GalleryListView } = await import('../GalleryListView');
    await act(async () => {
      render(<GalleryListView />);
    });
    act(() => {
      (navPropsRef.current.onViewingPageChange as (p: number) => void)(10);
    });
    const galleryCalls = setItemSpy.mock.calls.filter(([key]) => key === 'gallery-list-page');
    expect(galleryCalls).toHaveLength(0);
    setItemSpy.mockRestore();
  });

  it('does not run custom history-state scroll restoration', async () => {
    window.history.replaceState(
      {
        unrelatedAppState: { scrollY: 3200, anchorIndex: 175 },
      },
      '',
      '/',
    );
    const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);

    vi.resetModules();
    const { GalleryListView } = await import('../GalleryListView');
    await act(async () => {
      render(<GalleryListView />);
    });

    expect(mockRequestPage).not.toHaveBeenCalled();
    expect(mockScrollToItem).not.toHaveBeenCalled();
    expect(navPropsRef.current.viewingPage).toBe(1);

    act(() => {
      vi.advanceTimersByTime(16 * 20);
    });
    expect(scrollToSpy).not.toHaveBeenCalled();

    scrollToSpy.mockRestore();
  });
});

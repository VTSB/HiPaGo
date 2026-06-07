// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

let mockQuery = '';
let mockSortParam: string | null = null;
let mockAtParam: string | null = null;
let mockDefaultFilterQuery = '';
const capturedUseQueryOptions: Array<{ queryKey: unknown[]; queryFn?: () => unknown }> = [];

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({
    get: (key: string) => {
      if (key === 'q') return mockQuery;
      if (key === 'sort') return mockSortParam;
      if (key === 'at') return mockAtParam;
      return null;
    },
  }),
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (sel: (s: { language: string; defaultFilterQuery: string }) => unknown) =>
    sel({ language: 'all', defaultFilterQuery: mockDefaultFilterQuery }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn((options: { queryKey: string[]; queryFn?: () => unknown }) => {
    const { queryKey } = options;
    capturedUseQueryOptions.push(options);
    // Return mock search results
    if (queryKey[0] === 'search-ids' && mockQuery) {
      return {
        data: [100, 200, 300, 400, 500],
        isLoading: false,
        isError: false,
      };
    }
    return { data: undefined, isLoading: false, isError: false };
  }),
}));

// Container for props captured from the mock component via useEffect.
const capturedGridRef: { current: Record<string, unknown> | null } = { current: null };

vi.mock('@/features/gallery-list/components/VirtualGalleryGrid', () => ({
  VirtualGalleryGrid: React.forwardRef(function MockGrid(props: Record<string, unknown>, ref: React.Ref<unknown>) {
    React.useEffect(() => { capturedGridRef.current = props; });
    React.useImperativeHandle(ref, () => ({ scrollToPage: vi.fn(), scrollToItem: vi.fn() }));
    return <div data-testid="virtual-gallery-grid" />;
  }),
}));

vi.mock('@/features/gallery-list/components/GalleryCard', () => ({
  GalleryCardById: ({ id }: { id: number }) => <div data-testid={`card-${id}`} />,
}));

vi.mock('@/shared/components/FloatingPageNav', () => ({
  FloatingPageNav: React.forwardRef(function MockNav(_props: unknown, ref: React.Ref<unknown>) {
    React.useImperativeHandle(ref, () => ({ suppress: vi.fn() }));
    return <div data-testid="floating-nav" />;
  }),
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

vi.mock('@/lib/api/search', () => ({
  getGalleryIdsForQuery: vi.fn(() => Promise.resolve([100, 200, 300, 400, 500])),
  parseCompoundQuery: vi.fn((q: string) => q.split(' ')),
}));

vi.mock('@/lib/utils/constants', () => ({
  PAGE_SIZE: 25,
}));

describe('SearchResults — VirtualGalleryGrid integration', () => {
  let replaceStateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedGridRef.current = null;
    capturedUseQueryOptions.length = 0;
    mockQuery = 'female:test';
    mockSortParam = null;
    mockAtParam = null;
    mockDefaultFilterQuery = '';
    window.history.replaceState(null, '', '/search?q=female%3Atest');
    replaceStateSpy = vi.spyOn(window.history, 'replaceState');
  });

  afterEach(() => {
    replaceStateSpy.mockRestore();
    cleanup();
  });

  it('renders VirtualGalleryGrid instead of GalleryGridById for results', async () => {
    vi.resetModules();
    const { SearchResults } = await import('../SearchResults');
    const { container } = render(<SearchResults />);
    expect(container.querySelector('[data-testid="virtual-gallery-grid"]')).not.toBeNull();
  });

  it('passes filteredIds to VirtualGalleryGrid, not allIds', async () => {
    // When query is numeric, the numeric ID should be filtered out of grid results
    mockQuery = '200';
    vi.resetModules();
    const { SearchResults } = await import('../SearchResults');
    render(<SearchResults />);

    if (capturedGridRef.current) {
      const getItemId = capturedGridRef.current.getItemId as (i: number) => number | null;
      // ID 200 should be filtered (shown as featured card), so grid should not contain it
      const gridIds: (number | null)[] = [];
      for (let i = 0; i < 5; i++) gridIds.push(getItemId(i));
      expect(gridIds).not.toContain(200);
    }
  });

  it('combines the user query with the default result filter for execution', async () => {
    mockQuery = 'artist:yam';
    mockDefaultFilterQuery = '-female:loli';
    vi.resetModules();

    const { getGalleryIdsForQuery } = await import('@/lib/api/search');
    const { SearchResults } = await import('../SearchResults');
    render(<SearchResults />);

    const primary = capturedUseQueryOptions.find((o) => o.queryKey[0] === 'search-ids');
    expect(primary?.queryKey).toEqual(['search-ids', 'artist:yam', '-female:loli', 'all', 'date_added']);

    await primary?.queryFn?.();
    expect(getGalleryIdsForQuery).toHaveBeenCalledWith(
      'artist:yam -female:loli',
      'all',
      undefined,
    );
  });

  it('preserves numericId featured card for numeric queries', async () => {
    mockQuery = '12345';
    vi.resetModules();

    // Override useQuery to return results including the numeric ID
    const { useQuery } = await import('@tanstack/react-query');
    vi.mocked(useQuery).mockImplementation((() => ({
      data: [12345, 100, 200],
      isLoading: false,
      isError: false,
    })) as never);

    const { SearchResults } = await import('../SearchResults');
    const { container } = render(<SearchResults />);
    // Featured card should be rendered
    expect(container.querySelector('[data-testid="card-12345"]')).not.toBeNull();
  });

  it('reads ?sort= from URL', async () => {
    mockSortParam = 'popular_year';
    vi.resetModules();
    const { SearchResults } = await import('../SearchResults');
    const { container } = render(<SearchResults />);
    const sortSelector = container.querySelector('[data-testid="sort-selector"]');
    expect(sortSelector?.getAttribute('data-sort')).toBe('popular_year');
  });

  it('strips legacy ?at= and ?page= from URL', async () => {
    mockAtParam = '100';
    window.history.replaceState(null, '', '/search?q=female%3Atest&at=100&page=5');
    vi.resetModules();
    const { SearchResults } = await import('../SearchResults');
    render(<SearchResults />);
    const lastUrl = replaceStateSpy.mock.calls.at(-1)?.[2] as string;
    expect(lastUrl).toBe('/search?q=female%3Atest');
  });

  it('updates sort in URL on sort change', async () => {
    const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    vi.resetModules();
    const { SearchResults } = await import('../SearchResults');
    const { getByTestId } = render(<SearchResults />);
    replaceStateSpy.mockClear();

    fireEvent.click(getByTestId('sort-selector'));

    const lastUrl = replaceStateSpy.mock.calls.at(-1)?.[2] as string;
    expect(lastUrl).toBe('/search?q=female%3Atest&sort=popular_year');
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0 });
    scrollToSpy.mockRestore();
  });

  it('does not render InfiniteScrollTrigger', async () => {
    vi.resetModules();
    const { SearchResults } = await import('../SearchResults');
    const { container } = render(<SearchResults />);
    // InfiniteScrollTrigger should not be in the DOM
    expect(container.querySelector('[data-testid="infinite-scroll-trigger"]')).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // AC-006 — single-term header is human-readable and script-preserving
  // ---------------------------------------------------------------------------
  it('header drops the English type prefix and underscores for a single term', async () => {
    mockQuery = 'female:big_breasts';
    vi.resetModules();
    const { SearchResults } = await import('../SearchResults');
    const { container } = render(<SearchResults />);
    const h1 = container.querySelector('h1');
    expect(h1?.textContent).toBe('search.title: big breasts');
  });

  it('header shows a Korean single-term query in Korean, prefix dropped', async () => {
    mockQuery = '여자:큰_가슴';
    vi.resetModules();
    const { SearchResults } = await import('../SearchResults');
    const { container } = render(<SearchResults />);
    const h1 = container.querySelector('h1');
    expect(h1?.textContent).toBe('search.title: 큰 가슴');
  });

  it('header keeps the raw query for a multi-term search', async () => {
    mockQuery = 'female:loli artist:yam';
    vi.resetModules();
    const { SearchResults } = await import('../SearchResults');
    const { container } = render(<SearchResults />);
    const h1 = container.querySelector('h1');
    expect(h1?.textContent).toBe('search.title: female:loli artist:yam');
  });

  // ---------------------------------------------------------------------------
  // Layout: the multi-term "sort unavailable" message must be able to shrink and
  // wrap so it can't overflow the header row sideways on narrow screens.
  // ---------------------------------------------------------------------------
  it('multi-term sort-unavailable message can shrink + wrap and is not inside a shrink-0 box', async () => {
    mockQuery = 'female:loli artist:yam';
    vi.resetModules();
    const { SearchResults } = await import('../SearchResults');
    const { container } = render(<SearchResults />);

    const msg = [...container.querySelectorAll('p')].find(
      (p) => p.textContent === 'search.sortUnavailable',
    );
    expect(msg).toBeTruthy();
    // allowed to shrink + wrap, right-aligned — not pinned to content width
    expect(msg!.classList.contains('shrink')).toBe(true);
    expect(msg!.classList.contains('shrink-0')).toBe(false);
    expect(msg!.classList.contains('min-w-0')).toBe(true);
    expect(msg!.classList.contains('break-words')).toBe(true);
    expect(msg!.classList.contains('text-right')).toBe(true);
    // the overflow cause was a shrink-0 ancestor — there must be none
    expect(msg!.closest('.shrink-0')).toBeNull();
    // the title column must also be allowed to shrink
    const h1 = container.querySelector('h1');
    expect(h1!.parentElement!.classList.contains('min-w-0')).toBe(true);
  });

  it('single-term header renders the SortSelector in a shrink-0 box (no regression)', async () => {
    mockQuery = 'female:loli';
    vi.resetModules();
    const { SearchResults } = await import('../SearchResults');
    const { container } = render(<SearchResults />);
    const selector = container.querySelector('[data-testid="sort-selector"]');
    expect(selector).not.toBeNull();
    // dropdown stays shrink-0; the message branch is not rendered
    expect(selector!.closest('.shrink-0')).not.toBeNull();
    const msg = [...container.querySelectorAll('p')].find(
      (p) => p.textContent === 'search.sortUnavailable',
    );
    expect(msg).toBeUndefined();
  });
});

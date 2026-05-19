// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';

let mockQuery = '';
let mockSortParam: string | null = null;
let mockAtParam: string | null = null;

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
  useSettingsStore: (sel: (s: { language: string }) => unknown) => sel({ language: 'all' }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(({ queryKey }: { queryKey: string[] }) => {
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
  SortSelector: ({ value }: { value: string }) => <div data-testid="sort-selector" data-sort={value} />,
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
  beforeEach(() => {
    vi.clearAllMocks();
    capturedGridRef.current = null;
    mockQuery = 'female:test';
    mockSortParam = null;
    mockAtParam = null;
  });

  afterEach(() => {
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
});

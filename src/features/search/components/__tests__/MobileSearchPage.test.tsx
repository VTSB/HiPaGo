// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { MobileSearchPage } from '../MobileSearchPage';

const mockPush = vi.fn();
const mockBack = vi.fn();
const mockReplace = vi.fn();
const mockSetQuery = vi.fn();
const mockSetAutocompleteQuery = vi.fn();
const mockClearSuggestions = vi.fn();
const mockAddRecentSearch = vi.fn();
const mockRemoveRecentSearch = vi.fn();
const mockClearRecentSearches = vi.fn();

let mockSuggestions: Array<{ tagType: string; tag: string }> = [];
let mockRecentSearches: string[] = [];
let mockUrlQuery = '';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack, replace: mockReplace }),
  useSearchParams: () => ({ get: (key: string) => (key === 'q' ? mockUrlQuery : '') }),
}));

vi.mock('@/features/search/store/search.store', () => ({
  useSearchStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      query: '',
      suggestions: mockSuggestions,
      recentSearches: mockRecentSearches,
      setQuery: mockSetQuery,
      setAutocompleteQuery: mockSetAutocompleteQuery,
      clearSuggestions: mockClearSuggestions,
      addRecentSearch: mockAddRecentSearch,
      removeRecentSearch: mockRemoveRecentSearch,
      clearRecentSearches: mockClearRecentSearches,
    }),
}));

vi.mock('@/features/search/hooks/useSearch', () => ({ useSearch: vi.fn() }));

vi.mock('@/lib/store/db-status', () => ({
  useDbStatusStore: (selector: (state: { dbReady: boolean }) => unknown) => selector({ dbReady: false }),
}));

vi.mock('@/lib/i18n/useT', () => ({ useT: () => (key: string) => key }));

vi.mock('@/lib/db/search-local', () => ({
  searchLocalTags: vi.fn().mockResolvedValue([]),
}));

// Stub the heavy results grid with a marker so "results shown" is observable
// without pulling in the gallery/data layer. Its presence === committed === true.
vi.mock('@/features/search/components/SearchResults', () => ({
  SearchResults: () => <div data-testid="search-results" />,
}));

function getInput(container: HTMLElement) {
  return container.querySelector('input') as HTMLInputElement;
}

function hasResults(container: HTMLElement) {
  return container.querySelector('[data-testid="search-results"]') !== null;
}

describe('MobileSearchPage — back navigation restores the previous query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSuggestions = [];
    mockRecentSearches = [];
    mockUrlQuery = '';
    // Flush requestAnimationFrame synchronously so the deferred setCommitted
    // settles within act() — keeps the committed-state assertions deterministic.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  it('restores the term in edit mode (no results grid) when going back from /search?q=… to bare /search', () => {
    // Fresh open at bare /search.
    const { container, rerender } = render(<MobileSearchPage />);
    const input = getInput(container);

    // User types and the URL gains ?q=manga (navigation to results).
    act(() => {
      fireEvent.change(input, { target: { value: 'manga' } });
    });
    mockUrlQuery = 'manga';
    act(() => {
      rerender(<MobileSearchPage />);
    });
    // Committed results view is shown for the query URL.
    expect(hasResults(container)).toBe(true);
    expect(getInput(container).value).toBe('manga');

    // Back chevron → router.back() lands on the bare /search (no ?q=).
    mockUrlQuery = '';
    act(() => {
      rerender(<MobileSearchPage />);
    });

    // AC-001: previous term is restored into the input (edit mode).
    expect(getInput(container).value).toBe('manga');
    // AC-003: the stale/blank results grid is gone (committed reset to false).
    expect(hasResults(container)).toBe(false);
  });

  it('leaves the input empty and shows the idle screen on a fresh /search open (no prior query)', () => {
    mockRecentSearches = ['manga'];
    const { container } = render(<MobileSearchPage />);

    // AC-002: empty box, no results grid — the idle popular/recent screen.
    expect(getInput(container).value).toBe('');
    expect(hasResults(container)).toBe(false);
    // The recent-search row renders (idle screen), not a blank page.
    expect(container.textContent).toContain('manga');
  });
});

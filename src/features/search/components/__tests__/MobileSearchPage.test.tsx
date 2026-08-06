// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, fireEvent, screen, waitFor } from '@testing-library/react';
import { MobileSearchPage } from '../MobileSearchPage';
import { TagType, type Suggestion } from '@/lib/utils/types';
import { useSettingsStore } from '@/lib/store/settings';

const { mockSearchLocalTags, mockDbState } = vi.hoisted(() => ({
  mockSearchLocalTags: vi.fn().mockResolvedValue([]),
  mockDbState: { dbReady: false },
}));

const mockPush = vi.fn();
const mockBack = vi.fn();
const mockReplace = vi.fn();
const mockSetQuery = vi.fn();
const mockSetAutocompleteQuery = vi.fn();
const mockClearSuggestions = vi.fn();
const mockAddRecentSearch = vi.fn();
const mockRemoveRecentSearch = vi.fn();
const mockClearRecentSearches = vi.fn();

let mockSuggestions: Array<{ tagType: TagType; tag: string; localName?: string; amount: number }> =
  [];
let mockRecentSearches: string[] = [];
let mockUrlQuery = '';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

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
  useDbStatusStore: (selector: (state: { dbReady: boolean }) => unknown) => selector(mockDbState),
}));

vi.mock('@/lib/i18n/useT', () => ({ useT: () => (key: string) => key }));

vi.mock('@/lib/db/search-local', () => ({
  searchLocalTags: mockSearchLocalTags,
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
    mockDbState.dbReady = false;
    mockSearchLocalTags.mockResolvedValue([]);
    useSettingsStore.setState({ favoriteTags: [] });
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

  it('wraps long tag suggestions inside the mobile row instead of widening the viewport', () => {
    mockSuggestions = [
      {
        tagType: TagType.SERIES,
        tag: 'love live! nijigasaki high school idol club',
        localName: '러브 라이브! 니지가사키 학원 스쿨 아이돌 동호회',
        amount: 1444,
      },
    ];

    const { container } = render(<MobileSearchPage />);
    const input = getInput(container);

    act(() => {
      fireEvent.change(input, { target: { value: '러브' } });
    });

    const option = container.querySelector('[data-search-option]') as HTMLElement;
    expect(option.parentElement).toHaveClass('min-w-0');
    expect(option.parentElement?.querySelector('.min-w-0.flex-1')).not.toBeNull();
    expect(option.parentElement?.querySelector('[data-tag-favorite-chip]')).not.toBeNull();
    expect(screen.getByText('1,444')).toHaveClass('shrink-0', 'tabular-nums');

    const chip = screen.getByText('러브 라이브! 니지가사키 학원 스쿨 아이돌 동호회');
    expect(chip).toHaveClass('max-w-full', 'whitespace-normal', 'break-words');
    expect(chip).toHaveStyle({ overflowWrap: 'anywhere' });
  });

  it('toggles an autocomplete favorite without selecting the suggestion and reorders immediately', async () => {
    mockSuggestions = [
      { tagType: TagType.ARTIST, tag: 'regular artist', amount: 100 },
      { tagType: TagType.ARTIST, tag: 'favorite artist', amount: 1 },
    ];

    const { container } = render(<MobileSearchPage />);
    const input = getInput(container);
    act(() => {
      fireEvent.change(input, { target: { value: 'artist' } });
    });

    expect(container.querySelectorAll('[data-search-option]')[0]).toHaveTextContent(
      'regular artist',
    );
    const favoriteButton = container.querySelector(
      'button[data-tag-favorite-key="artist:favorite_artist"]',
    ) as HTMLButtonElement;
    expect(favoriteButton).not.toBeNull();
    expect(favoriteButton.parentElement?.closest('button')).toBeNull();
    expect(screen.getByRole('list', { name: 'search.tagSuggestions' })).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    favoriteButton.focus();
    expect(favoriteButton).toHaveFocus();
    fireEvent.keyDown(favoriteButton, { key: ' ', code: 'Space' });

    await act(async () => {
      fireEvent.mouseDown(favoriteButton);
      fireEvent.click(favoriteButton);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useSettingsStore.getState().favoriteTags).toContain('artist:favorite_artist');
    expect(favoriteButton).toHaveFocus();
    expect(container.querySelectorAll('[data-search-option]')[0]).toHaveTextContent(
      'favorite artist',
    );
    expect(input).toHaveValue('artist');
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockAddRecentSearch).not.toHaveBeenCalled();
  });

  it('toggles a popular-tag favorite without running the popular-tag navigation action', async () => {
    mockDbState.dbReady = true;
    mockSearchLocalTags.mockResolvedValue([
      { tagType: TagType.TAG, tag: 'popular tag', amount: 100 },
    ]);

    const { container } = render(<MobileSearchPage />);

    await waitFor(() => {
      expect(
        container.querySelector('button[data-tag-favorite-key="tag:popular_tag"]'),
      ).not.toBeNull();
    });
    const favoriteButton = container.querySelector(
      'button[data-tag-favorite-key="tag:popular_tag"]',
    ) as HTMLButtonElement;
    expect(favoriteButton.parentElement?.closest('button')).toBeNull();

    await act(async () => {
      fireEvent.mouseDown(favoriteButton);
      fireEvent.click(favoriteButton);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useSettingsStore.getState().favoriteTags).toContain('tag:popular_tag');
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockAddRecentSearch).not.toHaveBeenCalled();
  });

  it('preserves a popular favorite button focus when its row moves to the front', async () => {
    mockDbState.dbReady = true;
    mockSearchLocalTags.mockResolvedValue([
      { tagType: TagType.TAG, tag: 'popular regular', amount: 100 },
      { tagType: TagType.TAG, tag: 'popular favorite', amount: 1 },
    ]);
    const { container } = render(<MobileSearchPage />);
    await waitFor(() => {
      expect(
        container.querySelector('button[data-tag-favorite-key="tag:popular_favorite"]'),
      ).not.toBeNull();
    });
    const favoriteButton = container.querySelector(
      'button[data-tag-favorite-key="tag:popular_favorite"]',
    ) as HTMLButtonElement;
    favoriteButton.focus();
    fireEvent.keyDown(favoriteButton, { key: ' ', code: 'Space' });

    await act(async () => {
      fireEvent.click(favoriteButton);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(favoriteButton).toHaveFocus();
    const renderedTags = Array.from(container.querySelectorAll('[data-tag-key]')).map((element) =>
      element.getAttribute('data-tag-key'),
    );
    expect(renderedTags).toEqual(['tag:popular_favorite', 'tag:popular_regular']);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('reloads popular tags when favorites change so a low-count favorite can join the list', async () => {
    mockDbState.dbReady = true;
    mockSearchLocalTags
      .mockResolvedValueOnce([{ tagType: TagType.TAG, tag: 'popular regular', amount: 100 }])
      .mockResolvedValueOnce([
        { tagType: TagType.TAG, tag: 'popular favorite', amount: 1 },
        { tagType: TagType.TAG, tag: 'popular regular', amount: 100 },
      ]);

    const { container } = render(<MobileSearchPage />);
    await waitFor(() => expect(mockSearchLocalTags).toHaveBeenCalledTimes(1));

    act(() => {
      useSettingsStore.setState({ favoriteTags: ['tag:popular_favorite'] });
    });

    await waitFor(() => expect(mockSearchLocalTags).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const renderedTags = Array.from(container.querySelectorAll('[data-tag-key]')).map((element) =>
        element.getAttribute('data-tag-key'),
      );
      expect(renderedTags).toEqual(['tag:popular_favorite', 'tag:popular_regular']);
    });
  });

  it('ignores a stale popular-tag response after favorites trigger a newer request', async () => {
    mockDbState.dbReady = true;
    const staleRequest = deferred<Suggestion[]>();
    mockSearchLocalTags
      .mockReturnValueOnce(staleRequest.promise)
      .mockResolvedValueOnce([{ tagType: TagType.TAG, tag: 'latest favorite', amount: 1 }]);

    const { container } = render(<MobileSearchPage />);
    await waitFor(() => expect(mockSearchLocalTags).toHaveBeenCalledTimes(1));

    act(() => {
      useSettingsStore.setState({ favoriteTags: ['tag:latest_favorite'] });
    });
    await waitFor(() => expect(mockSearchLocalTags).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(container.querySelector('[data-tag-key="tag:latest_favorite"]')).not.toBeNull();
    });

    await act(async () => {
      staleRequest.resolve([{ tagType: TagType.TAG, tag: 'stale regular', amount: 100 }]);
      await staleRequest.promise;
      await Promise.resolve();
    });

    expect(container.querySelector('[data-tag-key="tag:latest_favorite"]')).not.toBeNull();
    expect(container.querySelector('[data-tag-key="tag:stale_regular"]')).toBeNull();
  });
});

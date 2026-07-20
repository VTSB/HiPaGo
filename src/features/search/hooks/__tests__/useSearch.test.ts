// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSearch } from '../useSearch';
import { useSettingsStore } from '@/lib/store/settings';

type SearchState = {
  query: string;
  autocompleteQuery: string | null;
  suggestions: unknown[];
  isSearching: boolean;
  isLoadingSuggestions: boolean;
  recentSearches: string[];
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject } as Deferred<T>;
};

const mockSetQuery = vi.fn();
const mockSetAutocompleteQuery = vi.fn();
const mockAddRecentSearch = vi.fn();
const mockSetIsSearching = vi.fn();
const mockSetSuggestions = vi.fn();
const mockClearSuggestions = vi.fn();
const mockSetIsLoadingSuggestions = vi.fn();
const mockSearchLocalTags = vi.fn();
const mockGetSuggestionsForQuery = vi.fn();

let storeState: SearchState = {
  query: '',
  autocompleteQuery: null,
  suggestions: [],
  isSearching: false,
  isLoadingSuggestions: false,
  recentSearches: [],
};

let dbReady = true;

vi.mock('@/features/search/store/search.store', () => ({
  useSearchStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      ...storeState,
      setQuery: mockSetQuery,
      setAutocompleteQuery: mockSetAutocompleteQuery,
      addRecentSearch: mockAddRecentSearch,
      setIsSearching: mockSetIsSearching,
      setSuggestions: mockSetSuggestions,
      clearSuggestions: mockClearSuggestions,
      setIsLoadingSuggestions: mockSetIsLoadingSuggestions,
    }),
}));

vi.mock('@/lib/store/db-status', () => ({
  useDbStatusStore: (selector: (state: { dbReady: boolean }) => unknown) => selector({ dbReady }),
}));

vi.mock('@/lib/db/search-local', () => ({
  searchLocalTags: (...args: unknown[]) => mockSearchLocalTags(...args),
}));

vi.mock('@/lib/api/search', () => ({
  getSuggestionsForQuery: (...args: unknown[]) => mockGetSuggestionsForQuery(...args),
  parseQuery: (query: string) => {
    const colonIndex = query.indexOf(':');
    if (colonIndex <= 0) return { tagType: undefined, tag: query };
    return { tagType: query.slice(0, colonIndex), tag: query.slice(colonIndex + 1) };
  },
}));

describe('useSearch autocomplete term selection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    storeState = {
      query: '',
      autocompleteQuery: null,
      suggestions: [],
      isSearching: false,
      isLoadingSuggestions: false,
      recentSearches: [],
    };
    dbReady = true;
    useSettingsStore.setState({ favoriteTags: [] });
    mockSearchLocalTags.mockResolvedValue([]);
    mockGetSuggestionsForQuery.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('prefers autocompleteQuery over the last token of the full query', async () => {
    const pending = createDeferred<unknown[]>();
    mockSearchLocalTags.mockReturnValueOnce(pending.promise);

    storeState = {
      ...storeState,
      query: 'start female:loli middle artist:foo tail',
      autocompleteQuery: 'female:',
    };

    renderHook(() => useSearch());

    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    expect(mockSearchLocalTags).toHaveBeenCalledWith('', 'female');

    pending.resolve([{ tag: 'tag-from-prefixed-query' }]);
    await Promise.resolve();
    expect(mockSetSuggestions).toHaveBeenCalledTimes(1);
  });

  it('does not fetch suggestions when autocompleteQuery is null', async () => {
    storeState = {
      ...storeState,
      query: 'female:loli artist:foo',
      autocompleteQuery: null,
    };

    renderHook(() => useSearch());

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockClearSuggestions).toHaveBeenCalledTimes(1);

    expect(mockSearchLocalTags).not.toHaveBeenCalled();
    expect(mockGetSuggestionsForQuery).not.toHaveBeenCalled();
  });

  it('fetches local suggestions immediately for single-character terms', async () => {
    const pending = createDeferred<unknown[]>();
    mockSearchLocalTags.mockReturnValueOnce(pending.promise);

    storeState = {
      ...storeState,
      query: 'f',
      autocompleteQuery: 'f',
    };

    renderHook(() => useSearch());

    await Promise.resolve();

    expect(mockSearchLocalTags).toHaveBeenCalledTimes(1);
    expect(mockSearchLocalTags).toHaveBeenCalledWith('f', undefined);
    expect(mockGetSuggestionsForQuery).not.toHaveBeenCalled();

    pending.resolve([{ tag: 'female' }]);
    await Promise.resolve();

    expect(mockSetSuggestions).toHaveBeenCalledWith([{ tag: 'female' }]);
  });

  it('debounces local autocomplete for 2+ char terms at 100ms', async () => {
    const pending = createDeferred<unknown[]>();
    mockSearchLocalTags.mockReturnValueOnce(pending.promise);

    storeState = {
      ...storeState,
      query: 'female:loli artist:foo',
      autocompleteQuery: 'female:l',
    };

    renderHook(() => useSearch());

    await vi.advanceTimersByTimeAsync(99);
    expect(mockSearchLocalTags).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mockSearchLocalTags).toHaveBeenCalledTimes(1);
    expect(mockSearchLocalTags).toHaveBeenCalledWith('l', 'female');

    pending.resolve([{ tag: 'female' }]);
    await Promise.resolve();

    expect(mockSetSuggestions).toHaveBeenCalledWith([{ tag: 'female' }]);
  });

  it('debounces remote autocomplete for 2+ char terms at 200ms when dbReady is false', async () => {
    const pending = createDeferred<unknown[]>();
    mockGetSuggestionsForQuery.mockReturnValueOnce(pending.promise);
    dbReady = false;

    storeState = {
      ...storeState,
      autocompleteQuery: 'zz',
    };

    renderHook(() => useSearch());

    await vi.advanceTimersByTimeAsync(199);
    expect(mockGetSuggestionsForQuery).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mockGetSuggestionsForQuery).toHaveBeenCalledTimes(1);
    expect(mockGetSuggestionsForQuery).toHaveBeenCalledWith('zz');

    pending.resolve([{ tag: 'remote-suggestion' }]);
    await Promise.resolve();

    expect(mockSearchLocalTags).not.toHaveBeenCalled();
    expect(mockSetSuggestions).toHaveBeenCalledWith([{ tag: 'remote-suggestion' }]);
  });

  // ---------------------------------------------------------------------------
  // AC-003 — Hangul input must not hit the English-only remote tagindex API
  // while the local tag DB is not ready (it would 400 on every keystroke).
  // ---------------------------------------------------------------------------
  it('does not call remote getSuggestionsForQuery for Hangul input when dbReady is false', async () => {
    dbReady = false;

    storeState = {
      ...storeState,
      autocompleteQuery: '여자',
    };

    renderHook(() => useSearch());

    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();

    expect(mockGetSuggestionsForQuery).not.toHaveBeenCalled();
    expect(mockSearchLocalTags).not.toHaveBeenCalled();
    expect(mockClearSuggestions).toHaveBeenCalled();
  });

  it('still calls remote getSuggestionsForQuery for English input when dbReady is false', async () => {
    dbReady = false;
    mockGetSuggestionsForQuery.mockResolvedValueOnce([{ tag: 'english-remote' }]);

    storeState = {
      ...storeState,
      autocompleteQuery: 'loli',
    };

    renderHook(() => useSearch());

    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    expect(mockGetSuggestionsForQuery).toHaveBeenCalledWith('loli');
  });

  it('uses parsed prefixed tag path before local lookup', async () => {
    const pending = createDeferred<unknown[]>();
    mockSearchLocalTags.mockReturnValueOnce(pending.promise);

    storeState = {
      ...storeState,
      autocompleteQuery: 'male:dr',
    };

    renderHook(() => useSearch());

    await vi.advanceTimersByTimeAsync(100);
    expect(mockSearchLocalTags).toHaveBeenCalledWith('dr', 'male');

    pending.resolve([{ tag: 'male:dragon' }]);
    await Promise.resolve();

    expect(mockSetSuggestions).toHaveBeenCalledWith([{ tag: 'male:dragon' }]);
  });

  it('refetches local autocomplete when favorites change so a limited-out item can join', async () => {
    mockSearchLocalTags
      .mockResolvedValueOnce([{ tag: 'regular-result' }])
      .mockResolvedValueOnce([{ tag: 'favorite-result' }, { tag: 'regular-result' }]);
    storeState = {
      ...storeState,
      autocompleteQuery: 'artist:ar',
    };

    renderHook(() => useSearch());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(mockSearchLocalTags).toHaveBeenCalledTimes(1);

    act(() => {
      useSettingsStore.setState({ favoriteTags: ['artist:favorite_result'] });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(mockSearchLocalTags).toHaveBeenCalledTimes(2);
    expect(mockSetSuggestions).toHaveBeenLastCalledWith([
      { tag: 'favorite-result' },
      { tag: 'regular-result' },
    ]);
  });

  it('does not refetch remote autocomplete when favorites change', async () => {
    dbReady = false;
    mockGetSuggestionsForQuery.mockResolvedValue([{ tag: 'remote-result' }]);
    storeState = {
      ...storeState,
      autocompleteQuery: 'remote',
    };

    renderHook(() => useSearch());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(mockGetSuggestionsForQuery).toHaveBeenCalledTimes(1);

    act(() => {
      useSettingsStore.setState({ favoriteTags: ['artist:new_favorite'] });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(mockGetSuggestionsForQuery).toHaveBeenCalledTimes(1);
  });

  it('suppresses stale local results when a later query resolves later', async () => {
    const firstLookup = createDeferred<unknown[]>();
    const secondLookup = createDeferred<unknown[]>();
    mockSearchLocalTags
      .mockReturnValueOnce(firstLookup.promise)
      .mockReturnValueOnce(secondLookup.promise);

    storeState = {
      ...storeState,
      autocompleteQuery: 'first',
    };

    const { rerender } = renderHook(() => useSearch());

    await vi.advanceTimersByTimeAsync(100);
    expect(mockSearchLocalTags).toHaveBeenCalledTimes(1);

    storeState = {
      ...storeState,
      autocompleteQuery: 'second',
    };
    rerender();

    await vi.advanceTimersByTimeAsync(100);
    expect(mockSearchLocalTags).toHaveBeenCalledTimes(2);

    firstLookup.resolve([{ tag: 'old-result' }]);
    await Promise.resolve();
    secondLookup.resolve([{ tag: 'latest-result' }]);
    await Promise.resolve();

    expect(mockSetSuggestions).toHaveBeenCalledTimes(1);
    expect(mockSetSuggestions).toHaveBeenCalledWith([{ tag: 'latest-result' }]);
  });
});

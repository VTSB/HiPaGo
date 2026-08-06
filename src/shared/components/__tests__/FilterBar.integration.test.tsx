// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { FilterBar } from '../FilterBar';
import { useDbStatusStore } from '@/lib/store/db-status';
import { useSettingsStore } from '@/lib/store/settings';
import type { Suggestion } from '@/lib/utils/types';

const { mockSearchLocalTags, mockGetSuggestionsForQuery } = vi.hoisted(() => ({
  mockSearchLocalTags: vi.fn().mockResolvedValue([]),
  mockGetSuggestionsForQuery: vi.fn().mockResolvedValue([]),
}));

let onSuggestionSelect: ((tag: string, tagType: string, localName?: string) => void) | null = null;
let onSuggestionHover: ((index: number) => void) | null = null;
let lastDropdownSuggestions: Suggestion[] | null = null;
let lastSelectedIndex = -1;
let lastKoreanDisplay: boolean | undefined = undefined;

/** A manually-resolvable promise, for deterministic race tests. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Mock SearchInput as a simple controlled input so FilterBar logic is testable
// ---------------------------------------------------------------------------
vi.mock('@/shared/components/SearchInput', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');

  function MockSearchInput({
    value = '',
    onChange,
    onClear,
    onKeyDown,
    onFocus,
    onBlur,
    inputRef,
    placeholder,
  }: {
    value?: string;
    onChange?: (v: string) => void;
    onClear?: () => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    inputRef?: React.Ref<HTMLInputElement>;
    placeholder?: string;
    [key: string]: unknown;
  }) {
    const inputEl = React.createElement('input', {
      key: 'main-input',
      autoComplete: 'off',
      value,
      placeholder,
      ref: inputRef,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange?.(e.target.value),
      onFocus: () => onFocus?.(),
      onBlur: () => onBlur?.(),
      onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => onKeyDown?.(e),
    });

    const clearBtn = onClear
      ? React.createElement(
          'button',
          {
            key: 'clear',
            'data-testid': 'clear-all',
            onClick: () => onClear(),
          },
          '×',
        )
      : null;

    return React.createElement('div', null, inputEl, clearBtn);
  }

  return { SearchInput: MockSearchInput };
});

vi.mock('@/shared/utils/parse-token', () => ({
  parseToken: (token: string) => {
    const m = token.match(/^(\w+):(.+)$/);
    if (!m) return null;
    return { type: m[1], tag: m[2] };
  },
}));

vi.mock('@/lib/utils/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils/types')>();
  return {
    ...actual,
    getTagColor: () => 'bg-gray-200',
    TAG_TYPE_DISPLAY: { female: ' ♀', male: ' ♂' } as Record<string, string>,
  };
});

vi.mock('@/lib/db/search-local', () => ({
  searchLocalTags: mockSearchLocalTags,
}));

vi.mock('@/lib/api/search', () => ({
  getSuggestionsForQuery: mockGetSuggestionsForQuery,
}));

vi.mock('@/shared/hooks/useClickOutside', () => ({
  useClickOutside: vi.fn(),
}));

vi.mock('@/features/search/components/SuggestionDropdown', () => ({
  SuggestionDropdown: (props: {
    onSelect: (tag: string, tagType: string, localName?: string) => void;
    onHover: (index: number) => void;
    suggestions: Suggestion[];
    selectedIndex: number;
    koreanDisplay?: boolean;
  }) => {
    onSuggestionSelect = props.onSelect;
    onSuggestionHover = props.onHover;
    lastDropdownSuggestions = props.suggestions;
    lastSelectedIndex = props.selectedIndex;
    lastKoreanDisplay = props.koreanDisplay;
    return (
      <div data-testid="suggestion-dropdown">
        <button type="button" data-testid="filter-dropdown-favorite">
          favorite
        </button>
      </div>
    );
  },
}));

function getMainInput(container: HTMLElement) {
  return container.querySelector('input[autocomplete="off"]') as HTMLInputElement;
}

describe('FilterBar integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    onSuggestionSelect = null;
    onSuggestionHover = null;
    lastDropdownSuggestions = null;
    lastSelectedIndex = -1;
    lastKoreanDisplay = undefined;
    mockSearchLocalTags.mockResolvedValue([]);
    mockGetSuggestionsForQuery.mockResolvedValue([]);
    useSettingsStore.setState({ favoriteTags: [] });
    // Default to a ready tag DB so the local-search path is exercised.
    useDbStatusStore.setState({ dbReady: true });
  });

  afterEach(() => {
    act(() => {
      useDbStatusStore.setState({ dbReady: false });
      useSettingsStore.setState({ favoriteTags: [] });
    });
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('selecting a suggestion inserts tag into value and calls onFilterChange', async () => {
    mockSearchLocalTags.mockResolvedValue([{ tagType: 'female', tag: 'loli', amount: 10 }]);
    const onFilterChange = vi.fn();
    const { container, getByTestId } = render(
      <FilterBar onFilterChange={onFilterChange} placeholder="Search..." />,
    );
    const mainInput = getMainInput(container);

    // Type a tag prefix to trigger autocomplete
    act(() => {
      fireEvent.change(mainInput, { target: { value: 'female:lo' } });
    });

    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    expect(mockSearchLocalTags).toHaveBeenCalledWith('lo', 'female', 10);
    expect(getByTestId('suggestion-dropdown')).toBeTruthy();

    // Click a suggestion
    act(() => {
      onSuggestionSelect?.('loli', 'female');
    });
    act(() => {
      vi.runAllTimers();
    });

    const calls = onFilterChange.mock.calls;
    const lastCall = calls[calls.length - 1][0];
    expect(lastCall.tags).toEqual([{ type: 'female', name: 'loli' }]);
    expect(lastCall.titleQuery).toBe('');
  });

  it('reorders an open suggestion list immediately when favorites change', async () => {
    mockSearchLocalTags.mockResolvedValue([
      { tagType: 'artist', tag: 'regular artist', amount: 100 },
      { tagType: 'artist', tag: 'favorite artist', amount: 1 },
    ]);
    const { container } = render(<FilterBar onFilterChange={vi.fn()} placeholder="Search..." />);
    const mainInput = getMainInput(container);

    act(() => {
      fireEvent.change(mainInput, { target: { value: 'artist:ar' } });
    });
    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(lastDropdownSuggestions?.map((suggestion) => suggestion.tag)).toEqual([
      'regular artist',
      'favorite artist',
    ]);

    act(() => {
      useSettingsStore.setState({ favoriteTags: ['artist:favorite_artist'] });
    });

    expect(lastDropdownSuggestions?.map((suggestion) => suggestion.tag)).toEqual([
      'favorite artist',
      'regular artist',
    ]);
  });

  it('refetches local suggestions so a newly favored limited-out item can join', async () => {
    mockSearchLocalTags
      .mockResolvedValueOnce([{ tagType: 'artist', tag: 'regular artist', amount: 100 }])
      .mockResolvedValueOnce([
        { tagType: 'artist', tag: 'hidden favorite', amount: 1 },
        { tagType: 'artist', tag: 'regular artist', amount: 100 },
      ]);
    const { container } = render(<FilterBar onFilterChange={vi.fn()} placeholder="Search..." />);
    const mainInput = getMainInput(container);

    act(() => {
      fireEvent.change(mainInput, { target: { value: 'artist:ar' } });
    });
    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockSearchLocalTags).toHaveBeenCalledTimes(1);
    expect(lastDropdownSuggestions?.map((suggestion) => suggestion.tag)).toEqual([
      'regular artist',
    ]);

    act(() => {
      useSettingsStore.setState({ favoriteTags: ['artist:hidden_favorite'] });
    });
    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockSearchLocalTags).toHaveBeenCalledTimes(2);
    expect(lastDropdownSuggestions?.map((suggestion) => suggestion.tag)).toEqual([
      'hidden favorite',
      'regular artist',
    ]);
  });

  it('does not refetch remote suggestions when favorites change', async () => {
    useDbStatusStore.setState({ dbReady: false });
    mockGetSuggestionsForQuery.mockResolvedValue([
      { tagType: 'artist', tag: 'remote regular', amount: 100 },
      { tagType: 'artist', tag: 'remote favorite', amount: 1 },
    ]);
    const { container } = render(<FilterBar onFilterChange={vi.fn()} placeholder="Search..." />);
    const mainInput = getMainInput(container);

    act(() => {
      fireEvent.change(mainInput, { target: { value: 'artist:ar' } });
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockGetSuggestionsForQuery).toHaveBeenCalledTimes(1);

    act(() => {
      useSettingsStore.setState({ favoriteTags: ['artist:remote_favorite'] });
    });
    expect(lastDropdownSuggestions?.map((suggestion) => suggestion.tag)).toEqual([
      'remote favorite',
      'remote regular',
    ]);
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });

    expect(mockGetSuggestionsForQuery).toHaveBeenCalledTimes(1);
  });

  it('clears a stale hovered index when its item moves after becoming a favorite', async () => {
    mockSearchLocalTags.mockResolvedValue([
      { tagType: 'artist', tag: 'regular artist', amount: 100 },
      { tagType: 'artist', tag: 'selected artist', amount: 1 },
    ]);
    const { container } = render(<FilterBar onFilterChange={vi.fn()} placeholder="Search..." />);
    const mainInput = getMainInput(container);

    act(() => {
      fireEvent.change(mainInput, { target: { value: 'artist:ar' } });
    });
    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      onSuggestionHover?.(1);
    });
    expect(lastSelectedIndex).toBe(1);

    act(() => {
      useSettingsStore.setState({ favoriteTags: ['artist:selected_artist'] });
    });
    expect(lastDropdownSuggestions?.map((suggestion) => suggestion.tag)).toEqual([
      'selected artist',
      'regular artist',
    ]);
    expect(lastSelectedIndex).toBe(-1);

    act(() => {
      fireEvent.keyDown(mainInput, { key: 'Enter', code: 'Enter' });
    });

    expect(mainInput).toHaveValue('artist:ar');
  });

  it('keeps the dropdown open when Tab moves focus from the input into it', async () => {
    mockSearchLocalTags.mockResolvedValue([{ tagType: 'artist', tag: 'focus artist', amount: 1 }]);
    const { container, getByTestId } = render(
      <FilterBar onFilterChange={vi.fn()} placeholder="Search..." />,
    );
    const mainInput = getMainInput(container);

    act(() => {
      fireEvent.change(mainInput, { target: { value: 'artist:fo' } });
    });
    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
      await Promise.resolve();
    });

    const favoriteButton = getByTestId('filter-dropdown-favorite');
    fireEvent.keyDown(mainInput, { key: 'Tab', code: 'Tab' });
    fireEvent.blur(mainInput);
    favoriteButton.focus();
    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(favoriteButton).toHaveFocus();
    expect(getByTestId('suggestion-dropdown')).toBeInTheDocument();
  });

  it('typing plain text calls onFilterChange with titleQuery', () => {
    const onFilterChange = vi.fn();
    const { container } = render(
      <FilterBar onFilterChange={onFilterChange} placeholder="Search..." />,
    );
    const mainInput = getMainInput(container);

    act(() => {
      fireEvent.change(mainInput, { target: { value: 'hello' } });
    });

    act(() => {
      vi.runAllTimers();
    });

    const calls = onFilterChange.mock.calls;
    const lastCall = calls[calls.length - 1][0];
    expect(lastCall.tags).toEqual([]);
    expect(lastCall.titleQuery).toBe('hello');
  });

  it('typing mixed tag and plain text produces correct tags and titleQuery', () => {
    const onFilterChange = vi.fn();
    const { container } = render(
      <FilterBar onFilterChange={onFilterChange} placeholder="Search..." />,
    );
    const mainInput = getMainInput(container);

    act(() => {
      fireEvent.change(mainInput, { target: { value: 'female:loli hello' } });
    });

    act(() => {
      vi.runAllTimers();
    });

    const calls = onFilterChange.mock.calls;
    const lastCall = calls[calls.length - 1][0];
    expect(lastCall.tags).toEqual([{ type: 'female', name: 'loli' }]);
    expect(lastCall.titleQuery).toBe('hello');
  });

  it('undo restores the previous filter state', async () => {
    mockSearchLocalTags.mockResolvedValue([{ tagType: 'female', tag: 'loli', amount: 10 }]);
    const onFilterChange = vi.fn();
    const { container } = render(
      <FilterBar onFilterChange={onFilterChange} placeholder="Search..." />,
    );
    const mainInput = getMainInput(container);

    // Type a tag prefix and select suggestion
    act(() => {
      fireEvent.change(mainInput, { target: { value: 'female:lo' } });
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    act(() => {
      onSuggestionSelect?.('loli', 'female');
    });
    act(() => {
      vi.runAllTimers();
    });

    const afterInsert = onFilterChange.mock.calls[onFilterChange.mock.calls.length - 1][0];
    expect(afterInsert.tags).toHaveLength(1);

    // Ctrl+Z to undo
    act(() => {
      fireEvent.keyDown(mainInput, { key: 'z', ctrlKey: true, code: 'KeyZ' });
    });
    act(() => {
      vi.runAllTimers();
    });

    // After undo, value is restored to what it was before insertSuggestion
    const afterUndo = onFilterChange.mock.calls[onFilterChange.mock.calls.length - 1][0];
    expect(afterUndo.tags).toEqual([]);
  });

  it('clear button clears value and notifies onFilterChange', async () => {
    mockSearchLocalTags.mockResolvedValue([{ tagType: 'female', tag: 'loli', amount: 10 }]);
    const onFilterChange = vi.fn();
    const { container, getByTestId } = render(
      <FilterBar onFilterChange={onFilterChange} placeholder="Search..." />,
    );
    const mainInput = getMainInput(container);

    // Type some text
    act(() => {
      fireEvent.change(mainInput, { target: { value: 'female:loli hello' } });
    });
    act(() => {
      vi.runAllTimers();
    });

    // Click clear
    act(() => {
      fireEvent.click(getByTestId('clear-all'));
    });
    act(() => {
      vi.runAllTimers();
    });

    const calls = onFilterChange.mock.calls;
    const lastCall = calls[calls.length - 1][0];
    expect(lastCall.tags).toEqual([]);
    expect(lastCall.titleQuery).toBe('');
  });

  it('shows suggestion dropdown when token has 2+ chars after colon', async () => {
    mockSearchLocalTags.mockResolvedValue([{ tagType: 'female', tag: 'lion', amount: 10 }]);

    const onFilterChange = vi.fn();
    const { container, getByTestId } = render(
      <FilterBar onFilterChange={onFilterChange} placeholder="Search..." />,
    );
    const mainInput = getMainInput(container);

    act(() => {
      fireEvent.change(mainInput, { target: { value: 'female:li' } });
    });

    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    expect(mockSearchLocalTags).toHaveBeenCalledWith('li', 'female', 10);
    expect(getByTestId('suggestion-dropdown')).toBeTruthy();

    // Selecting the suggestion inserts it into value
    act(() => {
      onSuggestionSelect?.('lion', 'female');
    });
    act(() => {
      vi.runAllTimers();
    });

    const lastCall = onFilterChange.mock.calls[onFilterChange.mock.calls.length - 1][0];
    expect(lastCall.tags).toEqual([{ type: 'female', name: 'lion' }]);
    expect(lastCall.titleQuery).toBe('');
  });

  // ---------------------------------------------------------------------------
  // AC-002 — remote fallback while the local tag DB is still syncing
  // ---------------------------------------------------------------------------
  it('uses remote getSuggestionsForQuery when the tag DB is not ready', async () => {
    useDbStatusStore.setState({ dbReady: false });
    mockGetSuggestionsForQuery.mockResolvedValue([{ tagType: 'female', tag: 'remote', amount: 7 }]);

    const { container } = render(<FilterBar onFilterChange={vi.fn()} placeholder="Search..." />);
    const mainInput = getMainInput(container);

    act(() => {
      fireEvent.change(mainInput, { target: { value: 'female:lo' } });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(mockGetSuggestionsForQuery).toHaveBeenCalledWith('female:lo');
    expect(mockSearchLocalTags).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // AC-003 — Hangul input must not hit the English-only remote tagindex API
  // while the local tag DB is not ready.
  // ---------------------------------------------------------------------------
  it('skips remote getSuggestionsForQuery for Hangul input when the tag DB is not ready', async () => {
    useDbStatusStore.setState({ dbReady: false });

    const { container } = render(<FilterBar onFilterChange={vi.fn()} placeholder="Search..." />);
    const mainInput = getMainInput(container);

    act(() => {
      fireEvent.change(mainInput, { target: { value: '여자:로리' } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(mockGetSuggestionsForQuery).not.toHaveBeenCalled();
    expect(mockSearchLocalTags).not.toHaveBeenCalled();
  });

  it('still uses remote getSuggestionsForQuery for English input when the tag DB is not ready', async () => {
    useDbStatusStore.setState({ dbReady: false });
    mockGetSuggestionsForQuery.mockResolvedValue([{ tagType: 'female', tag: 'remote', amount: 7 }]);

    const { container } = render(<FilterBar onFilterChange={vi.fn()} placeholder="Search..." />);
    const mainInput = getMainInput(container);

    act(() => {
      fireEvent.change(mainInput, { target: { value: 'female:lo' } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(mockGetSuggestionsForQuery).toHaveBeenCalledWith('female:lo');
  });

  // ---------------------------------------------------------------------------
  // AC-001 — autocomplete re-queries the local DB the moment dbReady flips true
  // ---------------------------------------------------------------------------
  it('switches to local DB search automatically when the tag DB becomes ready', async () => {
    useDbStatusStore.setState({ dbReady: false });
    mockGetSuggestionsForQuery.mockResolvedValue([]);
    mockSearchLocalTags.mockResolvedValue([{ tagType: 'female', tag: 'loli', amount: 10 }]);

    const { container } = render(<FilterBar onFilterChange={vi.fn()} placeholder="Search..." />);
    const mainInput = getMainInput(container);

    // Query typed while the DB is still syncing — remote path runs.
    act(() => {
      fireEvent.change(mainInput, { target: { value: 'female:lo' } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mockGetSuggestionsForQuery).toHaveBeenCalled();
    expect(mockSearchLocalTags).not.toHaveBeenCalled();

    // Tag DB finishes syncing — effect must re-run on the dbReady transition
    // without the user editing the input.
    act(() => {
      useDbStatusStore.setState({ dbReady: true });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });

    expect(mockSearchLocalTags).toHaveBeenCalledWith('lo', 'female', 10);
  });

  // ---------------------------------------------------------------------------
  // AC-003 — a stale in-flight remote response cannot overwrite the fresh
  // local result produced after the dbReady transition.
  // ---------------------------------------------------------------------------
  it('discards a stale remote response that resolves after the dbReady transition', async () => {
    useDbStatusStore.setState({ dbReady: false });
    const remote = deferred<Suggestion[]>();
    mockGetSuggestionsForQuery.mockReturnValue(remote.promise);
    mockSearchLocalTags.mockResolvedValue([{ tagType: 'female', tag: 'localtag', amount: 5 }]);

    const { container } = render(<FilterBar onFilterChange={vi.fn()} placeholder="Search..." />);
    const mainInput = getMainInput(container);

    // Remote request fires and stays in-flight (deferred not yet resolved).
    act(() => {
      fireEvent.change(mainInput, { target: { value: 'female:lo' } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mockGetSuggestionsForQuery).toHaveBeenCalled();

    // DB becomes ready — local search supersedes the in-flight remote request.
    act(() => {
      useDbStatusStore.setState({ dbReady: true });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(lastDropdownSuggestions).toEqual([{ tagType: 'female', tag: 'localtag', amount: 5 }]);

    // Stale remote response resolves late — the request-id guard must drop it.
    await act(async () => {
      remote.resolve([{ tagType: 'female', tag: 'stale-remote', amount: 99 }] as Suggestion[]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(lastDropdownSuggestions).toEqual([{ tagType: 'female', tag: 'localtag', amount: 5 }]);
  });

  // ---------------------------------------------------------------------------
  // AC-004 — autocomplete display is input-script-aware
  // ---------------------------------------------------------------------------
  it('drives koreanDisplay=false for an English active token', async () => {
    mockSearchLocalTags.mockResolvedValue([
      { tagType: 'female', tag: 'loli', amount: 10, localName: '로리' },
    ]);
    const { container } = render(<FilterBar onFilterChange={vi.fn()} placeholder="Search..." />);
    const mainInput = getMainInput(container);

    act(() => {
      fireEvent.change(mainInput, { target: { value: 'female:lo' } });
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    expect(lastKoreanDisplay).toBe(false);
  });

  it('drives koreanDisplay=true for a Korean active token', async () => {
    mockSearchLocalTags.mockResolvedValue([
      { tagType: 'female', tag: 'loli', amount: 10, localName: '로리' },
    ]);
    const { container } = render(<FilterBar onFilterChange={vi.fn()} placeholder="Search..." />);
    const mainInput = getMainInput(container);

    act(() => {
      fireEvent.change(mainInput, { target: { value: '여자:로리' } });
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    // Korean type label resolves to the English type byte for the DB query.
    expect(mockSearchLocalTags).toHaveBeenCalledWith('로리', 'female', 10);
    expect(lastKoreanDisplay).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // AC-005 — clicking a suggestion inserts a script-matching token
  // ---------------------------------------------------------------------------
  it('inserts an English token when the user is typing English', async () => {
    mockSearchLocalTags.mockResolvedValue([
      { tagType: 'female', tag: 'loli', amount: 10, localName: '로리' },
    ]);
    const onFilterChange = vi.fn();
    const { container } = render(
      <FilterBar onFilterChange={onFilterChange} placeholder="Search..." />,
    );
    const mainInput = getMainInput(container);

    act(() => {
      fireEvent.change(mainInput, { target: { value: 'female:lo' } });
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    act(() => {
      onSuggestionSelect?.('loli', 'female', '로리');
    });
    act(() => {
      vi.runAllTimers();
    });

    expect(getMainInput(container).value).toBe('female:loli ');
  });

  it('inserts a Korean type-qualified token when the user is typing Korean', async () => {
    mockSearchLocalTags.mockResolvedValue([
      { tagType: 'female', tag: 'loli', amount: 10, localName: '로리' },
    ]);
    const onFilterChange = vi.fn();
    const { container } = render(
      <FilterBar onFilterChange={onFilterChange} placeholder="Search..." />,
    );
    const mainInput = getMainInput(container);

    act(() => {
      fireEvent.change(mainInput, { target: { value: '여자:로리' } });
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    act(() => {
      onSuggestionSelect?.('loli', 'female', '로리');
    });
    act(() => {
      vi.runAllTimers();
    });

    expect(getMainInput(container).value).toBe('여자:로리 ');
  });
});

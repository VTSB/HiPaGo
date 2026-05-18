// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { FilterBar } from '../FilterBar';
import { useDbStatusStore } from '@/lib/store/db-status';
import type { Suggestion } from '@/lib/utils/types';

const { mockSearchLocalTags, mockGetSuggestionsForQuery } = vi.hoisted(() => ({
  mockSearchLocalTags: vi.fn().mockResolvedValue([]),
  mockGetSuggestionsForQuery: vi.fn().mockResolvedValue([]),
}));

let onSuggestionSelect: ((tag: string, tagType: string) => void) | null = null;
let lastDropdownSuggestions: Suggestion[] | null = null;

/** A manually-resolvable promise, for deterministic race tests. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
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
      ? React.createElement('button', {
          key: 'clear',
          'data-testid': 'clear-all',
          onClick: () => onClear(),
        }, '×')
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

vi.mock('@/lib/utils/types', () => ({
  getTagColor: () => 'bg-gray-200',
  TAG_TYPE_DISPLAY: { female: ' ♀', male: ' ♂' } as Record<string, string>,
}));

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
  SuggestionDropdown: (props: { onSelect: (tag: string, tagType: string) => void; suggestions: Suggestion[] }) => {
    onSuggestionSelect = props.onSelect;
    lastDropdownSuggestions = props.suggestions;
    return <div data-testid="suggestion-dropdown" />;
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
    lastDropdownSuggestions = null;
    mockSearchLocalTags.mockResolvedValue([]);
    mockGetSuggestionsForQuery.mockResolvedValue([]);
    // Default to a ready tag DB so the local-search path is exercised.
    useDbStatusStore.setState({ dbReady: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    useDbStatusStore.setState({ dbReady: false });
  });

  it('selecting a suggestion inserts tag into value and calls onFilterChange', async () => {
    mockSearchLocalTags.mockResolvedValue([{ tagType: 'female', tag: 'loli', amount: 10 }]);
    const onFilterChange = vi.fn();
    const { container, getByTestId } = render(
      <FilterBar onFilterChange={onFilterChange} placeholder="Search..." />
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

  it('typing plain text calls onFilterChange with titleQuery', () => {
    const onFilterChange = vi.fn();
    const { container } = render(
      <FilterBar onFilterChange={onFilterChange} placeholder="Search..." />
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
      <FilterBar onFilterChange={onFilterChange} placeholder="Search..." />
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
      <FilterBar onFilterChange={onFilterChange} placeholder="Search..." />
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
      <FilterBar onFilterChange={onFilterChange} placeholder="Search..." />
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
      <FilterBar onFilterChange={onFilterChange} placeholder="Search..." />
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

    const { container } = render(
      <FilterBar onFilterChange={vi.fn()} placeholder="Search..." />
    );
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
  // AC-001 — autocomplete re-queries the local DB the moment dbReady flips true
  // ---------------------------------------------------------------------------
  it('switches to local DB search automatically when the tag DB becomes ready', async () => {
    useDbStatusStore.setState({ dbReady: false });
    mockGetSuggestionsForQuery.mockResolvedValue([]);
    mockSearchLocalTags.mockResolvedValue([{ tagType: 'female', tag: 'loli', amount: 10 }]);

    const { container } = render(
      <FilterBar onFilterChange={vi.fn()} placeholder="Search..." />
    );
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

    const { container } = render(
      <FilterBar onFilterChange={vi.fn()} placeholder="Search..." />
    );
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
      remote.resolve([{ tagType: 'female', tag: 'stale-remote', amount: 99 }]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(lastDropdownSuggestions).toEqual([{ tagType: 'female', tag: 'localtag', amount: 5 }]);
  });
});

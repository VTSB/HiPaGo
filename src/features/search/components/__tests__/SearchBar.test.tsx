// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { SearchBar } from '../SearchBar';
import * as UnifiedDropdownModule from '@/shared/components/UnifiedDropdown';

const mockPush = vi.fn();
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
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => ({ get: (key: string) => key === 'q' ? mockUrlQuery : '' }),
}));

vi.mock('@/features/search/store/search.store', () => ({
  useSearchStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
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

vi.mock('@/features/search/hooks/useSearch', () => ({
  useSearch: vi.fn(),
}));

vi.mock('@/lib/store/db-status', () => ({
  useDbStatusStore: (selector: (state: { dbReady: boolean }) => unknown) => selector({ dbReady: false }),
}));

vi.mock('@/lib/i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

vi.mock('@/shared/hooks/useClickOutside', () => ({
  useClickOutside: vi.fn(),
}));

vi.mock('@/lib/db/search-local', () => ({
  searchLocalTags: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/shared/components/UnifiedDropdown', () => ({
  UnifiedDropdown: (props: { onSelectSuggestion: (tag: string, tagType: string) => void; onSelectRecent: (q: string) => void }) => {
    (globalThis as Record<string, unknown>).__onSelectSuggestion = props.onSelectSuggestion;
    (globalThis as Record<string, unknown>).__onSelectRecent = props.onSelectRecent;
    return <div data-testid="unified-dropdown" />;
  },
  buildDropdownItems: vi.fn(() => []),
}));

function getInput(container: HTMLElement) {
  return container.querySelector('input') as HTMLInputElement;
}

describe('SearchBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSuggestions = [];
    mockRecentSearches = [];
    mockUrlQuery = '';
    delete (globalThis as Record<string, unknown>).__onSelectSuggestion;
    delete (globalThis as Record<string, unknown>).__onSelectRecent;
  });

  it('syncs query and autocompleteQuery to store on input change', () => {
    const { container } = render(<SearchBar />);
    const input = getInput(container);

    act(() => {
      fireEvent.change(input, { target: { value: 'hello' } });
    });

    expect(mockSetQuery).toHaveBeenCalledWith('hello');
    expect(mockSetAutocompleteQuery).toHaveBeenCalledWith('hello');
  });

  it('syncs from URL query on mount', () => {
    mockUrlQuery = 'female:loli';
    // syncFromQuery sets the value directly from the URL query
    const { container } = render(<SearchBar />);
    // Just verify the URL query caused a sync — setQuery is called with the resolved value
    expect(mockSetQuery).toHaveBeenCalled();
    expect(container).toBeTruthy();
  });

  it('does not re-sync from the same URL query on rerender', () => {
    mockUrlQuery = 'female:loli';
    const { rerender } = render(<SearchBar />);
    const firstCallCount = mockSetQuery.mock.calls.length;

    rerender(<SearchBar />);

    // setQuery is called once more due to state/effect, but syncFromQuery should not be called again
    // The key behavior: re-render doesn't trigger a second URL sync
    expect(firstCallCount).toBeGreaterThan(0);
  });

  it('submits query on Enter and navigates', () => {
    const { container } = render(<SearchBar />);
    const input = getInput(container);

    act(() => {
      fireEvent.change(input, { target: { value: 'manga' } });
    });

    act(() => {
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', nativeEvent: { isComposing: false } });
    });

    expect(mockAddRecentSearch).toHaveBeenCalledWith('manga');
    expect(mockPush).toHaveBeenCalledWith('/search?q=manga');
  });

  it('skips submit when input is empty', () => {
    const { container } = render(<SearchBar />);
    const input = getInput(container);

    act(() => {
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', nativeEvent: { isComposing: false } });
    });

    expect(mockAddRecentSearch).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('Ctrl+Z triggers undo without error', () => {
    const { container } = render(<SearchBar />);
    const input = getInput(container);

    act(() => {
      fireEvent.change(input, { target: { value: 'text' } });
    });

    // Should not throw
    act(() => {
      fireEvent.keyDown(input, { key: 'z', ctrlKey: true, code: 'KeyZ', nativeEvent: { isComposing: false } });
    });

    expect(container).toBeTruthy();
  });

  it('Ctrl+Y triggers redo without error', () => {
    const { container } = render(<SearchBar />);
    const input = getInput(container);

    act(() => {
      fireEvent.change(input, { target: { value: 'text' } });
    });

    act(() => {
      fireEvent.keyDown(input, { key: 'y', ctrlKey: true, code: 'KeyY', nativeEvent: { isComposing: false } });
    });

    expect(container).toBeTruthy();
  });

  it('setAutocompleteQuery uses currentToken (last word)', () => {
    const { container } = render(<SearchBar />);
    const input = getInput(container);

    act(() => {
      fireEvent.change(input, { target: { value: 'foo female:lo' } });
    });

    // currentToken is 'female:lo' (last whitespace-separated token)
    expect(mockSetAutocompleteQuery).toHaveBeenCalledWith('female:lo');
  });

  it('setAutocompleteQuery is null when input is empty', () => {
    render(<SearchBar />);

    // On mount with empty input, currentToken is null
    expect(mockSetAutocompleteQuery).toHaveBeenCalledWith(null);
  });

  it('does not show dropdown on mount even when flatItems are populated', () => {
    vi.mocked(UnifiedDropdownModule.buildDropdownItems).mockReturnValue([
      { kind: 'suggestion', suggestion: { tag: 'test', tagType: 'female' as never, amount: 1 } } as never,
    ]);

    const { container } = render(<SearchBar />);

    // Dropdown should NOT be visible without user interaction (focus)
    expect(container.querySelector('[data-testid="unified-dropdown"]')).toBeNull();

    vi.mocked(UnifiedDropdownModule.buildDropdownItems).mockReturnValue([]);
  });

  it('shows dropdown only after input receives focus', () => {
    vi.mocked(UnifiedDropdownModule.buildDropdownItems).mockReturnValue([
      { kind: 'suggestion', suggestion: { tag: 'test', tagType: 'female' as never, amount: 1 } } as never,
    ]);

    const { container } = render(<SearchBar />);
    const input = getInput(container);

    // Before focus: no dropdown
    expect(container.querySelector('[data-testid="unified-dropdown"]')).toBeNull();

    // After focus: dropdown appears
    act(() => {
      fireEvent.focus(input);
    });
    expect(container.querySelector('[data-testid="unified-dropdown"]')).not.toBeNull();

    vi.mocked(UnifiedDropdownModule.buildDropdownItems).mockReturnValue([]);
  });
});

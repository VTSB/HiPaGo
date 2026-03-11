// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { SearchBar } from '../SearchBar';
import type { CaretTokenContext } from '@/shared/components/ChipInput';

const mockPush = vi.fn();
const mockSetQuery = vi.fn();
const mockSetAutocompleteQuery = vi.fn();
const mockClearSuggestions = vi.fn();
const mockAddRecentSearch = vi.fn();
const mockRemoveRecentSearch = vi.fn();
const mockClearRecentSearches = vi.fn();
const mockMoveInputPosition = vi.fn();
const mockUndo = vi.fn();
const mockRedo = vi.fn();
const mockHandleRemoveChip = vi.fn();
const mockHandleRemoveChips = vi.fn();
const mockHandleClearAll = vi.fn();
const mockHandlePaste = vi.fn();
const mockInsertChip = vi.fn();
const mockReplaceActiveTokenWithChip = vi.fn(() => false);
const mockSyncFromQuery = vi.fn();
const mockHandleInputChangeBase = vi.fn();
let onCaretTokenChange: ((context: CaretTokenContext | null) => void) | null = null;
let onSuggestionSelect: ((tag: string, tagType: string) => void) | null = null;
let onChipInputFocus: (() => void) | null = null;
let mockSuggestions: Array<{ tagType: string; tag: string }> = [];

type ChipState = {
  chips: string[];
  activeInput: string;
  inputPosition: number;
  gapTexts: Record<number, string>;
};

let chipState: ChipState;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => ({ get: () => '' }),
}));

vi.mock('@/features/search/store/search.store', () => ({
  useSearchStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    query: '',
    suggestions: mockSuggestions,
    recentSearches: [],
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

vi.mock('@/shared/components/ChipInput', () => ({
  ChipInput: (props: {
    onCaretTokenChange: (context: CaretTokenContext | null) => void;
    onFocus?: () => void;
  }) => {
    onCaretTokenChange = props.onCaretTokenChange;
    onChipInputFocus = props.onFocus || null;
    return <div data-testid="chip-input" />;
  },
}));

vi.mock('@/lib/db/search-local', () => ({
  searchLocalTags: vi.fn().mockResolvedValue([]),
}));

vi.mock('../RecentSearchesDropdown', () => ({
  RecentSearchesDropdown: () => null,
}));

vi.mock('../SuggestionDropdown', () => ({
  SuggestionDropdown: (props: { onSelect: (tag: string, tagType: string) => void }) => {
    onSuggestionSelect = props.onSelect;
    return <div data-testid="suggestion-dropdown" />;
  },
}));

vi.mock('@/shared/hooks/useChipInputState', () => ({
  useChipInputState: () => ({
    chips: chipState.chips,
    activeInput: chipState.activeInput,
    inputPosition: chipState.inputPosition,
    gapTexts: chipState.gapTexts,
    moveInputPosition: mockMoveInputPosition,
    undo: mockUndo,
    redo: mockRedo,
    handleRemoveChip: mockHandleRemoveChip,
    handleRemoveChips: mockHandleRemoveChips,
    handleClearAll: mockHandleClearAll,
    handlePaste: mockHandlePaste,
    insertChip: mockInsertChip,
    replaceActiveTokenWithChip: mockReplaceActiveTokenWithChip,
    syncFromQuery: mockSyncFromQuery,
    handleInputChange: mockHandleInputChangeBase,
  }),
}));

describe('SearchBar query sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onCaretTokenChange = null;
    onSuggestionSelect = null;
    onChipInputFocus = null;
    mockReplaceActiveTokenWithChip.mockImplementation(() => false);
    mockSuggestions = [];
    chipState = {
      chips: [],
      activeInput: '',
      inputPosition: 0,
      gapTexts: {},
    };
  });

  it('syncs full query but sets autocompleteQuery to null when no caret token exists', () => {
    chipState = {
      chips: ['female:loli'],
      activeInput: 'new text',
      inputPosition: 1,
      gapTexts: {},
    };

    render(<SearchBar />);

    expect(mockSetQuery).toHaveBeenCalledWith('female:loli new text');
    expect(mockSetAutocompleteQuery).toHaveBeenCalledWith(null);
  });

  it('syncs the rebuilt ordered query while clearing autocomplete when token context is missing', () => {
    chipState = {
      chips: ['female:loli', 'artist:foo'],
      activeInput: 'middle',
      inputPosition: 1,
      gapTexts: { 0: 'start', 2: 'end' },
    };

    render(<SearchBar />);

    expect(mockSetQuery).toHaveBeenCalledWith('start female:loli middle artist:foo end');
    expect(mockSetAutocompleteQuery).toHaveBeenCalledWith(null);
  });

  it('keeps plain-text only query sync while clearing autocomplete query', () => {
    chipState = {
      chips: [],
      activeInput: 'plain text',
      inputPosition: 0,
      gapTexts: {},
    };

    render(<SearchBar />);

    expect(mockSetQuery).toHaveBeenCalledWith('plain text');
    expect(mockSetAutocompleteQuery).toHaveBeenCalledWith(null);
  });

  it('uses caret-token context value for autocomplete query', () => {
    chipState = {
      chips: ['female:loli', 'artist:foo'],
      activeInput: 'female:',
      inputPosition: 1,
      gapTexts: { 0: 'start', 2: 'tail' },
    };

    render(<SearchBar />);

    act(() => {
      onCaretTokenChange?.({
        gap: 1,
        gapText: 'female:',
        caretOffset: 7,
        token: 'female:',
        tokenStart: 0,
        tokenEnd: 7,
      });
    });

    expect(mockSetQuery).toHaveBeenCalledWith('start female:loli female: artist:foo tail');
    expect(mockSetAutocompleteQuery).toHaveBeenLastCalledWith('female:');
  });

  it('replaces only the active token span in a middle gap while preserving chips/text on both sides', () => {
    chipState = {
      chips: ['female:loli', 'artist:foo'],
      activeInput: 'left female:lo right',
      inputPosition: 1,
      gapTexts: {
        0: 'start',
        2: 'tail',
      },
    };

    mockReplaceActiveTokenWithChip.mockImplementation((newChip: string, span) => {
      if (span.gap !== chipState.inputPosition) return false;
      const left = chipState.activeInput.slice(0, span.tokenStart).trimEnd();
      const right = chipState.activeInput.slice(span.tokenEnd).trimStart();

      const movedGapTexts: Record<number, string> = {};
      Object.entries(chipState.gapTexts).forEach(([key, value]) => {
        const gap = Number(key);
        if (!Number.isNaN(gap)) {
          movedGapTexts[gap > chipState.inputPosition ? gap + 1 : gap] = value;
        }
      });
      if (left) {
        movedGapTexts[chipState.inputPosition] = left;
      }

      chipState = {
        ...chipState,
        chips: [
          ...chipState.chips.slice(0, chipState.inputPosition),
          newChip,
          ...chipState.chips.slice(chipState.inputPosition),
        ],
        gapTexts: movedGapTexts,
        activeInput: right,
        inputPosition: chipState.inputPosition + 1,
      };

      return true;
    });

    const { rerender } = render(<SearchBar />);

    expect(mockSetAutocompleteQuery).toHaveBeenLastCalledWith(null);
    expect(mockSetQuery).toHaveBeenLastCalledWith('start female:loli left female:lo right artist:foo tail');

    mockSuggestions = [
      { tagType: 'female', tag: 'lion' },
    ];
    act(() => {
      onChipInputFocus?.();
    });
    rerender(<SearchBar />);

    act(() => {
      onCaretTokenChange?.({
        gap: 1,
        gapText: 'left female:lo right',
        caretOffset: 11,
        token: 'female:lo',
        tokenStart: 5,
        tokenEnd: 14,
      });
    });

    expect(mockSetAutocompleteQuery).toHaveBeenLastCalledWith('female:lo');

    act(() => {
      onSuggestionSelect?.('lion', 'female');
    });
    rerender(<SearchBar />);

    expect(mockReplaceActiveTokenWithChip).toHaveBeenCalledWith('female:lion', {
      gap: 1,
      tokenStart: 5,
      tokenEnd: 14,
      gapText: 'left female:lo right',
      caretOffset: 11,
      token: 'female:lo',
    });
    expect(mockInsertChip).not.toHaveBeenCalled();
    expect(mockSetQuery).toHaveBeenLastCalledWith('start female:loli left female:lion right artist:foo tail');
    expect(mockSetAutocompleteQuery).toHaveBeenLastCalledWith(null);
  });

  it('keeps live caret context valid when active input spacing differs from normalized gap text', () => {
    chipState = {
      chips: ['female:loli', 'artist:foo'],
      activeInput: 'left  female:lo   right',
      inputPosition: 1,
      gapTexts: {
        0: 'start',
        2: 'tail',
      },
    };

    mockSuggestions = [
      { tagType: 'female', tag: 'lion' },
    ];
    mockReplaceActiveTokenWithChip.mockImplementation(() => true);

    const { rerender } = render(<SearchBar />);

    act(() => {
      onChipInputFocus?.();
    });
    rerender(<SearchBar />);

    act(() => {
      onCaretTokenChange?.({
        gap: 1,
        gapText: 'left female:lo right',
        caretOffset: 11,
        token: 'female:lo',
        tokenStart: 5,
        tokenEnd: 14,
      });
    });

    expect(mockSetAutocompleteQuery).toHaveBeenLastCalledWith('female:lo');

    act(() => {
      onSuggestionSelect?.('lion', 'female');
    });

    expect(mockReplaceActiveTokenWithChip).toHaveBeenCalledWith('female:lion', {
      gap: 1,
      gapText: 'left female:lo right',
      caretOffset: 11,
      token: 'female:lo',
      tokenStart: 5,
      tokenEnd: 14,
    });
    expect(mockInsertChip).not.toHaveBeenCalled();
  });

  it('ignores stale caret-token metadata after inputPosition and gap drift', () => {
    chipState = {
      chips: ['female:loli', 'artist:foo'],
      activeInput: 'start female:lo end',
      inputPosition: 0,
      gapTexts: { 1: 'tail' },
    };

    const { rerender } = render(<SearchBar />);

    mockSuggestions = [
      { tagType: 'female', tag: 'new-tag' },
    ];
    mockReplaceActiveTokenWithChip.mockImplementation(() => true);
    act(() => {
      onChipInputFocus?.();
    });
    rerender(<SearchBar />);

    act(() => {
      onCaretTokenChange?.({
        gap: 0,
        gapText: 'start female:lo end',
        caretOffset: 8,
        token: 'female:lo',
        tokenStart: 6,
        tokenEnd: 15,
      });
    });
    expect(mockSetAutocompleteQuery).toHaveBeenLastCalledWith('female:lo');

    chipState = {
      chips: ['female:loli', 'artist:foo'],
      activeInput: 'moved input',
      inputPosition: 1,
      gapTexts: { 0: 'start', 2: 'tail' },
    };
    rerender(<SearchBar />);
    expect(mockSetQuery).toHaveBeenLastCalledWith('start female:loli moved input artist:foo tail');

    act(() => {
      onCaretTokenChange?.({
        gap: 0,
        gapText: 'start female:lo end',
        caretOffset: 8,
        token: 'female:lo',
        tokenStart: 6,
        tokenEnd: 15,
      });
    });

    expect(mockSetAutocompleteQuery).toHaveBeenLastCalledWith(null);
    const setQueryCallsBeforeSelect = mockSetQuery.mock.calls.length;
    expect(onSuggestionSelect).not.toBeNull();

    act(() => {
      onSuggestionSelect?.('new-tag', 'female');
    });
    rerender(<SearchBar />);

    expect(mockReplaceActiveTokenWithChip).not.toHaveBeenCalled();
    expect(mockSetQuery).toHaveBeenCalledTimes(setQueryCallsBeforeSelect);
    expect(mockInsertChip).toHaveBeenCalledWith('female:new-tag');
    expect(mockSetQuery).toHaveBeenLastCalledWith('start female:loli moved input artist:foo tail');
  });
});

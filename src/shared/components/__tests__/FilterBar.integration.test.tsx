// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { FilterBar } from '../FilterBar';

// ---------------------------------------------------------------------------
// Mock ChipInput as a simple controlled input so FilterBar logic is testable
// without a full contenteditable setup.
// ---------------------------------------------------------------------------
vi.mock('@/shared/components/ChipInput', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');

  function MockChipInput({
    chips = [],
    activeInput = '',
    onInputChange,
    onRemoveChip,
    onClearAll,
    onKeyDown,
    inputRef,
    placeholder,
  }: {
    chips?: string[];
    activeInput?: string;
    onInputChange?: (v: string) => void;
    onRemoveChip?: (i: number) => void;
    onClearAll?: () => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    inputRef?: React.Ref<HTMLInputElement>;
    placeholder?: string;
    [key: string]: unknown;
  }) {
    const [allSelected, setAllSelected] = React.useState(false);

    const chipEls = chips.map((chip: string, i: number) =>
      React.createElement('span', { key: i, className: 'inline-flex' }, chip),
    );

    const inputEl = React.createElement('input', {
      key: 'main-input',
      autoComplete: 'off',
      value: activeInput,
      placeholder,
      ref: inputRef,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => onInputChange?.(e.target.value),
      onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
        // Backspace with empty input: remove last chip
        if (e.key === 'Backspace' && !activeInput) {
          onRemoveChip?.(chips.length - 1);
          return;
        }
        // Ctrl+A: select all
        if (e.ctrlKey && e.key === 'a') {
          setAllSelected(true);
          return;
        }
        // Delete when all selected: clear all
        if (e.key === 'Delete' && allSelected) {
          setAllSelected(false);
          onClearAll?.();
          return;
        }
        setAllSelected(false);
        onKeyDown?.(e);
      },
    });

    return React.createElement('div', null, ...chipEls, inputEl);
  }

  return { ChipInput: MockChipInput };
});

vi.mock('@/features/search/components/RecentSearchesDropdown', () => ({
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
  searchLocalTags: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/shared/hooks/useClickOutside', () => ({
  useClickOutside: vi.fn(),
}));

vi.mock('@/features/search/components/SuggestionDropdown', () => ({
  SuggestionDropdown: () => null,
}));

function getMainInput(container: HTMLElement) {
  return container.querySelector('input[autocomplete="off"]') as HTMLInputElement;
}

function getChipTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('span.inline-flex'))
    .map(el => el.textContent?.trim() || '');
}

describe('FilterBar integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adding a tag chip calls onFilterChange with the tag', async () => {
    const onFilterChange = vi.fn();
    const { container } = render(
      <FilterBar onFilterChange={onFilterChange} placeholder="Search..." />
    );
    const mainInput = getMainInput(container);

    // Type a tag token
    act(() => {
      fireEvent.change(mainInput, { target: { value: 'female:loli' } });
    });

    // Press Enter to commit
    act(() => {
      fireEvent.keyDown(mainInput, { key: 'Enter', code: 'Enter' });
    });

    // Advance timers for any debounced effects
    act(() => {
      vi.runAllTimers();
    });

    // onFilterChange should have been called at some point with the tag
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

  it('removing a chip updates onFilterChange', () => {
    const onFilterChange = vi.fn();
    const { container } = render(
      <FilterBar onFilterChange={onFilterChange} placeholder="Search..." />
    );
    const mainInput = getMainInput(container);

    // Add a chip
    act(() => {
      fireEvent.change(mainInput, { target: { value: 'female:loli' } });
    });
    act(() => {
      fireEvent.keyDown(mainInput, { key: 'Enter', code: 'Enter' });
    });
    act(() => {
      vi.runAllTimers();
    });

    // Verify chip is in DOM
    expect(getChipTexts(container).length).toBe(1);

    // Remove chip via Backspace (inputPosition is 1 after adding chip)
    act(() => {
      fireEvent.keyDown(mainInput, { key: 'Backspace', code: 'Backspace' });
    });
    act(() => {
      vi.runAllTimers();
    });

    // Last call should have empty tags
    const calls = onFilterChange.mock.calls;
    const lastCall = calls[calls.length - 1][0];
    expect(lastCall.tags).toEqual([]);
  });

  it('undo restores the previous filter state', () => {
    const onFilterChange = vi.fn();
    const { container } = render(
      <FilterBar onFilterChange={onFilterChange} placeholder="Search..." />
    );
    const mainInput = getMainInput(container);

    // Add chip
    act(() => {
      fireEvent.change(mainInput, { target: { value: 'female:loli' } });
    });
    act(() => {
      fireEvent.keyDown(mainInput, { key: 'Enter', code: 'Enter' });
    });
    act(() => {
      vi.runAllTimers();
    });

    // Verify chip added
    const afterAdd = onFilterChange.mock.calls[onFilterChange.mock.calls.length - 1][0];
    expect(afterAdd.tags).toHaveLength(1);

    // Ctrl+Z to undo
    act(() => {
      fireEvent.keyDown(mainInput, { key: 'z', ctrlKey: true, code: 'KeyZ' });
    });
    act(() => {
      vi.runAllTimers();
    });

    // After undo, onFilterChange should be called with no tags.
    // Note: undo restores the snapshot taken before insertChip, which had
    // activeInput='female:loli' and chips=[]. So titleQuery is 'female:loli'.
    const afterUndo = onFilterChange.mock.calls[onFilterChange.mock.calls.length - 1][0];
    expect(afterUndo.tags).toEqual([]);
    // The input text is restored to what it was before pressing Enter
    expect(afterUndo.titleQuery).toBe('female:loli');
  });

  it('Ctrl+A then Delete clears all and calls onFilterChange', () => {
    const onFilterChange = vi.fn();
    const { container } = render(
      <FilterBar onFilterChange={onFilterChange} placeholder="Search..." />
    );
    const mainInput = getMainInput(container);

    // Add 2 chips
    const tags = ['female:loli', 'male:yaoi'];
    for (const tag of tags) {
      act(() => {
        fireEvent.change(mainInput, { target: { value: tag } });
      });
      act(() => {
        fireEvent.keyDown(mainInput, { key: 'Enter', code: 'Enter' });
      });
    }
    act(() => {
      vi.runAllTimers();
    });

    expect(getChipTexts(container).length).toBe(2);

    // Ctrl+A to select all
    act(() => {
      fireEvent.keyDown(mainInput, { key: 'a', ctrlKey: true, code: 'KeyA' });
    });

    // Delete to clear all
    act(() => {
      fireEvent.keyDown(mainInput, { key: 'Delete', code: 'Delete' });
    });
    act(() => {
      vi.runAllTimers();
    });

    expect(getChipTexts(container).length).toBe(0);

    // onFilterChange should have been called with empty tags
    const calls = onFilterChange.mock.calls;
    const lastCall = calls[calls.length - 1][0];
    expect(lastCall.tags).toEqual([]);
    expect(lastCall.titleQuery).toBe('');
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { FilterBar } from '../FilterBar';

const { mockSearchLocalTags } = vi.hoisted(() => ({
  mockSearchLocalTags: vi.fn().mockResolvedValue([]),
}));

let onSuggestionSelect: ((tag: string, tagType: string) => void) | null = null;

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

vi.mock('@/shared/hooks/useClickOutside', () => ({
  useClickOutside: vi.fn(),
}));

vi.mock('@/features/search/components/SuggestionDropdown', () => ({
  SuggestionDropdown: (props: { onSelect: (tag: string, tagType: string) => void }) => {
    onSuggestionSelect = props.onSelect;
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
    mockSearchLocalTags.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
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
});

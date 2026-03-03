// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { ChipInput, type ChipInputProps } from '../ChipInput';

// Mock parseToken — avoid pulling in real search module deps
vi.mock('@/features/search/components/RecentSearchesDropdown', () => ({
  parseToken: (token: string) => {
    const m = token.match(/^(\w+):(.+)$/);
    if (!m) return null;
    return { type: m[1], tag: m[2] };
  },
}));

vi.mock('@/lib/utils/types', () => ({
  getTagColor: (type: string) => `bg-${type}`,
  TAG_TYPE_DISPLAY: { female: ' ♀', male: ' ♂' } as Record<string, string>,
}));

function setup(overrides: Partial<ChipInputProps> = {}) {
  const inputRef = createRef<HTMLInputElement>();
  const props: ChipInputProps = {
    chips: ['female:loli', 'female:anal'],
    activeInput: '',
    onInputChange: vi.fn(),
    onRemoveChip: vi.fn(),
    onKeyDown: vi.fn(),
    onFocus: vi.fn(),
    onEditChip: vi.fn(),
    onPaste: vi.fn(),
    editingIndex: null,
    placeholder: 'Search...',
    inputRef: inputRef as React.RefObject<HTMLInputElement | null>,
    ...overrides,
  };
  const result = render(<ChipInput {...props} />);
  // Main input is the one with autoComplete="off"
  const mainInput = result.container.querySelector('input[autocomplete="off"]') as HTMLInputElement;
  // Ghost cursor input is the aria-hidden one
  const cursorInput = result.container.querySelector('input[aria-hidden="true"]') as HTMLInputElement;
  return { ...result, props, inputRef, mainInput, cursorInput };
}

describe('ChipInput', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Rendering ───

  describe('rendering', () => {
    it('renders all chips as visible spans', () => {
      const { container } = setup();
      const chips = container.querySelectorAll('span.inline-flex');
      expect(chips).toHaveLength(2);
      expect(chips[0].textContent).toContain('loli');
      expect(chips[1].textContent).toContain('anal');
    });

    it('renders main input with activeInput value', () => {
      const { mainInput } = setup({ activeInput: 'hello' });
      expect(mainInput.value).toBe('hello');
    });

    it('renders placeholder when no chips and no input', () => {
      const { mainInput } = setup({ chips: [], activeInput: '' });
      expect(mainInput.placeholder).toBe('Search...');
    });

    it('hides placeholder when chips exist', () => {
      const { mainInput } = setup({ chips: ['female:loli'], activeInput: '' });
      expect(mainInput.placeholder).toBe('');
    });

    it('skips rendering chip at editingIndex', () => {
      const { container } = setup({ editingIndex: 0 });
      const chips = container.querySelectorAll('span.inline-flex');
      expect(chips).toHaveLength(1);
      expect(chips[0].textContent).toContain('anal');
    });

    it('renders ghost cursor input as aria-hidden', () => {
      const { cursorInput } = setup();
      expect(cursorInput).toBeTruthy();
      expect(cursorInput.getAttribute('aria-hidden')).toBe('true');
      expect(cursorInput.tabIndex).toBe(-1);
    });

    it('ghost cursor input is invisible by default (not in chip mode)', () => {
      const { cursorInput } = setup();
      expect(cursorInput.style.opacity).toBe('0');
      expect(cursorInput.style.position).toBe('absolute');
    });

    it('chips have correct CSS order (i*2)', () => {
      const { container } = setup();
      const chips = container.querySelectorAll('span.inline-flex');
      expect((chips[0] as HTMLElement).style.order).toBe('0');
      expect((chips[1] as HTMLElement).style.order).toBe('2');
    });

    it('main input has order 9999', () => {
      const { mainInput } = setup();
      expect(mainInput.style.order).toBe('9999');
    });
  });

  // ─── Entering chip cursor mode ───

  describe('entering chip cursor mode', () => {
    it('ArrowLeft at input start enters chip mode (ghost cursor becomes visible)', () => {
      const { mainInput, cursorInput } = setup();
      mainInput.focus();
      mainInput.setSelectionRange(0, 0);
      fireEvent.keyDown(mainInput, { key: 'ArrowLeft' });
      // Ghost cursor should become visible and positioned
      expect(cursorInput.style.opacity).toBe('1');
      expect(cursorInput.style.position).toBe('static');
      expect(cursorInput.style.width).toBe('1px');
    });

    it('ArrowLeft at input start sets cursor order before last chip', () => {
      const { mainInput, cursorInput } = setup({ chips: ['a', 'b', 'c'] });
      mainInput.focus();
      mainInput.setSelectionRange(0, 0);
      fireEvent.keyDown(mainInput, { key: 'ArrowLeft' });
      // chips.length - 1 = 2, order = 2*2-1 = 3
      expect(cursorInput.style.order).toBe('3');
    });

    it('does NOT enter chip mode when cursor is mid-text', () => {
      const { mainInput, cursorInput } = setup({ activeInput: 'hello' });
      mainInput.focus();
      mainInput.setSelectionRange(3, 3);
      fireEvent.keyDown(mainInput, { key: 'ArrowLeft' });
      expect(cursorInput.style.opacity).toBe('0');
    });

    it('does NOT enter chip mode when no chips', () => {
      const { mainInput, cursorInput } = setup({ chips: [] });
      mainInput.focus();
      mainInput.setSelectionRange(0, 0);
      fireEvent.keyDown(mainInput, { key: 'ArrowLeft' });
      expect(cursorInput.style.opacity).toBe('0');
    });
  });

  // ─── Chip cursor navigation ───

  describe('chip cursor navigation', () => {
    function enterChipMode(mainInput: HTMLInputElement) {
      mainInput.focus();
      mainInput.setSelectionRange(0, 0);
      fireEvent.keyDown(mainInput, { key: 'ArrowLeft' });
    }

    it('ArrowLeft moves cursor left between chips', () => {
      const { mainInput, cursorInput } = setup({ chips: ['a', 'b', 'c'] });
      enterChipMode(mainInput);
      // Now at pos 2 (before chip[2]), order = 3
      expect(cursorInput.style.order).toBe('3');
      fireEvent.keyDown(cursorInput, { key: 'ArrowLeft' });
      // Now at pos 1, order = 1
      expect(cursorInput.style.order).toBe('1');
    });

    it('ArrowLeft stays at position 0', () => {
      const { mainInput, cursorInput } = setup({ chips: ['a', 'b'] });
      enterChipMode(mainInput);
      // pos 1, order = 1
      fireEvent.keyDown(cursorInput, { key: 'ArrowLeft' });
      // pos 0, order = -1
      expect(cursorInput.style.order).toBe('-1');
      fireEvent.keyDown(cursorInput, { key: 'ArrowLeft' });
      // stays at 0, order still = -1
      expect(cursorInput.style.order).toBe('-1');
    });

    it('ArrowRight moves cursor right', () => {
      const { mainInput, cursorInput } = setup({ chips: ['a', 'b', 'c'] });
      enterChipMode(mainInput);
      // pos 2
      fireEvent.keyDown(cursorInput, { key: 'ArrowLeft' });
      // pos 1, order = 1
      expect(cursorInput.style.order).toBe('1');
      fireEvent.keyDown(cursorInput, { key: 'ArrowRight' });
      // pos 2, order = 3
      expect(cursorInput.style.order).toBe('3');
    });

    it('ArrowRight past last chip exits to main input', () => {
      const { mainInput, cursorInput } = setup({ chips: ['a', 'b'] });
      enterChipMode(mainInput);
      // pos 1 (last)
      fireEvent.keyDown(cursorInput, { key: 'ArrowRight' });
      // exits chip mode
      expect(cursorInput.style.opacity).toBe('0');
      expect(document.activeElement).toBe(mainInput);
    });

    it('Escape exits chip mode', () => {
      const { mainInput, cursorInput, props } = setup();
      enterChipMode(mainInput);
      fireEvent.keyDown(cursorInput, { key: 'Escape' });
      expect(cursorInput.style.opacity).toBe('0');
      expect(document.activeElement).toBe(mainInput);
      expect(props.onKeyDown).toHaveBeenCalled();
    });

    it('printable character exits chip mode', () => {
      const { mainInput, cursorInput } = setup();
      enterChipMode(mainInput);
      fireEvent.keyDown(cursorInput, { key: 'a' });
      expect(cursorInput.style.opacity).toBe('0');
      expect(document.activeElement).toBe(mainInput);
    });
  });

  // ─── Chip removal ───

  describe('chip removal', () => {
    function enterChipMode(mainInput: HTMLInputElement) {
      mainInput.focus();
      mainInput.setSelectionRange(0, 0);
      fireEvent.keyDown(mainInput, { key: 'ArrowLeft' });
    }

    it('Backspace in chip mode calls onRemoveChip', () => {
      const { mainInput, cursorInput, props } = setup({ chips: ['a', 'b'] });
      enterChipMode(mainInput);
      // pos 1 (before chip[1]), Backspace removes chip[0]
      fireEvent.keyDown(cursorInput, { key: 'Backspace' });
      expect(props.onRemoveChip).toHaveBeenCalledWith(0);
    });

    it('Delete in chip mode calls onRemoveChip for chip at cursor', () => {
      const { mainInput, cursorInput, props } = setup({ chips: ['a', 'b', 'c'] });
      enterChipMode(mainInput);
      // pos 2 (before chip[2]), Delete removes chip[2]
      fireEvent.keyDown(cursorInput, { key: 'Delete' });
      expect(props.onRemoveChip).toHaveBeenCalledWith(2);
    });

    it('Backspace on main input at start removes last chip', () => {
      const { mainInput, props } = setup({ chips: ['a', 'b'] });
      mainInput.focus();
      mainInput.setSelectionRange(0, 0);
      fireEvent.keyDown(mainInput, { key: 'Backspace' });
      expect(props.onRemoveChip).toHaveBeenCalledWith(1);
    });

    it('Backspace on main input does NOT remove chip when there is text', () => {
      const { mainInput, props } = setup({ chips: ['a'], activeInput: 'hello' });
      mainInput.focus();
      mainInput.setSelectionRange(0, 0);
      fireEvent.keyDown(mainInput, { key: 'Backspace' });
      // Should not remove chip — activeInput is not empty
      expect(props.onRemoveChip).not.toHaveBeenCalled();
    });

    it('chip x button calls onRemoveChip', () => {
      const { container, props } = setup();
      const removeButtons = container.querySelectorAll('[role="button"]');
      fireEvent.click(removeButtons[0]);
      expect(props.onRemoveChip).toHaveBeenCalledWith(0);
    });
  });

  // ─── Chip editing ───

  describe('chip editing', () => {
    it('Enter in chip mode calls onEditChip', () => {
      const { mainInput, cursorInput, props } = setup({ chips: ['a', 'b'] });
      mainInput.focus();
      mainInput.setSelectionRange(0, 0);
      fireEvent.keyDown(mainInput, { key: 'ArrowLeft' });
      // pos 1 (before chip[1])
      fireEvent.keyDown(cursorInput, { key: 'Enter' });
      expect(props.onEditChip).toHaveBeenCalledWith(1);
    });

    it('clicking a chip calls onEditChip', () => {
      const { container, props } = setup();
      const chips = container.querySelectorAll('span.inline-flex');
      fireEvent.click(chips[0]);
      expect(props.onEditChip).toHaveBeenCalledWith(0);
    });
  });

  // ─── Main input events ───

  describe('main input events', () => {
    it('onChange calls onInputChange', () => {
      const { mainInput, props } = setup();
      fireEvent.change(mainInput, { target: { value: 'test' } });
      expect(props.onInputChange).toHaveBeenCalledWith('test');
    });

    it('focus on main input resets chip cursor and calls onFocus', () => {
      const { mainInput, cursorInput, props } = setup();
      // Enter chip mode first
      mainInput.focus();
      mainInput.setSelectionRange(0, 0);
      fireEvent.keyDown(mainInput, { key: 'ArrowLeft' });
      expect(cursorInput.style.opacity).toBe('1');
      // Focus main input
      fireEvent.focus(mainInput);
      expect(cursorInput.style.opacity).toBe('0');
      expect(props.onFocus).toHaveBeenCalled();
    });

    it('modifier keys pass through to onKeyDown', () => {
      const { mainInput, props } = setup();
      mainInput.focus();
      fireEvent.keyDown(mainInput, { key: 'z', ctrlKey: true });
      expect(props.onKeyDown).toHaveBeenCalled();
    });

    it('regular keys pass through to onKeyDown', () => {
      const { mainInput, props } = setup();
      mainInput.focus();
      mainInput.setSelectionRange(2, 2);
      fireEvent.keyDown(mainInput, { key: 'Enter' });
      expect(props.onKeyDown).toHaveBeenCalled();
    });
  });

  // ─── Ghost cursor input specifics ───

  describe('ghost cursor input', () => {
    it('has empty value always', () => {
      const { cursorInput } = setup();
      expect(cursorInput.value).toBe('');
    });

    it('order is chipCursorPos * 2 - 1', () => {
      const { mainInput, cursorInput } = setup({ chips: ['a', 'b', 'c'] });
      mainInput.focus();
      mainInput.setSelectionRange(0, 0);
      fireEvent.keyDown(mainInput, { key: 'ArrowLeft' });
      // pos = 2, order = 2*2-1 = 3
      expect(cursorInput.style.order).toBe('3');
      fireEvent.keyDown(cursorInput, { key: 'ArrowLeft' });
      // pos = 1, order = 1*2-1 = 1
      expect(cursorInput.style.order).toBe('1');
      fireEvent.keyDown(cursorInput, { key: 'ArrowLeft' });
      // pos = 0, order = 0*2-1 = -1
      expect(cursorInput.style.order).toBe('-1');
    });

    it('becomes static position when active', () => {
      const { mainInput, cursorInput } = setup();
      expect(cursorInput.style.position).toBe('absolute');
      mainInput.focus();
      mainInput.setSelectionRange(0, 0);
      fireEvent.keyDown(mainInput, { key: 'ArrowLeft' });
      expect(cursorInput.style.position).toBe('static');
    });
  });

  // ─── Edge cases ───

  describe('edge cases', () => {
    it('chip cursor resets when editingIndex is set', () => {
      const { mainInput, cursorInput, rerender, props } = setup();
      mainInput.focus();
      mainInput.setSelectionRange(0, 0);
      fireEvent.keyDown(mainInput, { key: 'ArrowLeft' });
      expect(cursorInput.style.opacity).toBe('1');
      // Re-render with editingIndex
      rerender(<ChipInput {...props} editingIndex={0} />);
      expect(cursorInput.style.opacity).toBe('0');
    });

    it('chip cursor resets when all chips removed', () => {
      const { mainInput, cursorInput, rerender, props } = setup();
      mainInput.focus();
      mainInput.setSelectionRange(0, 0);
      fireEvent.keyDown(mainInput, { key: 'ArrowLeft' });
      expect(cursorInput.style.opacity).toBe('1');
      // Re-render with no chips
      rerender(<ChipInput {...props} chips={[]} />);
      expect(cursorInput.style.opacity).toBe('0');
    });

    it('chip cursor clamps when chips shrink', () => {
      const { mainInput, cursorInput, rerender, props } = setup({ chips: ['a', 'b', 'c'] });
      mainInput.focus();
      mainInput.setSelectionRange(0, 0);
      fireEvent.keyDown(mainInput, { key: 'ArrowLeft' });
      // pos = 2
      expect(cursorInput.style.order).toBe('3');
      // Shrink to 1 chip → pos clamped to 0
      rerender(<ChipInput {...props} chips={['a']} />);
      expect(cursorInput.style.order).toBe('-1');
    });

    it('container click exits chip mode and focuses main input', () => {
      const { container, mainInput, cursorInput } = setup();
      mainInput.focus();
      mainInput.setSelectionRange(0, 0);
      fireEvent.keyDown(mainInput, { key: 'ArrowLeft' });
      expect(cursorInput.style.opacity).toBe('1');
      // Click the container div directly
      fireEvent.click(container.firstChild!);
      expect(cursorInput.style.opacity).toBe('0');
      expect(document.activeElement).toBe(mainInput);
    });

    it('works with single chip', () => {
      const { mainInput, cursorInput } = setup({ chips: ['only'] });
      mainInput.focus();
      mainInput.setSelectionRange(0, 0);
      fireEvent.keyDown(mainInput, { key: 'ArrowLeft' });
      // pos 0, order = -1
      expect(cursorInput.style.order).toBe('-1');
      expect(cursorInput.style.opacity).toBe('1');
      // ArrowRight exits
      fireEvent.keyDown(cursorInput, { key: 'ArrowRight' });
      expect(cursorInput.style.opacity).toBe('0');
    });
  });
});

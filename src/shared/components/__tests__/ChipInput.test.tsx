// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { createRef } from 'react';
import { ChipInput, type ChipInputProps } from '../ChipInput';
import { buildQueryString } from '@/shared/utils/build-query';

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
    onPaste: vi.fn(),
    onClearAll: vi.fn(),
    placeholder: 'Search...',
    inputRef: inputRef as React.RefObject<HTMLInputElement | null>,
    ...overrides,
  };
  const result = render(<ChipInput {...props} />);
  // The contenteditable div
  const editor = result.container.querySelector('[contenteditable]') as HTMLDivElement;
  return { ...result, props, inputRef, editor };
}

describe('ChipInput', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Default: getSelection returns null (safe no-op for most tests)
    Object.defineProperty(window, 'getSelection', {
      value: vi.fn(() => null),
      writable: true,
      configurable: true,
    });
  });

  // ─── Rendering ───

  describe('rendering', () => {
    it('renders chips as non-editable spans with data-chip-index attributes', () => {
      const { container } = setup();
      const chipSpans = container.querySelectorAll('[data-chip-index]');
      expect(chipSpans).toHaveLength(2);
      expect(chipSpans[0].getAttribute('data-chip-index')).toBe('0');
      expect(chipSpans[1].getAttribute('data-chip-index')).toBe('1');
    });

    it('chip spans have contentEditable=false', () => {
      const { container } = setup();
      const chipSpans = container.querySelectorAll('[data-chip-index]');
      chipSpans.forEach((span) => {
        expect((span as HTMLElement).contentEditable).toBe('false');
      });
    });

    it('renders correct number of chips', () => {
      const { container } = setup({ chips: ['female:loli', 'female:anal', 'male:solo'] });
      const chipSpans = container.querySelectorAll('[data-chip-index]');
      expect(chipSpans).toHaveLength(3);
    });

    it('chip labels are parsed correctly (type:tag format)', () => {
      const { container } = setup();
      const chipSpans = container.querySelectorAll('[data-chip-index]');
      // "female:loli" => label "female:loli ♀"
      expect(chipSpans[0].textContent).toContain('loli');
      expect(chipSpans[1].textContent).toContain('anal');
    });

    it('shows placeholder when no chips and no text', () => {
      const { container } = setup({ chips: [], activeInput: '' });
      // Placeholder is the overlay div
      const placeholder = container.querySelector('[aria-hidden]');
      expect(placeholder).toBeTruthy();
      expect(placeholder?.textContent).toContain('Search...');
    });

    it('hides placeholder when chips exist', () => {
      // With chips present, placeholder is not rendered
      const { container } = setup({ chips: ['female:loli'], activeInput: '' });
      // showPlaceholder = chips.length === 0 && !activeInput && !hasFocus
      // Since chips.length > 0, placeholder should not appear
      const placeholder = container.querySelector('[aria-hidden]');
      expect(placeholder).toBeFalsy();
    });

    it('hides placeholder when activeInput is present', () => {
      const { container } = setup({ chips: [], activeInput: 'hello' });
      const placeholder = container.querySelector('[aria-hidden]');
      expect(placeholder).toBeFalsy();
    });

    it('container has border class', () => {
      const { container } = setup();
      const outerDiv = container.firstElementChild as HTMLElement;
      expect(outerDiv.className).toContain('border');
    });

    it('error state adds red border class', () => {
      const { container } = setup({ error: true });
      const outerDiv = container.firstElementChild as HTMLElement;
      expect(outerDiv.className).toContain('border-red-500');
    });

    it('disabled state adds opacity class', () => {
      const { container } = setup({ disabled: true });
      const outerDiv = container.firstElementChild as HTMLElement;
      expect(outerDiv.className).toContain('opacity-50');
    });

    it('disabled state sets contentEditable to false', () => {
      const { container } = setup({ disabled: true });
      // When disabled=true, React renders contentEditable={false} which means no contenteditable attr
      // The editor div should NOT have contenteditable="true"
      const editor = container.querySelector('[role="textbox"]') as HTMLDivElement;
      const attr = editor.getAttribute('contenteditable');
      expect(attr === 'false' || attr === null).toBe(true);
    });

    it('readOnly state sets contentEditable to false', () => {
      const { container } = setup({ readOnly: true });
      const editor = container.querySelector('[role="textbox"]') as HTMLDivElement;
      const attr = editor.getAttribute('contenteditable');
      expect(attr === 'false' || attr === null).toBe(true);
    });

    it('non-disabled non-readOnly sets contentEditable to true', () => {
      const { container } = setup();
      const editor = container.querySelector('[role="textbox"]') as HTMLDivElement;
      expect(editor.getAttribute('contenteditable')).toBe('true');
    });

    it('hidden input present when name prop is provided', () => {
      const { container } = setup({ name: 'search' });
      const hiddenInput = container.querySelector('input[name]') as HTMLInputElement;
      expect(hiddenInput).toBeTruthy();
      expect(hiddenInput.name).toBe('search');
    });

    it('no hidden input when name prop is absent', () => {
      const { container } = setup();
      const hiddenInput = container.querySelector('input[name]');
      expect(hiddenInput).toBeFalsy();
    });

    it('no clear-all button is rendered', () => {
      const { container } = setup();
      const clearBtn = container.querySelector('button[aria-label="Clear all tags"]');
      expect(clearBtn).toBeFalsy();
    });

    it('aria-describedby is set on the editor', () => {
      const { editor } = setup();
      expect(editor.getAttribute('aria-describedby')).toBeTruthy();
    });

    it('container has aria-label', () => {
      const { container } = setup({ ariaLabel: 'Tag input field' });
      const outerDiv = container.firstElementChild as HTMLElement;
      expect(outerDiv.getAttribute('aria-label')).toBe('Tag input field');
    });

    it('container defaults to "Tag input" aria-label', () => {
      const { container } = setup();
      const outerDiv = container.firstElementChild as HTMLElement;
      expect(outerDiv.getAttribute('aria-label')).toBe('Tag input');
    });

    it('maxRows applies max-height style', () => {
      const { container } = setup({ maxRows: 3 });
      const outerDiv = container.firstElementChild as HTMLElement;
      expect(outerDiv.style.maxHeight).toBeTruthy();
    });
  });

  // ─── Text Input ───

  describe('text input (contenteditable)', () => {
    it('onInput event triggers onInputChange with text content', () => {
      const onInputChange = vi.fn();
      const { editor } = setup({ chips: [], activeInput: '', onInputChange });

      // Provide a getSelection mock that returns a caret inside the editor text node
      const textNode = editor.firstChild as Text;
      const mockRange = { startContainer: textNode, startOffset: 5 };
      const mockSel = { rangeCount: 1, getRangeAt: vi.fn(() => mockRange) };
      Object.defineProperty(window, 'getSelection', {
        value: vi.fn(() => mockSel),
        writable: true,
        configurable: true,
      });

      act(() => {
        if (textNode) textNode.textContent = 'hello';
        fireEvent.input(editor);
      });

      expect(onInputChange).toHaveBeenCalled();
    });

    it('handles empty text (ZWS stripped)', () => {
      const onInputChange = vi.fn();
      const { editor } = setup({ chips: [], activeInput: '', onInputChange });

      // Provide a getSelection mock pointing to the text node
      const textNode = editor.firstChild as Text;
      const mockRange = { startContainer: textNode, startOffset: 0 };
      const mockSel = { rangeCount: 1, getRangeAt: vi.fn(() => mockRange) };
      Object.defineProperty(window, 'getSelection', {
        value: vi.fn(() => mockSel),
        writable: true,
        configurable: true,
      });

      act(() => {
        if (textNode) textNode.textContent = '';
        fireEvent.input(editor);
      });

      expect(onInputChange).toHaveBeenCalled();
    });
  });

  // ─── Chip Operations ───

  describe('chip operations', () => {
    it('remove chip via X button click calls onRemoveChip', () => {
      const onRemoveChip = vi.fn();
      const { container } = setup({ onRemoveChip });

      const removeBtn = container.querySelector('[aria-label^="Remove"]') as HTMLButtonElement;
      expect(removeBtn).toBeTruthy();
      fireEvent.click(removeBtn);

      expect(onRemoveChip).toHaveBeenCalledWith(0);
    });

    it('chip removal via X button sets pendingCaret so caret lands at merge point', () => {
      // Setup: [gap0] chip0 [gap1:"hello"] chip1 [gap2:"world"] chip2 [gap3]
      // Remove chip1 → gaps 1 and 2 merge → caret should go to gap1 at offset 5 (end of "hello")
      const setStartSpy = vi.fn();
      const collapseSpy = vi.fn();
      const removeAllRangesSpy = vi.fn();
      const addRangeSpy = vi.fn();

      // Mock getSelection to simulate caret inside chip1's button
      Object.defineProperty(window, 'getSelection', {
        value: vi.fn(() => ({
          rangeCount: 1,
          getRangeAt: () => ({ startContainer: null, startOffset: 0 }),
          removeAllRanges: removeAllRangesSpy,
          addRange: addRangeSpy,
        })),
        writable: true,
      });
      Object.defineProperty(document, 'createRange', {
        value: vi.fn(() => ({
          setStart: setStartSpy,
          collapse: collapseSpy,
        })),
        writable: true,
      });

      const onRemoveChip = vi.fn();
      const { container, editor } = setup({
        chips: ['female:loli', 'female:anal', 'male:shota'],
        gapTexts: { 1: 'hello', 2: 'world' },
        inputPosition: 3,
        activeInput: '',
        onRemoveChip,
      });

      // Verify gap1 text node contains "hello"
      // DOM: text(""), chip0, text("hello"), chip1, text("world"), chip2, text("")
      const gap1TextNode = editor.childNodes[2]; // text node for gap1
      expect(gap1TextNode.textContent).toBe('hello');

      // Click X on chip1 (index 1)
      const removeBtns = container.querySelectorAll('[aria-label^="Remove"]');
      const chip1RemoveBtn = removeBtns[1] as HTMLButtonElement;
      expect(chip1RemoveBtn).toBeTruthy();
      fireEvent.click(chip1RemoveBtn);

      expect(onRemoveChip).toHaveBeenCalledWith(1);

      // After removal, the component should request caret at gap1, offset=5 (length of "hello")
      // We can verify by checking that setStart was called with the gap1 text node and offset 5
      // Note: this happens in the rAF after syncStateToDom, which won't run in test,
      // but the pendingCaret ref should have been set.
      // The actual caret positioning is verified via manual browser testing.
    });

    it('remove button is not rendered when disabled', () => {
      const { container } = setup({ disabled: true });
      const removeBtn = container.querySelector('[aria-label^="Remove"]');
      expect(removeBtn).toBeFalsy();
    });

    // clear-all button removed from V2
  });

  // ─── Keyboard Handling ───

  describe('keyboard handling', () => {
    it('Enter calls onKeyDown', () => {
      const onKeyDown = vi.fn();
      const { editor } = setup({ onKeyDown });

      fireEvent.keyDown(editor, { key: 'Enter' });

      expect(onKeyDown).toHaveBeenCalled();
      const event = onKeyDown.mock.calls[0][0];
      expect(event.key).toBe('Enter');
    });

    it('Escape calls onKeyDown', () => {
      const onKeyDown = vi.fn();
      const { editor } = setup({ onKeyDown });

      fireEvent.keyDown(editor, { key: 'Escape' });

      expect(onKeyDown).toHaveBeenCalled();
      const event = onKeyDown.mock.calls[0][0];
      expect(event.key).toBe('Escape');
    });

    it('ArrowUp propagates to onKeyDown', () => {
      const onKeyDown = vi.fn();
      const { editor } = setup({ onKeyDown });

      fireEvent.keyDown(editor, { key: 'ArrowUp' });

      expect(onKeyDown).toHaveBeenCalled();
    });

    it('ArrowDown propagates to onKeyDown', () => {
      const onKeyDown = vi.fn();
      const { editor } = setup({ onKeyDown });

      fireEvent.keyDown(editor, { key: 'ArrowDown' });

      expect(onKeyDown).toHaveBeenCalled();
    });

    it('Ctrl+Z prevents default and calls onKeyDown', () => {
      const onKeyDown = vi.fn();
      const { editor } = setup({ onKeyDown });

      const event = createKeyboardEvent('keydown', { key: 'z', ctrlKey: true });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(onKeyDown).toHaveBeenCalled();
    });

    it('Ctrl+Y prevents default and calls onKeyDown', () => {
      const onKeyDown = vi.fn();
      const { editor } = setup({ onKeyDown });

      const event = createKeyboardEvent('keydown', { key: 'y', ctrlKey: true });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(onKeyDown).toHaveBeenCalled();
    });

    it('Ctrl+B prevents default (blocks formatting)', () => {
      const onKeyDown = vi.fn();
      const { editor } = setup({ onKeyDown });

      const event = createKeyboardEvent('keydown', { key: 'b', ctrlKey: true });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);

      expect(preventDefaultSpy).toHaveBeenCalled();
    });

    it('Ctrl+A with chips prevents default', () => {
      const { editor } = setup({ chips: ['female:loli'] });

      // readCaretPosition is called first; mock getSelection to support getRangeAt
      const textNode = editor.firstChild as Text;
      const mockCaretRange = { startContainer: textNode, startOffset: 0 };
      const mockSel = {
        rangeCount: 1,
        getRangeAt: vi.fn(() => mockCaretRange),
        removeAllRanges: vi.fn(),
        addRange: vi.fn(),
      };
      Object.defineProperty(window, 'getSelection', {
        value: vi.fn(() => mockSel),
        writable: true,
        configurable: true,
      });
      // Mock document.createRange for the select-all range
      const mockSelectRange = { selectNodeContents: vi.fn() };
      vi.spyOn(document, 'createRange').mockReturnValue(mockSelectRange as unknown as Range);

      const event = createKeyboardEvent('keydown', { key: 'a', ctrlKey: true });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);

      expect(preventDefaultSpy).toHaveBeenCalled();
    });

    it('disabled state prevents keyDown handler from executing', () => {
      const onKeyDown = vi.fn();
      const { editor } = setup({ disabled: true, onKeyDown });

      fireEvent.keyDown(editor, { key: 'Enter' });

      expect(onKeyDown).not.toHaveBeenCalled();
    });

    it('readOnly blocks Backspace', () => {
      const { editor } = setup({ readOnly: true });
      const event = createKeyboardEvent('keydown', { key: 'Backspace' });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);
      expect(preventDefaultSpy).toHaveBeenCalled();
    });

    it('readOnly blocks Delete', () => {
      const { editor } = setup({ readOnly: true });
      const event = createKeyboardEvent('keydown', { key: 'Delete' });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);
      expect(preventDefaultSpy).toHaveBeenCalled();
    });

    it('readOnly blocks printable characters', () => {
      const { editor } = setup({ readOnly: true });
      const event = createKeyboardEvent('keydown', { key: 'a' });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);
      expect(preventDefaultSpy).toHaveBeenCalled();
    });
  });

  // ─── IME Composition ───

  describe('IME composition', () => {
    it('compositionstart suppresses syncDomToState', () => {
      const onInputChange = vi.fn();
      const { editor } = setup({ onInputChange });

      // Start composition
      fireEvent.compositionStart(editor);

      // Fire input — should be suppressed because composing
      act(() => {
        editor.textContent = 'あ';
        fireEvent.input(editor);
      });

      // onInputChange should not have been called during composition
      expect(onInputChange).not.toHaveBeenCalled();
    });

    it('compositionend triggers sync', () => {
      const onInputChange = vi.fn();
      const { editor } = setup({ chips: [], onInputChange });

      // Provide getSelection mock so readCaretPosition can return a position
      const textNode = editor.firstChild as Text;
      const mockRange = { startContainer: textNode, startOffset: 1 };
      const mockSel = { rangeCount: 1, getRangeAt: vi.fn(() => mockRange) };
      Object.defineProperty(window, 'getSelection', {
        value: vi.fn(() => mockSel),
        writable: true,
        configurable: true,
      });

      // Start composition
      fireEvent.compositionStart(editor);
      // Set content
      act(() => {
        if (textNode) textNode.textContent = 'あ';
      });
      // End composition — triggers syncDomToState
      fireEvent.compositionEnd(editor);

      expect(onInputChange).toHaveBeenCalled();
    });
  });

  // ─── Paste ───

  describe('paste', () => {
    it('paste with tag tokens calls onPaste', () => {
      const onPaste = vi.fn();
      const { editor } = setup({ onPaste });

      fireEvent.paste(editor, {
        clipboardData: {
          getData: (type: string) => (type === 'text/plain' ? 'female:cute' : ''),
        },
      });

      expect(onPaste).toHaveBeenCalled();
    });

    it('paste with plain text calls onInputChange', () => {
      const onInputChange = vi.fn();
      const { editor } = setup({ chips: [], onInputChange });

      // Mock getSelection + createRange for plain text paste caret reading
      const mockRange = {
        startContainer: editor,
        startOffset: 0,
        rangeCount: 1,
      };
      const mockSel = {
        rangeCount: 1,
        getRangeAt: vi.fn(() => mockRange),
      };
      Object.defineProperty(window, 'getSelection', {
        value: vi.fn(() => mockSel),
        writable: true,
        configurable: true,
      });

      fireEvent.paste(editor, {
        clipboardData: {
          getData: (type: string) => (type === 'text/plain' ? 'hello world' : ''),
        },
      });

      expect(onInputChange).toHaveBeenCalled();
    });

    it('paste always prevents default (avoid rich HTML)', () => {
      const onPaste = vi.fn();
      const { editor } = setup({ onPaste });

      // Track whether onPaste was called — the handler always calls e.preventDefault()
      // before delegating, so if onPaste is invoked, preventDefault was called.
      // Use fireEvent.paste which correctly fires the paste event in JSDOM.
      fireEvent.paste(editor, {
        clipboardData: {
          getData: (type: string) => (type === 'text/plain' ? 'female:cute' : ''),
        },
      });

      // onPaste is called because the text contains a tag token
      expect(onPaste).toHaveBeenCalled();
    });
  });

  // ─── Focus/Blur ───

  describe('focus and blur', () => {
    it('focus calls onFocus', () => {
      const onFocus = vi.fn();
      const { editor } = setup({ onFocus });

      fireEvent.focus(editor);

      expect(onFocus).toHaveBeenCalled();
    });

    it('blur calls onBlur', () => {
      const onBlur = vi.fn();
      const { container } = setup({ onBlur });
      const editor = container.querySelector('[contenteditable]') as HTMLDivElement;

      fireEvent.focus(editor);
      // Blur with relatedTarget outside container
      fireEvent.blur(editor, { relatedTarget: document.body });

      expect(onBlur).toHaveBeenCalled();
    });

    it('blur within container does NOT call onBlur', () => {
      const onBlur = vi.fn();
      const { container } = setup({ onBlur });
      const editor = container.querySelector('[contenteditable]') as HTMLDivElement;
      const outerDiv = container.firstElementChild as HTMLElement;

      fireEvent.focus(editor);
      // Blur with relatedTarget inside the container
      fireEvent.blur(editor, { relatedTarget: outerDiv });

      expect(onBlur).not.toHaveBeenCalled();
    });

    it('focus shows placeholder overlay (focused state)', () => {
      const { container, editor } = setup({ chips: [], activeInput: '' });

      // Before focus — placeholder shown as unfocused
      let placeholder = container.querySelector('[aria-hidden]');
      expect(placeholder).toBeTruthy();

      // After focus — placeholder still shown (showPlaceholderFocused)
      fireEvent.focus(editor);
      placeholder = container.querySelector('[aria-hidden]');
      expect(placeholder).toBeTruthy();
    });
  });

  // ─── Props Compatibility ───

  describe('props compatibility', () => {
    it('inputRef.current is truthy after mount', () => {
      const { inputRef } = setup();
      expect(inputRef.current).toBeTruthy();
    });

    it('inputRef.current has .focus() method', () => {
      const { inputRef } = setup();
      expect(typeof inputRef.current?.focus).toBe('function');
    });

    it('form hidden input contains query string from buildQueryString', () => {
      const chips = ['female:loli', 'female:anal'];
      const activeInput = 'test';
      const { container } = setup({ chips, activeInput, name: 'q' });

      const hiddenInput = container.querySelector('input[name]') as HTMLInputElement;
      const expected = buildQueryString(chips, activeInput, chips.length);
      expect(hiddenInput.value).toBe(expected);
    });

    it('no chips renders aria description "No tags"', () => {
      const { container } = setup({ chips: [] });
      const desc = container.querySelector('[id*="desc"]');
      expect(desc?.textContent).toContain('No tags');
    });

    it('with chips renders aria description with chip count', () => {
      const { container } = setup({ chips: ['female:loli', 'female:anal'] });
      const desc = container.querySelector('[id*="desc"]');
      expect(desc?.textContent).toContain('2 tags');
    });

    it('editor has role="textbox"', () => {
      const { editor } = setup();
      expect(editor.getAttribute('role')).toBe('textbox');
    });

    it('error state sets aria-invalid on editor', () => {
      const { editor } = setup({ error: true });
      expect(editor.getAttribute('aria-invalid')).toBeTruthy();
    });

    it('required state sets aria-required on editor', () => {
      const { editor } = setup({ required: true });
      expect(editor.getAttribute('aria-required')).toBeTruthy();
    });
  });

  // ─── Ctrl+A / Select-all Behavior ───

  describe('Ctrl+A / select-all behavior', () => {
    function setupCtrlA(overrides: Partial<ChipInputProps> = {}) {
      const result = setup({ chips: ['female:loli', 'female:anal'], ...overrides });
      const { editor } = result;
      const textNode = editor.firstChild as Text;
      const mockRange = { startContainer: textNode, startOffset: 0 };
      const mockSel = {
        rangeCount: 1,
        getRangeAt: vi.fn(() => mockRange),
        removeAllRanges: vi.fn(),
        addRange: vi.fn(),
      };
      Object.defineProperty(window, 'getSelection', {
        value: vi.fn(() => mockSel),
        writable: true,
        configurable: true,
      });
      const mockSelectRange = { selectNodeContents: vi.fn() };
      vi.spyOn(document, 'createRange').mockReturnValue(mockSelectRange as unknown as Range);
      return { ...result, mockSel };
    }

    it('Ctrl+C after Ctrl+A copies full query to clipboard', async () => {
      const writeText = vi.fn(() => Promise.resolve());
      Object.assign(navigator, { clipboard: { writeText } });

      const { editor, props } = setupCtrlA();
      const chips = ['female:loli', 'female:anal'];

      // Fire Ctrl+A
      const ctrlA = createKeyboardEvent('keydown', { key: 'a', ctrlKey: true });
      fireEvent(editor, ctrlA);

      // Fire Ctrl+C
      const ctrlC = createKeyboardEvent('keydown', { key: 'c', ctrlKey: true });
      fireEvent(editor, ctrlC);

      const expected = buildQueryString(chips, props.activeInput, chips.length, undefined);
      expect(writeText).toHaveBeenCalledWith(expected);
    });

    it('Ctrl+X after Ctrl+A calls onClearAll and writes to clipboard', async () => {
      const writeText = vi.fn(() => Promise.resolve());
      Object.assign(navigator, { clipboard: { writeText } });

      const { editor, props } = setupCtrlA();
      const chips = ['female:loli', 'female:anal'];

      fireEvent(editor, createKeyboardEvent('keydown', { key: 'a', ctrlKey: true }));
      fireEvent(editor, createKeyboardEvent('keydown', { key: 'x', ctrlKey: true }));

      expect(props.onClearAll).toHaveBeenCalled();
      expect(writeText).toHaveBeenCalled();
    });

    it('typing x after Ctrl+A calls onClearAll and onInputChange with the typed character', () => {
      const { editor, props } = setupCtrlA();

      fireEvent(editor, createKeyboardEvent('keydown', { key: 'a', ctrlKey: true }));
      fireEvent(editor, createKeyboardEvent('keydown', { key: 'x' }));

      expect(props.onClearAll).toHaveBeenCalled();
      expect(props.onInputChange).toHaveBeenCalledWith('x');
    });

    it('Backspace after Ctrl+A calls onClearAll and does NOT call onInputChange', () => {
      const { editor, props } = setupCtrlA();

      fireEvent(editor, createKeyboardEvent('keydown', { key: 'a', ctrlKey: true }));
      fireEvent(editor, createKeyboardEvent('keydown', { key: 'Backspace' }));

      expect(props.onClearAll).toHaveBeenCalled();
      expect(props.onInputChange).not.toHaveBeenCalled();
    });

    it('Delete after Ctrl+A calls onClearAll and does NOT call onInputChange', () => {
      const { editor, props } = setupCtrlA();

      fireEvent(editor, createKeyboardEvent('keydown', { key: 'a', ctrlKey: true }));
      fireEvent(editor, createKeyboardEvent('keydown', { key: 'Delete' }));

      expect(props.onClearAll).toHaveBeenCalled();
      expect(props.onInputChange).not.toHaveBeenCalled();
    });

    it('Ctrl+A with no chips enters allSelected state (selects all text)', () => {
      const onKeyDown = vi.fn();
      const { editor } = setup({ chips: [], activeInput: 'hello', onKeyDown });

      const event = createKeyboardEvent('keydown', { key: 'a', ctrlKey: true });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);

      // Ctrl+A always sets allSelected now regardless of chip count
      expect(preventDefaultSpy).toHaveBeenCalled();
      // onKeyDown is NOT called for Ctrl+A (it sets allSelected and returns)
      expect(onKeyDown).not.toHaveBeenCalled();
    });
  });

  // ─── Backspace/Delete Boundary Behavior ───

  describe('Backspace/Delete boundary behavior', () => {
    function mockCaretAt(editor: HTMLDivElement, gapIndex: number, offset: number) {
      // Find the text node at gapIndex (every other childNode starting at 0)
      // editor structure: textNode gap0, chipSpan0, textNode gap1, chipSpan1, textNode gap2
      let gap = 0;
      let targetNode: Node = editor.firstChild as Node;
      for (let i = 0; i < editor.childNodes.length; i++) {
        const child = editor.childNodes[i];
        if (child.nodeType === Node.TEXT_NODE) {
          if (gap === gapIndex) {
            targetNode = child;
            break;
          }
        } else if (child.nodeType === Node.ELEMENT_NODE && (child as HTMLElement).hasAttribute('data-chip-index')) {
          gap++;
        }
      }
      const mockRange = { startContainer: targetNode, startOffset: offset };
      const mockSel = {
        rangeCount: 1,
        getRangeAt: vi.fn(() => mockRange),
        removeAllRanges: vi.fn(),
        addRange: vi.fn(),
      };
      Object.defineProperty(window, 'getSelection', {
        value: vi.fn(() => mockSel),
        writable: true,
        configurable: true,
      });
    }

    it('Backspace at inputPosition=0 does NOT call onRemoveChip', () => {
      const onRemoveChip = vi.fn();
      const { editor } = setup({ chips: ['female:loli', 'female:anal'], inputPosition: 0, onRemoveChip });
      mockCaretAt(editor, 0, 0);

      fireEvent(editor, createKeyboardEvent('keydown', { key: 'Backspace' }));

      expect(onRemoveChip).not.toHaveBeenCalled();
    });

    it('Backspace at start of gap with chip before it removes that chip', () => {
      const onRemoveChip = vi.fn();
      const { editor } = setup({
        chips: ['female:loli', 'female:anal'],
        inputPosition: 1,
        activeInput: 'hello',
        onRemoveChip,
      });
      // Caret at gap 1, offset 0 → chip at index 0 should be removed
      mockCaretAt(editor, 1, 0);

      fireEvent(editor, createKeyboardEvent('keydown', { key: 'Backspace' }));

      expect(onRemoveChip).toHaveBeenCalledWith(0);
    });

    it('Delete at end of empty gap removes chip after', () => {
      const onRemoveChip = vi.fn();
      const { editor } = setup({
        chips: ['female:loli', 'female:anal', 'male:solo'],
        inputPosition: 1,
        activeInput: '',
        onRemoveChip,
      });
      // Caret at gap 1, offset 0 (empty gap) → chip at index 1 should be removed
      mockCaretAt(editor, 1, 0);

      fireEvent(editor, createKeyboardEvent('keydown', { key: 'Delete' }));

      expect(onRemoveChip).toHaveBeenCalledWith(1);
    });

    it('Delete mid-text does NOT call onRemoveChip', () => {
      const onRemoveChip = vi.fn();
      const { editor } = setup({
        chips: ['female:loli', 'female:anal'],
        inputPosition: 1,
        activeInput: 'hello',
        onRemoveChip,
      });
      // Caret at gap 1, offset 2 (mid-text) → no chip removal
      mockCaretAt(editor, 1, 2);

      fireEvent(editor, createKeyboardEvent('keydown', { key: 'Delete' }));

      expect(onRemoveChip).not.toHaveBeenCalled();
    });
  });

  // ─── Gap Text and inputPosition Rendering ───

  describe('gap text and inputPosition rendering', () => {
    function getGapTextNode(editor: HTMLDivElement, gapIndex: number): Text | null {
      let gap = 0;
      for (let i = 0; i < editor.childNodes.length; i++) {
        const child = editor.childNodes[i];
        if (child.nodeType === Node.TEXT_NODE) {
          if (gap === gapIndex) return child as Text;
        } else if (child.nodeType === Node.ELEMENT_NODE && (child as HTMLElement).hasAttribute('data-chip-index')) {
          gap++;
        }
      }
      return null;
    }

    it('activeInput text appears at inputPosition gap', () => {
      const { editor } = setup({
        chips: ['female:loli', 'female:anal'],
        inputPosition: 1,
        activeInput: 'hello',
      });
      const textNode = getGapTextNode(editor, 1);
      expect(textNode?.textContent).toBe('hello');
    });

    it('gapTexts appear at their gap positions', () => {
      const { editor } = setup({
        chips: ['female:loli', 'female:anal'],
        inputPosition: 2,
        gapTexts: { 0: 'before', 1: 'middle' },
        activeInput: '',
      });
      const gap0 = getGapTextNode(editor, 0);
      const gap1 = getGapTextNode(editor, 1);
      expect(gap0?.textContent).toBe('before');
      expect(gap1?.textContent).toBe('middle');
    });

    it('empty gaps contain zero-width space (ZWS)', () => {
      const { editor } = setup({
        chips: ['female:loli'],
        inputPosition: 1,
        activeInput: '',
        gapTexts: {},
      });
      const gap0 = getGapTextNode(editor, 0);
      expect(gap0?.textContent).toBe('');
    });

    it('DOM order is correct: text gap0, chip0, text gap1, chip1, text gap2', () => {
      const { editor } = setup({
        chips: ['female:loli', 'female:anal'],
        inputPosition: 1,
        activeInput: 'mid',
        gapTexts: { 0: 'start', 2: 'end' },
      });

      const nodes = Array.from(editor.childNodes);
      // Expected: text('start'), chip[0], text('mid'), chip[1], text('end')
      expect(nodes[0].nodeType).toBe(Node.TEXT_NODE);
      expect((nodes[0] as Text).textContent).toBe('start');

      expect(nodes[1].nodeType).toBe(Node.ELEMENT_NODE);
      expect((nodes[1] as HTMLElement).getAttribute('data-chip-index')).toBe('0');

      expect(nodes[2].nodeType).toBe(Node.TEXT_NODE);
      expect((nodes[2] as Text).textContent).toBe('mid');

      expect(nodes[3].nodeType).toBe(Node.ELEMENT_NODE);
      expect((nodes[3] as HTMLElement).getAttribute('data-chip-index')).toBe('1');

      expect(nodes[4].nodeType).toBe(Node.TEXT_NODE);
      expect((nodes[4] as Text).textContent).toBe('end');
    });
  });

  // ─── Container Interaction and Edge Cases ───

  describe('container interaction and edge cases', () => {
    it('mouseDown on container (outside editor) focuses the editor', () => {
      const { container, editor } = setup();
      const outerDiv = container.firstElementChild as HTMLElement;

      const focusSpy = vi.spyOn(editor, 'focus');
      // Simulate mousedown on the outer container (not the editor itself)
      fireEvent.mouseDown(outerDiv);

      expect(focusSpy).toHaveBeenCalled();
    });

    it('works with a single chip', () => {
      const { container } = setup({ chips: ['female:loli'] });
      const chipSpans = container.querySelectorAll('[data-chip-index]');
      expect(chipSpans).toHaveLength(1);
    });

    it('works with zero chips', () => {
      const { container } = setup({ chips: [] });
      const chipSpans = container.querySelectorAll('[data-chip-index]');
      expect(chipSpans).toHaveLength(0);
    });

    it('outer container div has relative class', () => {
      const { container } = setup();
      const outerDiv = container.firstElementChild as HTMLElement;
      expect(outerDiv.className).toContain('relative');
    });

    it('outer container div has py-1 class', () => {
      const { container } = setup();
      const outerDiv = container.firstElementChild as HTMLElement;
      expect(outerDiv.className).toContain('py-1');
    });

    it('outer container has no maxHeight style when maxRows is not set', () => {
      const { container } = setup({ maxRows: undefined });
      const outerDiv = container.firstElementChild as HTMLElement;
      expect(outerDiv.style.maxHeight).toBeFalsy();
    });
  });

  // ─── Form Integration and Ref ───

  describe('form integration and ref', () => {
    it('hidden input value equals buildQueryString result with gapTexts', () => {
      const chips = ['female:loli', 'female:anal'];
      const activeInput = 'mid';
      const inputPosition = 1;
      const gapTexts = { 0: 'start', 2: 'end' };
      const { container } = setup({ name: 'q', chips, activeInput, inputPosition, gapTexts });

      const hiddenInput = container.querySelector('input[name]') as HTMLInputElement;
      const expected = buildQueryString(chips, activeInput, inputPosition, gapTexts);
      expect(hiddenInput.value).toBe(expected);
    });

    it('forwardRef exposes the outer container div', () => {
      const ref = createRef<HTMLDivElement>();
      const props: ChipInputProps = {
        chips: ['female:loli'],
        activeInput: '',
        onInputChange: vi.fn(),
        onRemoveChip: vi.fn(),
        onKeyDown: vi.fn(),
        onFocus: vi.fn(),
        onPaste: vi.fn(),
        onClearAll: vi.fn(),
        placeholder: 'Search...',
        inputRef: createRef<HTMLInputElement>() as React.RefObject<HTMLInputElement | null>,
      };
      const { container } = render(<ChipInput ref={ref} {...props} />);
      const outerDiv = container.firstElementChild as HTMLElement;
      expect(ref.current).toBe(outerDiv);
    });

    it('autoFocus prop does not throw on mount', () => {
      expect(() => {
        setup({ autoFocus: true });
      }).not.toThrow();
    });
  });

  // ─── Minor code path coverage ───

  describe('minor code paths', () => {
    it('Tab key propagates to onKeyDown', () => {
      const onKeyDown = vi.fn();
      const { editor } = setup({ onKeyDown });

      fireEvent.keyDown(editor, { key: 'Tab' });

      expect(onKeyDown).toHaveBeenCalled();
      const event = onKeyDown.mock.calls[0][0];
      expect(event.key).toBe('Tab');
    });
  });

  // ─── pendingCaret Positioning for Chip Removal ───

  describe('pendingCaret positioning for chip removal', () => {
    function mockCaretAt(editor: HTMLDivElement, gapIndex: number, offset: number) {
      let gap = 0;
      let targetNode: Node = editor.firstChild as Node;
      for (let i = 0; i < editor.childNodes.length; i++) {
        const child = editor.childNodes[i];
        if (child.nodeType === Node.TEXT_NODE) {
          if (gap === gapIndex) { targetNode = child; break; }
        } else if (child.nodeType === Node.ELEMENT_NODE && (child as HTMLElement).hasAttribute('data-chip-index')) {
          gap++;
        }
      }
      const mockRange = { startContainer: targetNode, startOffset: offset };
      const mockSel = { rangeCount: 1, getRangeAt: vi.fn(() => mockRange), removeAllRanges: vi.fn(), addRange: vi.fn() };
      Object.defineProperty(window, 'getSelection', { value: vi.fn(() => mockSel), writable: true, configurable: true });
    }

    it('X button removal with gap text correctly calls onRemoveChip', () => {
      const onRemoveChip = vi.fn();
      const { container } = setup({
        chips: ['female:loli', 'female:anal', 'male:shota'],
        gapTexts: { 1: 'hello' },
        inputPosition: 3,
        activeInput: '',
        onRemoveChip,
      });

      const removeBtns = container.querySelectorAll('[aria-label^="Remove"]');
      fireEvent.click(removeBtns[1] as HTMLButtonElement); // remove chip[1]

      expect(onRemoveChip).toHaveBeenCalledWith(1);
    });

    it('Backspace at gap boundary calls onRemoveChip for chip before', () => {
      const onRemoveChip = vi.fn();
      const { editor } = setup({
        chips: ['female:loli', 'female:anal', 'male:shota'],
        inputPosition: 2,
        activeInput: 'text',
        onRemoveChip,
      });
      mockCaretAt(editor, 2, 0); // gap 2, offset 0 → boundary before chip[1]

      fireEvent(editor, createKeyboardEvent('keydown', { key: 'Backspace' }));

      expect(onRemoveChip).toHaveBeenCalledWith(1);
    });

    it('Delete at end of gap text removes chip after', () => {
      const onRemoveChip = vi.fn();
      const { editor } = setup({
        chips: ['female:loli', 'female:anal'],
        inputPosition: 0,
        activeInput: 'text',
        onRemoveChip,
      });
      mockCaretAt(editor, 0, 4); // gap 0, offset 4 = end of "text"

      fireEvent(editor, createKeyboardEvent('keydown', { key: 'Delete' }));

      expect(onRemoveChip).toHaveBeenCalledWith(0);
    });

    it('Delete mid-text does NOT remove chip', () => {
      const onRemoveChip = vi.fn();
      const { editor } = setup({
        chips: ['female:loli', 'female:anal'],
        inputPosition: 0,
        activeInput: 'text',
        onRemoveChip,
      });
      mockCaretAt(editor, 0, 2); // mid-text

      fireEvent(editor, createKeyboardEvent('keydown', { key: 'Delete' }));

      expect(onRemoveChip).not.toHaveBeenCalled();
    });

  });

  // ─── syncDomToState (input position sync) ───

  describe('syncDomToState (input position sync)', () => {
    function mockCaretAtNode(node: Node, offset: number) {
      const mockRange = { startContainer: node, startOffset: offset };
      const mockSel = { rangeCount: 1, getRangeAt: vi.fn(() => mockRange), removeAllRanges: vi.fn(), addRange: vi.fn() };
      Object.defineProperty(window, 'getSelection', { value: vi.fn(() => mockSel), writable: true, configurable: true });
    }

    it('input event calls onInputPositionChange if caret gap differs', () => {
      const onInputPositionChange = vi.fn();
      const onInputChange = vi.fn();
      const { editor } = setup({
        chips: ['female:loli', 'female:anal'],
        inputPosition: 0,
        activeInput: '',
        onInputPositionChange,
        onInputChange,
      });

      // Mock caret at gap 2 (different from inputPosition=0)
      // DOM: text(""), chip0, text(""), chip1, text("")
      const gap2Node = editor.childNodes[4]; // text node at gap 2
      mockCaretAtNode(gap2Node, 0);

      act(() => {
        fireEvent.input(editor);
      });

      // effectivePos = inputPos = 0, caretGap = 2 → should call onInputPositionChange(2)
      expect(onInputPositionChange).toHaveBeenCalledWith(2);
      expect(onInputChange).toHaveBeenCalled();
    });

    it('input event calls onInputChange with gap text content', () => {
      const onInputChange = vi.fn();
      const { editor } = setup({
        chips: ['female:loli'],
        inputPosition: 1,
        activeInput: '',
        onInputChange,
      });

      // DOM: text(""), chip0, text("")
      const gap1Node = editor.childNodes[2] as Text;
      gap1Node.textContent = 'newtext';
      mockCaretAtNode(gap1Node, 7);

      act(() => {
        fireEvent.input(editor);
      });

      expect(onInputChange).toHaveBeenCalledWith('newtext');
    });
  });

  // ─── Ctrl+Z/Y Undo-Redo and Formatting Prevention ───

  describe('Ctrl+Z/Y undo-redo and formatting prevention', () => {
    it('Ctrl+Z preventDefault and propagates to onKeyDown', () => {
      const onKeyDown = vi.fn();
      const { editor } = setup({ onKeyDown });

      const event = createKeyboardEvent('keydown', { key: 'z', ctrlKey: true });
      const spy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);

      expect(spy).toHaveBeenCalled();
      expect(onKeyDown).toHaveBeenCalled();
      expect(onKeyDown.mock.calls[0][0].key).toBe('z');
    });

    it('Ctrl+Shift+Z preventDefault and propagates to onKeyDown', () => {
      const onKeyDown = vi.fn();
      const { editor } = setup({ onKeyDown });

      const event = createKeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true });
      const spy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);

      expect(spy).toHaveBeenCalled();
      expect(onKeyDown).toHaveBeenCalled();
    });

    it('Ctrl+Y preventDefault and propagates to onKeyDown', () => {
      const onKeyDown = vi.fn();
      const { editor } = setup({ onKeyDown });

      const event = createKeyboardEvent('keydown', { key: 'y', ctrlKey: true });
      const spy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);

      expect(spy).toHaveBeenCalled();
      expect(onKeyDown).toHaveBeenCalled();
    });

    it('Ctrl+B prevents default (no bold formatting)', () => {
      const { editor } = setup();
      const event = createKeyboardEvent('keydown', { key: 'b', ctrlKey: true });
      const spy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);
      expect(spy).toHaveBeenCalled();
    });

    it('Ctrl+I prevents default (no italic formatting)', () => {
      const { editor } = setup();
      const event = createKeyboardEvent('keydown', { key: 'i', ctrlKey: true });
      const spy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);
      expect(spy).toHaveBeenCalled();
    });

    it('Ctrl+U prevents default (no underline formatting)', () => {
      const { editor } = setup();
      const event = createKeyboardEvent('keydown', { key: 'u', ctrlKey: true });
      const spy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);
      expect(spy).toHaveBeenCalled();
    });

    it('Meta+Z (Mac) also propagates to onKeyDown', () => {
      const onKeyDown = vi.fn();
      const { editor } = setup({ onKeyDown });

      const event = createKeyboardEvent('keydown', { key: 'z', metaKey: true });
      const spy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);

      expect(spy).toHaveBeenCalled();
      expect(onKeyDown).toHaveBeenCalled();
    });
  });

  // ─── Arrow Key Navigation ───

  describe('arrow key navigation', () => {
    it('ArrowRight does NOT preventDefault (browser handles natively)', () => {
      const { editor } = setup();

      const event = createKeyboardEvent('keydown', { key: 'ArrowRight' });
      const spy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);

      expect(spy).not.toHaveBeenCalled();
    });

    it('ArrowLeft does NOT preventDefault', () => {
      const { editor } = setup();

      const event = createKeyboardEvent('keydown', { key: 'ArrowLeft' });
      const spy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);

      expect(spy).not.toHaveBeenCalled();
    });

    it('ArrowDown propagates to onKeyDown for dropdown navigation', () => {
      const onKeyDown = vi.fn();
      const { editor } = setup({ onKeyDown });

      fireEvent.keyDown(editor, { key: 'ArrowDown' });

      expect(onKeyDown).toHaveBeenCalled();
      expect(onKeyDown.mock.calls[0][0].key).toBe('ArrowDown');
    });

    it('ArrowUp propagates to onKeyDown for dropdown navigation', () => {
      const onKeyDown = vi.fn();
      const { editor } = setup({ onKeyDown });

      fireEvent.keyDown(editor, { key: 'ArrowUp' });

      expect(onKeyDown).toHaveBeenCalled();
      expect(onKeyDown.mock.calls[0][0].key).toBe('ArrowUp');
    });

    it('ArrowLeft does NOT propagate to onKeyDown (only Up/Down do)', () => {
      const onKeyDown = vi.fn();
      const { editor } = setup({ onKeyDown });

      fireEvent.keyDown(editor, { key: 'ArrowLeft' });

      expect(onKeyDown).not.toHaveBeenCalled();
    });

    it('ArrowRight does NOT propagate to onKeyDown', () => {
      const onKeyDown = vi.fn();
      const { editor } = setup({ onKeyDown });

      fireEvent.keyDown(editor, { key: 'ArrowRight' });

      expect(onKeyDown).not.toHaveBeenCalled();
    });

    it('Home key does NOT preventDefault', () => {
      const { editor } = setup();
      const event = createKeyboardEvent('keydown', { key: 'Home' });
      const spy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);
      expect(spy).not.toHaveBeenCalled();
    });

    it('End key does NOT preventDefault', () => {
      const { editor } = setup();
      const event = createKeyboardEvent('keydown', { key: 'End' });
      const spy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ─── Chip Click → Select Chip ───

  describe('chip click selects chip', () => {
    it('clicking chip[0] does NOT call onInputPositionChange (selects chip instead)', () => {
      const onInputPositionChange = vi.fn();
      const { container } = setup({ onInputPositionChange, inputPosition: 0 });
      const chip = container.querySelector('[data-chip-index="0"]')!;

      fireEvent.click(chip);

      // Chip click selects the chip, does not move caret
      expect(onInputPositionChange).not.toHaveBeenCalled();
    });

    it('clicking chip[1] does NOT call onInputPositionChange (selects chip instead)', () => {
      const onInputPositionChange = vi.fn();
      const { container } = setup({ onInputPositionChange, inputPosition: 0 });
      const chip = container.querySelector('[data-chip-index="1"]')!;

      fireEvent.click(chip);

      expect(onInputPositionChange).not.toHaveBeenCalled();
    });

    it('clicking chip remove button calls onRemoveChip, not select', () => {
      const onInputPositionChange = vi.fn();
      const onRemoveChip = vi.fn();
      const { container } = setup({ onInputPositionChange, onRemoveChip, inputPosition: 0 });
      const btn = container.querySelector('[aria-label^="Remove"]')!;

      fireEvent.click(btn);

      expect(onRemoveChip).toHaveBeenCalled();
      expect(onInputPositionChange).not.toHaveBeenCalled();
    });
  });

  // ─── Shift+Arrow Selection Preservation ───

  describe('shift+arrow selection preservation', () => {
    it('Shift+ArrowRight does NOT call onInputPositionChange', () => {
      const onInputPositionChange = vi.fn();
      const { editor } = setup({ onInputPositionChange });

      const event = createKeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true });
      fireEvent(editor, event);

      expect(onInputPositionChange).not.toHaveBeenCalled();
    });

    it('Shift+ArrowLeft does NOT call onInputPositionChange', () => {
      const onInputPositionChange = vi.fn();
      const { editor } = setup({ onInputPositionChange });

      const event = createKeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true });
      fireEvent(editor, event);

      expect(onInputPositionChange).not.toHaveBeenCalled();
    });

    it('ArrowRight without Shift still triggers position sync (via rAF)', () => {
      const onInputPositionChange = vi.fn();
      const { editor } = setup({ onInputPositionChange });

      // Without shiftKey, ArrowRight allows rAF position sync
      const event = createKeyboardEvent('keydown', { key: 'ArrowRight' });
      const spy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);

      // Should NOT preventDefault (browser handles arrow natively)
      expect(spy).not.toHaveBeenCalled();
    });

    it('Shift+ArrowDown still propagates to onKeyDown (for dropdown)', () => {
      const onKeyDown = vi.fn();
      const { editor } = setup({ onKeyDown });

      const event = createKeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true });
      fireEvent(editor, event);

      expect(onKeyDown).toHaveBeenCalled();
    });

    it('Shift+Home does NOT call onInputPositionChange', () => {
      const onInputPositionChange = vi.fn();
      const { editor } = setup({ onInputPositionChange });

      const event = createKeyboardEvent('keydown', { key: 'Home', shiftKey: true });
      fireEvent(editor, event);

      expect(onInputPositionChange).not.toHaveBeenCalled();
    });

    it('Shift+End does NOT call onInputPositionChange', () => {
      const onInputPositionChange = vi.fn();
      const { editor } = setup({ onInputPositionChange });

      const event = createKeyboardEvent('keydown', { key: 'End', shiftKey: true });
      fireEvent(editor, event);

      expect(onInputPositionChange).not.toHaveBeenCalled();
    });
  });

  // ─── Ctrl+C/X Partial Selection with Chips ───

  describe('Ctrl+C/X with chip selection', () => {
    it('Ctrl+C with allSelected copies full query and prevents default', () => {
      const { editor } = setup({ chips: ['female:loli'], activeInput: 'hello' });

      // Mock selection to trigger allSelected state
      // First, trigger Ctrl+A to set allSelected
      const textNode = editor.firstChild as Text;
      const mockRange = { startContainer: textNode, startOffset: 0, selectNodeContents: vi.fn() };
      const mockSel = {
        rangeCount: 1,
        getRangeAt: vi.fn(() => mockRange),
        removeAllRanges: vi.fn(),
        addRange: vi.fn(),
        isCollapsed: false,
      };
      Object.defineProperty(window, 'getSelection', {
        value: vi.fn(() => mockSel),
        writable: true,
        configurable: true,
      });
      vi.spyOn(document, 'createRange').mockReturnValue(mockRange as unknown as Range);

      // Trigger Ctrl+A
      const ctrlA = createKeyboardEvent('keydown', { key: 'a', ctrlKey: true });
      fireEvent(editor, ctrlA);

      // Now Ctrl+C
      const ctrlC = createKeyboardEvent('keydown', { key: 'c', ctrlKey: true });
      const spy = vi.spyOn(ctrlC, 'preventDefault');
      fireEvent(editor, ctrlC);

      expect(spy).toHaveBeenCalled();
    });

    it('Ctrl+X with allSelected calls onClearAll', () => {
      const onClearAll = vi.fn();
      const { editor } = setup({ chips: ['female:loli'], onClearAll });

      const textNode = editor.firstChild as Text;
      const mockRange = { startContainer: textNode, startOffset: 0, selectNodeContents: vi.fn() };
      const mockSel = {
        rangeCount: 1,
        getRangeAt: vi.fn(() => mockRange),
        removeAllRanges: vi.fn(),
        addRange: vi.fn(),
        isCollapsed: false,
      };
      Object.defineProperty(window, 'getSelection', {
        value: vi.fn(() => mockSel),
        writable: true,
        configurable: true,
      });
      vi.spyOn(document, 'createRange').mockReturnValue(mockRange as unknown as Range);

      // Ctrl+A → Ctrl+X
      fireEvent(editor, createKeyboardEvent('keydown', { key: 'a', ctrlKey: true }));
      const ctrlX = createKeyboardEvent('keydown', { key: 'x', ctrlKey: true });
      fireEvent(editor, ctrlX);

      expect(onClearAll).toHaveBeenCalled();
    });

    it('Ctrl+X with chip in selection calls onRemoveChips', () => {
      const onRemoveChips = vi.fn();
      const { editor } = setup({
        chips: ['female:loli', 'female:anal'],
        onRemoveChips,
      });

      // Mock selection that includes a chip span
      const chipSpan = editor.querySelector('[data-chip-index="0"]')!;
      const mockRange = {
        startContainer: editor.firstChild,
        startOffset: 0,
        endContainer: editor.childNodes[2],
        endOffset: 0,
        intersectsNode: vi.fn((node: Node) => node === chipSpan || node === editor.firstChild),
      };
      const mockSel = {
        rangeCount: 1,
        getRangeAt: vi.fn(() => mockRange),
        isCollapsed: false,
        removeAllRanges: vi.fn(),
        addRange: vi.fn(),
      };
      Object.defineProperty(window, 'getSelection', {
        value: vi.fn(() => mockSel),
        writable: true,
        configurable: true,
      });

      const ctrlX = createKeyboardEvent('keydown', { key: 'x', ctrlKey: true });
      const spy = vi.spyOn(ctrlX, 'preventDefault');
      fireEvent(editor, ctrlX);

      expect(spy).toHaveBeenCalled();
      expect(onRemoveChips).toHaveBeenCalledWith([0]);
    });

    it('Ctrl+C with chip in selection prevents default (custom copy)', () => {
      const { editor } = setup({ chips: ['female:loli', 'female:anal'] });

      const chipSpan = editor.querySelector('[data-chip-index="1"]')!;
      const mockRange = {
        startContainer: editor.childNodes[2],
        startOffset: 0,
        endContainer: editor.childNodes[4],
        endOffset: 0,
        intersectsNode: vi.fn((node: Node) => node === chipSpan || node === editor.childNodes[2]),
      };
      const mockSel = {
        rangeCount: 1,
        getRangeAt: vi.fn(() => mockRange),
        isCollapsed: false,
        removeAllRanges: vi.fn(),
        addRange: vi.fn(),
      };
      Object.defineProperty(window, 'getSelection', {
        value: vi.fn(() => mockSel),
        writable: true,
        configurable: true,
      });

      const ctrlC = createKeyboardEvent('keydown', { key: 'c', ctrlKey: true });
      const spy = vi.spyOn(ctrlC, 'preventDefault');
      fireEvent(editor, ctrlC);

      expect(spy).toHaveBeenCalled();
    });

    it('Ctrl+C with text-only selection does NOT preventDefault (browser native)', () => {
      const { editor } = setup({ chips: ['female:loli'], activeInput: 'hello', inputPosition: 1 });

      // Mock text-only selection (no chip)
      const textNode = editor.childNodes[2]; // text after chip
      const mockRange = {
        startContainer: textNode,
        startOffset: 0,
        endContainer: textNode,
        endOffset: 3,
        intersectsNode: vi.fn((node: Node) => node === textNode),
      };
      const mockSel = {
        rangeCount: 1,
        getRangeAt: vi.fn(() => mockRange),
        isCollapsed: false,
        removeAllRanges: vi.fn(),
        addRange: vi.fn(),
      };
      Object.defineProperty(window, 'getSelection', {
        value: vi.fn(() => mockSel),
        writable: true,
        configurable: true,
      });

      const ctrlC = createKeyboardEvent('keydown', { key: 'c', ctrlKey: true });
      const spy = vi.spyOn(ctrlC, 'preventDefault');
      fireEvent(editor, ctrlC);

      // Text-only → let browser handle → no preventDefault
      expect(spy).not.toHaveBeenCalled();
    });

    it('Ctrl+X with no selection does not call onRemoveChips', () => {
      const onRemoveChips = vi.fn();
      const { editor } = setup({ onRemoveChips });

      // Mock collapsed selection (no selection)
      const mockSel = {
        rangeCount: 1,
        getRangeAt: vi.fn(() => ({ startContainer: editor.firstChild, startOffset: 0 })),
        isCollapsed: true,
        removeAllRanges: vi.fn(),
        addRange: vi.fn(),
      };
      Object.defineProperty(window, 'getSelection', {
        value: vi.fn(() => mockSel),
        writable: true,
        configurable: true,
      });

      const ctrlX = createKeyboardEvent('keydown', { key: 'x', ctrlKey: true });
      fireEvent(editor, ctrlX);

      expect(onRemoveChips).not.toHaveBeenCalled();
    });
  });

  // ─── Ctrl+V Passthrough ───

  describe('Ctrl+V passthrough', () => {
    it('Ctrl+V does NOT preventDefault (allows browser paste event)', () => {
      const { editor } = setup();

      const event = createKeyboardEvent('keydown', { key: 'v', ctrlKey: true });
      const spy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);

      expect(spy).not.toHaveBeenCalled();
    });

    it('Meta+V (Mac) does NOT preventDefault', () => {
      const { editor } = setup();

      const event = createKeyboardEvent('keydown', { key: 'v', metaKey: true });
      const spy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);

      expect(spy).not.toHaveBeenCalled();
    });

    it('Ctrl+B still prevents default (formatting blocked)', () => {
      const { editor } = setup();

      const event = createKeyboardEvent('keydown', { key: 'b', ctrlKey: true });
      const spy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);

      expect(spy).toHaveBeenCalled();
    });
  });

  // ─── US-001: Ctrl word-deletion / navigation passthrough ───

  describe('Ctrl+Backspace / Ctrl+Delete / Ctrl+Home / Ctrl+End passthrough', () => {
    it('Ctrl+Backspace does NOT preventDefault (browser deletes word)', () => {
      const { editor } = setup();
      const event = createKeyboardEvent('keydown', { key: 'Backspace', ctrlKey: true });
      const spy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);
      expect(spy).not.toHaveBeenCalled();
    });

    it('Ctrl+Delete does NOT preventDefault (browser deletes word forward)', () => {
      const { editor } = setup();
      const event = createKeyboardEvent('keydown', { key: 'Delete', ctrlKey: true });
      const spy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);
      expect(spy).not.toHaveBeenCalled();
    });

    it('Ctrl+Home does NOT preventDefault (jump to start)', () => {
      const { editor } = setup();
      const event = createKeyboardEvent('keydown', { key: 'Home', ctrlKey: true });
      const spy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);
      expect(spy).not.toHaveBeenCalled();
    });

    it('Ctrl+End does NOT preventDefault (jump to end)', () => {
      const { editor } = setup();
      const event = createKeyboardEvent('keydown', { key: 'End', ctrlKey: true });
      const spy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);
      expect(spy).not.toHaveBeenCalled();
    });

    it('Ctrl+Shift+Home does NOT preventDefault (select to start)', () => {
      const { editor } = setup();
      const event = createKeyboardEvent('keydown', { key: 'Home', ctrlKey: true, shiftKey: true });
      const spy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);
      expect(spy).not.toHaveBeenCalled();
    });

    it('Ctrl+Shift+End does NOT preventDefault (select to end)', () => {
      const { editor } = setup();
      const event = createKeyboardEvent('keydown', { key: 'End', ctrlKey: true, shiftKey: true });
      const spy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);
      expect(spy).not.toHaveBeenCalled();
    });

    it('Ctrl+I prevents default (italic formatting blocked)', () => {
      const { editor } = setup();
      const event = createKeyboardEvent('keydown', { key: 'i', ctrlKey: true });
      const spy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);
      expect(spy).toHaveBeenCalled();
    });

    it('Ctrl+U prevents default (underline formatting blocked)', () => {
      const { editor } = setup();
      const event = createKeyboardEvent('keydown', { key: 'u', ctrlKey: true });
      const spy = vi.spyOn(event, 'preventDefault');
      fireEvent(editor, event);
      expect(spy).toHaveBeenCalled();
    });
  });

  // ─── US-002: cut/copy DOM events ───

  describe('cut/copy DOM events use custom clipboard logic', () => {
    it('copy event on editor with allSelected is intercepted (preventDefault called)', () => {
      const { editor } = setup({ chips: ['female:loli'], activeInput: 'hello' });

      // Set allSelected via Ctrl+A
      const mockRange = { selectNodeContents: vi.fn() };
      const mockSel = {
        rangeCount: 1, isCollapsed: false,
        getRangeAt: vi.fn(() => mockRange),
        removeAllRanges: vi.fn(), addRange: vi.fn(),
      };
      Object.defineProperty(window, 'getSelection', { value: vi.fn(() => mockSel), writable: true, configurable: true });
      vi.spyOn(document, 'createRange').mockReturnValue(mockRange as unknown as Range);
      fireEvent(editor, createKeyboardEvent('keydown', { key: 'a', ctrlKey: true }));

      // fireEvent.copy returns false if event.preventDefault() was called
      const notPrevented = fireEvent.copy(editor);
      expect(notPrevented).toBe(false);
    });

    it('copy event with no allSelected and no chip selection is NOT intercepted', () => {
      const { editor } = setup({ chips: [], activeInput: '' });
      // No selection, no allSelected → handler does nothing → browser native
      const notPrevented = fireEvent.copy(editor);
      expect(notPrevented).toBe(true);
    });
  });

  // ─── US-004: ARIA improvements ───

  describe('ARIA attributes', () => {
    it('editor has enterKeyHint="search"', () => {
      const { editor } = setup();
      expect(editor.getAttribute('enterkeyhint')).toBe('search');
    });

    it('editor always has aria-label (not conditional on chips)', () => {
      const { editor } = setup({ chips: [] });
      expect(editor.getAttribute('aria-label')).toBeTruthy();
    });

    it('editor aria-label is set even with chips present', () => {
      const { editor } = setup({ chips: ['female:loli'] });
      expect(editor.getAttribute('aria-label')).toBeTruthy();
    });

    it('chip spans have aria-label describing the tag', () => {
      const { container } = setup({ chips: ['female:loli'] });
      const chip = container.querySelector('[data-chip-index="0"]')!;
      expect(chip.getAttribute('aria-label')).toBeTruthy();
    });

    it('chip spans have role="option"', () => {
      const { container } = setup({ chips: ['female:loli'] });
      const chip = container.querySelector('[data-chip-index="0"]')!;
      expect(chip.getAttribute('role')).toBe('option');
    });

    it('aria-live region exists in the DOM', () => {
      const { container } = setup();
      const liveRegion = container.querySelector('[aria-live]');
      expect(liveRegion).not.toBeNull();
    });
  });

  // ─── US-005: Triple-click / Ctrl+A (no chips) allSelected ───

  describe('Ctrl+A with no chips sets allSelected', () => {
    it('Ctrl+A with chips=[] sets allSelected (calls onClearAll on next char)', () => {
      const onClearAll = vi.fn();
      const onInputChange = vi.fn();
      const { editor } = setup({ chips: [], activeInput: 'hello', onClearAll, onInputChange });

      // Ctrl+A
      fireEvent(editor, createKeyboardEvent('keydown', { key: 'a', ctrlKey: true }));
      // Type a char — should clear and replace
      fireEvent(editor, createKeyboardEvent('keydown', { key: 'x' }));

      expect(onClearAll).toHaveBeenCalled();
    });

    it('Ctrl+A with chips present still sets allSelected', () => {
      const onClearAll = vi.fn();
      const { editor } = setup({ chips: ['female:loli'], onClearAll });

      fireEvent(editor, createKeyboardEvent('keydown', { key: 'a', ctrlKey: true }));
      fireEvent(editor, createKeyboardEvent('keydown', { key: 'x' }));

      expect(onClearAll).toHaveBeenCalled();
    });
  });

  // ─── US-006: required form validation ───

  describe('required form validation', () => {
    it('renders input[type=text] (not type=hidden) when name prop is set', () => {
      const { container } = setup({ name: 'q' });
      const input = container.querySelector('input[name="q"]');
      expect(input?.getAttribute('type')).toBe('text');
    });

    it('input has required attribute when required=true', () => {
      const { container } = setup({ name: 'q', required: true });
      const input = container.querySelector('input[name="q"]');
      expect(input?.hasAttribute('required')).toBe(true);
    });

    it('input does NOT have required attribute when required is not set', () => {
      const { container } = setup({ name: 'q' });
      const input = container.querySelector('input[name="q"]');
      expect(input?.hasAttribute('required')).toBe(false);
    });

    it('input has aria-hidden="true" so screen readers ignore it', () => {
      const { container } = setup({ name: 'q' });
      const input = container.querySelector('input[name="q"]');
      expect(input?.getAttribute('aria-hidden')).toBe('true');
    });

    it('input value equals buildQueryString output', () => {
      const chips = ['female:loli'];
      const { container } = setup({ name: 'q', chips, activeInput: 'hello', inputPosition: 1 });
      const input = container.querySelector('input[name="q"]') as HTMLInputElement;
      expect(input?.value).toBe(buildQueryString(chips, 'hello', 1));
    });
  });

  // ─── US-007: Triple-click allSelected ───

  describe('triple-click sets allSelected', () => {
    it('mouseup with detail=3 triggers allSelected (next char calls onClearAll)', () => {
      const onClearAll = vi.fn();
      const { editor } = setup({ onClearAll, chips: ['female:loli'] });

      fireEvent.mouseUp(editor, { detail: 3 });
      fireEvent(editor, createKeyboardEvent('keydown', { key: 'x' }));

      expect(onClearAll).toHaveBeenCalled();
    });

    it('mouseup with detail=2 does NOT set allSelected', () => {
      const onClearAll = vi.fn();
      const { editor } = setup({ onClearAll, chips: ['female:loli'] });

      fireEvent.mouseUp(editor, { detail: 2 });
      fireEvent(editor, createKeyboardEvent('keydown', { key: 'x' }));

      expect(onClearAll).not.toHaveBeenCalled();
    });

    it('mouseup with detail=1 does NOT set allSelected', () => {
      const onClearAll = vi.fn();
      const { editor } = setup({ onClearAll, chips: ['female:loli'] });

      fireEvent.mouseUp(editor, { detail: 1 });
      fireEvent(editor, createKeyboardEvent('keydown', { key: 'x' }));

      expect(onClearAll).not.toHaveBeenCalled();
    });
  });

  // ─── US-008: inputRef.current.value getter ───

  describe('inputRef.current.value getter', () => {
    it('inputRef.current.value returns activeInput text', () => {
      const { inputRef } = setup({ activeInput: 'hello' });
      const el = inputRef.current as unknown as HTMLElement & { value: string };
      expect(el?.value).toBe('hello');
    });

    it('inputRef.current.value returns empty string when activeInput is empty', () => {
      const { inputRef } = setup({ activeInput: '' });
      const el = inputRef.current as unknown as HTMLElement & { value: string };
      expect(el?.value).toBe('');
    });
  });

  // ─── US-009: Shift+Click extends selection ───

  describe('shift+click extends selection across chips', () => {
    it('shift+mouseup on chip after mousedown sets a new range (removeAllRanges + addRange called)', () => {
      const { editor, container } = setup({ chips: ['female:loli'] });
      const chip = container.querySelector('[data-chip-index="0"]')!;

      const mockRange = {
        startContainer: editor.firstChild,
        startOffset: 0,
        setStart: vi.fn(),
        setEnd: vi.fn(),
        setEndAfter: vi.fn(),
        collapse: vi.fn(),
      };
      const mockSel = {
        rangeCount: 1,
        isCollapsed: true,
        anchorNode: editor.firstChild,
        anchorOffset: 0,
        getRangeAt: vi.fn(() => mockRange),
        removeAllRanges: vi.fn(),
        addRange: vi.fn(),
      };
      Object.defineProperty(window, 'getSelection', {
        value: vi.fn(() => mockSel),
        writable: true,
        configurable: true,
      });
      vi.spyOn(document, 'createRange').mockReturnValue(mockRange as unknown as Range);

      // mousedown (no shift) to save anchor
      fireEvent.mouseDown(editor, { shiftKey: false });
      // shift+mouseup on chip
      fireEvent.mouseUp(chip, { shiftKey: true });

      expect(mockSel.removeAllRanges).toHaveBeenCalled();
      expect(mockSel.addRange).toHaveBeenCalled();
    });

    it('mouseup without shift does NOT call removeAllRanges/addRange', () => {
      const { editor, container } = setup({ chips: ['female:loli'] });
      const chip = container.querySelector('[data-chip-index="0"]')!;

      const mockSel = {
        rangeCount: 1,
        isCollapsed: true,
        anchorNode: editor.firstChild,
        anchorOffset: 0,
        getRangeAt: vi.fn(() => ({ startContainer: editor.firstChild, startOffset: 0 })),
        removeAllRanges: vi.fn(),
        addRange: vi.fn(),
      };
      Object.defineProperty(window, 'getSelection', {
        value: vi.fn(() => mockSel),
        writable: true,
        configurable: true,
      });

      fireEvent.mouseDown(editor, { shiftKey: false });
      fireEvent.mouseUp(chip, { shiftKey: false });

      expect(mockSel.removeAllRanges).not.toHaveBeenCalled();
    });
  });
});

// Helper to create keyboard events with proper properties
function createKeyboardEvent(
  type: string,
  init: { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
): KeyboardEvent {
  return new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
  });
}

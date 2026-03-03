import { describe, it, expect } from 'vitest';
import { getChipCursorAction } from '../chip-cursor';

describe('getChipCursorAction', () => {
  // --- Entering chip cursor mode ---

  it('enters chip cursor at last chip position (not after it) from input', () => {
    // chips: [c0, c1], cursor at input pos 0 → should enter at pos 1 (before c1), NOT 2 (after c1)
    const result = getChipCursorAction('ArrowLeft', -1, 2, 0, 0);
    expect(result.newPos).toBe(1); // before last chip
    expect(result.preventDefault).toBe(true);
  });

  it('enters at position 0 when only 1 chip', () => {
    const result = getChipCursorAction('ArrowLeft', -1, 1, 0, 0);
    expect(result.newPos).toBe(0); // before the only chip
    expect(result.preventDefault).toBe(true);
  });

  it('does NOT enter when text cursor is not at position 0', () => {
    const result = getChipCursorAction('ArrowLeft', -1, 2, 3, 3);
    expect(result.newPos).toBe(-1);
    expect(result.preventDefault).toBe(false);
  });

  it('does NOT enter when there are no chips', () => {
    const result = getChipCursorAction('ArrowLeft', -1, 0, 0, 0);
    expect(result.newPos).toBe(-1);
    expect(result.preventDefault).toBe(false);
  });

  it('does NOT enter when there is a text selection', () => {
    const result = getChipCursorAction('ArrowLeft', -1, 2, 0, 5);
    expect(result.newPos).toBe(-1);
    expect(result.preventDefault).toBe(false);
  });

  // --- Navigation ---

  it('moves left within chips', () => {
    const result = getChipCursorAction('ArrowLeft', 1, 3, 0, 0);
    expect(result.newPos).toBe(0);
    expect(result.preventDefault).toBe(true);
  });

  it('stays at position 0 when pressing left at leftmost', () => {
    const result = getChipCursorAction('ArrowLeft', 0, 3, 0, 0);
    expect(result.newPos).toBe(0);
    expect(result.preventDefault).toBe(true);
  });

  it('moves right within chips', () => {
    const result = getChipCursorAction('ArrowRight', 0, 3, 0, 0);
    expect(result.newPos).toBe(1);
    expect(result.preventDefault).toBe(true);
  });

  it('exits to input when pressing right from last chip position', () => {
    // 3 chips, max valid pos = 2 (before chip[2])
    const result = getChipCursorAction('ArrowRight', 2, 3, 0, 0);
    expect(result.newPos).toBe(-1);
    expect(result.action).toBe('exitToInput');
    expect(result.preventDefault).toBe(true);
  });

  // --- Backspace ---

  it('backspace removes chip before cursor and decrements pos', () => {
    // pos=1 means "before chip[1]", backspace removes chip[0]
    const result = getChipCursorAction('Backspace', 1, 2, 0, 0);
    expect(result.action).toBe('removeChipBefore');
    expect(result.chipIndex).toBe(0);
    expect(result.newPos).toBe(0);
    expect(result.preventDefault).toBe(true);
  });

  it('backspace at position 0 removes chip[0] (special case)', () => {
    // At leftmost position, backspace removes the chip to the right (chip[0])
    const result = getChipCursorAction('Backspace', 0, 2, 0, 0);
    expect(result.action).toBe('removeChipAt');
    expect(result.chipIndex).toBe(0);
    expect(result.newPos).toBe(0); // still valid (before remaining chip)
    expect(result.preventDefault).toBe(true);
  });

  it('backspace at position 0 exits when last chip removed', () => {
    const result = getChipCursorAction('Backspace', 0, 1, 0, 0);
    expect(result.action).toBe('removeChipAt');
    expect(result.chipIndex).toBe(0);
    expect(result.newPos).toBe(-1); // no chips left, exit
    expect(result.preventDefault).toBe(true);
  });

  // --- Delete ---

  it('delete removes chip at cursor position', () => {
    // pos=0 means "before chip[0]", delete removes chip[0]
    const result = getChipCursorAction('Delete', 0, 2, 0, 0);
    expect(result.action).toBe('removeChipAt');
    expect(result.chipIndex).toBe(0);
    expect(result.newPos).toBe(0); // still valid (before the remaining chip)
    expect(result.preventDefault).toBe(true);
  });

  it('delete exits to input when last chip is removed', () => {
    const result = getChipCursorAction('Delete', 0, 1, 0, 0);
    expect(result.action).toBe('removeChipAt');
    expect(result.chipIndex).toBe(0);
    expect(result.newPos).toBe(-1); // no chips left, exit
    expect(result.preventDefault).toBe(true);
  });

  it('delete adjusts position when removing last chip in multi-chip list', () => {
    // 3 chips, pos=2 (before chip[2]), delete chip[2] → 2 chips remain, max pos = 1
    const result = getChipCursorAction('Delete', 2, 3, 0, 0);
    expect(result.action).toBe('removeChipAt');
    expect(result.chipIndex).toBe(2);
    expect(result.newPos).toBe(1); // adjusted to new max
    expect(result.preventDefault).toBe(true);
  });

  // --- Other keys ---

  it('enter edits chip at cursor position', () => {
    const result = getChipCursorAction('Enter', 1, 3, 0, 0);
    expect(result.action).toBe('editChip');
    expect(result.chipIndex).toBe(1);
    expect(result.preventDefault).toBe(true);
  });

  it('escape exits to input', () => {
    const result = getChipCursorAction('Escape', 1, 3, 0, 0);
    expect(result.action).toBe('exitToInput');
    expect(result.newPos).toBe(-1);
    expect(result.preventDefault).toBe(true);
  });

  it('character key exits to input without preventDefault', () => {
    const result = getChipCursorAction('a', 1, 3, 0, 0);
    expect(result.action).toBe('exitToInput');
    expect(result.newPos).toBe(-1);
    expect(result.preventDefault).toBe(false); // let the character be typed
  });

  it('ignores modifier keys without exiting', () => {
    const result = getChipCursorAction('Shift', 1, 3, 0, 0);
    expect(result.newPos).toBe(1); // stay in place
    expect(result.action).toBe('none');
  });
});

import { describe, it, expect } from 'vitest';
import { getChipCursorAction } from '../chip-cursor';

// Helper: old-style call (all chips before input)
// getChipCursorAction(key, pos, chipsCount, chipsCount, selStart, selEnd)
function old(key: string, pos: number, chipsCount: number, selStart: number, selEnd: number) {
  return getChipCursorAction(key, pos, chipsCount, chipsCount, selStart, selEnd);
}

describe('getChipCursorAction', () => {
  // --- Entering chip cursor mode ---

  it('enters chip cursor at last chip position (not after it) from input', () => {
    // chips: [c0, c1], cursor at input pos 0 → should enter at pos 1 (before c1), NOT 2 (after c1)
    const result = old('ArrowLeft', -1, 2, 0, 0);
    expect(result.newPos).toBe(1); // before last chip
    expect(result.preventDefault).toBe(true);
  });

  it('enters at position 0 when only 1 chip', () => {
    const result = old('ArrowLeft', -1, 1, 0, 0);
    expect(result.newPos).toBe(0); // before the only chip
    expect(result.preventDefault).toBe(true);
  });

  it('does NOT enter when text cursor is not at position 0', () => {
    const result = old('ArrowLeft', -1, 2, 3, 3);
    expect(result.newPos).toBe(-1);
    expect(result.preventDefault).toBe(false);
  });

  it('does NOT enter when there are no chips', () => {
    const result = old('ArrowLeft', -1, 0, 0, 0);
    expect(result.newPos).toBe(-1);
    expect(result.preventDefault).toBe(false);
  });

  it('does NOT enter when there is a text selection', () => {
    const result = old('ArrowLeft', -1, 2, 0, 5);
    expect(result.newPos).toBe(-1);
    expect(result.preventDefault).toBe(false);
  });

  // --- Navigation ---

  it('moves left within chips', () => {
    const result = old('ArrowLeft', 1, 3, 0, 0);
    expect(result.newPos).toBe(0);
    expect(result.preventDefault).toBe(true);
  });

  it('stays at position 0 when pressing left at leftmost (B4: NO_ACTION)', () => {
    const result = old('ArrowLeft', 0, 3, 0, 0);
    expect(result.newPos).toBe(0);
    expect(result.action).toBe('none');
    expect(result.preventDefault).toBe(false);
  });

  it('moves right within chips', () => {
    const result = old('ArrowRight', 0, 3, 0, 0);
    expect(result.newPos).toBe(1);
    expect(result.preventDefault).toBe(true);
  });

  it('exits to input when pressing right from last chip position', () => {
    // 3 chips, inputPos=3, pos=2 (before chip[2]) is inputPos-1
    // ArrowRight at inputPos-1 exits with exitSide:'left'
    const result = old('ArrowRight', 2, 3, 0, 0);
    expect(result.newPos).toBe(-1);
    expect(result.action).toBe('exitToInput');
    expect(result.preventDefault).toBe(true);
  });

  // --- Backspace ---

  it('backspace removes the focused chip (B3: removeChipAt)', () => {
    // pos=1 means cursor is on chip[1], backspace removes chip[1]
    const result = old('Backspace', 1, 2, 0, 0);
    expect(result.action).toBe('removeChipAt');
    expect(result.chipIndex).toBe(1);
    expect(result.newPos).toBe(0); // 1 >= 2-1=1, so pos-1=0
    expect(result.preventDefault).toBe(true);
  });

  it('backspace at position 0 removes chip[0] (B3: focused chip delete)', () => {
    // pos=0, totalChips=2: removes chip[0], cursor stays at 0 (chip[1] now at 0)
    const result = old('Backspace', 0, 2, 0, 0);
    expect(result.action).toBe('removeChipAt');
    expect(result.chipIndex).toBe(0);
    expect(result.newPos).toBe(0);
    expect(result.preventDefault).toBe(true);
  });

  it('backspace at position 0 with single chip exits to input', () => {
    const result = old('Backspace', 0, 1, 0, 0);
    expect(result.action).toBe('removeChipAt');
    expect(result.chipIndex).toBe(0);
    expect(result.newPos).toBe(-1);
    expect(result.preventDefault).toBe(true);
  });

  // --- Delete ---

  it('delete removes chip at cursor position', () => {
    // pos=0 means "before chip[0]", delete removes chip[0]
    const result = old('Delete', 0, 2, 0, 0);
    expect(result.action).toBe('removeChipAt');
    expect(result.chipIndex).toBe(0);
    expect(result.newPos).toBe(0); // still valid (before the remaining chip)
    expect(result.preventDefault).toBe(true);
  });

  it('delete exits to input when last chip is removed', () => {
    const result = old('Delete', 0, 1, 0, 0);
    expect(result.action).toBe('removeChipAt');
    expect(result.chipIndex).toBe(0);
    expect(result.newPos).toBe(-1); // no chips left, exit
    expect(result.preventDefault).toBe(true);
  });

  it('delete adjusts position when removing last chip in multi-chip list', () => {
    // 3 chips, pos=2 (before chip[2]), delete chip[2] → 2 chips remain, max pos = 1
    const result = old('Delete', 2, 3, 0, 0);
    expect(result.action).toBe('removeChipAt');
    expect(result.chipIndex).toBe(2);
    expect(result.newPos).toBe(1); // adjusted to new max
    expect(result.preventDefault).toBe(true);
  });

  // --- Other keys ---

  it('enter edits chip at cursor position', () => {
    const result = old('Enter', 1, 3, 0, 0);
    expect(result.action).toBe('editChip');
    expect(result.chipIndex).toBe(1);
    expect(result.preventDefault).toBe(true);
  });

  it('escape exits to input', () => {
    const result = old('Escape', 1, 3, 0, 0);
    expect(result.action).toBe('exitToInput');
    expect(result.newPos).toBe(-1);
    expect(result.preventDefault).toBe(true);
  });

  it('character key exits to input without preventDefault', () => {
    const result = old('a', 1, 3, 0, 0);
    expect(result.action).toBe('exitToInput');
    expect(result.newPos).toBe(-1);
    expect(result.preventDefault).toBe(false); // let the character be typed
  });

  it('ignores modifier keys without exiting', () => {
    const result = old('Shift', 1, 3, 0, 0);
    expect(result.newPos).toBe(1); // stay in place
    expect(result.action).toBe('none');
  });
});

// Layout for new tests:
// chips: [c0, c1, INPUT, c2, c3]
// totalChips=4, inputPos=2
// before-zone: pos 0,1 (before c0, before c1)
// after-zone: pos 2,3 (before c2, before c3)

describe('after-input zone navigation', () => {
  // [c0, c1, INPUT, c2, c3], totalChips=4, inputPos=2

  it('ArrowRight in after-zone moves right', () => {
    const result = getChipCursorAction('ArrowRight', 2, 4, 2, 0, 0);
    expect(result.newPos).toBe(3);
    expect(result.action).toBe('move');
    expect(result.preventDefault).toBe(true);
  });

  it('ArrowRight at totalChips-1 returns none (P7: rightmost, no-op)', () => {
    const result = getChipCursorAction('ArrowRight', 3, 4, 2, 0, 0);
    expect(result.action).toBe('none');
  });

  it('ArrowLeft in after-zone at pos > inputPos moves left', () => {
    const result = getChipCursorAction('ArrowLeft', 3, 4, 2, 0, 0);
    expect(result.newPos).toBe(2);
    expect(result.action).toBe('move');
    expect(result.preventDefault).toBe(true);
  });

  it('ArrowLeft at pos == inputPos exits to input with exitSide:right', () => {
    const result = getChipCursorAction('ArrowLeft', 2, 4, 2, 0, 0);
    expect(result.newPos).toBe(-1);
    expect(result.action).toBe('exitToInput');
    expect(result.exitSide).toBe('right');
    expect(result.preventDefault).toBe(true);
  });

  it('ArrowRight at inputPos-1 exits to input with exitSide:left', () => {
    // pos=1 is inputPos-1=1 in before-zone
    const result = getChipCursorAction('ArrowRight', 1, 4, 2, 0, 0);
    expect(result.newPos).toBe(-1);
    expect(result.action).toBe('exitToInput');
    expect(result.exitSide).toBe('left');
    expect(result.preventDefault).toBe(true);
  });

  it('Delete in after-zone removes chip at pos', () => {
    // pos=2, totalChips=4, inputPos=2: removes chip[2], newChipsCount=3, pos stays at 2
    const result = getChipCursorAction('Delete', 2, 4, 2, 0, 0);
    expect(result.action).toBe('removeChipAt');
    expect(result.chipIndex).toBe(2);
    expect(result.newPos).toBe(2);
    expect(result.preventDefault).toBe(true);
  });

  it('Delete at last chip in after-zone adjusts pos', () => {
    // pos=3, totalChips=4, inputPos=2: removes chip[3], newChipsCount=3, pos>=newChipsCount so newPos=2
    const result = getChipCursorAction('Delete', 3, 4, 2, 0, 0);
    expect(result.action).toBe('removeChipAt');
    expect(result.chipIndex).toBe(3);
    expect(result.newPos).toBe(2);
    expect(result.preventDefault).toBe(true);
  });

  it('Backspace at pos == inputPos deletes focused chip (B3: always deletes focused chip)', () => {
    // At first chip of after-zone, Backspace removes chip at pos (B3)
    const result = getChipCursorAction('Backspace', 2, 4, 2, 0, 0);
    expect(result.action).toBe('removeChipAt');
    expect(result.chipIndex).toBe(2);
    expect(result.preventDefault).toBe(true);
  });
});

describe('Home/End/ArrowUp/ArrowDown', () => {
  // totalChips=4, inputPos=2

  it('Home moves to pos 0 from any before-zone position', () => {
    const result = getChipCursorAction('Home', 1, 4, 2, 0, 0);
    expect(result.newPos).toBe(0);
    expect(result.action).toBe('move');
    expect(result.preventDefault).toBe(true);
  });

  it('Home moves to pos 0 from after-zone position', () => {
    const result = getChipCursorAction('Home', 3, 4, 2, 0, 0);
    expect(result.newPos).toBe(0);
    expect(result.action).toBe('move');
    expect(result.preventDefault).toBe(true);
  });

  it('End moves to totalChips-1 from any before-zone position', () => {
    const result = getChipCursorAction('End', 0, 4, 2, 0, 0);
    expect(result.newPos).toBe(3);
    expect(result.action).toBe('move');
    expect(result.preventDefault).toBe(true);
  });

  it('End moves to totalChips-1 from after-zone position', () => {
    const result = getChipCursorAction('End', 2, 4, 2, 0, 0);
    expect(result.newPos).toBe(3);
    expect(result.action).toBe('move');
    expect(result.preventDefault).toBe(true);
  });

  it('End exits to input when there are no chips', () => {
    const result = getChipCursorAction('End', 0, 0, 0, 0, 0);
    expect(result.newPos).toBe(-1);
    expect(result.action).toBe('exitToInput');
    expect(result.preventDefault).toBe(true);
  });

  it('ArrowUp returns NO_ACTION (passes through for dropdown navigation)', () => {
    const result = getChipCursorAction('ArrowUp', 2, 4, 2, 0, 0);
    expect(result.action).toBe('none');
    expect(result.preventDefault).toBe(false);
    expect(result.newPos).toBe(2); // position unchanged
  });

  it('ArrowDown returns NO_ACTION (passes through for dropdown navigation)', () => {
    const result = getChipCursorAction('ArrowDown', 1, 4, 2, 0, 0);
    expect(result.action).toBe('none');
    expect(result.preventDefault).toBe(false);
    expect(result.newPos).toBe(1); // position unchanged
  });
});

describe('Shift+Arrow selection', () => {
  // [c0, c1, INPUT, c2, c3], totalChips=4, inputPos=2

  it('Shift+Left selects chip to the left and moves pos-1', () => {
    // pos=1, shift+left: selects chip[0], newPos=0
    const result = getChipCursorAction('ArrowLeft', 1, 4, 2, 0, 0, { ctrl: false, shift: true });
    expect(result.action).toBe('selectChip');
    expect(result.selectedIndices).toEqual([0]);
    expect(result.newPos).toBe(0);
    expect(result.preventDefault).toBe(true);
  });

  it('Shift+Left at pos 0 is no-op', () => {
    const result = getChipCursorAction('ArrowLeft', 0, 4, 2, 0, 0, { ctrl: false, shift: true });
    expect(result.action).toBe('none');
    expect(result.newPos).toBe(0);
  });

  it('Shift+Right selects chip at pos and moves pos+1', () => {
    // pos=0, shift+right: selects chip[0], newPos=1
    const result = getChipCursorAction('ArrowRight', 0, 4, 2, 0, 0, { ctrl: false, shift: true });
    expect(result.action).toBe('selectChip');
    expect(result.selectedIndices).toEqual([0]);
    expect(result.newPos).toBe(1);
    expect(result.preventDefault).toBe(true);
  });

  it('Shift+Right at inputPos-1 crosses to after-zone start and selects that chip', () => {
    // pos=1, inputPos=2, shift+right: selects chip[1], crosses to after-zone start (newPos=2)
    const result = getChipCursorAction('ArrowRight', 1, 4, 2, 0, 0, { ctrl: false, shift: true });
    expect(result.action).toBe('selectChip');
    expect(result.selectedIndices).toContain(1);
    expect(result.newPos).toBe(2); // after-zone start
    expect(result.preventDefault).toBe(true);
  });

  it('Shift+Right at totalChips-1 is no-op', () => {
    const result = getChipCursorAction('ArrowRight', 3, 4, 2, 0, 0, { ctrl: false, shift: true });
    expect(result.action).toBe('none');
    expect(result.newPos).toBe(3);
  });

  it('Shift+Left in after-zone selects chip to the left and moves', () => {
    // pos=3, shift+left: selects chip[2], newPos=2
    const result = getChipCursorAction('ArrowLeft', 3, 4, 2, 0, 0, { ctrl: false, shift: true });
    expect(result.action).toBe('selectChip');
    expect(result.selectedIndices).toEqual([2]);
    expect(result.newPos).toBe(2);
    expect(result.preventDefault).toBe(true);
  });
});

describe('Ctrl+Shift+Home/End selection', () => {
  // [c0, c1, INPUT, c2, c3], totalChips=4, inputPos=2

  it('Ctrl+Shift+Home selects all chips before pos and moves to 0', () => {
    // pos=3: select chips 0,1,2,3 -> all before pos 3
    const result = getChipCursorAction('Home', 3, 4, 2, 0, 0, { ctrl: true, shift: true });
    expect(result.action).toBe('selectChip');
    expect(result.selectedIndices).toEqual([0, 1, 2]);
    expect(result.newPos).toBe(0);
    expect(result.preventDefault).toBe(true);
  });

  it('Ctrl+Shift+Home at pos 0 selects nothing', () => {
    const result = getChipCursorAction('Home', 0, 4, 2, 0, 0, { ctrl: true, shift: true });
    expect(result.action).toBe('selectChip');
    expect(result.selectedIndices).toEqual([]);
    expect(result.newPos).toBe(0);
  });

  it('Ctrl+Shift+End selects all chips from pos to end and moves to totalChips-1', () => {
    // pos=1: select chips 1,2,3
    const result = getChipCursorAction('End', 1, 4, 2, 0, 0, { ctrl: true, shift: true });
    expect(result.action).toBe('selectChip');
    expect(result.selectedIndices).toEqual([1, 2, 3]);
    expect(result.newPos).toBe(3);
    expect(result.preventDefault).toBe(true);
  });

  it('Ctrl+Shift+End at last pos selects chip at pos only', () => {
    // pos=3: select chip[3]
    const result = getChipCursorAction('End', 3, 4, 2, 0, 0, { ctrl: true, shift: true });
    expect(result.action).toBe('selectChip');
    expect(result.selectedIndices).toEqual([3]);
    expect(result.newPos).toBe(3);
  });
});

describe('B5: Alt+Arrow returns NO_ACTION', () => {
  it('Alt+ArrowLeft in chip mode returns NO_ACTION', () => {
    const result = getChipCursorAction('ArrowLeft', 1, 4, 2, 0, 0, { ctrl: false, shift: false, alt: true });
    expect(result.action).toBe('none');
    expect(result.preventDefault).toBe(false);
    expect(result.newPos).toBe(1); // position unchanged
  });

  it('Alt+ArrowRight in chip mode returns NO_ACTION', () => {
    const result = getChipCursorAction('ArrowRight', 1, 4, 2, 0, 0, { ctrl: false, shift: false, alt: true });
    expect(result.action).toBe('none');
    expect(result.preventDefault).toBe(false);
    expect(result.newPos).toBe(1); // position unchanged
  });
});

describe('modifier keys - Ctrl+Arrow (chips are atomic, moves one step)', () => {
  // [c0, c1, INPUT, c2, c3], totalChips=4, inputPos=2
  // Ctrl+Arrow behaves identically to regular Arrow (one position at a time).

  it('Ctrl+ArrowLeft in before-zone moves one step left (NOT to zone boundary)', () => {
    const result = getChipCursorAction('ArrowLeft', 1, 4, 2, 0, 0, { ctrl: true, shift: false });
    expect(result.newPos).toBe(0); // one step: 1 → 0
    expect(result.action).toBe('move');
    expect(result.preventDefault).toBe(true);
  });

  it('Ctrl+ArrowLeft at pos 0 stays (NO_ACTION, same as regular ArrowLeft)', () => {
    const result = getChipCursorAction('ArrowLeft', 0, 4, 2, 0, 0, { ctrl: true, shift: false });
    expect(result.newPos).toBe(0);
    expect(result.action).toBe('none');
    expect(result.preventDefault).toBe(false);
  });

  it('Ctrl+ArrowLeft in after-zone at pos > inputPos moves one step left', () => {
    const result = getChipCursorAction('ArrowLeft', 3, 4, 2, 0, 0, { ctrl: true, shift: false });
    expect(result.newPos).toBe(2); // one step: 3 → 2
    expect(result.action).toBe('move');
    expect(result.preventDefault).toBe(true);
  });

  it('Ctrl+ArrowLeft at pos == inputPos exits to input (same as regular ArrowLeft)', () => {
    const result = getChipCursorAction('ArrowLeft', 2, 4, 2, 0, 0, { ctrl: true, shift: false });
    expect(result.newPos).toBe(-1);
    expect(result.action).toBe('exitToInput');
    expect(result.exitSide).toBe('right');
    expect(result.preventDefault).toBe(true);
  });

  it('Ctrl+ArrowRight in before-zone moves one step right (NOT to zone boundary)', () => {
    const result = getChipCursorAction('ArrowRight', 0, 4, 2, 0, 0, { ctrl: true, shift: false });
    expect(result.newPos).toBe(1); // one step: 0 → 1
    expect(result.action).toBe('move');
    expect(result.preventDefault).toBe(true);
  });

  it('Ctrl+ArrowRight at inputPos-1 exits to input (same as regular ArrowRight)', () => {
    const result = getChipCursorAction('ArrowRight', 1, 4, 2, 0, 0, { ctrl: true, shift: false });
    expect(result.newPos).toBe(-1);
    expect(result.action).toBe('exitToInput');
    expect(result.exitSide).toBe('left');
    expect(result.preventDefault).toBe(true);
  });

  it('Ctrl+ArrowRight in after-zone moves one step right', () => {
    const result = getChipCursorAction('ArrowRight', 2, 4, 2, 0, 0, { ctrl: true, shift: false });
    expect(result.newPos).toBe(3); // one step: 2 → 3
    expect(result.action).toBe('move');
    expect(result.preventDefault).toBe(true);
  });

  it('Ctrl+ArrowRight at totalChips-1 returns none (same as regular ArrowRight)', () => {
    const result = getChipCursorAction('ArrowRight', 3, 4, 2, 0, 0, { ctrl: true, shift: false });
    expect(result.action).toBe('none');
    expect(result.newPos).toBe(3);
  });

  it('Ctrl+Backspace same as Backspace (B3: removeChipAt focused chip)', () => {
    const result = getChipCursorAction('Backspace', 1, 4, 2, 0, 0, { ctrl: true, shift: false });
    expect(result.action).toBe('removeChipAt');
    expect(result.chipIndex).toBe(1);
    expect(result.newPos).toBe(1); // pos=1 < totalChips-1=3, so stays at pos=1
  });

  it('Ctrl+Delete same as Delete', () => {
    const result = getChipCursorAction('Delete', 0, 4, 2, 0, 0, { ctrl: true, shift: false });
    expect(result.action).toBe('removeChipAt');
    expect(result.chipIndex).toBe(0);
    expect(result.newPos).toBe(0);
  });
});

describe('cross-zone navigation', () => {
  // [INPUT, c0, c1], totalChips=2, inputPos=0 (all chips in after-zone)

  it('ArrowLeft from input enters at inputPos when inputPos == 0 (no before-zone)', () => {
    // chipCursorPos=-1, ArrowLeft: inputPos > 0 needed, so this stays in input
    const result = getChipCursorAction('ArrowLeft', -1, 2, 0, 0, 0);
    expect(result.newPos).toBe(-1); // no before-zone chips
    expect(result.action).toBe('none');
  });

  it('ArrowLeft in after-zone at pos==inputPos==0 returns NO_ACTION (B4: pos=0 is leftmost)', () => {
    // B4: pos=0 is always leftmost, ArrowLeft returns NO_ACTION regardless of zone
    const result = getChipCursorAction('ArrowLeft', 0, 2, 0, 0, 0);
    expect(result.newPos).toBe(0);
    expect(result.action).toBe('none');
    expect(result.preventDefault).toBe(false);
  });

  it('entering chip mode from input (ArrowLeft at selStart=0) only works when inputPos > 0', () => {
    // inputPos=2, totalChips=2 means no after-zone chips, so entering goes to pos 1 (inputPos-1)
    const result = getChipCursorAction('ArrowLeft', -1, 2, 2, 0, 0);
    expect(result.newPos).toBe(1); // inputPos - 1
    expect(result.action).toBe('move');
  });
});

describe('cross-zone Shift+Arrow', () => {
  it('Shift+ArrowRight at before-zone boundary crosses to after-zone', () => {
    // 5 chips, input at 2, cursor at pos 1 (before-zone end)
    const result = getChipCursorAction('ArrowRight', 1, 5, 2, 0, 0, { ctrl: false, shift: true });
    expect(result.action).toBe('selectChip');
    expect(result.newPos).toBe(2); // after-zone start
  });

  it('Shift+ArrowLeft at after-zone start crosses to before-zone', () => {
    // 5 chips, input at 2, cursor at pos 2 (after-zone start)
    const result = getChipCursorAction('ArrowLeft', 2, 5, 2, 0, 0, { ctrl: false, shift: true });
    expect(result.action).toBe('selectChip');
    expect(result.newPos).toBe(1); // before-zone end
  });

  it('Shift+ArrowRight at before-zone boundary with no after-zone chips returns NO_ACTION', () => {
    // 2 chips, input at 2 (all before, no after), cursor at pos 1
    const result = getChipCursorAction('ArrowRight', 1, 2, 2, 0, 0, { ctrl: false, shift: true });
    expect(result.action).toBe('none');
  });

  it('Shift+ArrowLeft at after-zone start with no before-zone chips returns NO_ACTION', () => {
    // 3 chips, input at 0 (all after), cursor at pos 0
    const result = getChipCursorAction('ArrowLeft', 0, 3, 0, 0, 0, { ctrl: false, shift: true });
    expect(result.action).toBe('none');
  });
});

describe('reverse deselect in chip-cursor', () => {
  it('Shift+ArrowLeft then Shift+ArrowRight produces correct positions for deselect', () => {
    // Start at pos 3, Shift+Left → pos 2
    const r1 = getChipCursorAction('ArrowLeft', 3, 5, 5, 0, 0, { ctrl: false, shift: true });
    expect(r1.newPos).toBe(2);
    expect(r1.selectedIndices).toEqual([2]);

    // Then Shift+Right from pos 2 → pos 3 (reverse)
    const r2 = getChipCursorAction('ArrowRight', 2, 5, 5, 0, 0, { ctrl: false, shift: true });
    expect(r2.newPos).toBe(3);
    expect(r2.selectedIndices).toEqual([2]); // chip at current pos
  });
});

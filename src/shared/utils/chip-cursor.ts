export interface ModifierState {
  ctrl: boolean;
  shift: boolean;
  alt?: boolean;
}

export interface ChipCursorAction {
  newPos: number; // -1 = exit to input
  action: 'move' | 'removeChipBefore' | 'removeChipAt' | 'editChip' | 'exitToInput' | 'selectChip' | 'none';
  chipIndex?: number;
  preventDefault: boolean;
  exitSide?: 'left' | 'right'; // which side of text input cursor lands
  selectedIndices?: number[];  // chip indices to select (for shift+arrow, ctrl+shift+home/end)
}

/**
 * Pure function for chip cursor keyboard navigation.
 *
 * Position model:
 *   - totalChips elements indexed 0..totalChips-1
 *   - Text input sits between chips[inputPos-1] and chips[inputPos]
 *   - Chip cursor positions 0..totalChips-1 where position i = "before chip[i]"
 *   - Before-zone: positions 0..inputPos-1 (chips before text input)
 *   - After-zone: positions inputPos..totalChips-1 (chips after text input)
 *
 * Entering chip cursor mode (chipCursorPos === -1):
 *   ArrowLeft at selStart=0,selEnd=0 enters at inputPos-1 (last before-zone chip).
 *   Entering from the right is handled by the React component, NOT here.
 */
export function getChipCursorAction(
  key: string,
  chipCursorPos: number,
  totalChips: number,
  inputPos: number,       // where text input sits (0..totalChips)
  selectionStart: number,
  selectionEnd: number,
  modifiers?: ModifierState,
): ChipCursorAction {
  const ctrl = modifiers?.ctrl ?? false;
  const shift = modifiers?.shift ?? false;
  const alt = modifiers?.alt ?? false;

  const NO_ACTION: ChipCursorAction = { newPos: chipCursorPos, action: 'none', preventDefault: false };

  // Alt+Arrow is used for word-jumping in text inputs; no-op in chip mode
  if (alt) return NO_ACTION;

  // --- Not in chip cursor mode: check if we should enter ---
  if (chipCursorPos === -1) {
    if (key === 'ArrowLeft' && inputPos > 0 && selectionStart === 0 && selectionEnd === 0) {
      return { newPos: inputPos - 1, action: 'move', preventDefault: true };
    }
    return NO_ACTION;
  }

  // --- In chip cursor mode ---

  const pos = chipCursorPos;
  const inBeforeZone = pos < inputPos;
  const inAfterZone = pos >= inputPos;

  // Helper: build exitToInput result
  function exitToInput(side?: 'left' | 'right'): ChipCursorAction {
    return { newPos: -1, action: 'exitToInput', preventDefault: true, exitSide: side };
  }

  // --- Modifier-specific handling ---

  // Ctrl+Shift+Home/End (range select)
  if (ctrl && shift) {
    if (key === 'Home') {
      const selected = Array.from({ length: pos }, (_, k) => k);
      return { newPos: 0, action: 'selectChip', selectedIndices: selected, preventDefault: true };
    }
    if (key === 'End') {
      const selected = Array.from({ length: totalChips - pos }, (_, k) => k + pos);
      return { newPos: totalChips > 0 ? totalChips - 1 : pos, action: 'selectChip', selectedIndices: selected, preventDefault: true };
    }
  }

  // Shift+Arrow (select single chip)
  if (shift && !ctrl) {
    if (key === 'ArrowLeft') {
      if (pos === 0) return { ...NO_ACTION, preventDefault: false };
      // Cross-zone: after-zone start → before-zone end
      if (inAfterZone && pos === inputPos) {
        if (inputPos > 0) {
          return { newPos: inputPos - 1, action: 'selectChip', selectedIndices: [inputPos - 1], preventDefault: true };
        }
        return { ...NO_ACTION, preventDefault: false };
      }
      return { newPos: pos - 1, action: 'selectChip', selectedIndices: [pos - 1], preventDefault: true };
    }
    if (key === 'ArrowRight') {
      if (pos === totalChips - 1) return { ...NO_ACTION, preventDefault: false };
      // Cross-zone: before-zone end → after-zone start
      if (inBeforeZone && pos === inputPos - 1) {
        if (inputPos < totalChips) {
          return { newPos: inputPos, action: 'selectChip', selectedIndices: [pos], preventDefault: true };
        }
        return { ...NO_ACTION, preventDefault: false };
      }
      return { newPos: pos + 1, action: 'selectChip', selectedIndices: [pos], preventDefault: true };
    }
  }

  // Ctrl+Arrow: chips are atomic units, so Ctrl+Arrow = regular Arrow (one chip at a time).
  // Ctrl+Backspace / Ctrl+Delete fall through to normal handling below.

  // --- Normal navigation (no shift, or ctrl+backspace/delete) ---

  if (key === 'ArrowLeft') {
    // B4: already at leftmost chip, nothing to move to
    if (pos === 0) return NO_ACTION;
    // Before-zone
    if (inBeforeZone) {
      return { newPos: pos - 1, action: 'move', preventDefault: true };
    }
    // After-zone: at inputPos → exit to input (right side)
    if (pos === inputPos) {
      return exitToInput('right');
    }
    // After-zone: pos > inputPos → move left
    return { newPos: pos - 1, action: 'move', preventDefault: true };
  }

  if (key === 'ArrowRight') {
    // Before-zone: at inputPos-1 → exit to input (left side)
    if (inBeforeZone && pos === inputPos - 1) {
      return exitToInput('left');
    }
    // Before-zone: not at boundary → move right
    if (inBeforeZone) {
      return { newPos: pos + 1, action: 'move', preventDefault: true };
    }
    // After-zone: at last chip → no movement (return NO_ACTION to avoid re-announcing)
    if (pos === totalChips - 1) {
      return NO_ACTION;
    }
    // After-zone: move right
    return { newPos: pos + 1, action: 'move', preventDefault: true };
  }

  if (key === 'Home') {
    if (totalChips === 0) return exitToInput();
    return { newPos: 0, action: 'move', preventDefault: true };
  }

  if (key === 'End') {
    if (totalChips === 0) return exitToInput();
    return { newPos: totalChips - 1, action: 'move', preventDefault: true };
  }

  if (key === 'Backspace') {
    // Delete the focused chip (the one at chipCursorPos / pos).
    // If this was the only chip, exit to input.
    if (totalChips === 1) {
      return { newPos: -1, action: 'removeChipAt', chipIndex: pos, exitSide: pos < inputPos ? 'left' : 'right', preventDefault: true };
    }
    // After deletion the chip list shrinks by 1. If we were on the last chip,
    // step back by one; otherwise stay at the same index.
    const newPos = pos >= totalChips - 1 ? pos - 1 : pos;
    return { newPos, action: 'removeChipAt', chipIndex: pos, preventDefault: true };
  }

  if (key === 'Delete') {
    if (pos < totalChips) {
      const newTotal = totalChips - 1;
      let newPos: number;
      if (newTotal === 0) {
        newPos = -1;
      } else if (pos >= newTotal) {
        newPos = newTotal - 1;
      } else {
        newPos = pos;
      }
      return { newPos, action: 'removeChipAt', chipIndex: pos, preventDefault: true };
    }
    return { newPos: pos, action: 'none', preventDefault: true };
  }

  if (key === 'Enter') {
    return { newPos: -1, action: 'editChip', chipIndex: pos, preventDefault: true };
  }

  if (key === 'Escape') {
    return { newPos: -1, action: 'exitToInput', preventDefault: true };
  }

  // Printable character: exit to input, let the key be typed
  if (key.length === 1 && !ctrl && !shift) {
    return { newPos: -1, action: 'exitToInput', preventDefault: false };
  }

  // Modifier keys (Shift, Control, etc.) and unhandled combos: ignore
  return NO_ACTION;
}

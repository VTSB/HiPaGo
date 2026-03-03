export interface ChipCursorAction {
  newPos: number; // -1 = exit to input
  action: 'move' | 'removeChipBefore' | 'removeChipAt' | 'editChip' | 'exitToInput' | 'none';
  chipIndex?: number;
  preventDefault: boolean;
}

/**
 * Pure function for chip cursor keyboard navigation.
 *
 * Position model: 0..chipsCount-1 where position i means "before chip[i]".
 * There is no "after last chip" position — that's the input.
 * Entering from input goes to chipsCount-1 (before last chip) for immediate visual feedback.
 */
export function getChipCursorAction(
  key: string,
  chipCursorPos: number,
  chipsCount: number,
  selectionStart: number,
  selectionEnd: number,
): ChipCursorAction {
  const NO_ACTION: ChipCursorAction = { newPos: chipCursorPos, action: 'none', preventDefault: false };

  // --- Not in chip cursor mode: check if we should enter ---
  if (chipCursorPos === -1) {
    if (key === 'ArrowLeft' && chipsCount > 0 && selectionStart === 0 && selectionEnd === 0) {
      return { newPos: chipsCount - 1, action: 'move', preventDefault: true };
    }
    return NO_ACTION;
  }

  // --- In chip cursor mode ---

  if (key === 'ArrowLeft') {
    return { newPos: Math.max(0, chipCursorPos - 1), action: 'move', preventDefault: true };
  }

  if (key === 'ArrowRight') {
    if (chipCursorPos >= chipsCount - 1) {
      return { newPos: -1, action: 'exitToInput', preventDefault: true };
    }
    return { newPos: chipCursorPos + 1, action: 'move', preventDefault: true };
  }

  if (key === 'Backspace') {
    if (chipCursorPos > 0) {
      return { newPos: chipCursorPos - 1, action: 'removeChipBefore', chipIndex: chipCursorPos - 1, preventDefault: true };
    }
    // At position 0: remove chip[0] (the chip to the right) as a special case
    if (chipsCount > 0) {
      const newChipsCount = chipsCount - 1;
      return { newPos: newChipsCount === 0 ? -1 : 0, action: 'removeChipAt', chipIndex: 0, preventDefault: true };
    }
    return { newPos: chipCursorPos, action: 'none', preventDefault: true };
  }

  if (key === 'Delete') {
    if (chipCursorPos < chipsCount) {
      const newChipsCount = chipsCount - 1;
      let newPos: number;
      if (newChipsCount === 0) {
        newPos = -1;
      } else if (chipCursorPos >= newChipsCount) {
        newPos = newChipsCount - 1;
      } else {
        newPos = chipCursorPos;
      }
      return { newPos, action: 'removeChipAt', chipIndex: chipCursorPos, preventDefault: true };
    }
    return { newPos: chipCursorPos, action: 'none', preventDefault: true };
  }

  if (key === 'Enter') {
    return { newPos: -1, action: 'editChip', chipIndex: chipCursorPos, preventDefault: true };
  }

  if (key === 'Escape') {
    return { newPos: -1, action: 'exitToInput', preventDefault: true };
  }

  // Printable character: exit to input, let the key be typed
  if (key.length === 1) {
    return { newPos: -1, action: 'exitToInput', preventDefault: false };
  }

  // Modifier keys (Shift, Control, etc.): ignore
  return NO_ACTION;
}

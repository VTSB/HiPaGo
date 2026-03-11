import { useState, useRef, useCallback, useEffect } from 'react';
import { parseToken } from '@/features/search/components/RecentSearchesDropdown';
import { normalizeGapText } from '@/shared/utils/caret-token';

interface Snapshot {
  chips: string[];
  activeInput: string;
  inputPosition: number;
  gapTexts: Record<number, string>;
}

interface UseChipInputStateOptions {
  initialChips?: string[];
  initialInput?: string;
  initialPosition?: number;
  maxChips?: number;
  onChipsChange?: (chips: string[]) => void;
  allowDuplicates?: boolean;
}

interface TokenReplacementSpan {
  gap: number;
  tokenStart: number;
  tokenEnd: number;
}

const UNDO_LIMIT = 50;

function normalizeStoredText(text: string): string {
  return normalizeGapText(text);
}

function normalizeGapTextMap(gapTexts: Record<number, string>): Record<number, string> {
  const normalized: Record<number, string> = {};

  Object.entries(gapTexts).forEach(([key, value]) => {
    const normalizedValue = normalizeStoredText(value);
    if (normalizedValue) {
      normalized[Number(key)] = normalizedValue;
    }
  });

  return normalized;
}

export function useChipInputState(options: UseChipInputStateOptions = {}) {
  const [chips, setChips] = useState<string[]>(options.initialChips ?? []);
  const [activeInput, setActiveInput] = useState(normalizeStoredText(options.initialInput ?? ''));
  const [inputPosition, setInputPosition] = useState(options.initialPosition ?? 0);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [gapTexts, setGapTexts] = useState<Record<number, string>>({});

  const undoStack = useRef<Snapshot[]>([]);
  const redoStack = useRef<Snapshot[]>([]);
  const textUndoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const maxChips = options.maxChips;
  const allowDuplicates = options.allowDuplicates ?? true;

  // Refs that always hold the current values — avoids stale closure bugs
  const chipsRef = useRef(chips);
  const activeInputRef = useRef(activeInput);
  const inputPositionRef = useRef(inputPosition);
  const maxChipsRef = useRef(maxChips);
  const allowDuplicatesRef = useRef(allowDuplicates);
  const gapTextsRef = useRef(gapTexts);

  chipsRef.current = chips;
  activeInputRef.current = activeInput;
  inputPositionRef.current = inputPosition;
  maxChipsRef.current = maxChips;
  allowDuplicatesRef.current = allowDuplicates;
  gapTextsRef.current = gapTexts;

  const onChipsChange = options.onChipsChange;
  useEffect(() => {
    onChipsChange?.(chips);
  }, [chips, onChipsChange]);

  useEffect(() => {
    return () => {
      if (textUndoTimerRef.current) {
        clearTimeout(textUndoTimerRef.current);
      }
    };
  }, []);

  const pushUndo = useCallback(() => {
    undoStack.current.push({
      chips: [...chipsRef.current],
      activeInput: activeInputRef.current,
      inputPosition: inputPositionRef.current,
      gapTexts: { ...gapTextsRef.current },
    });
    if (undoStack.current.length > UNDO_LIMIT) {
      undoStack.current.shift(); // remove oldest
    }
    redoStack.current = [];
  }, []); // No dependencies needed — reads from refs

  const undo = useCallback(() => {
    if (undoStack.current.length === 0) return false;
    redoStack.current.push({
      chips: [...chipsRef.current],
      activeInput: activeInputRef.current,
      inputPosition: inputPositionRef.current,
      gapTexts: { ...gapTextsRef.current },
    });
    const prev = undoStack.current.pop()!;
    setChips(prev.chips);
    setActiveInput(prev.activeInput);
    setInputPosition(prev.inputPosition);
    setGapTexts(prev.gapTexts);
    setEditingIndex(null);
    return true;
  }, []); // No dependencies needed

  const redo = useCallback(() => {
    if (redoStack.current.length === 0) return false;
    undoStack.current.push({
      chips: [...chipsRef.current],
      activeInput: activeInputRef.current,
      inputPosition: inputPositionRef.current,
      gapTexts: { ...gapTextsRef.current },
    });
    const next = redoStack.current.pop()!;
    setChips(next.chips);
    setActiveInput(next.activeInput);
    setInputPosition(next.inputPosition);
    setGapTexts(next.gapTexts);
    setEditingIndex(null);
    return true;
  }, []); // No dependencies needed

  const moveInputPosition = useCallback((newPos: number) => {
    const oldPos = inputPositionRef.current;
    if (newPos === oldPos) {
      setInputPosition(newPos);
      return;
    }

    const currentText = normalizeStoredText(activeInputRef.current);
    const updated = normalizeGapTextMap(gapTextsRef.current);

    // Save current text to gapTexts (delete if empty)
    if (currentText.trim()) {
      updated[oldPos] = currentText;
    } else {
      delete updated[oldPos];
    }

    // Load text from new position
    const loadedText = normalizeStoredText(updated[newPos] || '');
    delete updated[newPos];

    // Update refs eagerly for synchronous access (e.g., paste after position change)
    gapTextsRef.current = updated;
    activeInputRef.current = loadedText;
    inputPositionRef.current = newPos;

    setGapTexts(updated);
    setActiveInput(loadedText);
    setInputPosition(newPos);
  }, []);

  const handleRemoveChip = useCallback((index: number) => {
    pushUndo();
    setChips((prev) => prev.filter((_, i) => i !== index));

    const pos = inputPositionRef.current;
    const gt = normalizeGapTextMap(gapTextsRef.current);
    const ai = normalizeStoredText(activeInputRef.current);

    // Get texts from the two gaps being merged
    const leftText = index === pos ? ai : (gt[index] || '');
    const rightText = (index + 1) === pos ? ai : (gt[index + 1] || '');
    const merged = normalizeStoredText([leftText, rightText].filter(Boolean).join(' '));

    // Build new gapTexts with shifted keys
    const newGt: Record<number, string> = {};
    for (const [k, v] of Object.entries(gt)) {
      const key = Number(k);
      if (key === index || key === index + 1) continue; // Skip merged gaps
      const newKey = key > index + 1 ? key - 1 : key;
      if (v) newGt[newKey] = v;
    }

    // Place merged text
    if (pos === index || pos === index + 1) {
      // Active input was one of the merged gaps
      setActiveInput(merged);
      if (pos > index) setInputPosition(pos - 1);
    } else {
      if (merged) newGt[index] = merged;
      if (pos > index) setInputPosition(pos - 1);
    }

    setGapTexts(newGt);
  }, [pushUndo]);

  /** Remove multiple chips at once (single undo entry).
   *  @param indices - chip indices to remove. Order does not matter; they are
   *  filtered by Set membership so duplicates and ordering are handled internally.
   */
  const handleRemoveChips = useCallback((indices: number[]) => {
    pushUndo();
    const removeSet = new Set(indices);
    setChips((prev) => prev.filter((_, i) => !removeSet.has(i)));

    const pos = inputPositionRef.current;
    const ai = normalizeStoredText(activeInputRef.current);
    const gt = normalizeGapTextMap(gapTextsRef.current);

    // Build a complete texts array: texts[i] = text at gap i
    const totalGaps = chipsRef.current.length + 1;
    const allTexts: string[] = [];
    for (let i = 0; i < totalGaps; i++) {
      allTexts.push(i === pos ? ai : (gt[i] || ''));
    }

    // After removing chips, adjacent gaps merge.
    // Walk through chip indices: for each removed chip, merge its left and right gaps.
    // Process in ascending order. After removal, the gap array collapses.
    const sortedIndices = [...indices].sort((a, b) => a - b);

    // Build merged gap texts: iterate original gaps, skip removed chip boundaries
    const mergedTexts: string[] = [];
    let currentMerge: string[] = [];
    for (let g = 0; g < totalGaps; g++) {
      currentMerge.push(allTexts[g]);
      // If there's a chip at index g (i.e., gap g is followed by chip g),
      // and that chip is NOT being removed, commit the merge
      if (g < chipsRef.current.length && !removeSet.has(g)) {
        mergedTexts.push(normalizeStoredText(currentMerge.filter(Boolean).join(' ')));
        currentMerge = [];
      }
    }
    // Commit the last merge group
    mergedTexts.push(normalizeStoredText(currentMerge.filter(Boolean).join(' ')));

    // Now mergedTexts has (chips.length - indices.length + 1) entries
    // Find new inputPosition and rebuild gapTexts
    const beforeCount = sortedIndices.filter(i => i < pos).length;
    const newPos = pos - beforeCount;

    const newGt: Record<number, string> = {};
    let newActiveInput = ai;
    for (let i = 0; i < mergedTexts.length; i++) {
      if (i === newPos) {
        newActiveInput = mergedTexts[i];
      } else if (mergedTexts[i]) {
        newGt[i] = mergedTexts[i];
      }
    }

    setGapTexts(newGt);
    setActiveInput(newActiveInput);
    setInputPosition(newPos);
  }, [pushUndo]);

  const handleClearAll = useCallback(() => {
    pushUndo();
    setChips([]);
    setActiveInput('');
    setInputPosition(0);
    setEditingIndex(null);
    setGapTexts({});
  }, [pushUndo]);

  const handleAbandonEdit = useCallback(() => {
    undo();
  }, [undo]);

  const handleInputChange = useCallback((text: string) => {
    // Debounced undo: push a snapshot before the first change in a typing burst,
    // then suppress further snapshots for 500ms (word-group approach).
    if (!textUndoTimerRef.current) {
      pushUndo();
    } else {
      clearTimeout(textUndoTimerRef.current);
    }
    textUndoTimerRef.current = setTimeout(() => {
      textUndoTimerRef.current = null;
    }, 500);
    setActiveInput(normalizeStoredText(text));
  }, [pushUndo]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLInputElement>, removeIndices?: number[], caretOffset?: number) => {
    const text = e.clipboardData.getData('text/plain');
    if (!text) {
      // Even if no paste text, still remove chips if requested
      if (removeIndices && removeIndices.length > 0) {
        pushUndo();
        const indicesToRemove = new Set(removeIndices);
        setChips((prev) => prev.filter((_, i) => !indicesToRemove.has(i)));
        const pos = inputPositionRef.current;
        const beforeCount = removeIndices.filter((i) => i < pos).length;
        if (beforeCount > 0) setInputPosition(pos - beforeCount);
      }
      return;
    }
    const tokens = text.trim().split(/[\s\n]+/).filter(Boolean);
    const hasTag = tokens.some((t) => parseToken(t));
    if (!hasTag) {
      // Plain text paste — remove chips if requested.
      if (removeIndices && removeIndices.length > 0) {
        // Prevent default so chip removal + text insertion form a single undo step.
        e.preventDefault();
        pushUndo();
        const indicesToRemove = new Set(removeIndices);
        setChips((prev) => prev.filter((_, i) => !indicesToRemove.has(i)));
        const pos = inputPositionRef.current;
        const beforeCount = removeIndices.filter((i) => i < pos).length;
        if (beforeCount > 0) setInputPosition(pos - beforeCount);
        // Manually append pasted text so it's part of the same undo snapshot.
        setActiveInput((prev) => normalizeStoredText(prev + text));
      }
      return;
    }
    e.preventDefault();
    pushUndo(); // single undo for remove + paste combined

    // Parse tokens preserving interleaved tag/text order
    let newChips: string[] = [];
    const pasteGapTexts: Record<number, string> = {};
    let currentGap = 0;

    for (const token of tokens) {
      if (parseToken(token)) {
        newChips.push(token);
        currentGap++;
      } else {
        const existing = pasteGapTexts[currentGap];
        pasteGapTexts[currentGap] = existing ? `${existing} ${token}` : token;
      }
    }

    if (maxChipsRef.current !== undefined) {
      const available = maxChipsRef.current - (chipsRef.current.length - (removeIndices?.length ?? 0));
      newChips = newChips.slice(0, Math.max(0, available));
    }

    // Calculate adjusted position after removing chips
    const pos = inputPositionRef.current;
    let posAdjust = 0;
    if (removeIndices && removeIndices.length > 0) {
      posAdjust = removeIndices.filter((i) => i < pos).length;
    }

    setChips((prev) => {
      let next = [...prev];
      if (removeIndices && removeIndices.length > 0) {
        const indicesToRemove = new Set(removeIndices);
        next = next.filter((_, i) => !indicesToRemove.has(i));
      }
      const adjustedPos = pos - posAdjust;
      if (newChips.length > 0) {
        next.splice(adjustedPos, 0, ...newChips);
      }
      return next;
    });

    const adjustedPos = pos - posAdjust;
    setInputPosition(adjustedPos + newChips.length);

    // Split existing text at caret offset
    const currentText = normalizeStoredText(activeInputRef.current);
    const leftText = caretOffset !== undefined
      ? normalizeStoredText(currentText.slice(0, caretOffset))
      : '';
    const rightText = caretOffset !== undefined
      ? normalizeStoredText(currentText.slice(caretOffset))
      : currentText;

    // Active input = text after last pasted chip + existing right text
    const lastGapText = pasteGapTexts[newChips.length] || '';
    const activeInputParts = [lastGapText, rightText].filter(Boolean);
    setActiveInput(normalizeStoredText(activeInputParts.join(' ')));

    // Build gap texts: shift existing keys, add left text + interleaved paste texts
    setGapTexts((prev) => {
      const next: Record<number, string> = {};
      // Shift existing gap keys for inserted chips
      for (const [k, v] of Object.entries(prev)) {
        const key = Number(k);
        const normalizedValue = normalizeStoredText(v);
        if (normalizedValue) {
          next[key >= adjustedPos ? key + newChips.length : key] = normalizedValue;
        }
      }
      // Text before first pasted chip (merged with left text from caret split)
      const firstGapText = pasteGapTexts[0] || '';
      const leftMerged = normalizeStoredText([leftText, firstGapText].filter(Boolean).join(' '));
      if (leftMerged) {
        next[adjustedPos] = leftMerged;
      }
      // Interleaved text between pasted chips
      for (let g = 1; g < newChips.length; g++) {
        const normalizedGapText = normalizeStoredText(pasteGapTexts[g] || '');
        if (normalizedGapText) {
          next[adjustedPos + g] = normalizedGapText;
        }
      }
      return next;
    });
  }, [pushUndo]);

  // Insert a chip (tag) at inputPosition or replace editingIndex
  const insertChip = useCallback((chip: string) => {
    if (editingIndex === null && maxChipsRef.current !== undefined && chipsRef.current.length >= maxChipsRef.current) {
      return;
    }
    if (!allowDuplicatesRef.current) {
      const isDuplicate = editingIndex !== null
        ? chipsRef.current.some((c, idx) => idx !== editingIndex && c === chip)
        : chipsRef.current.includes(chip);
      if (isDuplicate) return;
    }
    pushUndo();
    if (editingIndex !== null) {
      setChips((prev) => {
        const next = [...prev];
        next[editingIndex] = chip;
        return next;
      });
      setEditingIndex(null);
    } else {
      const pos = inputPositionRef.current;
      setChips((prev) => {
        const next = [...prev];
        next.splice(pos, 0, chip);
        return next;
      });
      setInputPosition(pos + 1);
      // Shift gap keys >= pos + 1 up by 1
      setGapTexts((prev) => {
        const next: Record<number, string> = {};
        for (const [k, v] of Object.entries(prev)) {
          const key = Number(k);
          next[key > pos ? key + 1 : key] = v;
        }
        return next;
      });
    }
    setActiveInput('');
  }, [pushUndo, editingIndex]);

  const replaceActiveTokenWithChip = useCallback((chip: string, span: TokenReplacementSpan) => {
    if (editingIndex === null && maxChipsRef.current !== undefined && chipsRef.current.length >= maxChipsRef.current) {
      return false;
    }

    if (!allowDuplicatesRef.current) {
      const isDuplicate = editingIndex !== null
        ? chipsRef.current.some((c, idx) => idx !== editingIndex && c === chip)
        : chipsRef.current.includes(chip);
      if (isDuplicate) return false;
    }

    const pos = inputPositionRef.current;
    if (span.gap !== pos) {
      return false;
    }

    const currentText = normalizeStoredText(activeInputRef.current);
    const safeStart = Math.max(0, Math.min(span.tokenStart, currentText.length));
    const safeEnd = Math.max(safeStart, Math.min(span.tokenEnd, currentText.length));
    const leftText = normalizeStoredText(currentText.slice(0, safeStart));
    const rightText = normalizeStoredText(currentText.slice(safeEnd));

    pushUndo();

    setChips((prev) => {
      const next = [...prev];
      next.splice(pos, 0, chip);
      return next;
    });

    setGapTexts((prev) => {
      const next: Record<number, string> = {};
      for (const [k, v] of Object.entries(prev)) {
        const key = Number(k);
        const normalizedValue = normalizeStoredText(v);
        if (normalizedValue) {
          next[key > pos ? key + 1 : key] = normalizedValue;
        }
      }
      if (leftText) {
        next[pos] = leftText;
      }
      return next;
    });

    setActiveInput(rightText);
    setInputPosition(pos + 1);
    setEditingIndex(null);

    return true;
  }, [pushUndo, editingIndex]);

  const editChip = useCallback((index: number) => {
    pushUndo();
    // Stash current activeInput to gapTexts before overwriting
    const currentText = normalizeStoredText(activeInputRef.current);
    if (currentText) {
      setGapTexts((prev) => ({ ...normalizeGapTextMap(prev), [inputPositionRef.current]: currentText }));
    }
    setActiveInput(chipsRef.current[index]);
    setEditingIndex(index);
    setInputPosition(index);
  }, [pushUndo]);

  // Sync from query string (used by SearchBar)
  const syncFromQuery = useCallback((q: string) => {
    const tokens = q.trim().split(/\s+/).filter(Boolean);
    const tagChips: string[] = [];
    const gapMap: Record<number, string> = {};
    let currentGap = 0;

    for (const token of tokens) {
      if (parseToken(token)) {
        tagChips.push(token);
        currentGap++;
      } else {
        // Append to current gap's text
        const existing = gapMap[currentGap];
        gapMap[currentGap] = existing ? `${existing} ${token}` : token;
      }
    }

    setChips(tagChips);
    // Last gap with text becomes activeInput, rest go to gapTexts
    // Default: inputPosition at the end
    const lastGap = tagChips.length;
    const activeText = gapMap[lastGap] || '';
    delete gapMap[lastGap];
    // Clean empty entries
    const cleanGap: Record<number, string> = {};
    for (const [k, v] of Object.entries(gapMap)) {
      const normalizedValue = normalizeStoredText(v);
      if (normalizedValue) cleanGap[Number(k)] = normalizedValue;
    }
    setGapTexts(cleanGap);
    setActiveInput(normalizeStoredText(activeText));
    setInputPosition(lastGap);
  }, []);

  return {
    // State
    chips, setChips,
    activeInput, setActiveInput,
    inputPosition, setInputPosition,
    editingIndex, setEditingIndex,
    gapTexts, setGapTexts,
    // Actions
    pushUndo, undo, redo,
    moveInputPosition,
    handleRemoveChip, handleRemoveChips,
    handleClearAll, handleAbandonEdit,
    handleInputChange, handlePaste,
    insertChip, replaceActiveTokenWithChip, editChip,
    syncFromQuery,
  };
}

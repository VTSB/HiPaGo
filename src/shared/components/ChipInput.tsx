import {
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useId,
  forwardRef,
  useImperativeHandle,
  useState,
} from 'react';

import { parseToken } from '@/features/search/components/RecentSearchesDropdown';
import { getTagColor, TAG_TYPE_DISPLAY } from '@/lib/utils/types';
import { buildQueryString } from '@/shared/utils/build-query';

// ---------------------------------------------------------------------------
// ChipInputProps — identical to V1
// ---------------------------------------------------------------------------

export interface ChipInputProps {
  chips: string[];
  activeInput: string;
  inputPosition?: number;
  onInputChange: (text: string) => void;
  onInputPositionChange?: (pos: number) => void;
  onRemoveChip: (index: number) => void;
  onRemoveChips?: (indices: number[]) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onFocus?: () => void;
  onPaste?: (e: React.ClipboardEvent<HTMLInputElement>, removeIndices?: number[], caretOffset?: number) => void;
  onClearAll?: () => void;
  onBlur?: () => void;
  maxChips?: number;
  allowDuplicates?: boolean;
  maxRows?: number;
  placeholder?: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  ariaLabel?: string;
  disabled?: boolean;
  readOnly?: boolean;
  gapTexts?: Record<number, string>;
  onGapTextClick?: (position: number) => void;
  error?: boolean;
  name?: string;
  required?: boolean;
  autoFocus?: boolean;
}

// ---------------------------------------------------------------------------
// Zero-width space used for empty gap text nodes so the caret can land there
// ---------------------------------------------------------------------------

const ZWS = '\u200B';

// ---------------------------------------------------------------------------
// Chip span builder (imperative — creates DOM nodes, not React elements)
// ---------------------------------------------------------------------------

function createChipSpan(
  chip: string,
  index: number,
  disabled?: boolean,
  readOnly?: boolean,
): HTMLSpanElement {
  const parsed = parseToken(chip);
  const color = parsed
    ? getTagColor(parsed.type)
    : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300';
  const label = parsed
    ? `${parsed.type}:${parsed.tag.replace(/_/g, ' ')}${TAG_TYPE_DISPLAY[parsed.type]}`
    : chip;

  const span = document.createElement('span');
  span.contentEditable = 'false';
  span.setAttribute('data-chip-index', String(index));
  span.setAttribute('role', 'option');
  span.setAttribute('aria-label', `${label}, press Delete to remove`);
  span.title = label;
  span.className = `relative inline-flex h-5 max-w-[200px] items-center gap-0.5 rounded-full text-xs font-medium pl-2 pr-1 whitespace-nowrap cursor-pointer transition-transform duration-150 hover:scale-105 ${color}`;
  // Spacing and vertical alignment within the contenteditable line
  span.style.verticalAlign = 'middle';
  span.style.margin = '2px 3px';

  const labelSpan = document.createElement('span');
  labelSpan.className = 'truncate';
  labelSpan.textContent = label;
  span.appendChild(labelSpan);

  if (!disabled && !readOnly) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.tabIndex = -1;
    btn.setAttribute('aria-label', `Remove ${label}`);
    btn.className =
      'ml-0.5 flex-shrink-0 rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer border-none bg-transparent text-current';
    btn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="h-3 w-3"><path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z"/></svg>';
    span.appendChild(btn);
  }

  return span;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Walk the editor's childNodes and return the gap index + offset of the current caret. */
function readCaretPosition(editor: HTMLDivElement): { gap: number; offset: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  const offset = range.startOffset;

  // If the selection is directly in the editor div (e.g., caret between child nodes)
  if (node === editor) {
    // offset is the child index; map to gap
    let gap = 0;
    for (let i = 0; i < offset && i < editor.childNodes.length; i++) {
      const child = editor.childNodes[i];
      if (child.nodeType === Node.ELEMENT_NODE && (child as HTMLElement).hasAttribute('data-chip-index')) {
        gap++;
      }
    }
    return { gap, offset: 0 };
  }

  // Find which text node the caret is in
  let gap = 0;
  for (let i = 0; i < editor.childNodes.length; i++) {
    const child = editor.childNodes[i];
    if (child.nodeType === Node.TEXT_NODE) {
      if (child === node) {
        return { gap, offset };
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      if ((child as HTMLElement).hasAttribute('data-chip-index')) {
        gap++;
      }
      // The caret might be inside the chip span (e.g., after clicking)
      if (child.contains(node)) {
        return { gap, offset: 0 };
      }
    }
  }

  return null;
}

/** Set the caret to a specific gap and character offset within the editor. */
function setCaretPosition(editor: HTMLDivElement, gap: number, offset: number) {
  let currentGap = 0;
  for (let i = 0; i < editor.childNodes.length; i++) {
    const child = editor.childNodes[i];
    if (child.nodeType === Node.TEXT_NODE) {
      if (currentGap === gap) {
        const text = child.textContent || '';
        const clampedOffset = Math.min(offset, text.length);
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.setStart(child, clampedOffset);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        return;
      }
    } else if (child.nodeType === Node.ELEMENT_NODE && (child as HTMLElement).hasAttribute('data-chip-index')) {
      currentGap++;
    }
  }
}

/** Get the text content at a gap position, stripping ZWS. */
function getGapText(editor: HTMLDivElement, gap: number): string {
  let currentGap = 0;
  for (let i = 0; i < editor.childNodes.length; i++) {
    const child = editor.childNodes[i];
    if (child.nodeType === Node.TEXT_NODE) {
      if (currentGap === gap) {
        return (child.textContent || '').replace(/\u200B/g, '');
      }
    } else if (child.nodeType === Node.ELEMENT_NODE && (child as HTMLElement).hasAttribute('data-chip-index')) {
      currentGap++;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// ChipInput — contenteditable-based chip input
// ---------------------------------------------------------------------------

export const ChipInput = forwardRef<HTMLDivElement, ChipInputProps>(function ChipInput(
  {
    chips,
    activeInput,
    inputPosition: inputPositionProp,
    onInputChange,
    onInputPositionChange,
    onRemoveChip,
    onRemoveChips,
    onKeyDown,
    onFocus,
    onPaste,
    onClearAll,
    onBlur,
    maxRows,
    placeholder,
    inputRef,
    ariaLabel,
    disabled,
    readOnly,
    gapTexts,
    error,
    name,
    required,
    autoFocus,
  }: ChipInputProps,
  ref,
) {
  const inputPos = inputPositionProp ?? chips.length;
  const editorRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const isSyncingRef = useRef(false);
  const userInputRef = useRef(false);
  const pendingCaretRef = useRef<{ gap: number; offset: number } | null>(null);
  const ariaLiveRef = useRef<HTMLSpanElement>(null);
  const selectionAnchorRef = useRef<{ node: Node; offset: number } | null>(null);
  const prevChipsLengthRef = useRef(chips.length);
  // Always-fresh snapshot for cut/copy DOM event handlers (avoid stale closure)
  const clipboardStateRef = useRef({ chips, activeInput, inputPos, gapTexts, allSelected: false, onClearAll, onRemoveChips });
  const [allSelected, setAllSelected] = useState(false);
  const [hasFocus, setHasFocus] = useState(false);

  const rawId = useId();
  const containerId = `chipinput-v2-${rawId.replace(/:/g, '')}`;

  // Expose container ref
  useImperativeHandle(ref, () => containerRef.current!, []);

  // Keep clipboardStateRef fresh on every render (for cut/copy DOM event handlers)
  clipboardStateRef.current = { chips, activeInput, inputPos, gapTexts, allSelected, onClearAll, onRemoveChips };

  // Aria-live announcement when chips change
  useEffect(() => {
    const prev = prevChipsLengthRef.current;
    prevChipsLengthRef.current = chips.length;
    if (!ariaLiveRef.current) return;
    if (chips.length > prev) {
      ariaLiveRef.current.textContent = `Tag added. ${chips.length} tags.`;
    } else if (chips.length < prev) {
      ariaLiveRef.current.textContent = `Tag removed. ${chips.length} tags.`;
    }
  }, [chips]);

  // Cut/copy DOM event listeners — mirrors Ctrl+C/X keyboard logic for right-click menu
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const getSelectionClipData = () => {
      const { chips: c, allSelected: asel } = clipboardStateRef.current;
      if (asel) return { text: buildQueryString(c, clipboardStateRef.current.activeInput, clipboardStateRef.current.inputPos, clipboardStateRef.current.gapTexts), chipIndices: [] as number[], isAll: true };

      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);
      if (typeof range.intersectsNode !== 'function') return null;

      const textParts: string[] = [];
      const chipIndices: number[] = [];
      for (let i = 0; i < editor.childNodes.length; i++) {
        const child = editor.childNodes[i];
        if (!range.intersectsNode(child)) continue;
        if (child.nodeType === Node.TEXT_NODE) {
          const text = child.textContent || '';
          let start = 0, end = text.length;
          if (child === range.startContainer) start = range.startOffset;
          if (child === range.endContainer) end = range.endOffset;
          const portion = text.slice(start, end).replace(/\u200B/g, '');
          if (portion) textParts.push(portion);
        } else if (child.nodeType === Node.ELEMENT_NODE && (child as HTMLElement).hasAttribute('data-chip-index')) {
          const idx = parseInt((child as HTMLElement).getAttribute('data-chip-index') || '', 10);
          if (!isNaN(idx) && idx < c.length) { chipIndices.push(idx); textParts.push(c[idx]); }
        }
      }
      if (chipIndices.length === 0 && textParts.length === 0) return null;
      return { text: textParts.join(' '), chipIndices, isAll: false };
    };

    const handleCopy = (e: ClipboardEvent) => {
      const data = getSelectionClipData();
      if (!data) return; // no custom content — let browser handle
      e.preventDefault();
      e.clipboardData?.setData('text/plain', data.text);
    };

    const handleCut = (e: ClipboardEvent) => {
      const data = getSelectionClipData();
      if (!data) return;
      e.preventDefault();
      e.clipboardData?.setData('text/plain', data.text);
      if (data.isAll) {
        clipboardStateRef.current.onClearAll?.();
      } else if (data.chipIndices.length > 0) {
        clipboardStateRef.current.onRemoveChips?.(data.chipIndices);
      }
    };

    editor.addEventListener('copy', handleCopy);
    editor.addEventListener('cut', handleCut);
    return () => {
      editor.removeEventListener('copy', handleCopy);
      editor.removeEventListener('cut', handleCut);
    };
  }, []); // empty deps — always reads from clipboardStateRef

  // ---------------------------------------------------------------------------
  // inputRef proxy — point to the actual contenteditable div so that
  // document.activeElement === inputRef.current works, and .focus()/.blur() work.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (inputRef && editorRef.current) {
      (inputRef as React.MutableRefObject<HTMLInputElement | null>).current =
        editorRef.current as unknown as HTMLInputElement;
    }
  }, [inputRef]);

  // inputRef.current.value getter — lets consumers read activeInput via .value
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    Object.defineProperty(el, 'value', {
      get() { return activeInput; },
      configurable: true,
      enumerable: false,
    });
  }, [activeInput]);

  // ---------------------------------------------------------------------------
  // Sync State -> DOM
  // ---------------------------------------------------------------------------
  const syncStateToDom = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;

    isSyncingRef.current = true;

    // Save caret
    const savedCaret = editor.ownerDocument.hasFocus() && editor.contains(editor.ownerDocument.activeElement)
      ? readCaretPosition(editor)
      : null;

    // Clear and rebuild
    while (editor.firstChild) editor.removeChild(editor.firstChild);

    for (let g = 0; g <= chips.length; g++) {
      // Text node for this gap
      const text = g === inputPos ? (activeInput || '') : (gapTexts?.[g] || '');
      const textNode = document.createTextNode(text);
      editor.appendChild(textNode);

      if (g < chips.length) {
        const chipSpan = createChipSpan(chips[g], g, disabled, readOnly);
        editor.appendChild(chipSpan);
      }
    }

    // Restore caret — prefer pendingCaret (set by chip removal) over savedCaret
    const targetCaret = pendingCaretRef.current || savedCaret;
    pendingCaretRef.current = null;
    if (targetCaret) {
      requestAnimationFrame(() => {
        if (editorRef.current) {
          setCaretPosition(editorRef.current, targetCaret.gap, targetCaret.offset);
        }
      });
    }

    isSyncingRef.current = false;
  }, [chips, activeInput, inputPos, gapTexts, disabled, readOnly]);

  // Run sync on state changes (skip when state change came from user input)
  useLayoutEffect(() => {
    if (userInputRef.current) {
      userInputRef.current = false;
      return;
    }
    syncStateToDom();
  }, [syncStateToDom]);

  // ---------------------------------------------------------------------------
  // Sync DOM -> State (called on input events)
  // ---------------------------------------------------------------------------
  const syncDomToState = useCallback(() => {
    if (isSyncingRef.current || composingRef.current) return;
    const editor = editorRef.current;
    if (!editor) return;

    const caret = readCaretPosition(editor);
    if (!caret) return;

    const caretGap = caret.gap;
    const textAtCaret = getGapText(editor, caretGap);

    // Mark as user-driven so useLayoutEffect skips DOM rebuild
    userInputRef.current = true;

    // Notify parent of position change if needed
    if (caretGap !== inputPos) {
      onInputPositionChange?.(caretGap);
    }

    // Notify parent of text change
    onInputChange(textAtCaret);
  }, [inputPos, onInputChange, onInputPositionChange]);

  // ---------------------------------------------------------------------------
  // Auto-focus
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (autoFocus && editorRef.current) {
      editorRef.current.focus();
      // Place caret at the end of the active input position
      const editor = editorRef.current;
      const text = activeInput || '';
      setCaretPosition(editor, inputPos, text.length);
    }
    // Only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  const handleInput = useCallback(() => {
    if (composingRef.current) return;
    syncDomToState();
  }, [syncDomToState]);

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(() => {
    composingRef.current = false;
    syncDomToState();
  }, [syncDomToState]);

  // Block browser's built-in undo/redo on contenteditable — we handle it ourselves
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const onBeforeInput = (e: InputEvent) => {
      if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
        e.preventDefault();
      }
    };
    editor.addEventListener('beforeinput', onBeforeInput);
    return () => editor.removeEventListener('beforeinput', onBeforeInput);
  }, []);

  const handleFocus = useCallback(() => {
    setHasFocus(true);
    onFocus?.();
  }, [onFocus]);

  const handleBlur = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    // If focus is moving within the container, ignore
    if (containerRef.current?.contains(e.relatedTarget as Node)) return;
    setHasFocus(false);
    setAllSelected(false);
    onBlur?.();
  }, [onBlur]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;

      const editor = editorRef.current;
      if (!editor) return;

      const key = e.key;

      // IME composing — pass through
      if (e.nativeEvent.isComposing || composingRef.current) {
        onKeyDown?.(e as unknown as React.KeyboardEvent<HTMLInputElement>);
        return;
      }

      // readOnly: block editing keys
      if (readOnly) {
        const isEditingKey =
          key === 'Backspace' ||
          key === 'Delete' ||
          (key.length === 1 && !e.ctrlKey && !e.metaKey) ||
          ((e.ctrlKey || e.metaKey) && (key === 'x' || key === 'Backspace' || key === 'Delete'));
        if (isEditingKey) {
          e.preventDefault();
          onKeyDown?.(e as unknown as React.KeyboardEvent<HTMLInputElement>);
          return;
        }
      }

      const caret = readCaretPosition(editor);
      const caretGap = caret?.gap ?? inputPos;
      const caretOffset = caret?.offset ?? 0;
      const textAtCaret = caret ? getGapText(editor, caretGap) : '';

      // ---------------------------------------------------------------
      // Ctrl/Meta combos
      // ---------------------------------------------------------------
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+A — select all
        if (key === 'a') {
          e.preventDefault();
          setAllSelected(true);
          // Select all content in the editor
          const sel = window.getSelection();
          if (sel) {
            const range = document.createRange();
            range.selectNodeContents(editor);
            sel.removeAllRanges();
            sel.addRange(range);
          }
          return;
        }

        // Ctrl+C / Ctrl+X — copy or cut selection
        if (key === 'c' || key === 'x') {
          if (allSelected) {
            e.preventDefault();
            const query = buildQueryString(chips, activeInput, inputPos, gapTexts);
            navigator.clipboard.writeText(query).catch(() => {});
            if (key === 'x') {
              onClearAll?.();
              setAllSelected(false);
            }
            return;
          }

          // Partial selection — check if chips are included
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            const selectedChipIndices: number[] = [];
            const textParts: string[] = [];

            for (let i = 0; i < editor.childNodes.length; i++) {
              const child = editor.childNodes[i];
              if (!range.intersectsNode(child)) continue;

              if (child.nodeType === Node.TEXT_NODE) {
                const text = child.textContent || '';
                let start = 0, end = text.length;
                if (child === range.startContainer) start = range.startOffset;
                if (child === range.endContainer) end = range.endOffset;
                const portion = text.slice(start, end).replace(/\u200B/g, '');
                if (portion) textParts.push(portion);
              } else if (child.nodeType === Node.ELEMENT_NODE) {
                const el = child as HTMLElement;
                if (el.hasAttribute('data-chip-index')) {
                  const idx = parseInt(el.getAttribute('data-chip-index') || '', 10);
                  if (!isNaN(idx) && idx < chips.length) {
                    selectedChipIndices.push(idx);
                    textParts.push(chips[idx]);
                  }
                }
              }
            }

            if (selectedChipIndices.length > 0) {
              e.preventDefault();
              const clipText = textParts.join(' ');
              navigator.clipboard.writeText(clipText).catch(() => {});
              if (key === 'x' && onRemoveChips) {
                onRemoveChips(selectedChipIndices);
              }
              setAllSelected(false);
              return;
            }
          }
          // Text-only selection — let browser handle natively
          return;
        }

        // Ctrl+Z / Ctrl+Y — prevent browser undo, propagate to consumer
        if (key === 'z' || key === 'y') {
          e.preventDefault();
          onKeyDown?.(e as unknown as React.KeyboardEvent<HTMLInputElement>);
          return;
        }

        // Ctrl+V — let browser fire paste event (handled by onPaste)
        if (key === 'v') return;

        // Ctrl+Arrow / Ctrl+Shift+Arrow — word navigation/selection, let browser handle
        if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
          if (!e.shiftKey) {
            requestAnimationFrame(() => {
              if (!editorRef.current) return;
              const afterCaret = readCaretPosition(editorRef.current);
              if (afterCaret && afterCaret.gap !== inputPos) {
                onInputPositionChange?.(afterCaret.gap);
              }
            });
          }
          return;
        }

        // Ctrl+Backspace / Ctrl+Delete — word deletion, let browser handle
        if (key === 'Backspace' || key === 'Delete') return;

        // Ctrl+Home / Ctrl+End (with or without Shift) — jump/select to content boundaries
        if (key === 'Home' || key === 'End') return;

        // Block only rich-text formatting keys (bold/italic/underline/strikethrough)
        if (key === 'b' || key === 'i' || key === 'u' || key === 's') {
          e.preventDefault();
          return;
        }

        // All other Ctrl combos — let browser handle (Ctrl+F, Ctrl+L, Ctrl+T, etc.)
        return;
      }

      // ---------------------------------------------------------------
      // allSelected handling for non-modifier keys
      // ---------------------------------------------------------------
      if (allSelected) {
        if (key.length === 1 || key === 'Backspace' || key === 'Delete') {
          e.preventDefault();
          onClearAll?.();
          setAllSelected(false);
          if (key.length === 1) {
            onInputChange(key);
          }
          return;
        }
        setAllSelected(false);
      }

      // ---------------------------------------------------------------
      // Selection contains chips — handle Backspace/Delete/char
      // ---------------------------------------------------------------
      {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          if (typeof range.intersectsNode === 'function') {
            const selectedChipIndices: number[] = [];
            for (let i = 0; i < editor.childNodes.length; i++) {
              const child = editor.childNodes[i];
              if (
                child.nodeType === Node.ELEMENT_NODE &&
                (child as HTMLElement).hasAttribute('data-chip-index') &&
                range.intersectsNode(child)
              ) {
                const idx = parseInt((child as HTMLElement).getAttribute('data-chip-index') || '', 10);
                if (!isNaN(idx)) selectedChipIndices.push(idx);
              }
            }
            if (selectedChipIndices.length > 0) {
              if (key === 'Backspace' || key === 'Delete') {
                e.preventDefault();
                if (onRemoveChips) onRemoveChips(selectedChipIndices);
                return;
              }
              if (key.length === 1) {
                e.preventDefault();
                if (onRemoveChips) onRemoveChips(selectedChipIndices);
                onInputChange(key);
                return;
              }
            }
          }
        }
      }

      // ---------------------------------------------------------------
      // Backspace — remove chip if at start of gap text
      // ---------------------------------------------------------------
      if (key === 'Backspace') {
        // At the start of a gap text with a chip before it → remove the chip
        const atBoundary = caretGap > 0 && caretOffset === 0;
        if (atBoundary) {
          e.preventDefault();
          const chipIdx = caretGap - 1;
          if (chipIdx >= 0 && chipIdx < chips.length) {
            // Caret at merge point: end of left gap's text
            if (editorRef.current) {
              const leftText = getGapText(editorRef.current, chipIdx);
              pendingCaretRef.current = { gap: chipIdx, offset: leftText.length };
            }
            onRemoveChip(chipIdx);
          }
          return;
        }
        // Let browser handle normal text backspace
        return;
      }

      // ---------------------------------------------------------------
      // Delete — remove chip if at end of gap text
      // ---------------------------------------------------------------
      if (key === 'Delete') {
        const gapTextLen = textAtCaret.length;
        if (caretOffset >= gapTextLen && caretGap < chips.length) {
          e.preventDefault();
          const chipIdx = caretGap;
          if (chipIdx >= 0 && chipIdx < chips.length) {
            // Caret at merge point: end of current gap's text (= current caret position)
            pendingCaretRef.current = { gap: chipIdx, offset: caretOffset };
            onRemoveChip(chipIdx);
            return;
          }
        }
        return;
      }

      // ---------------------------------------------------------------
      // Enter / Escape — propagate to consumer
      // ---------------------------------------------------------------
      if (key === 'Enter' || key === 'Escape') {
        e.preventDefault();
        onKeyDown?.(e as unknown as React.KeyboardEvent<HTMLInputElement>);
        return;
      }

      // ---------------------------------------------------------------
      // Arrow keys, Home, End — let browser handle natively
      // ---------------------------------------------------------------
      if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown' ||
          key === 'Home' || key === 'End') {
        // Save caret position before browser processes the key — used to detect
        // when the browser fails to cross a contenteditable="false" chip at a
        // visual line-wrap boundary.
        const beforeCaret = readCaretPosition(editorRef.current!);

        // When Shift is held, the browser is extending a selection — don't
        // change inputPosition (which triggers moveInputPosition and DOM
        // rebuild, destroying the selection).
        if (!e.shiftKey) {
          // After the browser moves the caret, sync the gap position only
          requestAnimationFrame(() => {
            if (!editorRef.current) return;
            const afterCaret = readCaretPosition(editorRef.current);
            if (!afterCaret) return;

            // If ArrowRight/ArrowLeft and caret didn't move, the browser is stuck
            // at a chip boundary (common at visual line wraps). Manually jump to
            // the adjacent gap.
            if (
              beforeCaret && afterCaret &&
              (key === 'ArrowRight' || key === 'ArrowLeft') &&
              beforeCaret.gap === afterCaret.gap &&
              beforeCaret.offset === afterCaret.offset
            ) {
              if (key === 'ArrowRight' && afterCaret.gap < chips.length) {
                setCaretPosition(editorRef.current, afterCaret.gap + 1, 0);
                const jumped = readCaretPosition(editorRef.current);
                if (jumped && jumped.gap !== inputPos) {
                  onInputPositionChange?.(jumped.gap);
                }
                return;
              }
              if (key === 'ArrowLeft' && afterCaret.gap > 0) {
                // Jump to end of previous gap text
                setCaretPosition(editorRef.current, afterCaret.gap - 1, Infinity);
                const jumped = readCaretPosition(editorRef.current);
                if (jumped && jumped.gap !== inputPos) {
                  onInputPositionChange?.(jumped.gap);
                }
                return;
              }
            }

            if (afterCaret.gap !== inputPos) {
              // Only update position — moveInputPosition handles the text swap
              onInputPositionChange?.(afterCaret.gap);
            }
          });
        }
        // For ArrowDown/ArrowUp, also propagate to consumer (for dropdown navigation)
        if (key === 'ArrowDown' || key === 'ArrowUp') {
          onKeyDown?.(e as unknown as React.KeyboardEvent<HTMLInputElement>);
        }
        return;
      }

      // ---------------------------------------------------------------
      // Tab — propagate (don't prevent)
      // ---------------------------------------------------------------
      if (key === 'Tab') {
        onKeyDown?.(e as unknown as React.KeyboardEvent<HTMLInputElement>);
        return;
      }

      // ---------------------------------------------------------------
      // Printable characters — let contenteditable handle naturally
      // After the character is inserted, syncDomToState will pick it up
      // via the `input` event handler.
      // ---------------------------------------------------------------
    },
    [
      disabled,
      readOnly,
      chips,
      activeInput,
      inputPos,
      gapTexts,
      allSelected,
      onKeyDown,
      onInputChange,
      onInputPositionChange,
      onRemoveChip,
      onRemoveChips,
      onClearAll,
    ],
  );

  // ---------------------------------------------------------------------------
  // Paste
  // ---------------------------------------------------------------------------
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      e.preventDefault(); // Always prevent — contenteditable would paste rich HTML

      const text = e.clipboardData.getData('text/plain');
      if (!text) return;

      // Sync caret position before processing paste
      const editor = editorRef.current;
      const caret = editor ? readCaretPosition(editor) : null;
      if (caret && caret.gap !== inputPos) {
        onInputPositionChange?.(caret.gap);
      }

      // Check if paste contains any tag tokens
      const tokens = text.trim().split(/[\s\n]+/).filter(Boolean);
      const hasTag = tokens.some((t) => parseToken(t));

      if (hasTag) {
        // Delegate to consumer's paste handler (creates chips + text)
        const tagCount = tokens.filter((t) => parseToken(t)).length;
        const pasteGap = caret?.gap ?? inputPos;
        pendingCaretRef.current = { gap: pasteGap + tagCount, offset: 0 };
        onPaste?.(e as unknown as React.ClipboardEvent<HTMLInputElement>, undefined, caret?.offset ?? 0);
        return;
      }

      // Plain text paste — insert at caret position
      if (!editor || !caret) return;
      const currentText = getGapText(editor, caret.gap);
      const newText = currentText.slice(0, caret.offset) + text + currentText.slice(caret.offset);
      pendingCaretRef.current = { gap: caret.gap, offset: caret.offset + text.length };
      onInputChange(newText);
    },
    [onPaste, inputPos, onInputChange, onInputPositionChange],
  );

  // ---------------------------------------------------------------------------
  // Click delegation for chip remove buttons and chip clicks
  // ---------------------------------------------------------------------------
  const handleEditorClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;

      // Chip remove button click
      const btn = target.closest('button');
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        const chipSpan = btn.closest('[data-chip-index]') as HTMLElement | null;
        if (chipSpan) {
          const idx = parseInt(chipSpan.getAttribute('data-chip-index') || '', 10);
          if (!isNaN(idx)) {
            // Set pending caret at the merge point: end of the left gap's text
            if (editorRef.current) {
              const leftText = getGapText(editorRef.current, idx);
              pendingCaretRef.current = { gap: idx, offset: leftText.length };
            }
            onRemoveChip(idx);
          }
        }
        return;
      }

      // Clicking on a chip → select it (native selection highlight)
      const chipSpan = target.closest('[data-chip-index]') as HTMLElement | null;
      if (chipSpan) {
        const editor = editorRef.current;
        if (editor) editor.focus();
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNode(chipSpan);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        return;
      }

      // Sync gap position on click (user may click a different gap)
      requestAnimationFrame(() => {
        const editor = editorRef.current;
        if (!editor) return;
        const caret = readCaretPosition(editor);
        if (caret && caret.gap !== inputPos) {
          onInputPositionChange?.(caret.gap);
        }
      });
    },
    [onRemoveChip, inputPos, onInputPositionChange],
  );

  // Prevent chip mousedowns from stealing focus / moving caret inside chip
  const handleEditorMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (disabled) return;
      const target = e.target as HTMLElement;
      // Save selection anchor for later Shift+Click (only when not clicking on a chip)
      if (!target.closest('[data-chip-index]') && !target.closest('button') && !e.shiftKey) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const r = sel.getRangeAt(0);
          selectionAnchorRef.current = { node: r.startContainer, offset: r.startOffset };
        }
      }
      // If clicking on a chip or button inside a chip, prevent default
      if (target.closest('[data-chip-index]') || target.closest('button')) {
        e.preventDefault();
      }
    },
    [disabled],
  );

  // Mouse-up: triple-click → allSelected; Shift+Click → extend selection
  const handleEditorMouseUp = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Triple-click (detail >= 3): select all content
      if (e.detail >= 3) {
        setAllSelected(true);
        const sel = window.getSelection();
        const editor = editorRef.current;
        if (sel && editor) {
          const range = document.createRange();
          range.selectNodeContents(editor);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        return;
      }

      // Shift+Click: extend selection from saved anchor to click position
      if (e.shiftKey && selectionAnchorRef.current) {
        const editor = editorRef.current;
        if (!editor) return;
        const target = e.target as HTMLElement;
        const chipSpan = target.closest('[data-chip-index]') as HTMLElement | null;
        const sel = window.getSelection();
        if (!sel) return;
        const range = document.createRange();
        try {
          const anchor = selectionAnchorRef.current;
          range.setStart(anchor.node, anchor.offset);
          if (chipSpan) {
            range.setEndAfter(chipSpan);
          } else {
            const caretRange = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(e.clientX, e.clientY);
            if (caretRange) {
              range.setEnd(caretRange.startContainer, caretRange.startOffset);
            } else {
              return;
            }
          }
        } catch {
          return;
        }
        sel.removeAllRanges();
        sel.addRange(range);
      }
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Container click — focus the editor
  // ---------------------------------------------------------------------------
  const handleContainerMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (disabled) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'BUTTON' || target.closest('button')) return;
      // Only handle if clicking on the container itself (not the editor)
      if (editorRef.current?.contains(target)) return;
      e.preventDefault();
      editorRef.current?.focus();
    },
    [disabled],
  );

  // ---------------------------------------------------------------------------
  // Placeholder
  // ---------------------------------------------------------------------------
  const showPlaceholder = chips.length === 0 && !activeInput && !hasFocus;
  const showPlaceholderFocused = chips.length === 0 && !activeInput && hasFocus;

  // ---------------------------------------------------------------------------
  // Query string for form integration
  // ---------------------------------------------------------------------------
  const queryString = useMemo(
    () => buildQueryString(chips, activeInput, inputPos, gapTexts),
    [chips, activeInput, inputPos, gapTexts],
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div
      ref={containerRef}
      aria-label={ariaLabel || 'Tag input'}
      onMouseDown={handleContainerMouseDown}
      className={[
        'relative flex flex-wrap items-center min-h-[36px] w-full rounded-md border bg-zinc-50 px-2 py-1.5 text-sm text-zinc-900 outline-none dark:bg-zinc-900 dark:text-zinc-100',
        error
          ? 'border-red-500 focus-within:border-red-500 focus-within:ring-1 focus-within:ring-red-500'
          : 'border-zinc-300 focus-within:border-zinc-500 focus-within:bg-white focus-within:ring-1 focus-within:ring-zinc-500 dark:border-zinc-700 dark:focus-within:border-zinc-500 dark:focus-within:bg-zinc-800',
        disabled ? 'opacity-50 cursor-not-allowed' : readOnly ? 'cursor-default' : 'cursor-text',
      ].join(' ')}
      style={{
        touchAction: 'manipulation',
        ...(maxRows ? { maxHeight: `${maxRows * 28 + 16}px`, overflowY: 'auto' as const } : {}),
      }}
    >
      {/* The contenteditable editor */}
      <div
        ref={editorRef}
        contentEditable={!disabled && !readOnly}
        suppressContentEditableWarning
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        role="textbox"
        aria-label="Search text"
        aria-describedby={`${containerId}-desc`}
        aria-invalid={error || undefined}
        aria-required={required || undefined}
        enterKeyHint="search"
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onClick={handleEditorClick}
        onMouseUp={handleEditorMouseUp}
        onMouseDown={handleEditorMouseDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        className="flex-1 min-w-0 bg-transparent text-sm leading-6 outline-none whitespace-pre-wrap break-words"
        style={{
          minHeight: '20px',
          caretColor: disabled ? 'transparent' : undefined,
        }}
      />

      {/* Placeholder overlay */}
      {(showPlaceholder || showPlaceholderFocused) && placeholder && (
        <div
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-sm text-zinc-400 dark:text-zinc-500 select-none"
          aria-hidden
        >
          {placeholder}
        </div>
      )}

      {/* Form integration — type=text so browser constraint validation (required) fires */}
      {name && (
        <input
          type="text"
          name={name}
          value={queryString}
          required={required || undefined}
          aria-hidden="true"
          tabIndex={-1}
          readOnly
          onChange={() => {}}
          style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: '1px', height: '1px', padding: 0, border: 0 }}
        />
      )}

      {/* Aria live region for chip add/remove announcements */}
      <span
        ref={ariaLiveRef}
        aria-live="polite"
        aria-atomic="true"
        style={{ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 }}
      />

      {/* Aria description for chip count */}
      <span
        id={`${containerId}-desc`}
        style={{
          position: 'absolute',
          width: '1px',
          height: '1px',
          overflow: 'hidden',
          clip: 'rect(0,0,0,0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {chips.length > 0 ? `${chips.length} tags` : 'No tags'}
      </span>
    </div>
  );
});
ChipInput.displayName = 'ChipInput';

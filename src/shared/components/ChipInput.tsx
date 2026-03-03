import { useState, useRef, useCallback, useEffect } from 'react';
import { parseToken } from '@/features/search/components/RecentSearchesDropdown';
import { getTagColor, TAG_TYPE_DISPLAY } from '@/lib/utils/types';
import { getChipCursorAction } from '@/shared/utils/chip-cursor';

export interface ChipInputProps {
  chips: string[];
  activeInput: string;
  onInputChange: (text: string) => void;
  onRemoveChip: (index: number) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onFocus?: () => void;
  onEditChip?: (index: number) => void;
  onPaste?: (e: React.ClipboardEvent<HTMLInputElement>) => void;
  editingIndex: number | null;
  placeholder?: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

function ChipElement({ chip, order, onRemove, onClick }: {
  chip: string;
  order: number;
  onRemove: () => void;
  onClick: () => void;
}) {
  const parsed = parseToken(chip);
  const color = parsed
    ? getTagColor(parsed.type)
    : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300';
  const label = parsed
    ? `${parsed.type}:${parsed.tag.replace(/_/g, ' ')}${TAG_TYPE_DISPLAY[parsed.type]}`
    : chip;

  return (
    <span
      className={`inline-flex h-5 max-w-[200px] items-center gap-0.5 rounded-full text-xs font-medium pl-2 pr-1 select-none whitespace-nowrap cursor-pointer ${color}`}
      style={{ order }}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      <span className="truncate">{label}</span>
      <span
        role="button"
        className="ml-0.5 flex-shrink-0 rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer"
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3">
          <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
        </svg>
      </span>
    </span>
  );
}

export function ChipInput({
  chips,
  activeInput,
  onInputChange,
  onRemoveChip,
  onKeyDown,
  onFocus,
  onEditChip,
  onPaste,
  editingIndex,
  placeholder,
  inputRef,
}: ChipInputProps) {
  const [chipCursorPos, setChipCursorPos] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);

  const inChipMode = chipCursorPos >= 0;

  // Reset chip cursor when chips change or editing starts
  useEffect(() => {
    if (editingIndex !== null) {
      setChipCursorPos(-1);
      return;
    }
    if (chips.length === 0) {
      setChipCursorPos(-1);
    } else if (chipCursorPos >= chips.length) {
      setChipCursorPos(chips.length - 1);
    }
  }, [chips.length, chipCursorPos, editingIndex]);

  // Focus the cursor input when entering chip mode
  useEffect(() => {
    if (inChipMode) {
      cursorRef.current?.focus();
    }
  }, [inChipMode, chipCursorPos]);

  const enterChipMode = useCallback((pos: number) => {
    setChipCursorPos(pos);
  }, []);

  const exitChipMode = useCallback(() => {
    setChipCursorPos(-1);
    inputRef.current?.focus();
  }, [inputRef]);

  // Main input: keydown (only handles entering chip mode)
  const handleMainKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || composingRef.current) {
      onKeyDown?.(e);
      return;
    }

    // Modifier combos → pass to consumer
    if (e.ctrlKey || e.metaKey) {
      onKeyDown?.(e);
      return;
    }

    const input = inputRef.current;
    const selStart = input?.selectionStart ?? 0;
    const selEnd = input?.selectionEnd ?? 0;

    // ArrowLeft at position 0 → enter chip cursor mode
    if (e.key === 'ArrowLeft' && selStart === 0 && selEnd === 0 && chips.length > 0) {
      e.preventDefault();
      enterChipMode(chips.length - 1);
      return;
    }

    // Backspace at input start with no text → remove last chip
    if (e.key === 'Backspace' && chips.length > 0 && selStart === 0 && selEnd === 0 && !activeInput) {
      e.preventDefault();
      onRemoveChip(chips.length - 1);
      return;
    }

    onKeyDown?.(e);
  }, [chips, activeInput, inputRef, onKeyDown, onRemoveChip, enterChipMode]);

  // Cursor input: keydown (handles chip navigation)
  const handleCursorKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // Modifier combos
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'c' && chipCursorPos >= 0 && chipCursorPos < chips.length) {
        e.preventDefault();
        navigator.clipboard.writeText(chips[chipCursorPos]).catch(() => {});
        return;
      }
      // Pass Ctrl combos to consumer (undo/redo etc)
      onKeyDown?.(e);
      return;
    }

    const action = getChipCursorAction(e.key, chipCursorPos, chips.length, 0, 0);

    if (action.action !== 'none') {
      if (action.preventDefault) e.preventDefault();
      switch (action.action) {
        case 'move':
          setChipCursorPos(action.newPos);
          return;
        case 'exitToInput':
          exitChipMode();
          if (e.key === 'Escape') onKeyDown?.(e);
          return;
        case 'removeChipBefore':
        case 'removeChipAt':
          onRemoveChip(action.chipIndex!);
          setChipCursorPos(action.newPos);
          return;
        case 'editChip':
          onEditChip?.(action.chipIndex!);
          setChipCursorPos(-1);
          return;
      }
    }

    // Printable character → exit to main input, let it handle the keystroke
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      exitChipMode();
      return;
    }

    onKeyDown?.(e);
  }, [chipCursorPos, chips, onKeyDown, onRemoveChip, onEditChip, exitChipMode]);

  const handleMainFocus = useCallback(() => {
    setChipCursorPos(-1);
    onFocus?.();
  }, [onFocus]);

  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    if (e.target === containerRef.current) {
      exitChipMode();
    }
  }, [exitChipMode]);

  return (
    <div
      ref={containerRef}
      onClick={handleContainerClick}
      className="flex flex-wrap items-center gap-1 min-h-[36px] w-full cursor-text rounded-md border border-zinc-300 bg-zinc-50 px-2 py-1.5 text-sm text-zinc-900 outline-none focus-within:border-zinc-500 focus-within:bg-white focus-within:ring-1 focus-within:ring-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus-within:border-zinc-500 dark:focus-within:bg-zinc-800"
    >
      {chips.map((chip, i) => {
        if (editingIndex === i) return null;
        return (
          <ChipElement
            key={i}
            chip={chip}
            order={i * 2}
            onRemove={() => onRemoveChip(i)}
            onClick={() => onEditChip?.(i)}
          />
        );
      })}
      {/* Ghost cursor input — only visible (as a native caret) when in chip mode */}
      <input
        ref={cursorRef}
        type="text"
        tabIndex={-1}
        aria-hidden
        value=""
        onChange={() => {}}
        onKeyDown={handleCursorKeyDown}
        className="bg-transparent text-sm leading-4 outline-none caret-current"
        style={{
          width: inChipMode ? '1px' : 0,
          minWidth: 0,
          flex: 'none',
          padding: 0,
          border: 'none',
          opacity: inChipMode ? 1 : 0,
          position: inChipMode ? 'static' : 'absolute',
          order: chipCursorPos * 2 - 1,
          margin: inChipMode ? '0 -2.5px' : 0,
        }}
      />
      {/* Main text input */}
      <input
        ref={inputRef}
        type="text"
        value={activeInput}
        onChange={(e) => onInputChange(e.target.value)}
        onKeyDown={handleMainKeyDown}
        onFocus={handleMainFocus}
        onPaste={onPaste}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        placeholder={chips.length === 0 && !activeInput ? (placeholder || '') : undefined}
        className="flex-1 min-w-[60px] bg-transparent text-sm leading-4 outline-none placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
        style={{ order: 9999 }}
        autoComplete="off"
      />
    </div>
  );
}

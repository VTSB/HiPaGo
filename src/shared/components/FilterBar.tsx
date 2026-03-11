'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ChipInput, type CaretTokenContext } from '@/shared/components/ChipInput';
import { SuggestionDropdown } from '@/features/search/components/SuggestionDropdown';
import { parseToken } from '@/features/search/components/RecentSearchesDropdown';
import { searchLocalTags } from '@/lib/db/search-local';
import { useClickOutside } from '@/shared/hooks/useClickOutside';
import { useChipInputState } from '@/shared/hooks/useChipInputState';
import type { TagType, Suggestion } from '@/lib/utils/types';

export interface FilterBarProps {
  onFilterChange: (filters: { tags: Array<{ type: TagType; name: string }>; titleQuery: string }) => void;
  placeholder?: string;
}

export function FilterBar({ onFilterChange, placeholder }: FilterBarProps) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [caretTokenContext, setCaretTokenContext] = useState<CaretTokenContext | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const ignoreMouseRef = useRef(false);

  const {
    chips,
    activeInput,
    inputPosition,
    gapTexts,
    moveInputPosition,
    undo, redo,
    handleRemoveChip, handleRemoveChips,
    handleClearAll,
    handlePaste,
    insertChip,
    replaceActiveTokenWithChip,
    handleInputChange: handleInputChangeBase,
  } = useChipInputState();

  const activeCaretTokenContext = caretTokenContext
    && caretTokenContext.gap === inputPosition
    && caretTokenContext.gapText === activeInput
    ? caretTokenContext
    : null;

  const handleClickOutside = useCallback(() => {
    setShowDropdown(false);
  }, []);
  useClickOutside([inputRef, dropdownRef], handleClickOutside);

  // Debounced autocomplete
  useEffect(() => {
    const activeToken = activeCaretTokenContext?.token ?? '';
    const colonIdx = activeToken.indexOf(':');
    const searchTerm = colonIdx > 0 ? activeToken.slice(colonIdx + 1) : activeToken;

    if (searchTerm.length < 2) {
      setSuggestions([]);
      setShowDropdown(false);
      return;
    }

    const timer = setTimeout(async () => {
      const typeFilter = colonIdx > 0 ? (activeToken.slice(0, colonIdx) as TagType) : undefined;
      const results = await searchLocalTags(searchTerm, typeFilter, 10);
      setSuggestions(results);
      setShowDropdown(results.length > 0);
    }, 200);

    return () => clearTimeout(timer);
  }, [activeCaretTokenContext?.token]);

  // Notify parent when chips or active input change
  useEffect(() => {
    const tags: Array<{ type: TagType; name: string }> = [];
    for (const chip of chips) {
      const parsed = parseToken(chip);
      if (parsed) {
        tags.push({ type: parsed.type, name: parsed.tag });
      }
    }
    const titleParts: string[] = [];
    for (let gap = 0; gap <= chips.length; gap += 1) {
      const text = gap === inputPosition ? activeInput.trim() : (gapTexts[gap] || '').trim();
      if (text) {
        titleParts.push(text);
      }
    }
    const titleQuery = titleParts.join(' ');
    onFilterChange({ tags, titleQuery });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chips, activeInput, inputPosition, gapTexts]);

  // Only commits tag-formatted values (type:name) as chips
  const commitTag = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed || !parseToken(trimmed)) return;

    const replaced = activeCaretTokenContext
      ? replaceActiveTokenWithChip(trimmed, activeCaretTokenContext)
      : false;

    if (!replaced) {
      insertChip(trimmed);
    }

    setSuggestions([]);
    setShowDropdown(false);
    setSelectedIndex(-1);
    setCaretTokenContext(null);
  }, [activeCaretTokenContext, insertChip, replaceActiveTokenWithChip]);

  const handleSuggestionClick = useCallback((tag: string, tagType: string) => {
    commitTag(`${tagType}:${tag}`);
    inputRef.current?.focus();
  }, [commitTag]);

  const handleInputChange = useCallback((text: string) => {
    handleInputChangeBase(text);
    setSelectedIndex(-1);
  }, [handleInputChangeBase]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;

    // Ctrl+Z: undo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
      return;
    }

    // Ctrl+Shift+Z / Ctrl+Y: redo
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      redo();
      return;
    }

    // Enter: accept suggestion or commit tag
    if (e.key === 'Enter') {
      e.preventDefault();
      if (showDropdown && selectedIndex >= 0 && suggestions[selectedIndex]) {
        const s = suggestions[selectedIndex];
        handleSuggestionClick(s.tag, s.tagType);
      } else {
        commitTag(activeInput);
      }
      return;
    }

    // Escape: close dropdown
    if (e.key === 'Escape') {
      setShowDropdown(false);
      setSuggestions([]);
      setSelectedIndex(-1);
      return;
    }

    // ArrowDown/Up: navigate suggestions (wrap-around)
    if (showDropdown && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => prev < suggestions.length - 1 ? prev + 1 : 0);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => prev > 0 ? prev - 1 : suggestions.length - 1);
        return;
      }
    }
  }, [activeInput, handleSuggestionClick, showDropdown, selectedIndex, suggestions, commitTag, undo, redo]);

  return (
    <div className="relative w-full">
      <ChipInput
        chips={chips}
        activeInput={activeInput}
        inputPosition={inputPosition}
        onInputChange={handleInputChange}
        onInputPositionChange={moveInputPosition}
        onCaretTokenChange={setCaretTokenContext}
        gapTexts={gapTexts}
        onGapTextClick={(pos) => { moveInputPosition(pos); }}
        onRemoveChip={handleRemoveChip}
        onRemoveChips={handleRemoveChips}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (suggestions.length > 0) setShowDropdown(true); }}
        onBlur={() => {
          setShowDropdown(false);
        }}
        onPaste={handlePaste}
        onClearAll={handleClearAll}
        placeholder={placeholder}
        inputRef={inputRef}
      />
      {showDropdown && suggestions.length > 0 && (
        <div ref={dropdownRef}>
          <SuggestionDropdown
            suggestions={suggestions}
            selectedIndex={selectedIndex}
            onSelect={handleSuggestionClick}
            onHover={setSelectedIndex}
            ignoreMouseRef={ignoreMouseRef}
          />
        </div>
      )}
    </div>
  );
}

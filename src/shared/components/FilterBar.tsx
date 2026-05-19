'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { SearchInput } from '@/shared/components/SearchInput';
import { SuggestionDropdown } from '@/features/search/components/SuggestionDropdown';
import { parseToken } from '@/shared/utils/parse-token';
import { searchLocalTags } from '@/lib/db/search-local';
import { getSuggestionsForQuery } from '@/lib/api/search';
import { useDbStatusStore } from '@/lib/store/db-status';
import { useClickOutside } from '@/shared/hooks/useClickOutside';
import { useSearchInputState } from '@/shared/hooks/useSearchInputState';
import { isHangul, KOREAN_LABEL_TO_TYPE } from '@/lib/utils/tag-query';
import type { TagType, Suggestion } from '@/lib/utils/types';

export interface FilterBarProps {
  onFilterChange: (filters: { tags: Array<{ type: TagType; name: string }>; titleQuery: string }) => void;
  placeholder?: string;
}

export function FilterBar({ onFilterChange, placeholder }: FilterBarProps) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const ignoreMouseRef = useRef(false);
  const reqIdRef = useRef(0);

  const dbReady = useDbStatusStore((s) => s.dbReady);

  const {
    value,
    updateValue,
    clear,
    currentToken,
    insertSuggestion,
    undo,
    redo,
  } = useSearchInputState();

  const activeToken = currentToken || '';
  const colonIdx = activeToken.indexOf(':');

  const handleClickOutside = useCallback(() => {
    setShowDropdown(false);
  }, []);
  useClickOutside([inputRef, dropdownRef], handleClickOutside);

  // Debounced autocomplete. Uses the local tag DB once it has finished
  // syncing (dbReady), and the remote tagindex API until then. dbReady is a
  // dependency so suggestions refresh automatically the moment the local DB
  // becomes ready, without the user re-typing.
  useEffect(() => {
    const searchTerm = colonIdx > 0 ? activeToken.slice(colonIdx + 1) : activeToken;
    const reqId = ++reqIdRef.current;

    if (searchTerm.length < 2) {
      setSuggestions([]);
      setShowDropdown(false);
      return;
    }

    // DB not ready and the user is typing Hangul — the remote tagindex API is
    // English-keyed and would 400. Skip it; show empty suggestions until sync.
    if (!dbReady && isHangul(searchTerm)) {
      setSuggestions([]);
      setShowDropdown(false);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const rawType = colonIdx > 0 ? activeToken.slice(0, colonIdx) : undefined;
        // Accept Korean type labels (여자:, 작가:, …) as well as English types.
        const typeFilter = rawType
          ? (KOREAN_LABEL_TO_TYPE[rawType] ?? (rawType as TagType))
          : undefined;
        const results = dbReady
          ? await searchLocalTags(searchTerm, typeFilter, 10)
          : await getSuggestionsForQuery(activeToken);
        // Discard a slow in-flight response superseded by a newer request
        // (e.g. a remote query still resolving after dbReady flipped true).
        if (reqId !== reqIdRef.current) return;
        setSuggestions(results);
        setShowDropdown(results.length > 0);
      } catch {
        // network/db failure — keep existing suggestions
      }
    }, dbReady ? 120 : 300);

    return () => clearTimeout(timer);
  }, [activeToken, colonIdx, dbReady]);

  // Notify parent when value changes
  useEffect(() => {
    const tags = value
      .split(/\s+/)
      .map(t => parseToken(t))
      .filter(Boolean)
      .map(p => ({ type: p!.type as TagType, name: p!.tag }));
    const titleQuery = value.split(/\s+/).filter(t => !parseToken(t)).join(' ').trim();
    onFilterChange({ tags, titleQuery });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const handleSuggestionClick = useCallback((tag: string, tagType: string, localName?: string) => {
    insertSuggestion(tag, tagType, localName);
    setSuggestions([]);
    setShowDropdown(false);
    setSelectedIndex(-1);
    inputRef.current?.focus();
  }, [insertSuggestion]);

  // Drive suggestion display + insertion script by the active token, not locale.
  const koreanInput = isHangul(activeToken);

  const handleInputChange = useCallback((text: string) => {
    updateValue(text);
    setSelectedIndex(-1);
  }, [updateValue]);

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

    // Enter: accept suggestion
    if (e.key === 'Enter') {
      e.preventDefault();
      if (showDropdown && selectedIndex >= 0 && suggestions[selectedIndex]) {
        const s = suggestions[selectedIndex];
        handleSuggestionClick(s.tag, s.tagType, s.localName);
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
  }, [handleSuggestionClick, showDropdown, selectedIndex, suggestions, undo, redo]);

  return (
    <div className="relative w-full">
      <SearchInput
        value={value}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (suggestions.length > 0) setShowDropdown(true); }}
        onBlur={() => { setShowDropdown(false); }}
        onClear={clear}
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
            koreanDisplay={koreanInput}
          />
        </div>
      )}
    </div>
  );
}

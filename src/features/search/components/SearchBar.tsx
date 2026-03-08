'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSearchStore } from '@/features/search/store/search.store';
import { useSearch } from '@/features/search/hooks/useSearch';
import { ChipInput } from '@/shared/components/ChipInput';
import type { Suggestion } from '@/lib/utils/types';
import { searchLocalTags } from '@/lib/db/search-local';
import { useDbStatusStore } from '@/lib/store/db-status';
import { useT } from '@/lib/i18n/useT';
import { useClickOutside } from '@/shared/hooks/useClickOutside';
import { buildQueryString } from '@/shared/utils/build-query';
import { useChipInputState } from '@/shared/hooks/useChipInputState';
import { RecentSearchesDropdown } from './RecentSearchesDropdown';
import { SuggestionDropdown } from './SuggestionDropdown';

export function SearchBar() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const ignoreMouseRef = useRef(false);
  const setQuery = useSearchStore((s) => s.setQuery);
  const suggestions = useSearchStore((s) => s.suggestions);
  const clearSuggestions = useSearchStore((s) => s.clearSuggestions);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const recentSearches = useSearchStore((s) => s.recentSearches);
  const addRecentSearch = useSearchStore((s) => s.addRecentSearch);
  const removeRecentSearch = useSearchStore((s) => s.removeRecentSearch);
  const clearRecentSearches = useSearchStore((s) => s.clearRecentSearches);
  const dbReady = useDbStatusStore((s) => s.dbReady);
  const t = useT();
  const [popularTags, setPopularTags] = useState<Suggestion[]>([]);

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
    syncFromQuery,
    handleInputChange: handleInputChangeBase,
  } = useChipInputState();

  const historyVisible = showDropdown && activeInput === '' && chips.length === 0 && recentSearches.length > 0 && suggestions.length === 0;

  const searchParams = useSearchParams();

  // Sync from URL when navigating via tag links
  useEffect(() => {
    const urlQuery = searchParams.get('q') || '';
    if (urlQuery) {
      syncFromQuery(urlQuery);
    }
  }, [searchParams, syncFromQuery]);

  // Trigger auto-fetch of suggestions
  useSearch();

  // Reset selection when suggestions change
  useEffect(() => {
    setSelectedIndex(-1);
  }, [suggestions]);

  // Load popular tags once DB is ready
  useEffect(() => {
    if (dbReady) {
      searchLocalTags('').then(setPopularTags).catch((e) => console.warn('[search] Popular tags load failed:', e));
    }
  }, [dbReady]);

  // Sync active input to store for autocomplete
  useEffect(() => {
    setQuery(activeInput);
  }, [activeInput, setQuery]);

  const appendTag = useCallback(
    (tag: string, tagType: string) => {
      const newTag = `${tagType}:${tag.replace(/ /g, '_')}`;
      insertChip(newTag);
      clearSuggestions();
      setSelectedIndex(-1);
      ignoreMouseRef.current = true;
      setTimeout(() => { ignoreMouseRef.current = false; }, 300);
      inputRef.current?.focus();
    },
    [insertChip, clearSuggestions],
  );

  const handleSuggestionClick = useCallback(
    (tag: string, tagType: string) => {
      appendTag(tag, tagType);
    },
    [appendTag],
  );

  const doSubmit = useCallback(() => {
    const fullQuery = buildQueryString(chips, activeInput, inputPosition, gapTexts);
    if (!fullQuery) return;
    setShowDropdown(false);
    clearSuggestions();
    addRecentSearch(fullQuery);
    router.push(`/search?q=${encodeURIComponent(fullQuery)}`);
  }, [activeInput, chips, inputPosition, gapTexts, router, clearSuggestions, addRecentSearch]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      doSubmit();
    },
    [doSubmit],
  );

  const handleHistoryClick = useCallback((search: string) => {
    syncFromQuery(search);
    setShowDropdown(false);
    clearSuggestions();
    addRecentSearch(search);
    router.push(`/search?q=${encodeURIComponent(search)}`);
  }, [syncFromQuery, clearSuggestions, addRecentSearch, router]);

  const handleInputChange = useCallback((text: string) => {
    handleInputChangeBase(text);
    setSelectedIndex(-1);
  }, [handleInputChangeBase]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Guard IME composition
      if (e.nativeEvent.isComposing) return;

      // Ctrl+Z: undo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }

      // Ctrl+Shift+Z or Ctrl+Y: redo
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
        return;
      }

      // Enter: submit or accept suggestion / recent search
      if (e.key === 'Enter') {
        e.preventDefault();
        if (historyVisible && selectedIndex >= 0 && selectedIndex < recentSearches.length) {
          handleHistoryClick(recentSearches[selectedIndex]);
          setSelectedIndex(-1);
          return;
        }
        const currentList = suggestions.length > 0 ? suggestions
          : (activeInput === '' && chips.length > 0 && popularTags.length > 0) ? popularTags : [];
        if (selectedIndex >= 0 && selectedIndex < currentList.length) {
          const s = currentList[selectedIndex];
          appendTag(s.tag, s.tagType);
          setSelectedIndex(-1);
        } else {
          doSubmit();
        }
        return;
      }

      // Escape
      if (e.key === 'Escape') {
        if (showDropdown) {
          setShowDropdown(false);
          clearSuggestions();
          // Re-focus to keep caret active; some browsers blur contenteditable on Escape
          setTimeout(() => inputRef.current?.focus(), 0);
        }
        return;
      }

      // ArrowDown/Up: navigate dropdown (recent searches or suggestions)
      if (historyVisible) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedIndex((prev) => prev < recentSearches.length - 1 ? prev + 1 : 0);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedIndex((prev) => prev > 0 ? prev - 1 : recentSearches.length - 1);
          return;
        }
      }
      const currentList = suggestions.length > 0 ? suggestions
        : (activeInput === '' && chips.length > 0 && popularTags.length > 0) ? popularTags : [];
      if (showDropdown && currentList.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedIndex((prev) => prev < currentList.length - 1 ? prev + 1 : 0);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedIndex((prev) => prev > 0 ? prev - 1 : currentList.length - 1);
          return;
        }
      }
    },
    [showDropdown, suggestions, popularTags, selectedIndex, appendTag, activeInput, chips, doSubmit, clearSuggestions, undo, redo, historyVisible, recentSearches, handleHistoryClick],
  );

  // Show dropdown when we have suggestions and input is focused
  useEffect(() => {
    if (suggestions.length > 0 && document.activeElement === inputRef.current) {
      setShowDropdown(true);
    }
  }, [suggestions]);

  // Handle click outside
  const handleClickOutside = useCallback(() => {
    setShowDropdown(false);
  }, []);
  useClickOutside([inputRef, dropdownRef], handleClickOutside);

  // Handle keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey && e.key === 'k') || (e.key === '/' && !(document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement))) {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === 'Escape') {
        if (showDropdown) {
          setShowDropdown(false);
          clearSuggestions();
        } else {
          inputRef.current?.blur();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showDropdown, clearSuggestions]);

  return (
    <div className="relative w-full max-w-md">
      <form onSubmit={handleSubmit}>
        <ChipInput
          chips={chips}
          activeInput={activeInput}
          inputPosition={inputPosition}
          onInputChange={handleInputChange}
          onInputPositionChange={moveInputPosition}
          gapTexts={gapTexts}
          onGapTextClick={(pos) => { moveInputPosition(pos); }}
          onRemoveChip={handleRemoveChip}
          onRemoveChips={handleRemoveChips}
          onKeyDown={handleKeyDown}
          onFocus={() => setShowDropdown(true)}
          onBlur={() => {
            setShowDropdown(false);
          }}
          onPaste={handlePaste}
          onClearAll={handleClearAll}
          placeholder={chips.length === 0 ? t('search.placeholder') : ''}
          inputRef={inputRef}
        />
      </form>

      {(() => {
        const historyVisible = showDropdown && activeInput === '' && chips.length === 0 && recentSearches.length > 0 && suggestions.length === 0;
        const popularVisible = showDropdown && activeInput === '' && chips.length > 0 && popularTags.length > 0 && suggestions.length === 0;
        const displayedTags = suggestions.length > 0 ? suggestions : popularVisible ? popularTags : [];

        if (historyVisible) {
          return (
            <div ref={dropdownRef}>
              <RecentSearchesDropdown
                searches={recentSearches}
                onSelect={handleHistoryClick}
                onRemove={removeRecentSearch}
                onClear={clearRecentSearches}
                selectedIndex={selectedIndex}
              />
            </div>
          );
        }

        if (showDropdown && displayedTags.length > 0) {
          return (
            <div ref={dropdownRef}>
              <SuggestionDropdown
                suggestions={displayedTags}
                selectedIndex={selectedIndex}
                onSelect={handleSuggestionClick}
                onHover={setSelectedIndex}
                ignoreMouseRef={ignoreMouseRef}
              />
            </div>
          );
        }

        return null;
      })()}
    </div>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSearchStore } from '@/features/search/store/search.store';
import { useSearch } from '@/features/search/hooks/useSearch';
import { SearchInput } from '@/shared/components/SearchInput';
import { useSearchInputState } from '@/shared/hooks/useSearchInputState';
import { UnifiedDropdown, buildDropdownItems } from '@/shared/components/UnifiedDropdown';
import { isHangul } from '@/lib/utils/tag-query';
import type { Suggestion } from '@/lib/utils/types';
import { searchLocalTags } from '@/lib/db/search-local';
import { useDbStatusStore } from '@/lib/store/db-status';
import { useT } from '@/lib/i18n/useT';
import { useClickOutside } from '@/shared/hooks/useClickOutside';

export function SearchBar({ autoFocus = false }: { autoFocus?: boolean } = {}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const setQuery = useSearchStore((s) => s.setQuery);
  const setAutocompleteQuery = useSearchStore((s) => s.setAutocompleteQuery);
  const suggestions = useSearchStore((s) => s.suggestions);
  const clearSuggestions = useSearchStore((s) => s.clearSuggestions);
  const [showDropdown, setShowDropdown] = useState(false);
  const recentSearches = useSearchStore((s) => s.recentSearches);
  const addRecentSearch = useSearchStore((s) => s.addRecentSearch);
  const removeRecentSearch = useSearchStore((s) => s.removeRecentSearch);
  const clearRecentSearches = useSearchStore((s) => s.clearRecentSearches);
  const dbReady = useDbStatusStore((s) => s.dbReady);
  const t = useT();
  const [popularTags, setPopularTags] = useState<Suggestion[]>([]);

  const {
    value,
    updateValue,
    clear,
    syncFromQuery,
    undo,
    redo,
    currentToken,
    insertSuggestion,
  } = useSearchInputState();

  const searchParams = useSearchParams();
  const lastSyncedUrlQueryRef = useRef<string | null>(null);

  // Sync from URL when navigating via tag links
  useEffect(() => {
    const urlQuery = searchParams.get('q') || '';
    if (!urlQuery || lastSyncedUrlQueryRef.current === urlQuery) return;
    lastSyncedUrlQueryRef.current = urlQuery;
    syncFromQuery(urlQuery);
  }, [searchParams, syncFromQuery]);

  // Trigger auto-fetch of suggestions
  useSearch();

  // Focus on mount when used as a dedicated search-page entry (mobile /search).
  // Deferred a frame so the focus + soft keyboard fire after layout settles.
  useEffect(() => {
    if (!autoFocus) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [autoFocus]);

  // selectedIndex is stored alongside the suggestions snapshot it belongs to.
  // When suggestions changes identity, the effective index is derived as -1
  // during render — no setState needed, no effect needed.
  const [selectionState, setSelectionState] = useState<{
    snapshot: Suggestion[];
    index: number;
  }>(() => ({ snapshot: suggestions, index: -1 }));

  const selectedIndex =
    selectionState.snapshot === suggestions ? selectionState.index : -1;

  const setSelectedIndex = useCallback((indexOrUpdater: number | ((prev: number) => number)) => {
    setSelectionState((prev) => {
      const next =
        typeof indexOrUpdater === 'function'
          ? indexOrUpdater(prev.snapshot === suggestions ? prev.index : -1)
          : indexOrUpdater;
      return { snapshot: suggestions, index: next };
    });
  }, [suggestions]);

  // Load popular tags once DB is ready
  useEffect(() => {
    if (dbReady) {
      searchLocalTags('').then(setPopularTags).catch((e) => console.warn('[search] Popular tags load failed:', e));
    }
  }, [dbReady]);

  // Sync active input to store for autocomplete
  useEffect(() => {
    setQuery(value.trim());
    setAutocompleteQuery(currentToken);
  }, [value, currentToken, setQuery, setAutocompleteQuery]);

  // Flat items for unified dropdown
  const flatItems = useMemo(() => buildDropdownItems({
    inputText: value,
    recentSearches,
    suggestions,
    popularTags,
  }), [value, recentSearches, suggestions, popularTags]);

  const doSubmit = useCallback(() => {
    const fullQuery = value.trim();
    if (!fullQuery) return;
    setShowDropdown(false);
    clearSuggestions();
    addRecentSearch(fullQuery);
    router.push(`/search?q=${encodeURIComponent(fullQuery)}`);
  }, [value, router, clearSuggestions, addRecentSearch]);

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

  const handleSuggestionClick = useCallback((tag: string, tagType: string, localName?: string) => {
    insertSuggestion(tag, tagType, localName);
    clearSuggestions();
    setSelectedIndex(-1);
    setShowDropdown(false);
    inputRef.current?.focus();
  }, [insertSuggestion, clearSuggestions, setSelectedIndex]);

  // Drive suggestion display + insertion script by the active token, not locale.
  const koreanInput = isHangul(currentToken ?? '');

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // IME guard
    if (e.nativeEvent.isComposing) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!showDropdown) { setShowDropdown(true); return; }
        setSelectedIndex(prev => prev < flatItems.length - 1 ? prev + 1 : 0);
        return;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev => prev > 0 ? prev - 1 : flatItems.length - 1);
        return;
      case 'Enter':
        e.preventDefault();
        if (selectedIndex >= 0 && selectedIndex < flatItems.length) {
          const item = flatItems[selectedIndex];
          if (item.kind === 'recent') { handleHistoryClick(item.query); }
          else if (item.kind === 'suggestion') { handleSuggestionClick(item.suggestion.tag, item.suggestion.tagType, item.suggestion.localName); }
          setSelectedIndex(-1);
        } else {
          doSubmit();
        }
        return;
      case 'Escape':
        setShowDropdown(false);
        setSelectedIndex(-1);
        return;
      case 'z':
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); undo(); return; }
        break;
      case 'y':
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); redo(); return; }
        break;
    }
  }, [showDropdown, flatItems, selectedIndex, undo, redo, doSubmit, handleHistoryClick, handleSuggestionClick, setSelectedIndex]);

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
        <SearchInput
          leadingIcon
          pill
          value={value}
          onChange={updateValue}
          onKeyDown={handleKeyDown}
          onFocus={() => { setShowDropdown(true); }}
          onBlur={() => { setTimeout(() => setShowDropdown(false), 150); }}
          onClear={clear}
          placeholder={t('search.placeholder')}
          inputRef={inputRef}
        />
      </form>

      {showDropdown && flatItems.length > 0 && (
        <div ref={dropdownRef}>
          <UnifiedDropdown
            flatItems={flatItems}
            selectedIndex={selectedIndex}
            onSelectRecent={handleHistoryClick}
            onSelectSuggestion={(tag, tagType, localName) => handleSuggestionClick(tag, tagType, localName)}
            onRemoveRecent={removeRecentSearch}
            onClearRecents={clearRecentSearches}
            koreanDisplay={koreanInput}
          />
        </div>
      )}
    </div>
  );
}

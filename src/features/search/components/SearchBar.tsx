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
import { RecentSearchesDropdown, parseToken } from './RecentSearchesDropdown';
import { SuggestionDropdown } from './SuggestionDropdown';

/** Build query string from chips + active input. */
function buildQuery(chips: string[], activeInput: string): string {
  const parts = [...chips];
  const trimmed = activeInput.trim();
  if (trimmed) parts.push(trimmed);
  return parts.join(' ');
}

interface Snapshot {
  chips: string[];
  activeInput: string;
}

export function SearchBar() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const ignoreMouseRef = useRef(false);
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  const suggestions = useSearchStore((s) => s.suggestions);
  const clearSuggestions = useSearchStore((s) => s.clearSuggestions);
  const [chips, setChips] = useState<string[]>([]);
  const [activeInput, setActiveInput] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const recentSearches = useSearchStore((s) => s.recentSearches);
  const addRecentSearch = useSearchStore((s) => s.addRecentSearch);
  const removeRecentSearch = useSearchStore((s) => s.removeRecentSearch);
  const clearRecentSearches = useSearchStore((s) => s.clearRecentSearches);
  const dbReady = useDbStatusStore((s) => s.dbReady);
  const t = useT();
  const [popularTags, setPopularTags] = useState<Suggestion[]>([]);

  // Undo/redo stacks
  const undoStack = useRef<Snapshot[]>([]);
  const redoStack = useRef<Snapshot[]>([]);

  const pushUndo = useCallback(() => {
    undoStack.current.push({ chips: [...chips], activeInput });
    redoStack.current = [];
  }, [chips, activeInput]);

  const searchParams = useSearchParams();

  // Parse query string: tags → chips, plain text → activeInput
  const syncFromQuery = useCallback((q: string) => {
    const tokens = q.trim().split(/\s+/).filter(Boolean);
    const tagChips: string[] = [];
    const textParts: string[] = [];
    for (const token of tokens) {
      if (parseToken(token)) {
        tagChips.push(token);
      } else {
        textParts.push(token);
      }
    }
    setChips(tagChips);
    setActiveInput(textParts.join(' '));
  }, []);

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
      pushUndo();
      const newTag = `${tagType}:${tag.replace(/ /g, '_')}`;
      if (editingIndex !== null) {
        setChips((prev) => {
          const next = [...prev];
          next[editingIndex] = newTag;
          return next;
        });
        setEditingIndex(null);
      } else {
        setChips((prev) => [...prev, newTag]);
      }
      setActiveInput('');
      clearSuggestions();
      setSelectedIndex(-1);
      ignoreMouseRef.current = true;
      setTimeout(() => { ignoreMouseRef.current = false; }, 300);
      inputRef.current?.focus();
    },
    [editingIndex, clearSuggestions, pushUndo],
  );

  const handleSuggestionClick = useCallback(
    (tag: string, tagType: string) => {
      appendTag(tag, tagType);
    },
    [appendTag],
  );

  const doSubmit = useCallback(() => {
    const fullQuery = buildQuery(chips, activeInput);
    if (!fullQuery) return;
    setShowDropdown(false);
    clearSuggestions();
    setEditingIndex(null);
    addRecentSearch(fullQuery);
    router.push(`/search?q=${encodeURIComponent(fullQuery)}`);
  }, [activeInput, chips, router, clearSuggestions, addRecentSearch]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      doSubmit();
    },
    [doSubmit],
  );

  const editChip = useCallback((index: number) => {
    pushUndo();
    const chip = chips[index];
    setActiveInput(chip);
    setEditingIndex(index);
    inputRef.current?.focus();
  }, [chips, pushUndo]);

  const handleHistoryClick = useCallback((search: string) => {
    syncFromQuery(search);
    setShowDropdown(false);
    clearSuggestions();
    addRecentSearch(search);
    router.push(`/search?q=${encodeURIComponent(search)}`);
  }, [syncFromQuery, clearSuggestions, addRecentSearch, router]);

  const handleInputChange = useCallback((text: string) => {
    setActiveInput(text);
    setSelectedIndex(-1);
  }, []);

  const handleRemoveChip = useCallback((index: number) => {
    pushUndo();
    setChips((prev) => prev.filter((_, i) => i !== index));
  }, [pushUndo]);

  // Paste handler: parse tags from pasted text
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    const tokens = text.trim().split(/[\s\n]+/).filter(Boolean);
    const hasTag = tokens.some((t) => parseToken(t));
    if (!hasTag) return; // let input handle plain text paste
    e.preventDefault();
    pushUndo();
    const newChips: string[] = [];
    const textParts: string[] = [];
    for (const token of tokens) {
      if (parseToken(token)) {
        newChips.push(token);
      } else {
        textParts.push(token);
      }
    }
    if (newChips.length > 0) setChips((prev) => [...prev, ...newChips]);
    if (textParts.length > 0) setActiveInput((prev) => prev + textParts.join(' '));
  }, [pushUndo]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Guard IME composition
      if (e.nativeEvent.isComposing) return;

      // Ctrl+Z: undo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (undoStack.current.length > 0) {
          redoStack.current.push({ chips: [...chips], activeInput });
          const prev = undoStack.current.pop()!;
          setChips(prev.chips);
          setActiveInput(prev.activeInput);
          setEditingIndex(null);
        }
        return;
      }

      // Ctrl+Shift+Z or Ctrl+Y: redo
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        if (redoStack.current.length > 0) {
          undoStack.current.push({ chips: [...chips], activeInput });
          const next = redoStack.current.pop()!;
          setChips(next.chips);
          setActiveInput(next.activeInput);
          setEditingIndex(null);
        }
        return;
      }

      // Enter: submit or accept suggestion
      if (e.key === 'Enter') {
        e.preventDefault();
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
        }
        if (editingIndex !== null) {
          setEditingIndex(null);
          setActiveInput('');
        }
        return;
      }

      // ArrowDown/Up: navigate dropdown
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
    [showDropdown, suggestions, popularTags, selectedIndex, appendTag, activeInput, chips, editingIndex, doSubmit, clearSuggestions],
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
    if (editingIndex !== null) {
      setEditingIndex(null);
      setActiveInput('');
    }
  }, [editingIndex]);
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
          onInputChange={handleInputChange}
          onRemoveChip={handleRemoveChip}
          onKeyDown={handleKeyDown}
          onFocus={() => setShowDropdown(true)}
          onEditChip={editChip}
          onPaste={handlePaste}
          editingIndex={editingIndex}
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

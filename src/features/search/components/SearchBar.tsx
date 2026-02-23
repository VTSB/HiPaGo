'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSearchStore } from '@/features/search/store/search.store';
import { useSearch } from '@/features/search/hooks/useSearch';
import { useSettingsStore } from '@/lib/store/settings';
import { TagChip } from '@/shared/components/TagChip';
import { getTagColor, TAG_TYPE_DISPLAY } from '@/lib/utils/types';
import type { TagType, Suggestion } from '@/lib/utils/types';
import { searchLocalTags } from '@/lib/db/search-local';
import { useDbStatusStore } from '@/lib/store/db-status';
import { useT } from '@/lib/i18n/useT';

/** Parse a single token like "female:loli" into { type, tag } or null for free text. */
function parseToken(token: string): { type: TagType; tag: string } | null {
  const colonIdx = token.indexOf(':');
  if (colonIdx <= 0) return null;
  const type = token.slice(0, colonIdx);
  const tag = token.slice(colonIdx + 1);
  if (!tag) return null;
  const validTypes = ['artist', 'group', 'series', 'character', 'tag', 'male', 'female', 'type', 'language'];
  if (!validTypes.includes(type)) return null;
  return { type: type as TagType, tag };
}

/** Build query string from chips + active input. */
function buildQuery(chips: string[], activeInput: string): string {
  const parts = [...chips];
  const trimmed = activeInput.trim();
  if (trimmed) parts.push(trimmed);
  return parts.join(' ');
}

export function SearchBar() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
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
  const locale = useSettingsStore((s) => s.locale);
  const dbReady = useDbStatusStore((s) => s.dbReady);
  const t = useT();
  const [popularTags, setPopularTags] = useState<Suggestion[]>([]);

  const searchParams = useSearchParams();

  // Parse query string into chips
  const syncFromQuery = useCallback((q: string) => {
    const tokens = q.trim().split(/\s+/).filter(Boolean);
    setChips(tokens);
    setActiveInput('');
  }, []);

  // Sync from URL when navigating via tag links
  useEffect(() => {
    const urlQuery = searchParams.get('q') || '';
    if (urlQuery) {
      syncFromQuery(urlQuery);
    }
  }, [searchParams]);

  // Trigger auto-fetch of suggestions
  useSearch();

  // Reset selection when suggestions change
  useEffect(() => {
    setSelectedIndex(-1);
  }, [suggestions]);

  // Load popular tags once DB is ready (shown after chip selection)
  useEffect(() => {
    if (dbReady) {
      searchLocalTags('').then(setPopularTags).catch(() => {});
    }
  }, [dbReady]);

  // Sync active input to store for autocomplete (only active input, not chips)
  useEffect(() => {
    setQuery(activeInput);
  }, [activeInput, setQuery]);

  const appendTag = useCallback(
    (tag: string, tagType: string) => {
      const newTag = `${tagType}:${tag.replace(/ /g, '_')}`;
      if (editingIndex !== null) {
        // Replace the chip being edited
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
    [editingIndex, clearSuggestions],
  );

  const handleSuggestionClick = useCallback(
    (tag: string, tagType: string) => {
      appendTag(tag, tagType);
    },
    [appendTag],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      // If there's active input, add it as a chip first
      const trimmed = activeInput.trim();
      const finalChips = trimmed ? [...chips, trimmed] : chips;
      if (finalChips.length === 0) return;
      const fullQuery = finalChips.join(' ');
      setChips(finalChips);
      setActiveInput('');
      setShowDropdown(false);
      clearSuggestions();
      setEditingIndex(null);
      addRecentSearch(fullQuery);
      router.push(`/search?q=${encodeURIComponent(fullQuery)}`);
    },
    [activeInput, chips, router, clearSuggestions, addRecentSearch],
  );

  const removeChip = useCallback((index: number) => {
    setChips((prev) => prev.filter((_, i) => i !== index));
    if (editingIndex === index) {
      setEditingIndex(null);
      setActiveInput('');
    }
    inputRef.current?.focus();
  }, [editingIndex]);

  const editChip = useCallback((index: number) => {
    const chip = chips[index];
    setActiveInput(chip);
    setEditingIndex(index);
    inputRef.current?.focus();
  }, [chips]);

  const handleHistoryClick = useCallback((search: string) => {
    syncFromQuery(search);
    setShowDropdown(false);
    clearSuggestions();
    addRecentSearch(search);
    router.push(`/search?q=${encodeURIComponent(search)}`);
  }, [syncFromQuery, clearSuggestions, addRecentSearch, router]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Backspace on empty input: remove last chip
      if (e.key === 'Backspace' && activeInput === '' && chips.length > 0 && editingIndex === null) {
        e.preventDefault();
        setChips((prev) => prev.slice(0, -1));
        return;
      }

      // Cancel editing on Escape
      if (e.key === 'Escape' && editingIndex !== null) {
        setEditingIndex(null);
        setActiveInput('');
        return;
      }

      const currentList = suggestions.length > 0 ? suggestions
        : (activeInput === '' && chips.length > 0 && popularTags.length > 0) ? popularTags : [];
      if (!showDropdown || currentList.length === 0) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev < currentList.length - 1 ? prev + 1 : 0,
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev > 0 ? prev - 1 : currentList.length - 1,
          );
          break;
        case 'Enter':
          if (selectedIndex >= 0 && selectedIndex < currentList.length) {
            e.preventDefault();
            const s = currentList[selectedIndex];
            appendTag(s.tag, s.tagType);
            setSelectedIndex(-1);
          }
          break;
      }
    },
    [showDropdown, suggestions, popularTags, selectedIndex, appendTag, activeInput, chips.length, editingIndex],
  );

  // Show dropdown when we have suggestions and input is focused
  useEffect(() => {
    if (suggestions.length > 0 && document.activeElement === inputRef.current) {
      setShowDropdown(true);
    }
  }, [suggestions]);

  // Handle click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node) &&
        !dropdownRef.current?.contains(e.target as Node)
      ) {
        setShowDropdown(false);
        // Finalize editing if clicking outside
        if (editingIndex !== null) {
          setEditingIndex(null);
          setActiveInput('');
        }
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [editingIndex]);

  // Handle keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey && e.key === 'k') || (e.key === '/' && !(document.activeElement instanceof HTMLInputElement))) {
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
        <div
          ref={containerRef}
          onClick={() => inputRef.current?.focus()}
          className="flex min-h-[36px] w-full cursor-text flex-wrap items-center gap-1 rounded-md border border-zinc-300 bg-zinc-50 px-2 py-1 text-sm focus-within:border-zinc-500 focus-within:bg-white focus-within:ring-1 focus-within:ring-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:focus-within:border-zinc-500 dark:focus-within:bg-zinc-800"
        >
          {chips.map((chip, i) => {
            const parsed = parseToken(chip);
            const isEditing = editingIndex === i;
            if (isEditing) return null; // Hide chip being edited
            return (
              <span
                key={`${chip}-${i}`}
                className={`inline-flex items-center gap-0.5 rounded-full text-xs font-medium pl-2 pr-1 py-0.5 cursor-pointer ${
                  parsed ? getTagColor(parsed.type) : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300'
                }`}
                onClick={(e) => { e.stopPropagation(); editChip(i); }}
              >
                {parsed ? `${parsed.tag.replace(/_/g, ' ')}${TAG_TYPE_DISPLAY[parsed.type]}` : chip}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); removeChip(i); }}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3">
                    <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
                  </svg>
                </button>
              </span>
            );
          })}
          <input
            ref={inputRef}
            type="text"
            value={activeInput}
            onChange={(e) => setActiveInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setShowDropdown(true)}
            placeholder={chips.length === 0 ? t('search.placeholder') : ''}
            className="min-w-[60px] flex-1 bg-transparent py-0.5 text-sm text-zinc-900 placeholder-zinc-400 outline-none dark:text-zinc-100"
          />
        </div>
      </form>

      {(() => {
        const historyVisible = showDropdown && activeInput === '' && chips.length === 0 && recentSearches.length > 0 && suggestions.length === 0;
        const popularVisible = showDropdown && activeInput === '' && chips.length > 0 && popularTags.length > 0 && suggestions.length === 0;
        const displayedTags = suggestions.length > 0 ? suggestions : popularVisible ? popularTags : [];

        if (historyVisible) {
          return (
            <div ref={dropdownRef} className="absolute top-full mt-1 w-full rounded-lg border border-zinc-300 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800 z-50 max-h-80 overflow-y-auto">
              <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-200 dark:border-zinc-700">
                <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{t('search.recentSearches')}</span>
                <button
                  type="button"
                  onClick={() => clearRecentSearches()}
                  className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                >
                  {t('search.clearHistory')}
                </button>
              </div>
              {recentSearches.map((search) => {
                const tokens = search.split(/\s+/).filter(Boolean);
                return (
                  <button
                    key={search}
                    type="button"
                    onClick={() => handleHistoryClick(search)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-700"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5 flex-shrink-0 text-zinc-400">
                      <path fillRule="evenodd" d="M1 8a7 7 0 1 1 14 0A7 7 0 0 1 1 8Zm7.75-4.25a.75.75 0 0 0-1.5 0V8c0 .414.336.75.75.75h3.25a.75.75 0 0 0 0-1.5h-2.5v-3.5Z" clipRule="evenodd" />
                    </svg>
                    <div className="flex flex-wrap gap-1 flex-1 min-w-0">
                      {tokens.map((token, i) => {
                        const parsed = parseToken(token);
                        return parsed ? (
                          <span key={i} className={`inline-flex rounded-full px-1.5 py-0.5 text-xs font-medium ${getTagColor(parsed.type)}`}>
                            {parsed.tag.replace(/_/g, ' ')}{TAG_TYPE_DISPLAY[parsed.type]}
                          </span>
                        ) : (
                          <span key={i} className="text-xs text-zinc-700 dark:text-zinc-300">{token}</span>
                        );
                      })}
                    </div>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); removeRecentSearch(search); }}
                      className="ml-auto flex-shrink-0 p-0.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3">
                        <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
                      </svg>
                    </button>
                  </button>
                );
              })}
            </div>
          );
        }

        if (showDropdown && displayedTags.length > 0) {
          return (
            <div ref={dropdownRef} className="absolute top-full mt-1 w-full rounded-lg border border-zinc-300 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800 z-50 max-h-80 overflow-y-auto">
              {displayedTags.map((suggestion, idx) => (
                <button
                  key={`${suggestion.tagType}-${suggestion.tag}-${idx}`}
                  type="button"
                  onClick={() => handleSuggestionClick(suggestion.tag, suggestion.tagType)}
                  onMouseEnter={() => !ignoreMouseRef.current && setSelectedIndex(idx)}
                  className={`w-full flex items-center justify-between px-4 py-2 text-left text-sm first:rounded-t-lg last:rounded-b-lg transition-colors ${
                    idx === selectedIndex
                      ? 'bg-zinc-100 dark:bg-zinc-700'
                      : 'hover:bg-zinc-100 dark:hover:bg-zinc-700'
                  }`}
                >
                  <TagChip tag={suggestion.tag} type={suggestion.tagType} displayName={locale === 'ko' && suggestion.localName ? suggestion.localName : undefined} linked={false} size="sm" />
                  <span className="text-zinc-500 dark:text-zinc-400 text-xs ml-auto flex-shrink-0">
                    {suggestion.amount.toLocaleString()}
                  </span>
                </button>
              ))}
            </div>
          );
        }

        return null;
      })()}
    </div>
  );
}

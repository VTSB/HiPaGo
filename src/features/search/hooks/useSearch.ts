'use client';

import { useEffect, useCallback, useRef } from 'react';
import { useSearchStore } from '@/features/search/store/search.store';
import { getSuggestionsForQuery, parseQuery } from '@/lib/api/search';
import { searchLocalTags } from '@/lib/db/search-local';
import { useDbStatusStore } from '@/lib/store/db-status';
import type { TagType } from '@/lib/utils/types';

/**
 * Extract the last term being typed for autocomplete purposes.
 * "female:loli artist:y" → "artist:y"
 */
function getActiveTerm(query: string): string {
  const lastSpaceIdx = query.lastIndexOf(' ');
  if (lastSpaceIdx === -1) return query;
  return query.slice(lastSpaceIdx + 1);
}

export function useSearch() {
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  const addRecentSearch = useSearchStore((s) => s.addRecentSearch);
  const setIsSearching = useSearchStore((s) => s.setIsSearching);
  const setSuggestions = useSearchStore((s) => s.setSuggestions);
  const clearSuggestions = useSearchStore((s) => s.clearSuggestions);
  const setIsLoadingSuggestions = useSearchStore((s) => s.setIsLoadingSuggestions);
  const dbReady = useDbStatusStore((s) => s.dbReady);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    // Only autocomplete the last term being typed
    const activeTerm = getActiveTerm(query).trim();

    if (!activeTerm) {
      clearSuggestions();
      return;
    }

    if (dbReady) {
      // DB initialized: use local search only (instant, no debounce)
      // Parse prefix (e.g., "female:lo" → tagType="female", tag="lo")
      const { tagType, tag } = parseQuery(activeTerm);
      const searchTerm = tagType ? tag : activeTerm;
      const typeFilter = tagType ? (tagType as TagType) : undefined;
      searchLocalTags(searchTerm, typeFilter).then((results) => {
        setSuggestions(results);
      }).catch(() => {});
    } else if (activeTerm.length >= 2) {
      // DB not initialized: use remote API (debounced, min 2 chars)
      setIsLoadingSuggestions(true);
      debounceRef.current = setTimeout(async () => {
        try {
          const remoteResults = await getSuggestionsForQuery(activeTerm);
          setSuggestions(remoteResults);
        } catch {
          // Silently fail
        } finally {
          setIsLoadingSuggestions(false);
        }
      }, 300);
    } else if (!dbReady) {
      clearSuggestions();
    }

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, dbReady, clearSuggestions, setIsLoadingSuggestions, setSuggestions]);

  const search = useCallback(
    (searchQuery: string) => {
      setQuery(searchQuery);
      addRecentSearch(searchQuery);
      setIsSearching(true);
    },
    [setQuery, addRecentSearch, setIsSearching],
  );

  return { query, setQuery, addRecentSearch, setIsSearching, setSuggestions, clearSuggestions, setIsLoadingSuggestions, search };
}

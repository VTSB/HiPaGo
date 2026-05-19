'use client';

import { useEffect, useCallback, useRef } from 'react';
import { useSearchStore } from '@/features/search/store/search.store';
import { getSuggestionsForQuery, parseQuery } from '@/lib/api/search';
import { searchLocalTags } from '@/lib/db/search-local';
import { useDbStatusStore } from '@/lib/store/db-status';
import { isHangul } from '@/lib/utils/tag-query';
import type { TagType } from '@/lib/utils/types';

export function useSearch() {
  const query = useSearchStore((s) => s.query);
  const autocompleteQuery = useSearchStore((s) => s.autocompleteQuery);
  const setQuery = useSearchStore((s) => s.setQuery);
  const setAutocompleteQuery = useSearchStore((s) => s.setAutocompleteQuery);
  const addRecentSearch = useSearchStore((s) => s.addRecentSearch);
  const setIsSearching = useSearchStore((s) => s.setIsSearching);
  const setSuggestions = useSearchStore((s) => s.setSuggestions);
  const clearSuggestions = useSearchStore((s) => s.clearSuggestions);
  const setIsLoadingSuggestions = useSearchStore((s) => s.setIsLoadingSuggestions);
  const dbReady = useDbStatusStore((s) => s.dbReady);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchIdRef = useRef(0);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const activeTerm = autocompleteQuery?.trim() ?? '';

    if (!activeTerm) {
      clearSuggestions();
      return;
    }

    // For single character: use local DB if available (instant but limited)
    if (activeTerm.length < 2) {
      setIsLoadingSuggestions(false);
      if (dbReady) {
        const { tagType, tag } = parseQuery(activeTerm);
        const searchTerm = tagType ? tag : activeTerm;
        const typeFilter = tagType ? (tagType as TagType) : undefined;
        const currentId = ++searchIdRef.current;
        searchLocalTags(searchTerm, typeFilter).then((results) => {
          if (currentId === searchIdRef.current) setSuggestions(results);
        }).catch(() => {});
      } else {
        clearSuggestions();
      }
      return;
    }

    // For 2+ chars: use local DB if ready (instant, comprehensive after HTML sync),
    // otherwise fall back to remote tagindex API.
    const currentId = ++searchIdRef.current;
    if (dbReady) {
      // Local DB has all tags from HTML page sync — use it for instant results
      debounceRef.current = setTimeout(async () => {
        setIsLoadingSuggestions(true);
        try {
          const { tagType, tag } = parseQuery(activeTerm);
          const searchTerm = tagType ? tag : activeTerm;
          const typeFilter = tagType ? (tagType as TagType) : undefined;
          const results = await searchLocalTags(searchTerm, typeFilter);
          if (currentId === searchIdRef.current) setSuggestions(results);
        } catch {
          // Silent failure — suggestions are non-critical
        } finally {
          setIsLoadingSuggestions(false);
        }
      }, 100);
    } else if (isHangul(activeTerm)) {
      // DB not ready and the user is typing Hangul — the remote tagindex API
      // is English-keyed and would 400 on every keystroke. Skip it entirely
      // and show empty suggestions until the local DB has synced.
      clearSuggestions();
      setIsLoadingSuggestions(false);
    } else {
      // DB not ready yet — use remote tagindex API
      debounceRef.current = setTimeout(async () => {
        setIsLoadingSuggestions(true);
        try {
          const remoteResults = await getSuggestionsForQuery(activeTerm);
          if (currentId === searchIdRef.current) setSuggestions(remoteResults);
        } catch {
          // Silent failure — suggestions are non-critical
        } finally {
          setIsLoadingSuggestions(false);
        }
      }, 200);
    }

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [autocompleteQuery, dbReady, clearSuggestions, setIsLoadingSuggestions, setSuggestions]);

  const search = useCallback(
    (searchQuery: string) => {
      setQuery(searchQuery);
      setAutocompleteQuery(null);
      addRecentSearch(searchQuery);
      setIsSearching(true);
    },
    [setQuery, setAutocompleteQuery, addRecentSearch, setIsSearching],
  );

  return { query, autocompleteQuery, setQuery, setAutocompleteQuery, addRecentSearch, setIsSearching, setSuggestions, clearSuggestions, setIsLoadingSuggestions, search };
}

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Suggestion } from '@/lib/utils/types';

interface SearchStoreState {
  query: string;
  autocompleteQuery: string | null;
  suggestions: Suggestion[];
  isSearching: boolean;
  isLoadingSuggestions: boolean;
  recentSearches: string[];
  setQuery: (query: string) => void;
  setAutocompleteQuery: (query: string | null) => void;
  setSuggestions: (suggestions: Suggestion[]) => void;
  setIsSearching: (isSearching: boolean) => void;
  setIsLoadingSuggestions: (loading: boolean) => void;
  addRecentSearch: (query: string) => void;
  removeRecentSearch: (query: string) => void;
  clearRecentSearches: () => void;
  clearSuggestions: () => void;
  reset: () => void;
}

export const useSearchStore = create<SearchStoreState>()(
  persist(
    (set) => ({
      query: '',
      autocompleteQuery: null,
      suggestions: [],
      isSearching: false,
      isLoadingSuggestions: false,
      recentSearches: [],
      setQuery: (query) => set({ query }),
      setAutocompleteQuery: (autocompleteQuery) => set({ autocompleteQuery }),
      setSuggestions: (suggestions) => set({ suggestions }),
      setIsSearching: (isSearching) => set({ isSearching }),
      setIsLoadingSuggestions: (loading) => set({ isLoadingSuggestions: loading }),
      addRecentSearch: (query) =>
        set((s) => ({
          recentSearches: [query, ...s.recentSearches.filter((x) => x !== query)].slice(0, 20),
        })),
      removeRecentSearch: (query) =>
        set((s) => ({
          recentSearches: s.recentSearches.filter((x) => x !== query),
        })),
      clearRecentSearches: () => set({ recentSearches: [] }),
      clearSuggestions: () => set({ suggestions: [] }),
      reset: () =>
        set({ query: '', autocompleteQuery: null, suggestions: [], isSearching: false, isLoadingSuggestions: false }),
    }),
    {
      name: 'hipago-search',
      partialize: (state) => ({ recentSearches: state.recentSearches }),
    },
  ),
);

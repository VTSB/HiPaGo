'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSearchStore } from '@/features/search/store/search.store';
import { useSearch } from '@/features/search/hooks/useSearch';
import { SearchInput } from '@/shared/components/SearchInput';
import { useSearchInputState } from '@/shared/hooks/useSearchInputState';
import { SearchResults } from '@/features/search/components/SearchResults';
import { TagChip } from '@/shared/components/TagChip';
import { tagFromSuggestion, toSearchString } from '@/lib/utils/hitomi-tag';
import { isHangul } from '@/lib/utils/tag-query';
import type { Suggestion } from '@/lib/utils/types';
import { searchLocalTags } from '@/lib/db/search-local';
import { useDbStatusStore } from '@/lib/store/db-status';
import { useT } from '@/lib/i18n/useT';

/**
 * Full-page mobile search experience: a search input pinned at the top of the
 * page content with its recent/popular/suggestion list rendered inline (normal
 * block flow) below it — not as a floating dropdown. Once a query is committed
 * (submit or row tap → /search?q=...), the page shows the SearchResults grid
 * instead. Reuses the same search store, hooks and item model as the desktop
 * SearchBar; only the presentation differs (inline vs. absolute overlay).
 */
export function MobileSearchPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const setQuery = useSearchStore((s) => s.setQuery);
  const setAutocompleteQuery = useSearchStore((s) => s.setAutocompleteQuery);
  const suggestions = useSearchStore((s) => s.suggestions);
  const clearSuggestions = useSearchStore((s) => s.clearSuggestions);
  const recentSearches = useSearchStore((s) => s.recentSearches);
  const addRecentSearch = useSearchStore((s) => s.addRecentSearch);
  const removeRecentSearch = useSearchStore((s) => s.removeRecentSearch);
  const clearRecentSearches = useSearchStore((s) => s.clearRecentSearches);
  const dbReady = useDbStatusStore((s) => s.dbReady);
  const t = useT();
  const [popularTags, setPopularTags] = useState<Suggestion[]>([]);

  const searchParams = useSearchParams();
  const urlQuery = searchParams.get('q') || '';

  const {
    value,
    updateValue,
    clear,
    syncFromQuery,
    undo,
    redo,
    currentToken,
    insertSuggestion,
  } = useSearchInputState({ initialValue: urlQuery });

  // committed === true means the current value reflects a query that has been
  // submitted/selected (so we show the results grid). Any keystroke flips it to
  // false (mid-typing → show the inline suggestion list). Starts committed when
  // the page is opened with a ?q= already in the URL (e.g. tag-link navigation).
  const [committed, setCommitted] = useState(() => urlQuery.trim().length > 0);
  const lastSyncedUrlQueryRef = useRef<string | null>(urlQuery || null);

  // Sync from URL when navigating via tag links / back-forward. Defer the
  // local setState into a rAF callback so it is not called synchronously in the
  // effect body (react-hooks/set-state-in-effect — same pattern as Header.tsx).
  useEffect(() => {
    if (!urlQuery || lastSyncedUrlQueryRef.current === urlQuery) return;
    lastSyncedUrlQueryRef.current = urlQuery;
    syncFromQuery(urlQuery);
    const id = requestAnimationFrame(() => setCommitted(true));
    return () => cancelAnimationFrame(id);
  }, [urlQuery, syncFromQuery]);

  // Auto-fetch of suggestions.
  useSearch();

  // Intentionally NO auto-focus on mount. Raising the mobile keyboard the
  // instant the search page opens — whether via the Search tab or a tag link —
  // is jarring and covers the content. The user taps the input when they
  // actually want to type.

  // Load popular tags once DB is ready.
  useEffect(() => {
    if (dbReady) {
      searchLocalTags('').then(setPopularTags).catch((e) => console.warn('[search] Popular tags load failed:', e));
    }
  }, [dbReady]);

  // Sync active input to the store for autocomplete.
  useEffect(() => {
    setQuery(value.trim());
    setAutocompleteQuery(currentToken);
  }, [value, currentToken, setQuery, setAutocompleteQuery]);

  const handleUpdateValue = useCallback((next: string) => {
    updateValue(next);
    setCommitted(false);
  }, [updateValue]);

  const doSubmit = useCallback(() => {
    const fullQuery = value.trim();
    if (!fullQuery) return;
    clearSuggestions();
    addRecentSearch(fullQuery);
    setCommitted(true);
    inputRef.current?.blur();
    router.push(`/search?q=${encodeURIComponent(fullQuery)}`);
  }, [value, router, clearSuggestions, addRecentSearch]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    doSubmit();
  }, [doSubmit]);

  const handleHistoryClick = useCallback((search: string) => {
    syncFromQuery(search);
    clearSuggestions();
    addRecentSearch(search);
    setCommitted(true);
    inputRef.current?.blur();
    router.push(`/search?q=${encodeURIComponent(search)}`);
  }, [syncFromQuery, clearSuggestions, addRecentSearch, router]);

  const handleSuggestionClick = useCallback((tag: string, tagType: string, localName?: string) => {
    insertSuggestion(tag, tagType, localName);
    clearSuggestions();
    setCommitted(false);
    inputRef.current?.focus();
  }, [insertSuggestion, clearSuggestions]);

  const koreanInput = isHangul(currentToken ?? '');

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); return; }
    if (e.key === 'y' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); redo(); return; }
  }, [undo, redo]);

  // Tapping a popular tag goes straight to its results (Toss behaviour).
  const handlePopularClick = useCallback((s: Suggestion) => {
    const q = toSearchString(tagFromSuggestion(s));
    clearSuggestions();
    addRecentSearch(q);
    setCommitted(true);
    inputRef.current?.blur();
    router.push(`/search?q=${encodeURIComponent(q)}`);
  }, [router, clearSuggestions, addRecentSearch]);

  const typing = value.trim().length > 0;
  // committed query → results grid. Typing → tag suggestions. Idle → popular
  // tags (horizontal pills) + recent searches (large rows), Toss-style.
  const showResults = committed;

  return (
    // On a results route (/search?q=) this is a stacked view and the (main)
    // layout drops its top padding, so add the status-bar safe-area here.
    <div className={urlQuery ? 'pt-[calc(0.5rem+env(safe-area-inset-top))]' : undefined}>
      <div className="mb-6 flex w-full items-center gap-1.5">
        {/* On a results route (/search?q=) this is a stacked view: show a ←
            back chevron to the left of the box (the tab bar is hidden). Pops
            one history level so repeated searches unwind in reverse order. */}
        {urlQuery && (
          <button
            type="button"
            aria-label={t('detail.back')}
            onClick={() => {
              if (typeof window !== 'undefined' && window.history.length > 1) router.back();
              else router.replace('/search');
            }}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-700 transition-colors active:bg-zinc-200/60 dark:text-zinc-200 dark:active:bg-zinc-800/60"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              aria-hidden="true"
              className="h-6 w-6"
            >
              <path d="m15 5-7 7 7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <form onSubmit={handleSubmit} className="min-w-0 flex-1">
          <SearchInput
            leadingIcon
            pill
            value={value}
            onChange={handleUpdateValue}
            onKeyDown={handleKeyDown}
            onClear={clear}
            placeholder={t('search.placeholder')}
            inputRef={inputRef}
          />
        </form>
      </div>

      {showResults ? (
        <SearchResults />
      ) : typing ? (
        suggestions.length > 0 && (
          <ul role="listbox" aria-label={t('search.tagSuggestions')} className="space-y-0.5">
            {suggestions.map((s, i) => (
              <li key={`${s.tagType}-${s.tag}-${i}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  onMouseDown={(e) => { e.preventDefault(); handleSuggestionClick(s.tag, s.tagType, s.localName); }}
                  className="flex min-h-[48px] w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-zinc-100 active:bg-zinc-200/70 dark:hover:bg-zinc-800 dark:active:bg-zinc-800/70"
                >
                  <TagChip tag={s.tag} type={s.tagType} displayName={koreanInput ? s.localName : s.tag} linked={false} size="lg" />
                  <span className="ml-auto shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
                    {s.amount.toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : (
        <>
          {/* 인기 태그 — horizontal chip scroller */}
          {popularTags.length > 0 && (
            <section className="mb-7">
              <p className="mb-3 px-1 text-sm font-medium text-zinc-500 dark:text-zinc-400">
                {t('search.popularTags')}
              </p>
              <div className="-mx-4 flex items-center gap-2.5 overflow-x-auto scrollbar-hide px-4 py-1.5">
                {popularTags.map((s, i) => (
                  <button
                    key={`${s.tagType}-${s.tag}-${i}`}
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); handlePopularClick(s); }}
                    className="shrink-0 rounded-full transition-transform active:scale-95"
                  >
                    <TagChip tag={s.tag} type={s.tagType} displayName={koreanInput ? s.localName : s.tag} linked={false} size="lg" />
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* 최근 검색 — large plain rows with delete */}
          {recentSearches.length > 0 && (
            <section>
              <div className="mb-1 flex items-center justify-between px-1">
                <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                  {t('search.recentSearches')}
                </p>
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); clearRecentSearches(); }}
                  className="text-sm text-zinc-500 active:text-zinc-700 dark:text-zinc-400 dark:active:text-zinc-200"
                >
                  {t('search.clearHistory')}
                </button>
              </div>
              <ul>
                {recentSearches.slice(0, 12).map((q) => (
                  <li key={q} className="relative">
                    <button
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); handleHistoryClick(q); }}
                      className="block w-full truncate rounded-xl py-3.5 pl-3 pr-14 text-left text-base font-semibold text-zinc-800 transition-colors hover:bg-zinc-100 active:bg-zinc-200/70 dark:text-zinc-100 dark:hover:bg-zinc-800 dark:active:bg-zinc-800/70"
                    >
                      {q.replace(/_/g, ' ')}
                    </button>
                    <button
                      type="button"
                      aria-label={`${t('search.clearHistory')}: ${q}`}
                      onMouseDown={(e) => { e.preventDefault(); removeRecentSearch(q); }}
                      className="absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-zinc-400 transition-colors hover:text-zinc-600 active:bg-zinc-300/60 dark:text-zinc-500 dark:hover:text-zinc-300 dark:active:bg-zinc-700/60"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-[19px] w-[19px]">
                        <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

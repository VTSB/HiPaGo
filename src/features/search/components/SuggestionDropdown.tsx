'use client';

import { TagFavoriteChip } from '@/shared/components/TagFavoriteChip';
import { useT } from '@/lib/i18n/useT';
import type { Suggestion } from '@/lib/utils/types';
import type { RefObject } from 'react';

interface SuggestionDropdownProps {
  suggestions: Suggestion[];
  selectedIndex: number;
  onSelect: (tag: string, tagType: string, localName?: string) => void;
  onHover: (index: number) => void;
  ignoreMouseRef: RefObject<boolean>;
  /**
   * When true the user is typing Korean — suggestion labels render the Korean
   * candidate name. Driven by the active input token's script, not the locale.
   */
  koreanDisplay?: boolean;
}

export function SuggestionDropdown({
  suggestions,
  selectedIndex,
  onSelect,
  onHover,
  ignoreMouseRef,
  koreanDisplay = false,
}: SuggestionDropdownProps) {
  const t = useT();

  return (
    <div
      role="region"
      aria-label={t('search.title')}
      className="absolute top-full mt-1 w-full rounded-lg border border-zinc-300 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800 z-50 max-h-80 overflow-y-auto"
    >
      <span className="sr-only" aria-live="polite">
        {suggestions.length} {t('search.results')}
      </span>
      {suggestions.map((suggestion, idx) => (
        <div
          key={`${suggestion.tagType}-${suggestion.tag}`}
          onMouseEnter={() => !ignoreMouseRef.current && onHover(idx)}
          className={`relative flex w-full min-w-0 items-center first:rounded-t-lg last:rounded-b-lg transition-colors ${
            idx === selectedIndex
              ? 'bg-zinc-100 dark:bg-zinc-700'
              : 'hover:bg-zinc-100 dark:hover:bg-zinc-700'
          }`}
        >
          <button
            id={`search-option-${idx}`}
            type="button"
            data-search-option
            aria-current={idx === selectedIndex ? 'true' : undefined}
            aria-label={`${koreanDisplay ? (suggestion.localName ?? suggestion.tag) : suggestion.tag} ${suggestion.amount.toLocaleString()}`}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => onSelect(suggestion.tag, suggestion.tagType, suggestion.localName)}
            className="absolute inset-0 z-0 w-full rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500"
          >
            <span className="sr-only">
              {koreanDisplay ? (suggestion.localName ?? suggestion.tag) : suggestion.tag}{' '}
              {suggestion.amount.toLocaleString()}
            </span>
          </button>
          <div className="pointer-events-none relative z-10 flex w-full min-w-0 items-center gap-2 px-4 py-2">
            <span className="min-w-0 flex-1">
              <TagFavoriteChip
                tag={suggestion.tag}
                type={suggestion.tagType}
                displayName={koreanDisplay ? suggestion.localName : suggestion.tag}
                linked={false}
                size="sm"
                wrap
              />
            </span>
            <span className="shrink-0 text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
              {suggestion.amount.toLocaleString()}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

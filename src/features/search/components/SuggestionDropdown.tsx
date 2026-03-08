'use client';

import { TagChip } from '@/shared/components/TagChip';
import { useT } from '@/lib/i18n/useT';
import type { Suggestion } from '@/lib/utils/types';
import { useSettingsStore } from '@/lib/store/settings';
import type { RefObject } from 'react';

interface SuggestionDropdownProps {
  suggestions: Suggestion[];
  selectedIndex: number;
  onSelect: (tag: string, tagType: string) => void;
  onHover: (index: number) => void;
  ignoreMouseRef: RefObject<boolean>;
}

export function SuggestionDropdown({ suggestions, selectedIndex, onSelect, onHover, ignoreMouseRef }: SuggestionDropdownProps) {
  const t = useT();
  const locale = useSettingsStore((s) => s.locale);

  return (
    <div role="listbox" aria-label={t('search.title')} className="absolute top-full mt-1 w-full rounded-lg border border-zinc-300 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800 z-50 max-h-80 overflow-y-auto">
      <span className="sr-only" aria-live="polite">{suggestions.length} {t('search.results')}</span>
      {suggestions.map((suggestion, idx) => (
        <button
          key={`${suggestion.tagType}-${suggestion.tag}-${idx}`}
          id={`search-option-${idx}`}
          type="button"
          role="option"
          aria-selected={idx === selectedIndex}
          onMouseDown={(e) => { e.preventDefault(); onSelect(suggestion.tag, suggestion.tagType); }}
          onMouseEnter={() => !ignoreMouseRef.current && onHover(idx)}
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

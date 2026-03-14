'use client';

import { getTagColor, TAG_TYPE_DISPLAY } from '@/lib/utils/types';
import { useT } from '@/lib/i18n/useT';
import { parseToken } from '@/shared/utils/parse-token';
import { tagFromSearch } from '@/lib/utils/hitomi-tag';

export { parseToken } from '@/shared/utils/parse-token';

interface RecentSearchesDropdownProps {
  searches: string[];
  onSelect: (search: string) => void;
  onRemove: (search: string) => void;
  onClear: () => void;
  selectedIndex?: number;
}

export function RecentSearchesDropdown({ searches, onSelect, onRemove, onClear, selectedIndex = -1 }: RecentSearchesDropdownProps) {
  const t = useT();

  return (
    <div className="absolute top-full mt-1 w-full rounded-lg border border-zinc-300 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800 z-50 max-h-80 overflow-y-auto">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-200 dark:border-zinc-700">
        <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{t('search.recentSearches')}</span>
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); onClear(); }}
          className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          {t('search.clearHistory')}
        </button>
      </div>
      {searches.map((search) => {
        const tokens = search.split(/\s+/).filter(Boolean);
        return (
          <div
            key={search}
            role="button"
            tabIndex={0}
            onMouseDown={(e) => { e.preventDefault(); onSelect(search); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(search); } }}
            className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-700 cursor-pointer ${searches.indexOf(search) === selectedIndex ? 'bg-zinc-100 dark:bg-zinc-700' : ''}`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5 flex-shrink-0 text-zinc-400">
              <path fillRule="evenodd" d="M1 8a7 7 0 1 1 14 0A7 7 0 0 1 1 8Zm7.75-4.25a.75.75 0 0 0-1.5 0V8c0 .414.336.75.75.75h3.25a.75.75 0 0 0 0-1.5h-2.5v-3.5Z" clipRule="evenodd" />
            </svg>
            <div className="flex flex-wrap gap-1 flex-1 min-w-0">
              {tokens.map((token, i) => {
                const parsed = parseToken(token);
                return parsed ? (
                  <span key={i} className={`inline-flex rounded-full px-1.5 py-0.5 text-xs font-medium ${getTagColor(parsed.type)}`}>
                    {parsed.type}:{tagFromSearch(parsed.tag, parsed.type).displayForm}{TAG_TYPE_DISPLAY[parsed.type]}
                  </span>
                ) : (
                  <span key={i} className="text-xs text-zinc-700 dark:text-zinc-300">{token}</span>
                );
              })}
            </div>
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(search); }}
              className="ml-auto flex-shrink-0 p-0.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3">
                <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}

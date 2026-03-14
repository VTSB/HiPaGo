'use client';

import { TagChip } from '@/shared/components/TagChip';
import { useT } from '@/lib/i18n/useT';
import { useSettingsStore } from '@/lib/store/settings';
import { getTagColor, TAG_TYPE_DISPLAY } from '@/lib/utils/types';
import type { Suggestion, TagType } from '@/lib/utils/types';
import { parseToken } from '@/features/search/components/RecentSearchesDropdown';
import { tagFromSearch } from '@/lib/utils/hitomi-tag';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FlatItem =
  | { kind: 'recent'; query: string }
  | { kind: 'suggestion'; suggestion: Suggestion };

// ---------------------------------------------------------------------------
// Pure builder — no React required
// ---------------------------------------------------------------------------

export function buildDropdownItems(params: {
  inputText: string;
  recentSearches: string[];
  suggestions: Suggestion[];
  popularTags: Suggestion[];
}): FlatItem[] {
  const { inputText, recentSearches, suggestions, popularTags } = params;
  const items: FlatItem[] = [];

  // Recent searches — filter by inputText if present, cap at 3; otherwise cap at 5
  let filtered = recentSearches;
  if (inputText) {
    filtered = recentSearches
      .filter((s) => s.toLowerCase().includes(inputText.toLowerCase()))
      .slice(0, 3);
  } else {
    filtered = recentSearches.slice(0, 5);
  }
  items.push(...filtered.map((q) => ({ kind: 'recent' as const, query: q })));

  // Tag suggestions take priority; fall back to popular tags only when:
  //   - no suggestions
  //   - inputText is empty
  if (suggestions.length > 0) {
    items.push(
      ...suggestions.map((s) => ({ kind: 'suggestion' as const, suggestion: s })),
    );
  } else if (!inputText && popularTags.length > 0) {
    items.push(
      ...popularTags.map((s) => ({ kind: 'suggestion' as const, suggestion: s })),
    );
  }

  return items;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface UnifiedDropdownProps {
  flatItems: FlatItem[];
  /** Index set by keyboard navigation (ArrowUp/Down). Used for Enter selection. */
  selectedIndex: number;
  onSelectRecent: (query: string) => void;
  onSelectSuggestion: (tag: string, tagType: TagType) => void;
  onRemoveRecent: (query: string) => void;
  onClearRecents: () => void;
  /** When true the header label changes to "Popular Tags" */
  showingPopular?: boolean;
}

export function UnifiedDropdown({
  flatItems,
  selectedIndex,
  onSelectRecent,
  onSelectSuggestion,
  onRemoveRecent,
  onClearRecents,
  showingPopular = false,
}: UnifiedDropdownProps) {
  const t = useT();
  const locale = useSettingsStore((s) => s.locale);

  const recentItems = flatItems.filter((i): i is Extract<FlatItem, { kind: 'recent' }> => i.kind === 'recent');
  const suggestionItems = flatItems.filter(
    (i): i is Extract<FlatItem, { kind: 'suggestion' }> => i.kind === 'suggestion',
  );

  const hasRecent = recentItems.length > 0;
  const hasSuggestions = suggestionItems.length > 0;

  // Global flat index offset — recent items come first
  const suggestionOffset = recentItems.length;

  return (
    <div
      role="listbox"
      className="absolute top-full mt-1 w-full rounded-lg border border-zinc-300 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800 z-50 max-h-80 overflow-y-auto"
    >
      {/* ── Recent Searches section ── */}
      {hasRecent && (
        <>
          <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-200 dark:border-zinc-700">
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              {t('search.recentSearches')}
            </span>
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onClearRecents();
              }}
              className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
            >
              {t('search.clearHistory')}
            </button>
          </div>

          {recentItems.map((item, localIdx) => {
            const flatIdx = localIdx;
            const isSelected = flatIdx === selectedIndex;
            const tokens = item.query.split(/\s+/).filter(Boolean);

            return (
              <div
                key={item.query}
                role="button"
                tabIndex={0}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelectRecent(item.query);
                }}
                                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectRecent(item.query);
                  }
                }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm cursor-pointer ${
                  isSelected ? 'bg-zinc-100 dark:bg-zinc-700' : ''
                } hover:bg-zinc-100 dark:hover:bg-zinc-700`}
              >
                {/* Clock icon */}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  className="h-3.5 w-3.5 flex-shrink-0 text-zinc-400"
                >
                  <path
                    fillRule="evenodd"
                    d="M1 8a7 7 0 1 1 14 0A7 7 0 0 1 1 8Zm7.75-4.25a.75.75 0 0 0-1.5 0V8c0 .414.336.75.75.75h3.25a.75.75 0 0 0 0-1.5h-2.5v-3.5Z"
                    clipRule="evenodd"
                  />
                </svg>

                {/* Tag tokens */}
                <div className="flex flex-wrap gap-1 flex-1 min-w-0">
                  {tokens.map((token, i) => {
                    const parsed = parseToken(token);
                    return parsed ? (
                      <span
                        key={i}
                        className={`inline-flex rounded-full px-1.5 py-0.5 text-xs font-medium ${getTagColor(parsed.type)}`}
                      >
                        {parsed.type}:{tagFromSearch(parsed.tag, parsed.type).displayForm}
                        {TAG_TYPE_DISPLAY[parsed.type]}
                      </span>
                    ) : (
                      <span key={i} className="text-xs text-zinc-700 dark:text-zinc-300">
                        {token}
                      </span>
                    );
                  })}
                </div>

                {/* Delete button */}
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onRemoveRecent(item.query);
                  }}
                  className="ml-auto flex-shrink-0 p-0.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    className="h-3 w-3"
                  >
                    <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
                  </svg>
                </button>
              </div>
            );
          })}
        </>
      )}

      {/* ── Tag Suggestions / Popular Tags section ── */}
      {hasSuggestions && (
        <>
          <div
            className={`flex items-center px-3 py-2 border-b border-zinc-200 dark:border-zinc-700 ${
              hasRecent ? 'border-t' : ''
            }`}
          >
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              {showingPopular ? t('search.popularTags') : t('search.tagSuggestions')}
            </span>
          </div>

          {suggestionItems.map((item, localIdx) => {
            const flatIdx = suggestionOffset + localIdx;
            const isSelected = flatIdx === selectedIndex;
            const { suggestion } = item;

            return (
              <button
                key={`${suggestion.tagType}-${suggestion.tag}-${localIdx}`}
                id={`search-option-${flatIdx}`}
                type="button"
                role="option"
                aria-selected={flatIdx === selectedIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelectSuggestion(suggestion.tag, suggestion.tagType);
                }}
                                className={`w-full flex items-center justify-between px-4 py-2 text-left text-sm first:rounded-t-lg last:rounded-b-lg transition-colors ${
                  isSelected ? 'bg-zinc-100 dark:bg-zinc-700' : ''
                } hover:bg-zinc-100 dark:hover:bg-zinc-700`}
              >
                <TagChip
                  tag={suggestion.tag}
                  type={suggestion.tagType}
                  displayName={
                    locale === 'ko' && suggestion.localName ? suggestion.localName : undefined
                  }
                  linked={false}
                  size="sm"
                />
                <span className="text-zinc-500 dark:text-zinc-400 text-xs ml-auto flex-shrink-0">
                  {suggestion.amount.toLocaleString()}
                </span>
              </button>
            );
          })}
        </>
      )}
    </div>
  );
}

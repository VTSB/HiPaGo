'use client';

import { useT } from '@/lib/i18n/useT';
import { useSettingsStore } from '@/lib/store/settings';
import { toFavoriteTagKey } from '@/lib/utils/tag-favorites';
import type { TagType } from '@/lib/utils/types';

interface TagFavoriteButtonProps {
  tag: string;
  type: TagType;
  size?: 'xs' | 'sm' | 'md';
  tone?: 'default' | 'chip';
  className?: string;
}

/** Toggle a metadata favorite without changing the surrounding link/row action. */
export function TagFavoriteButton({
  tag,
  type,
  size = 'sm',
  tone = 'default',
  className = '',
}: TagFavoriteButtonProps) {
  const t = useT();
  const favoriteKey = toFavoriteTagKey(type, tag);
  const isFavorite = useSettingsStore(
    (state) => state.favoriteTags?.includes(favoriteKey) ?? false,
  );
  const toggleFavoriteTag = useSettingsStore((state) => state.toggleFavoriteTag);
  const actionLabel = isFavorite ? t('detail.removeFavorite') : t('detail.addFavorite');
  const sizeClass = size === 'md' ? 'h-9 w-9' : size === 'xs' ? 'h-5 w-5' : 'h-7 w-7';
  const iconSizeClass = size === 'xs' ? 'h-3 w-3' : 'h-4 w-4';
  const focusClass =
    tone === 'chip' ? 'focus-visible:outline-current' : 'focus-visible:outline-amber-500';
  const toneClass =
    tone === 'chip'
      ? isFavorite
        ? 'pointer-events-auto text-current opacity-90 hover:bg-black/5 hover:opacity-100 active:bg-black/10 dark:hover:bg-white/10 dark:active:bg-white/15'
        : 'pointer-events-auto text-current opacity-45 hover:bg-black/5 hover:opacity-100 active:bg-black/10 dark:hover:bg-white/10 dark:active:bg-white/15'
      : isFavorite
        ? 'text-amber-500 hover:bg-amber-50 active:bg-amber-100 dark:text-amber-400 dark:hover:bg-amber-950/50 dark:active:bg-amber-900/50'
        : 'text-zinc-400 hover:bg-zinc-100 hover:text-amber-500 active:bg-zinc-200 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-amber-400 dark:active:bg-zinc-700';

  return (
    <button
      type="button"
      aria-label={`${actionLabel}: ${tag}`}
      aria-pressed={isFavorite}
      title={`${actionLabel}: ${tag}`}
      data-tag-favorite-key={favoriteKey}
      data-chip-integrated={tone === 'chip' ? '' : undefined}
      onMouseDown={(event) => {
        // Suggestion rows select on mouse-down. Keep this reusable control from
        // activating a surrounding row if it is composed there later.
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleFavoriteTag(favoriteKey);
      }}
      className={`inline-flex shrink-0 items-center justify-center rounded-full transition-[background-color,color,opacity] focus-visible:outline-2 focus-visible:outline-offset-2 ${focusClass} ${sizeClass} ${toneClass} ${className}`}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill={isFavorite ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={isFavorite ? 0 : 2}
        className={iconSizeClass}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.562.562 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z"
        />
      </svg>
    </button>
  );
}

'use client';

import Link from 'next/link';
import type { CSSProperties } from 'react';
import { useTagLocalName } from '@/lib/i18n/useTagI18n';
import { useSettingsStore } from '@/lib/store/settings';
import { TAG_TYPE_DISPLAY, getTagColor } from '@/lib/utils/types';
import type { TagType } from '@/lib/utils/types';
import { tagFromDisplay, toSearchString } from '@/lib/utils/hitomi-tag';
import { buildKoreanToken } from '@/lib/utils/tag-query';
import { toFavoriteTagKey } from '@/lib/utils/tag-favorites';

interface TagChipProps {
  tag: string;
  type: TagType;
  /** Translated display name (falls back to raw tag) */
  displayName?: string;
  /** Render as Link to search page (default true) */
  linked?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** Allow long labels to wrap inside constrained rows. */
  wrap?: boolean;
  /** Render the label inside a parent-owned composite chip surface. */
  embedded?: boolean;
}

export function TagChip({
  tag,
  type,
  displayName,
  linked = true,
  size = 'sm',
  wrap = false,
  embedded = false,
}: TagChipProps) {
  const localizedName = useTagLocalName(type, displayName === undefined ? tag : undefined);
  const locale = useSettingsStore((s) => s.locale);
  const favoriteKey = toFavoriteTagKey(type, tag);
  const isFavorite = useSettingsStore((s) => s.favoriteTags?.includes(favoriteKey) ?? false);

  const koreanName = displayName ?? localizedName;
  const label = (koreanName ?? tag) + TAG_TYPE_DISPLAY[type];
  const sizeCls =
    size === 'sm'
      ? embedded
        ? 'py-0.5 pl-2 pr-1 text-xs'
        : 'px-2 py-0.5 text-xs'
      : size === 'lg'
        ? embedded
          ? 'py-2 pl-4 pr-1.5 text-sm'
          : 'px-4 py-2 text-sm'
        : embedded
          ? 'py-1 pl-3 pr-1 text-[13px]'
          : 'px-3 py-1 text-[13px]';
  const flowCls = wrap
    ? 'inline-block min-w-0 max-w-full whitespace-normal break-words text-left leading-snug'
    : 'inline-block whitespace-nowrap';
  const style: CSSProperties | undefined = wrap ? { overflowWrap: 'anywhere' } : undefined;
  const surfaceCls = embedded ? '' : `rounded-full ${getTagColor(type)}`;
  const cls = `${flowCls} ${surfaceCls} font-medium ${sizeCls}`;
  const favoriteIndicator =
    isFavorite && !embedded ? (
      <span
        aria-hidden="true"
        data-favorite-indicator
        className="mr-1 inline-block text-[0.75em] text-current opacity-80"
      >
        ★
      </span>
    ) : null;

  if (!linked) {
    return (
      <span className={cls} style={style} data-tag-key={favoriteKey} data-favorite={isFavorite}>
        {favoriteIndicator}
        {label}
      </span>
    );
  }

  // With Korean locale and a Korean translation present, link to the Korean
  // type-qualified query so the search box keeps Korean. English otherwise.
  const href =
    locale === 'ko' && koreanName
      ? `/search?q=${encodeURIComponent(buildKoreanToken(type, koreanName))}`
      : `/search?q=${encodeURIComponent(toSearchString(tagFromDisplay(tag, type)))}`;

  return (
    <Link
      href={href}
      className={cls}
      style={style}
      data-tag-key={favoriteKey}
      data-favorite={isFavorite}
    >
      {favoriteIndicator}
      {label}
    </Link>
  );
}

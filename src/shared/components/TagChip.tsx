'use client';

import Link from 'next/link';
import type { CSSProperties } from 'react';
import { useTagLocalName } from '@/lib/i18n/useTagI18n';
import { useSettingsStore } from '@/lib/store/settings';
import { TAG_TYPE_DISPLAY, getTagColor } from '@/lib/utils/types';
import type { TagType } from '@/lib/utils/types';
import { tagFromDisplay, toSearchString } from '@/lib/utils/hitomi-tag';
import { buildKoreanToken } from '@/lib/utils/tag-query';

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
}

export function TagChip({
  tag,
  type,
  displayName,
  linked = true,
  size = 'sm',
  wrap = false,
}: TagChipProps) {
  const localizedName = useTagLocalName(type, displayName === undefined ? tag : undefined);
  const locale = useSettingsStore((s) => s.locale);

  const koreanName = displayName ?? localizedName;
  const label = (koreanName ?? tag) + TAG_TYPE_DISPLAY[type];
  const sizeCls =
    size === 'sm'
      ? 'px-2 py-0.5 text-xs'
      : size === 'lg'
        ? 'px-4 py-2 text-sm'
        : 'px-3 py-1 text-[13px]';
  const flowCls = wrap
    ? 'inline-block min-w-0 max-w-full whitespace-normal break-words text-left leading-snug'
    : 'inline-block whitespace-nowrap';
  const style: CSSProperties | undefined = wrap ? { overflowWrap: 'anywhere' } : undefined;
  const cls = `${flowCls} rounded-full font-medium ${getTagColor(type)} ${sizeCls}`;

  if (!linked) {
    return (
      <span className={cls} style={style}>
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
    <Link href={href} className={cls} style={style}>
      {label}
    </Link>
  );
}

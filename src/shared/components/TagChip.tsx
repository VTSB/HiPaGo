'use client';

import Link from 'next/link';
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
  size?: 'sm' | 'md';
}

export function TagChip({ tag, type, displayName, linked = true, size = 'sm' }: TagChipProps) {
  const localizedName = useTagLocalName(type, displayName === undefined ? tag : undefined);
  const locale = useSettingsStore((s) => s.locale);

  const koreanName = displayName ?? localizedName;
  const label = (koreanName ?? tag) + TAG_TYPE_DISPLAY[type];
  const cls = `whitespace-nowrap rounded-full font-medium ${getTagColor(type)} ${
    size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-[13px]'
  }`;

  if (!linked) {
    return <span className={cls}>{label}</span>;
  }

  // With Korean locale and a Korean translation present, link to the Korean
  // type-qualified query so the search box keeps Korean. English otherwise.
  const href =
    locale === 'ko' && koreanName
      ? `/search?q=${encodeURIComponent(buildKoreanToken(type, koreanName))}`
      : `/search?q=${encodeURIComponent(toSearchString(tagFromDisplay(tag, type)))}`;

  return (
    <Link href={href} className={cls}>
      {label}
    </Link>
  );
}

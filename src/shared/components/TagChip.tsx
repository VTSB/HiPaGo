'use client';

import Link from 'next/link';
import { TAG_TYPE_DISPLAY, getTagColor } from '@/lib/utils/types';
import type { TagType } from '@/lib/utils/types';
import { tagFromDisplay, toSearchString } from '@/lib/utils/hitomi-tag';

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
  const label = (displayName ?? tag) + TAG_TYPE_DISPLAY[type];
  const cls = `whitespace-nowrap rounded-full font-medium ${getTagColor(type)} ${
    size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-[13px]'
  }`;

  if (!linked) {
    return <span className={cls}>{label}</span>;
  }

  return (
    <Link
      href={`/search?q=${encodeURIComponent(toSearchString(tagFromDisplay(tag, type)))}`}
      className={cls}
    >
      {label}
    </Link>
  );
}
